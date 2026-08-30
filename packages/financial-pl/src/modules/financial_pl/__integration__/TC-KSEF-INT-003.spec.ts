import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/helpers/integration/salesFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';

const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

type ListBody = {
  items?: Array<Record<string, unknown>>;
  total?: number;
  summary?: {
    count?: number;
    totalNet?: string;
    totalGross?: string;
  };
};

function invoicePayload(invoiceNumber: string) {
  return {
    invoiceNumber,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    subtotalNetAmount: 100,
    subtotalGrossAmount: 123,
    taxTotalAmount: 23,
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    paidTotalAmount: 0,
    outstandingAmount: 123,
    lines: [
      {
        name: 'Tenant isolation line',
        quantity: 1,
        unitPriceNet: 100,
        unitPriceGross: 123,
        taxRate: 23,
        taxAmount: 23,
        totalNetAmount: 100,
        totalGrossAmount: 123,
        currencyCode: 'PLN',
      },
    ],
  };
}

async function landAcceptedSubmission(input: {
  organizationId: string;
  tenantId: string;
  salesInvoiceId: string;
}): Promise<string> {
  return withClient(async (client) => {
    const res = await client.query<{ id: string }>(
      `insert into financial_pl_ksef_submissions
         (id, organization_id, tenant_id, sales_invoice_id, document_kind, environment, mode,
          status, context_nip, attempt_count, ksef_number, created_at, accepted_at)
       values (gen_random_uuid(), $1, $2, $3, 'invoice', 'test', 'online',
          'accepted', '7980332920', 1, $4, now(), now())
       returning id`,
      [input.organizationId, input.tenantId, input.salesInvoiceId, `1111111111-20260622-${suffix()}AAAA-BB`],
    );
    return res.rows[0].id;
  });
}

async function deleteSubmissionRow(id: string | null): Promise<void> {
  if (!id) return;
  await withClient(async (client) => {
    await client.query('delete from financial_pl_ksef_submissions where id = $1', [id]);
  }).catch(() => undefined);
}

test.describe('TC-KSEF-INT-003: KSeF invoice list tenant isolation', () => {
  test('org B cannot see org A invoice rows or summary totals', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) {
      test.skip(true, 'token does not expose orgId/tenantId for the direct submission fixture');
    }

    let orgBId: string | null = null;
    let invoiceId: string | null = null;
    let submissionId: string | null = null;
    const invoiceNumber = `OM-INT003-${suffix()}`;

    try {
      try {
        orgBId = await createOrganizationFixture(request, token, { name: `QA INT003 Org B ${suffix()}`, tenantId });
      } catch {
        test.skip(true, 'cannot create a second organization on this DB (directory create requires super-admin)');
      }

      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', {
        token,
        data: invoicePayload(invoiceNumber),
      });
      if (createRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(createRes.status(), 'admin creates invoice in org A').toBe(201);
      const createBody = (await createRes.json()) as { invoiceId?: string; id?: string };
      invoiceId = createBody.invoiceId ?? createBody.id ?? null;
      expect(invoiceId, 'create returns invoice id').toBeTruthy();

      submissionId = await landAcceptedSubmission({ organizationId, tenantId, salesInvoiceId: invoiceId as string });

      // Positive control: org A (the invoice's own org, the token's scope) MUST see its invoice
      // with a non-zero list + summary. Without this, an implementation that returns empty for
      // EVERY org would pass the org-B emptiness check below while providing no real isolation.
      const orgARead = await apiRequest(
        request,
        'GET',
        `/api/financial_pl/ksef/invoices?search=${encodeURIComponent(invoiceNumber)}&pageSize=100`,
        { token },
      );
      expect(orgARead.status(), 'org-A scoped list read succeeds').toBe(200);
      const orgABody = (await orgARead.json()) as ListBody;
      const orgAItems = orgABody.items ?? [];
      expect(orgAItems.length, 'org-A sees its own invoice').toBeGreaterThan(0);
      expect(
        orgAItems.some((it) => it.invoiceNumber === invoiceNumber),
        'org-A list contains the seeded invoice number',
      ).toBe(true);
      expect(orgABody.summary?.count ?? 0, 'org-A summary count includes the seeded invoice').toBeGreaterThan(0);
      expect(Number(orgABody.summary?.totalGross ?? '0'), 'org-A summary gross is non-zero').toBeGreaterThan(0);

      const orgBRead = await apiRequestWithSelectedOrg(
        request,
        'GET',
        `/api/financial_pl/ksef/invoices?search=${encodeURIComponent(invoiceNumber)}&pageSize=100`,
        { token, selectedOrgId: orgBId as string },
      );
      if (orgBRead.status() === 403 || orgBRead.status() === 404) {
        test.skip(true, 'org-B selected scope is not readable on this DB');
      }
      expect(orgBRead.status(), 'org-B scoped list read succeeds').toBe(200);
      const body = (await orgBRead.json()) as ListBody;
      const items = body.items ?? [];
      expect(items, 'org-B filtered list is empty for org-A invoice number').toHaveLength(0);
      expect(body.total ?? 0, 'org-B total excludes the org-A invoice').toBe(0);
      expect(body.summary?.count ?? 0, 'org-B summary count excludes the org-A invoice').toBe(0);
      expect(Number(body.summary?.totalNet ?? '0'), 'org-B summary net excludes the org-A invoice').toBe(0);
      expect(Number(body.summary?.totalGross ?? '0'), 'org-B summary gross excludes the org-A invoice').toBe(0);
    } finally {
      await deleteSubmissionRow(submissionId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
      await deleteOrganizationIfExists(request, token, orgBId);
    }
  });
});
