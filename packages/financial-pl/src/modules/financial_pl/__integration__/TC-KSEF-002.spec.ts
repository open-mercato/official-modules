import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';

/**
 * TC-KSEF-002: Send-from-invoice API — auth + validation + unknown-invoice contract.
 * Covers: POST /api/financial_pl/ksef/submissions/from-invoice.
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the
 * test env (yarn official-modules add financial-pl).
 *
 * This asserts the HTTP contract that is self-contained (no external Ministry of
 * Finance TEST API, no issued-invoice fixture chain): authentication, payload
 * validation, and the 404 for an unknown invoice. The FA(3) resolution itself
 * (real buyer from the linked order, the 422 missing-buyer guard, the 409
 * proforma/non-issued guards, and the annotation threading) is proven by the
 * resolver/serializer unit tests (resolve-fa3-from-invoice.test.ts, fa3.test.ts).
 */
test.describe('TC-KSEF-002: KSeF send-from-invoice API', () => {
  test('rejects an unauthenticated submission', async ({ request }) => {
    const anonRes = await request.post('/api/financial_pl/ksef/submissions/from-invoice', {
      data: { salesInvoiceId: randomUUID() },
    });
    expect(anonRes.status(), 'unauthenticated send is rejected').toBe(401);
  });

  test('rejects an invalid payload', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-invoice', {
      token,
      data: { salesInvoiceId: 'not-a-uuid' },
    });
    expect(badRes.status(), 'invalid salesInvoiceId returns 400').toBe(400);
  });

  test('returns 404 for an unknown invoice', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-invoice', {
      token,
      data: { salesInvoiceId: randomUUID() },
    });
    expect(res.status(), 'unknown invoice returns 404').toBe(404);
  });
});
