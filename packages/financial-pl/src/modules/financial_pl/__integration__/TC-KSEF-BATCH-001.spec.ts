import { expect, test, type APIResponse } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/helpers/integration/salesFixtures';

/**
 * TC-KSEF-BATCH-001: KSeF batch send route contract (SPEC-015).
 * Covers: POST /api/financial_pl/ksef/submissions/batch.
 *
 * This does not assert a live KSeF batch upload. It verifies auth, the financial_pl.submit gate,
 * zod min(1) validation, and that a valid body referencing authored invoices reaches the command
 * and returns either the queued result or a structured credential/resolver/KSeF error without 500.
 */
const BATCH_ROUTE = '/api/financial_pl/ksef/submissions/batch';
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const BUYER = {
  companyName: 'Nabywca Batch Sp. z o.o.',
  nip: '5252344078',
  addressLine1: 'Ul. Batch 1',
  postalCode: '00-001',
  city: 'Warszawa',
  countryCode: 'PL',
};

function invoicePayload(index: number) {
  return {
    invoiceNumber: `OM-BATCH-${index}-${suffix()}`,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    metadata: { buyerSnapshot: { ...BUYER } },
    lines: [{ name: `Usluga batch ${index}`, quantity: 1, unitPriceNet: 100, taxRate: 23, currencyCode: 'PLN' }],
  };
}

async function expectStructuredError(response: APIResponse, label: string) {
  const body = (await response.json()) as { error?: unknown; code?: unknown; details?: unknown };
  expect(body, label).toBeTruthy();
  expect(
    typeof body.error === 'string' || typeof body.code === 'string' || Array.isArray(body.details),
    label,
  ).toBe(true);
}

test.describe('TC-KSEF-BATCH-001: batch send route', () => {
  test('rejects unauthenticated batch sends (401)', async ({ request }) => {
    const anon = await request.post(BATCH_ROUTE, { data: { invoiceIds: [] } });
    expect(anon.status(), 'unauthenticated batch send is rejected').toBe(401);
  });

  test('forbids a caller without financial_pl.submit (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', BATCH_ROUTE, {
      token,
      data: { invoiceIds: [] },
    });
    expect(res.status(), 'employee (financial_pl.view only) cannot send a batch').toBe(403);
  });

  test('rejects an empty invoiceIds array', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'POST', BATCH_ROUTE, {
      token,
      data: { invoiceIds: [] },
    });
    if (res.status() === 403) test.skip(true, 'admin lacks financial_pl.submit on this DB');
    expect([400, 422], 'empty invoiceIds violates zod min(1)').toContain(res.status());
  });

  test('valid authored invoice ids reach the command and never crash', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const invoiceIds: string[] = [];

    try {
      for (const index of [1, 2]) {
        const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', {
          token,
          data: invoicePayload(index),
        });
        if (createRes.status() === 403) {
          test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
        }
        expect(createRes.status(), 'admin can author an invoice for batch submission').toBe(201);
        const invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
        expect(invoiceId, 'create returns the invoice id').toBeTruthy();
        invoiceIds.push(invoiceId as string);
      }

      const res = await apiRequest(request, 'POST', BATCH_ROUTE, {
        token,
        data: { invoiceIds },
      });
      if (res.status() === 403) test.skip(true, 'admin lacks financial_pl.submit on this DB');
      expect(res.status(), 'valid batch body is authenticated').not.toBe(401);
      expect(res.status(), 'valid batch body passes zod validation').not.toBe(400);
      expect(res.status(), 'valid batch body must not crash the route').not.toBe(500);

      if (res.status() === 202) {
        const body = (await res.json()) as { ok?: unknown; batchReference?: unknown; count?: unknown };
        expect(body.ok, 'successful batch response carries ok:true').toBe(true);
        expect(typeof body.count, 'successful batch response carries a count').toBe('number');
        if (body.batchReference) expect(typeof body.batchReference).toBe('string');
      } else {
        expect([404, 409, 422, 502], 'command failures are structured non-2xx responses').toContain(res.status());
        await expectStructuredError(res, 'non-2xx batch responses are structured JSON errors');
      }
    } finally {
      for (const invoiceId of invoiceIds) {
        await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
      }
    }
  });
});
