import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-KSEF-INT-005: the KSeF credential-health endpoint is reachable and returns a health report.
 *
 * The Certificates / credential-health surface (per-org KSeF token + certificate status) is read
 * from GET /api/financial_pl/ksef/credential-health, gated by `financial_pl.view`. This asserts the
 * endpoint responds 200 with a JSON health object regardless of whether credentials are configured
 * (a fresh org reports "not configured" rather than erroring), and that it is auth-gated.
 *
 * `admin` holds `financial_pl.view`.
 */
test.describe('TC-KSEF-INT-005: KSeF credential-health endpoint', () => {
  test('returns a 200 health report for the org', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/credential-health', { token });
    if (res.status() === 403) {
      test.skip(true, 'admin lacks financial_pl.view on this DB (run yarn mercato auth sync-role-acls)');
    }
    expect(res.status(), 'credential-health responds 200').toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body, 'the response is a health object').toBeTruthy();
    expect(typeof body, 'health is a JSON object').toBe('object');
  });

  test('requires authentication', async ({ request }) => {
    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/credential-health', {});
    expect([401, 403], 'unauthenticated access is rejected').toContain(res.status());
  });
});
