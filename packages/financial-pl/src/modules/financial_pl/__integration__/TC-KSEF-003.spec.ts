import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-KSEF-003: Send-correction-from-credit-memo + JPK markings — auth + validation
 * + unknown-document contract.
 * Covers: POST /api/financial_pl/ksef/submissions/from-credit-memo and
 *         GET  /api/financial_pl/ksef/jpk-markings.
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the
 * test env (yarn official-modules add financial-pl).
 *
 * Asserts the self-contained HTTP contract (no external Ministry of Finance TEST
 * API, no issued-correction fixture chain): authentication, payload validation,
 * the 404 for an unknown credit memo, and the JPK-markings query guards. The
 * correction FA(3) resolution itself (negated amounts, NrKSeF/NrKSeFN reference,
 * required reason, original-not-accepted rejection) is proven by the unit tests
 * (resolve-fa3-from-credit-memo.test.ts, fa3.correction.test.ts).
 */
test.describe('TC-KSEF-003: KSeF correction + JPK markings API', () => {
  test('rejects an unauthenticated correction submission', async ({ request }) => {
    const anonRes = await request.post('/api/financial_pl/ksef/submissions/from-credit-memo', {
      data: { creditMemoId: randomUUID() },
    });
    expect(anonRes.status(), 'unauthenticated correction send is rejected').toBe(401);
  });

  test('rejects an invalid correction payload', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-credit-memo', {
      token,
      data: { creditMemoId: 'not-a-uuid' },
    });
    expect(badRes.status(), 'invalid creditMemoId returns 400').toBe(400);
  });

  test('returns 404 for an unknown credit memo', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-credit-memo', {
      token,
      data: { creditMemoId: randomUUID() },
    });
    expect(res.status(), 'unknown credit memo returns 404').toBe(404);
  });

  test('rejects an unauthenticated jpk-markings read', async ({ request }) => {
    const anonRes = await request.get(`/api/financial_pl/ksef/jpk-markings?salesInvoiceId=${randomUUID()}`);
    expect(anonRes.status(), 'unauthenticated jpk-markings read is rejected').toBe(401);
  });

  test('rejects a jpk-markings read with no ids', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk-markings', { token });
    expect(res.status(), 'missing salesInvoiceId returns 400').toBe(400);
  });

  test('returns markings for known ids (pending for invoices never sent)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const id = randomUUID();
    const res = await apiRequest(request, 'GET', `/api/financial_pl/ksef/jpk-markings?salesInvoiceId=${id}`, { token });
    expect(res.status(), 'authenticated jpk-markings read succeeds').toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    // An invoice with no submission and no outside-KSeF flag is undetermined (pending), never BFK.
    expect(body.items[0]).toMatchObject({ salesInvoiceId: id, marking: null, pending: true });
  });
});
