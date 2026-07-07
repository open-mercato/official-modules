import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-KSEF-UI-005: JPK + certificates backoffice route gating (SPEC-013).
 * Covers the gate matrix behind /backend/financial/jpk and /backend/financial/certificates:
 *   GET  /api/financial_pl/ksef/jpk/{filings,purchase-records}       → financial_pl.view
 *   POST /api/financial_pl/ksef/jpk/{filings,purchase-records,export} → financial_pl.manage
 *   GET  /api/financial_pl/ksef/certificates                         → financial_pl.manage
 *   POST /api/financial_pl/ksef/certificates/{enroll,revoke}         → financial_pl.manage
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the test env
 * (yarn official-modules add financial-pl). `admin` holds `financial_pl.*` (incl. .manage);
 * `employee` holds only `financial_pl.view` (see setup.ts) — the exact split this gate matrix
 * needs.
 *
 * This asserts the self-contained gate contract (401 unauthenticated; the view-vs-manage split
 * on each route) plus a happy-path JPK filing create→generate→export round-trip emitting
 * well-formed XML for an authorized caller. The XSD-exact JPK build and the certificate
 * enrollment runbook are proven by the unit suites (lib/jpk/__tests__/*, cert-enrollment.test.ts)
 * and the env-gated live cert round-trip (ksef-live.test.ts) — no live KSeF here.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function filingPayload() {
  return {
    variant: 'V7M',
    year: 2026,
    month: 11,
    celZlozenia: 1,
    correctionScope: 'both',
    kodUrzedu: '0202',
    contextNip: '7980332920',
  };
}

function purchasePayload() {
  return {
    year: 2026,
    month: 11,
    documentNumber: `FZ-UI5-${suffix()}`,
    purchaseDate: '2026-11-10',
    transactionClass: 'domestic',
    supplierNip: '3755747347',
    supplierName: 'QA Supplier',
    netOther: '1000.00',
    vatOther: '230.00',
  };
}

test.describe('TC-KSEF-UI-005: JPK + certificates route gating', () => {
  // ---------------- JPK: GET gated on financial_pl.view ----------------

  test('JPK GET reads are rejected when unauthenticated (401)', async ({ request }) => {
    const filings = await request.get('/api/financial_pl/ksef/jpk/filings');
    expect(filings.status(), 'unauthenticated filings read is rejected').toBe(401);
    const records = await request.get('/api/financial_pl/ksef/jpk/purchase-records');
    expect(records.status(), 'unauthenticated purchase-records read is rejected').toBe(401);
  });

  test('JPK GET reads succeed for a view-only (employee) token', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const filings = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk/filings', { token });
    expect(filings.status(), 'financial_pl.view can list filings').toBe(200);
    expect(Array.isArray(((await filings.json()) as { items?: unknown[] }).items)).toBe(true);

    const records = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk/purchase-records', { token });
    expect(records.status(), 'financial_pl.view can list purchase records').toBe(200);
    expect(Array.isArray(((await records.json()) as { items?: unknown[] }).items)).toBe(true);
  });

  // ---------------- JPK: writes gated on financial_pl.manage ----------------

  test('JPK writes WITHOUT financial_pl.manage are forbidden (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');

    const createFiling = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
      token,
      data: filingPayload(),
    });
    expect(createFiling.status(), 'employee (view-only) cannot create a filing').toBe(403);

    const createRecord = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/purchase-records', {
      token,
      data: purchasePayload(),
    });
    expect(createRecord.status(), 'employee (view-only) cannot create a purchase record').toBe(403);

    const generate = await apiRequest(request, 'POST', `/api/financial_pl/ksef/jpk/export?filingId=${randomUUID()}`, {
      token,
      data: {},
    });
    expect(generate.status(), 'employee (view-only) cannot generate a JPK export').toBe(403);
  });

  test('a financial_pl.manage holder can create → generate → export well-formed JPK XML', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    // Seed an in-period purchase row so the JPK has evidence to emit.
    const seedRecord = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/purchase-records', {
      token,
      data: purchasePayload(),
    });
    if (seedRecord.status() === 403) {
      test.skip(true, 'admin lacks financial_pl.manage on this DB (run yarn mercato auth sync-role-acls)');
    }
    expect(seedRecord.status(), 'admin creates a purchase record').toBe(200);

    const createRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
      token,
      data: filingPayload(),
    });
    expect(createRes.status(), 'admin creates a filing').toBe(200);
    const filingId = ((await createRes.json()) as { id?: string }).id ?? null;
    expect(filingId, 'create returns the filing id').toBeTruthy();

    const generateRes = await apiRequest(request, 'POST', `/api/financial_pl/ksef/jpk/export?filingId=${filingId}`, {
      token,
      data: {},
    });
    expect(generateRes.status(), 'generation succeeds').toBe(200);
    expect(((await generateRes.json()) as { ok?: boolean }).ok).toBe(true);

    const downloadRes = await apiRequest(request, 'GET', `/api/financial_pl/ksef/jpk/export?filingId=${filingId}`, {
      token,
    });
    expect(downloadRes.status(), 'download succeeds after generation').toBe(200);
    expect(downloadRes.headers()['content-type'] ?? '', 'the export is application/xml').toContain('application/xml');
    const xml = await downloadRes.text();
    expect(xml, 'the export is well-formed JPK XML (declaration + JPK root)').toContain('<?xml');
    expect(xml).toContain('JPK');
  });

  // ---------------- certificates: list/enroll/revoke gated on financial_pl.manage ----------------

  test('certificate routes are rejected when unauthenticated (401)', async ({ request }) => {
    const list = await request.get('/api/financial_pl/ksef/certificates');
    expect(list.status(), 'unauthenticated certificate list is rejected').toBe(401);
    const enroll = await request.post('/api/financial_pl/ksef/certificates/enroll', {
      data: { certificateName: 'OM Auth Cert' },
    });
    expect(enroll.status(), 'unauthenticated enrollment is rejected').toBe(401);
    const revoke = await request.post('/api/financial_pl/ksef/certificates/revoke', {
      data: { serialNumber: randomUUID() },
    });
    expect(revoke.status(), 'unauthenticated revoke is rejected').toBe(401);
  });

  test('certificate enroll/revoke WITHOUT financial_pl.manage are forbidden (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const enroll = await apiRequest(request, 'POST', '/api/financial_pl/ksef/certificates/enroll', {
      token,
      data: { certificateName: 'OM Auth Cert' },
    });
    expect(enroll.status(), 'employee (view-only) cannot enroll a certificate').toBe(403);

    const revoke = await apiRequest(request, 'POST', '/api/financial_pl/ksef/certificates/revoke', {
      token,
      data: { serialNumber: randomUUID() },
    });
    expect(revoke.status(), 'employee (view-only) cannot revoke a certificate').toBe(403);
  });

  test('a financial_pl.manage holder can list certificates (200)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/certificates', { token });
    if (res.status() === 403) {
      test.skip(true, 'admin lacks financial_pl.manage on this DB (run yarn mercato auth sync-role-acls)');
    }
    expect(res.status(), 'financial_pl.manage can list certificates').toBe(200);
  });
});
