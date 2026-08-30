import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/helpers/integration/salesFixtures';

const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

type DetailBody = {
  invoice?: Record<string, unknown>;
  lines?: Array<Record<string, unknown>>;
};

function invoicePayload() {
  return {
    invoiceNumber: `OM-INT004-${suffix()}`,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    dueDate: '2026-07-22',
    subtotalNetAmount: 180,
    subtotalGrossAmount: 221.4,
    discountTotalAmount: 20,
    taxTotalAmount: 41.4,
    grandTotalNetAmount: 180,
    grandTotalGrossAmount: 221.4,
    paidTotalAmount: 0,
    outstandingAmount: 221.4,
    metadata: { boundary: 'initial' },
    lines: [
      {
        name: 'Read-only edit boundary line',
        quantity: 2,
        unitPriceNet: 100,
        unitPriceGross: 123,
        discountPercent: 10,
        discountAmount: 20,
        taxRate: 23,
        taxAmount: 41.4,
        totalNetAmount: 180,
        totalGrossAmount: 221.4,
        currencyCode: 'PLN',
      },
    ],
  };
}

async function readDetail(
  request: Parameters<typeof apiRequest>[0],
  token: string,
  invoiceId: string,
): Promise<DetailBody> {
  const detailRes = await apiRequest(
    request,
    'GET',
    `/api/financial_pl/ksef/invoices/${encodeURIComponent(invoiceId)}`,
    { token },
  );
  expect(detailRes.status(), 'module invoice detail read succeeds').toBe(200);
  return (await detailRes.json()) as DetailBody;
}

test.describe('TC-KSEF-INT-004: invoice edit save does not rewrite lines', () => {
  test('header-only core PUT keeps persisted lines unchanged', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let invoiceId: string | null = null;

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

      const before = await readDetail(request, token, invoiceId as string);
      expect(before.lines?.length, 'fixture has one persisted line').toBe(1);
      const beforeLines = JSON.stringify(before.lines);

      const headerOnlyPayload = {
        id: invoiceId,
        dueDate: '2026-08-22',
        metadata: { boundary: 'edited-without-lines' },
      };
      expect(headerOnlyPayload, 'edit-save payload documents the no-lines contract').not.toHaveProperty('lines');

      const updateRes = await apiRequest(request, 'PUT', '/api/sales/invoices', {
        token,
        data: headerOnlyPayload,
      });
      expect(updateRes.status(), 'header-only core PUT is accepted').toBe(200);

      const after = await readDetail(request, token, invoiceId as string);
      expect(JSON.stringify(after.lines), 'invoice lines are unchanged after header-only edit save').toBe(beforeLines);
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
