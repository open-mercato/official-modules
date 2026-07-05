import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/modules/core/__integration__/helpers/salesFixtures';
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures';

const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function invoicePayload(label = 'INT-001') {
  return {
    invoiceNumber: `OM-${label}-${suffix()}`,
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
        name: `Boundary line ${label}`,
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

async function createInvoice(request: Parameters<typeof apiRequest>[0], token: string, label: string): Promise<string> {
  const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', {
    token,
    data: invoicePayload(label),
  });
  if (createRes.status() === 403) {
    test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
  }
  expect(createRes.status(), `admin creates invoice fixture ${label}`).toBe(201);
  const body = (await createRes.json()) as { invoiceId?: string; id?: string };
  const invoiceId = body.invoiceId ?? body.id ?? null;
  expect(invoiceId, 'create returns invoice id').toBeTruthy();
  return invoiceId as string;
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

test.describe('TC-KSEF-INT-001: KSeF immutability interceptor boundary', () => {
  test('accepted KSeF submissions lock core invoice PUT and DELETE while unsent invoices remain mutable', async ({
    request,
  }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) {
      test.skip(true, 'token does not expose orgId/tenantId for the direct submission fixture');
    }

    let lockedInvoiceId: string | null = null;
    let acceptedSubmissionId: string | null = null;
    let controlInvoiceId: string | null = null;
    let controlDeleteInvoiceId: string | null = null;

    try {
      lockedInvoiceId = await createInvoice(request, token, 'INT001-LOCKED');
      acceptedSubmissionId = await landAcceptedSubmission({
        organizationId,
        tenantId,
        salesInvoiceId: lockedInvoiceId,
      });

      const lockedPut = await apiRequest(request, 'PUT', '/api/sales/invoices', {
        token,
        data: { id: lockedInvoiceId, metadata: { immutableProbe: suffix() } },
      });
      expect(lockedPut.status(), 'PUT of a KSeF-accepted invoice returns 409').toBe(409);

      const lockedDelete = await apiRequest(
        request,
        'DELETE',
        `/api/sales/invoices?id=${encodeURIComponent(lockedInvoiceId)}`,
        { token },
      );
      expect(lockedDelete.status(), 'DELETE of a KSeF-accepted invoice returns 409').toBe(409);

      controlInvoiceId = await createInvoice(request, token, 'INT001-CONTROL-PUT');
      const controlPut = await apiRequest(request, 'PUT', '/api/sales/invoices', {
        token,
        data: { id: controlInvoiceId, metadata: { mutableProbe: suffix() } },
      });
      expect(controlPut.status(), 'PUT of an invoice without accepted KSeF submission is accepted').toBe(200);

      controlDeleteInvoiceId = await createInvoice(request, token, 'INT001-CONTROL-DELETE');
      const controlDelete = await apiRequest(
        request,
        'DELETE',
        `/api/sales/invoices?id=${encodeURIComponent(controlDeleteInvoiceId)}`,
        { token },
      );
      expect(controlDelete.status(), 'DELETE of an invoice without accepted KSeF submission is accepted').toBe(200);
      controlDeleteInvoiceId = null;
    } finally {
      await deleteSubmissionRow(acceptedSubmissionId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', lockedInvoiceId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', controlInvoiceId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', controlDeleteInvoiceId);
    }
  });
});
