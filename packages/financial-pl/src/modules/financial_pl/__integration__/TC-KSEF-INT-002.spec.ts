import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/modules/core/__integration__/helpers/salesFixtures';
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures';

const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

type JsonRecord = Record<string, unknown>;

function invoicePayload() {
  return {
    invoiceNumber: `OM-INT002-${suffix()}`,
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
        name: 'Enricher contract line',
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
  ksefNumber: string;
}): Promise<string> {
  return withClient(async (client) => {
    const res = await client.query<{ id: string }>(
      `insert into financial_pl_ksef_submissions
         (id, organization_id, tenant_id, sales_invoice_id, document_kind, environment, mode,
          status, context_nip, attempt_count, ksef_number, created_at, accepted_at)
       values (gen_random_uuid(), $1, $2, $3, 'invoice', 'test', 'online',
          'accepted', '7980332920', 1, $4, now(), now())
       returning id`,
      [input.organizationId, input.tenantId, input.salesInvoiceId, input.ksefNumber],
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

function listItems(body: JsonRecord): JsonRecord[] {
  return Array.isArray(body.items) ? (body.items as JsonRecord[]) : [];
}

test.describe('TC-KSEF-INT-002: KSeF enricher contract on core invoice reads', () => {
  test('GET /api/sales/invoices carries _financial_pl KSeF fields for an invoice with a submission', async ({
    request,
  }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) {
      test.skip(true, 'token does not expose orgId/tenantId for the direct submission fixture');
    }

    let invoiceId: string | null = null;
    let submissionId: string | null = null;
    const ksefNumber = `1111111111-20260622-${suffix()}AAAA-BB`;

    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', {
        token,
        data: invoicePayload(),
      });
      if (createRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(createRes.status(), 'admin creates invoice fixture').toBe(201);
      const createBody = (await createRes.json()) as { invoiceId?: string; id?: string };
      invoiceId = createBody.invoiceId ?? createBody.id ?? null;
      expect(invoiceId, 'create returns invoice id').toBeTruthy();

      submissionId = await landAcceptedSubmission({
        organizationId,
        tenantId,
        salesInvoiceId: invoiceId as string,
        ksefNumber,
      });

      const readRes = await apiRequest(
        request,
        'GET',
        `/api/sales/invoices?id=${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      expect(readRes.status(), 'core invoice read succeeds').toBe(200);
      const readBody = (await readRes.json()) as JsonRecord;
      const row = listItems(readBody).find((item) => item.id === invoiceId);
      expect(row, 'created invoice is present in the core read').toBeTruthy();

      const financialPl = row?._financial_pl as JsonRecord | undefined;
      expect(financialPl, 'core invoice row is enriched under _financial_pl').toBeTruthy();
      expect(financialPl?.ksefStatus).toBe('accepted');
      expect(financialPl?.ksefNumber).toBe(ksefNumber);
      expect(financialPl?.submissionId).toBe(submissionId);
      expect(financialPl?.upoAvailable).toBe(true);
      expect(financialPl).toHaveProperty('offlineSendDeadlineAt');
      expect(financialPl).toHaveProperty('jpkVatMarking');
    } finally {
      await deleteSubmissionRow(submissionId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
