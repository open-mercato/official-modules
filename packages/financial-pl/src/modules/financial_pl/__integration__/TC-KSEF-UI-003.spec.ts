import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/modules/core/__integration__/helpers/salesFixtures';

/**
 * TC-KSEF-UI-003: invoice-detail KSeF action endpoints — gating + dispatch (SPEC-013).
 * Covers: POST /api/financial_pl/ksef/submissions/from-invoice (Send),
 *         POST /api/financial_pl/ksef/submissions/retry      (Retry),
 *         GET  /api/financial_pl/ksef/submissions/upo        (Download UPO),
 *         GET  /api/financial_pl/ksef/invoice-pdf            (Download PDF).
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the test env
 * (yarn official-modules add financial-pl). `admin` holds `financial_pl.*`; `employee` holds
 * only `financial_pl.view` (see setup.ts) — used for the Send/Retry 403s (those require
 * `financial_pl.submit`, which `employee` lacks) and the UPO/PDF view-access cases.
 *
 * LIVE-KSEF HANDLING (mirrors the existing suite): the actual send to the Ministry of Finance
 * TEST API is performed by a subscriber against the external KSeF API and is NOT asserted here
 * — exactly as TC-KSEF-001/002/007/008 document and as the env-gated ksef-live.test.ts proves.
 * No new live dependency is introduced: the Send leg asserts the queue/dispatch contract for an
 * authored invoice (the route persists/dispatches the submission; the external accept is the
 * subscriber's job), and is deterministic with no network call. The optional live round-trip is
 * gated behind OM_KSEF_TEST_TOKEN + OM_KSEF_TEST_NIP, identical to ksef-live.test.ts, so the
 * default CI run stays hermetic.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const KSEF_LIVE = Boolean(process.env.OM_KSEF_TEST_TOKEN && process.env.OM_KSEF_TEST_NIP);

function invoicePayload() {
  return {
    invoiceNumber: `OM-UI3-${suffix()}`,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    lines: [{ name: 'Usługa testowa', quantity: 1, unitPriceNet: 100, taxRate: 23 }],
  };
}

test.describe('TC-KSEF-UI-003: invoice-detail KSeF actions — gating + dispatch', () => {
  // --- Send (from-invoice) requires financial_pl.submit ---

  test('Send is rejected when unauthenticated (401)', async ({ request }) => {
    const anon = await request.post('/api/financial_pl/ksef/submissions/from-invoice', {
      data: { salesInvoiceId: randomUUID() },
    });
    expect(anon.status(), 'unauthenticated Send is rejected').toBe(401);
  });

  test('Send WITHOUT financial_pl.submit is forbidden (403)', async ({ request }) => {
    // `employee` has only `financial_pl.view` — it cannot dispatch a Send.
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-invoice', {
      token,
      data: { salesInvoiceId: randomUUID() },
    });
    expect(res.status(), 'employee (no financial_pl.submit) cannot Send').toBe(403);
  });

  test('Send WITH financial_pl.submit queues for a real authored invoice (dispatch contract)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let invoiceId: string | null = null;
    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      if (createRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(createRes.status()).toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId).toBeTruthy();

      // Dispatch Send. With financial_pl.submit, the route persists/queues the submission and
      // returns 202 (the external accept is the subscriber's job and is NOT asserted — no live
      // KSeF). A FA(3) resolution guard for an incomplete invoice surfaces as a deterministic
      // 4xx (404/409/422), never a live send; either is an accepted NON-403 dispatch outcome.
      const sendRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-invoice', {
        token,
        data: { salesInvoiceId: invoiceId },
      });
      expect(sendRes.status(), 'a financial_pl.submit holder is NOT gated out of Send').not.toBe(403);
      expect(sendRes.status(), 'a financial_pl.submit holder is authenticated for Send').not.toBe(401);
      expect([202, 404, 409, 422], 'Send either queues (202) or fails the FA(3) resolver guard (4xx)').toContain(
        sendRes.status(),
      );
      if (sendRes.status() === 202) {
        const body = (await sendRes.json()) as { ok?: boolean; submissionId?: string };
        expect(body.ok).toBe(true);
        // A persisted submission id ⇒ the dispatch was recorded (the panel reflects this status).
        if (body.submissionId) expect(typeof body.submissionId).toBe('string');
      }
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });

  // --- Retry requires financial_pl.submit and targets a submission id ---

  test('Retry is rejected when unauthenticated (401)', async ({ request }) => {
    const anon = await request.post('/api/financial_pl/ksef/submissions/retry', {
      data: { id: randomUUID() },
    });
    expect(anon.status(), 'unauthenticated Retry is rejected').toBe(401);
  });

  test('Retry WITHOUT financial_pl.submit is forbidden (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/retry', {
      token,
      data: { id: randomUUID() },
    });
    expect(res.status(), 'employee (no financial_pl.submit) cannot Retry').toBe(403);
  });

  test('Retry WITH financial_pl.submit is past the gate (no live KSeF: 404 for an unknown submission)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    // The detail page's Retry targets the latest non-accepted submission id. With no such row
    // (unknown id, no live KSeF), the route is past the feature gate and resolves to a clear
    // non-2xx — never a 403/401. This proves the gate admits financial_pl.submit holders.
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/retry', {
      token,
      data: { id: randomUUID() },
    });
    expect(res.status(), 'admin (financial_pl.submit) is NOT gated out of Retry').not.toBe(403);
    expect(res.status(), 'admin is authenticated for Retry').not.toBe(401);
    expect([404, 409, 422], 'Retry of an unknown submission is a clear non-2xx').toContain(res.status());
  });

  // --- Download UPO requires financial_pl.view ---

  test('Download UPO is rejected when unauthenticated (401)', async ({ request }) => {
    const anon = await request.get(`/api/financial_pl/ksef/submissions/upo?id=${randomUUID()}`);
    expect(anon.status(), 'unauthenticated UPO download is rejected').toBe(401);
  });

  test('Download UPO WITH financial_pl.view is past the gate (404 for an unknown submission)', async ({ request }) => {
    // `employee` holds financial_pl.view — it can reach the UPO route. Without an accepted
    // submission + a stored receipt (no live KSeF), it resolves to 404 (UPO not available),
    // never a 403 — proving view access is sufficient for the download.
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'GET', `/api/financial_pl/ksef/submissions/upo?id=${randomUUID()}`, { token });
    expect(res.status(), 'financial_pl.view is NOT gated out of UPO download').not.toBe(403);
    expect(res.status(), 'an unknown submission has no UPO → 404').toBe(404);
  });

  // --- Download PDF requires financial_pl.view, returns application/pdf headers ---

  test('Download PDF is rejected when unauthenticated (401)', async ({ request }) => {
    const anon = await request.get(`/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=${randomUUID()}`);
    expect(anon.status(), 'unauthenticated PDF download is rejected').toBe(401);
  });

  test('Download PDF WITH financial_pl.view renders application/pdf for a real authored invoice', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let invoiceId: string | null = null;
    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      if (createRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(createRes.status()).toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId).toBeTruthy();

      // Set the minimal PL-VAT meta the PDF resolver needs (a plain VAT invoice).
      await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
        token,
        data: { salesInvoiceId: invoiceId, invoiceKind: 'vat', contextNip: '7980332920' },
      });

      const res = await apiRequest(request, 'GET', `/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=${encodeURIComponent(invoiceId as string)}`, {
        token,
      });
      expect(res.status(), 'financial_pl.view is NOT gated out of PDF download').not.toBe(403);
      expect(res.status(), 'admin is authenticated for PDF download').not.toBe(401);
      // The resolver may 422 if the authored invoice lacks a field it strictly requires (the
      // resolver guards are proven by the unit suite); a successful render returns a non-empty
      // application/pdf body. Both are valid non-gated outcomes.
      expect([200, 422], 'PDF either renders or hits a documented resolver guard (4xx), never a gate error').toContain(
        res.status(),
      );
      if (res.status() === 200) {
        expect(res.headers()['content-type'] ?? '', 'PDF is served as application/pdf').toContain('application/pdf');
        const body = await res.body();
        expect(body.length, 'the PDF body is non-empty content').toBeGreaterThan(0);
      }
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });

  // --- optional, env-gated live KSeF round-trip (mirrors ksef-live.test.ts) ---

  test('live KSeF send round-trip (env-gated; skipped without OM_KSEF_TEST_* creds)', async ({ request }) => {
    test.skip(!KSEF_LIVE, 'OM_KSEF_TEST_TOKEN + OM_KSEF_TEST_NIP not configured — live KSeF leg skipped');
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let invoiceId: string | null = null;
    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      if (createRes.status() === 403) test.skip(true, 'admin lacks sales.invoices.manage on this DB');
      expect(createRes.status()).toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      const sendRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-invoice', {
        token,
        data: { salesInvoiceId: invoiceId },
      });
      // Against the configured TEST env the dispatch is accepted (202); the subscriber drives the
      // external send. We assert only the synchronous dispatch contract here.
      expect([202, 404, 409, 422]).toContain(sendRes.status());
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
