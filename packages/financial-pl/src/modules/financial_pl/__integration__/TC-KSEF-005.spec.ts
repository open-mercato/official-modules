import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';

/**
 * TC-KSEF-005: KSeF certificate management — auth + validation HTTP contract (SPEC-007).
 * Covers: GET  /api/financial_pl/ksef/certificates
 *         POST /api/financial_pl/ksef/certificates/enroll
 *         POST /api/financial_pl/ksef/certificates/revoke
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the
 * test env (yarn official-modules add financial-pl).
 *
 * Asserts the self-contained HTTP contract only (no live Ministry of Finance KSeF
 * API, no enrolled certificate): authentication and payload validation. The
 * enrollment runbook itself (auth -> CSR -> enroll -> poll -> retrieve, and the
 * 409 certificate_auth_required_for_enrollment / 422 certificate_enrollment_failed
 * outcomes) is proven by the unit tests (cert-enrollment.test.ts) and the env-gated
 * live cert-auth round-trip (ksef-live.test.ts).
 */
test.describe('TC-KSEF-005: KSeF certificate management API', () => {
  test('rejects an unauthenticated certificate list', async ({ request }) => {
    const anonRes = await request.get('/api/financial_pl/ksef/certificates');
    expect(anonRes.status(), 'unauthenticated certificate list is rejected').toBe(401);
  });

  test('rejects an unauthenticated certificate enrollment', async ({ request }) => {
    const anonRes = await request.post('/api/financial_pl/ksef/certificates/enroll', {
      data: { certificateName: 'OM Auth Cert' },
    });
    expect(anonRes.status(), 'unauthenticated enrollment is rejected').toBe(401);
  });

  test('rejects an invalid enrollment payload', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/certificates/enroll', {
      token,
      data: { certificateName: '' },
    });
    expect(badRes.status(), 'empty certificateName returns 400').toBe(400);
  });

  test('rejects an unauthenticated certificate revoke', async ({ request }) => {
    const anonRes = await request.post('/api/financial_pl/ksef/certificates/revoke', {
      data: { serialNumber: randomUUID() },
    });
    expect(anonRes.status(), 'unauthenticated revoke is rejected').toBe(401);
  });

  test('rejects a revoke with a missing serialNumber', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/certificates/revoke', {
      token,
      data: {},
    });
    expect(badRes.status(), 'missing serialNumber returns 400').toBe(400);
  });
});
