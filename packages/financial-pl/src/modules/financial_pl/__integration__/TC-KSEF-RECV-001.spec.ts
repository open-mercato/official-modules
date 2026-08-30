import { expect, test, type APIResponse } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';

/**
 * TC-KSEF-RECV-001: inbound KSeF receiving routes (SPEC-015).
 * Covers: GET/POST /api/financial_pl/ksef/received-invoices
 *         GET      /api/financial_pl/ksef/received-invoices/{ksefNumber}/xml
 *         POST     /api/financial_pl/ksef/received-invoices/{ksefNumber}/to-purchase-record
 *
 * These are API-contract tests only. They assert auth, zod validation, tenant-scoped list shape,
 * unknown-row handling, and that a valid sync request reaches the command without crashing. Live
 * KSeF metadata/XML calls remain covered by env-gated live tests.
 */
const RECEIVED_BASE = '/api/financial_pl/ksef/received-invoices';
const UNKNOWN_KSEF_NUMBER = 'UNKNOWN-KSEF-NR-001';

async function expectStructuredError(response: APIResponse, label: string) {
  const body = (await response.json()) as { error?: unknown; code?: unknown; details?: unknown };
  expect(body, label).toBeTruthy();
  expect(
    typeof body.error === 'string' || typeof body.code === 'string' || Array.isArray(body.details),
    label,
  ).toBe(true);
}

test.describe('TC-KSEF-RECV-001: inbound receiving routes', () => {
  test('rejects unauthenticated receiving requests (401)', async ({ request }) => {
    const list = await request.get(RECEIVED_BASE);
    expect(list.status(), 'unauthenticated received-invoices list is rejected').toBe(401);

    const sync = await request.post(RECEIVED_BASE, {
      data: { dateFrom: '2026-06-01', dateTo: '2026-06-02' },
    });
    expect(sync.status(), 'unauthenticated received-invoices sync is rejected').toBe(401);

    const xml = await request.get(`${RECEIVED_BASE}/${encodeURIComponent(UNKNOWN_KSEF_NUMBER)}/xml`);
    expect(xml.status(), 'unauthenticated received-invoice XML download is rejected').toBe(401);

    const materialize = await request.post(
      `${RECEIVED_BASE}/${encodeURIComponent(UNKNOWN_KSEF_NUMBER)}/to-purchase-record`,
      { data: {} },
    );
    expect(materialize.status(), 'unauthenticated materialization is rejected').toBe(401);
  });

  test('GET received-invoices returns a paged shape for financial_pl.view', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'GET', `${RECEIVED_BASE}?page=1&pageSize=10`, { token });
    if (res.status() === 403) test.skip(true, 'employee lacks financial_pl.view on this DB');
    expect(res.status(), 'financial_pl.view can list received invoices').toBe(200);

    const body = (await res.json()) as {
      items?: unknown;
      total?: unknown;
      page?: unknown;
      pageSize?: unknown;
    };
    expect(Array.isArray(body.items), 'list response carries an items array').toBe(true);
    expect(typeof body.total, 'list response carries a total number').toBe('number');
    expect(body.page, 'list response echoes the requested page').toBe(1);
    expect(body.pageSize, 'list response echoes the requested pageSize').toBe(10);
  });

  test('POST sync validates dates and returns a structured command result or error', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');

    const malformed = await apiRequest(request, 'POST', RECEIVED_BASE, {
      token,
      data: { dateFrom: 'not-a-date', dateTo: '2026-06-30' },
    });
    if (malformed.status() === 403) test.skip(true, 'admin lacks financial_pl.submit on this DB');
    expect([400, 422], 'malformed sync dates are rejected by zod').toContain(malformed.status());

    const valid = await apiRequest(request, 'POST', RECEIVED_BASE, {
      token,
      data: { dateFrom: '2026-06-01', dateTo: '2026-06-02' },
    });
    expect(valid.status(), 'valid sync body is authenticated').not.toBe(401);
    expect(valid.status(), 'valid sync body is past the financial_pl.submit gate').not.toBe(403);
    expect(valid.status(), 'valid sync body must not crash the route').not.toBe(500);

    if (valid.status() === 200) {
      const body = (await valid.json()) as { ok?: unknown; synced?: unknown };
      expect(body.ok, 'successful sync response carries ok:true').toBe(true);
      expect(typeof body.synced, 'successful sync response carries a synced count').toBe('number');
    } else {
      expect([409, 422, 502], 'valid sync may fail only with a structured credential/KSeF error').toContain(
        valid.status(),
      );
      await expectStructuredError(valid, 'non-2xx sync responses are structured JSON errors');
    }
  });

  test('GET unknown XML is 404 for financial_pl.view', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(
      request,
      'GET',
      `${RECEIVED_BASE}/${encodeURIComponent(UNKNOWN_KSEF_NUMBER)}/xml`,
      { token },
    );
    if (res.status() === 403) test.skip(true, 'employee lacks financial_pl.view on this DB');
    expect(res.status(), 'unknown received KSeF number is not found').toBe(404);
  });
});
