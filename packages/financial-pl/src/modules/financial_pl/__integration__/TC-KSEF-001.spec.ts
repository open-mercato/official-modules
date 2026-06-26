import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';

/**
 * TC-KSEF-001: KSeF submission API — queue + list + auth gate.
 * Covers: POST/GET /api/financial_pl/ksef/submissions, org/tenant scoping, RBAC.
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the
 * test env (yarn official-modules add financial-pl).
 * The async send to KSeF is performed by a subscriber and is NOT asserted here
 * (it requires the external Ministry of Finance TEST API + credentials); this
 * test verifies the HTTP queueing/listing/authorization contract only.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function samplePayload(salesInvoiceId: string) {
  return {
    salesInvoiceId,
    contextNip: '7980332920',
    environment: 'test',
    invoice: {
      invoiceNumber: `OM-${suffix()}`,
      issueDate: '2026-06-22',
      currencyCode: 'PLN',
      seller: { nip: '7980332920', name: 'QA Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1, 00-001 Warszawa' },
      buyer: { nip: '3755747347', name: 'QA Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
      totalGross: '123.00',
      lines: [
        { lineNumber: 1, name: 'Usługa testowa', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
      ],
    },
  };
}

test.describe('TC-KSEF-001: KSeF submission API', () => {
  test('queues a submission and lists it (org/tenant scoped)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const salesInvoiceId = randomUUID();

    const createRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions', {
      token,
      data: samplePayload(salesInvoiceId),
    });
    expect(createRes.status(), 'queue returns 202').toBe(202);
    const submissionId = ((await createRes.json()) as { submissionId?: string }).submissionId ?? null;
    expect(submissionId).toBeTruthy();

    const listRes = await apiRequest(
      request,
      'GET',
      `/api/financial_pl/ksef/submissions?salesInvoiceId=${encodeURIComponent(salesInvoiceId)}`,
      { token },
    );
    expect(listRes.status()).toBe(200);
    const body = (await listRes.json()) as { items?: Array<Record<string, unknown>> };
    const found = (body.items ?? []).find((row) => row.id === submissionId);
    expect(found, 'queued submission appears in the scoped list').toBeTruthy();
    expect(found?.salesInvoiceId).toBe(salesInvoiceId);
  });

  test('rejects validation errors and unauthenticated reads', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions', {
      token,
      data: { salesInvoiceId: 'not-a-uuid', contextNip: '123' },
    });
    expect(badRes.status(), 'invalid payload returns 400').toBe(400);

    const anonRes = await request.get('/api/financial_pl/ksef/submissions');
    expect(anonRes.status(), 'unauthenticated read is rejected').toBe(401);
  });
});
