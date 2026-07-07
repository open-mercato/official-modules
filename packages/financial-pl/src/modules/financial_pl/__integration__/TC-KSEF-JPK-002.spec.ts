import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-KSEF-JPK-002: JPK submit route contract (SPEC-015).
 * Covers: POST /api/financial_pl/ksef/jpk/submit.
 *
 * This is not a live MF JPK gateway test. It asserts the route-level auth, feature gate, zod body
 * validation, and structured not-found/not-ready behavior for an unowned filing id. Live gateway
 * submission is env-gated in the dedicated JPK/KSeF live suites.
 */
const JPK_SUBMIT = '/api/financial_pl/ksef/jpk/submit';

async function expectStructuredError(response: APIResponse, label: string) {
  const body = (await response.json()) as { error?: unknown; code?: unknown; details?: unknown };
  expect(body, label).toBeTruthy();
  expect(
    typeof body.error === 'string' || typeof body.code === 'string' || Array.isArray(body.details),
    label,
  ).toBe(true);
}

test.describe('TC-KSEF-JPK-002: JPK submit route', () => {
  test('rejects unauthenticated submissions (401)', async ({ request }) => {
    const anon = await request.post(JPK_SUBMIT, { data: { filingId: randomUUID() } });
    expect(anon.status(), 'unauthenticated JPK submit is rejected').toBe(401);
  });

  test('forbids a caller without financial_pl.submit (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', JPK_SUBMIT, {
      token,
      data: { filingId: randomUUID() },
    });
    expect(res.status(), 'employee (financial_pl.view only) cannot submit JPK').toBe(403);
  });

  test('rejects missing and malformed filingId values', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');

    const missing = await apiRequest(request, 'POST', JPK_SUBMIT, { token, data: {} });
    if (missing.status() === 403) test.skip(true, 'admin lacks financial_pl.submit on this DB');
    expect([400, 422], 'missing filingId is rejected by zod').toContain(missing.status());

    const malformed = await apiRequest(request, 'POST', JPK_SUBMIT, {
      token,
      data: { filingId: 'not-a-uuid' },
    });
    expect([400, 422], 'non-uuid filingId is rejected by zod').toContain(malformed.status());
  });

  test('returns a structured 404/422 for a non-existent filing, never a 500', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    const res = await apiRequest(request, 'POST', JPK_SUBMIT, {
      token,
      data: { filingId: randomUUID() },
    });
    if (res.status() === 403) test.skip(true, 'admin lacks financial_pl.submit on this DB');
    expect(res.status(), 'admin is authenticated for JPK submit').not.toBe(401);
    expect(res.status(), 'JPK submit must not crash for an unknown filing').not.toBe(500);
    expect([404, 422], 'unknown or not-ready filing resolves to a structured 404/422').toContain(res.status());
    await expectStructuredError(res, 'non-existent filing submit response is structured');
  });
});
