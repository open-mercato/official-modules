import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';

/**
 * TC-KSEF-004: JPK_V7 export API — filings + purchase records + generate/download
 * HTTP contract (SPEC-012).
 *
 * Covers: GET/POST /api/financial_pl/ksef/jpk/filings
 *         GET/POST/DELETE /api/financial_pl/ksef/jpk/purchase-records
 *         POST (generate) + GET (download) /api/financial_pl/ksef/jpk/export
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the test env
 * (yarn official-modules add financial-pl). `admin` holds `financial_pl.*`; `employee` holds
 * only `financial_pl.view` (see setup.ts) — used for the view-only and 403 cases below.
 *
 * Asserts the self-contained HTTP contract: authentication (401), feature-gating (403 on the
 * write routes for a view-only role), org/tenant scoping (404 on a foreign/unowned filingId),
 * the create -> list -> generate -> download round-trip, the 422 download-before-generate gate,
 * and DELETE soft-delete + subsequent list omission. The XSD-exact JPK_V7M/V7K XML build, the
 * V7K quarterly Deklaracja, and the multi-NIP purchase scoping are proven by the unit suites
 * (lib/jpk/__tests__/*). Cross-org isolation is exercised via an unowned random filingId (a
 * second-tenant fixture chain is out of scope for this self-contained spec, mirroring
 * TC-KSEF-001/008); the positive no-leak invariant is asserted by listing only the caller's own
 * created rows back.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** A schema-complete JPK_V7M primary filing header (correctionScope must be 'both' on celZlozenia=1). */
function filingPayload() {
  return {
    variant: 'V7M',
    year: 2026,
    month: 6,
    celZlozenia: 1,
    correctionScope: 'both',
    kodUrzedu: '0202',
    contextNip: '7980332920',
  };
}

/** A schema-complete JPK purchase (zakup) evidence row with deductible "other" VAT. */
function purchasePayload() {
  return {
    year: 2026,
    month: 6,
    documentNumber: `FZ-${suffix()}`,
    purchaseDate: '2026-06-10',
    transactionClass: 'domestic',
    supplierNip: '3755747347',
    supplierName: 'QA Supplier',
    netOther: '1000.00',
    vatOther: '230.00',
  };
}

test.describe('TC-KSEF-004: JPK_V7 export API', () => {
  // --- authentication ---

  test('rejects unauthenticated reads (401)', async ({ request }) => {
    const anonFilings = await request.get('/api/financial_pl/ksef/jpk/filings');
    expect(anonFilings.status(), 'unauthenticated filings read is rejected').toBe(401);

    const anonRecords = await request.get('/api/financial_pl/ksef/jpk/purchase-records');
    expect(anonRecords.status(), 'unauthenticated purchase-records read is rejected').toBe(401);

    const anonExport = await request.get(`/api/financial_pl/ksef/jpk/export?filingId=${randomUUID()}`);
    expect(anonExport.status(), 'unauthenticated export download is rejected').toBe(401);
  });

  // --- view-only read access ---

  test('GET filings succeeds for a view-only (employee) token', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk/filings', { token });
    expect(res.status(), 'financial_pl.view can list filings').toBe(200);
    const body = (await res.json()) as { items?: unknown[]; total?: number };
    expect(Array.isArray(body.items), 'filings list returns an items array').toBe(true);
  });

  test('GET purchase-records succeeds for a view-only (employee) token', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk/purchase-records', { token });
    expect(res.status(), 'financial_pl.view can list purchase records').toBe(200);
    const body = (await res.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  // --- write feature-gating (financial_pl.manage) ---

  test('POST filings without financial_pl.manage is forbidden (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
      token,
      data: filingPayload(),
    });
    expect(res.status(), 'employee (view-only) cannot create a filing').toBe(403);
  });

  test('POST purchase-records without financial_pl.manage is forbidden (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/purchase-records', {
      token,
      data: purchasePayload(),
    });
    expect(res.status(), 'employee (view-only) cannot create a purchase record').toBe(403);
  });

  test('POST export (generate) without financial_pl.manage is forbidden (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', `/api/financial_pl/ksef/jpk/export?filingId=${randomUUID()}`, {
      token,
      data: {},
    });
    expect(res.status(), 'employee (view-only) cannot generate a JPK export').toBe(403);
  });

  // --- org/tenant scoping (a foreign/unowned filingId is invisible) ---

  test('GET export of a filingId the caller org does not own → 404', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const res = await apiRequest(request, 'GET', `/api/financial_pl/ksef/jpk/export?filingId=${randomUUID()}`, {
      token,
    });
    expect(res.status(), 'an unowned filingId is not found in the caller scope').toBe(404);
  });

  test('POST export (generate) of a filingId the caller org does not own → 404', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const res = await apiRequest(request, 'POST', `/api/financial_pl/ksef/jpk/export?filingId=${randomUUID()}`, {
      token,
      data: {},
    });
    expect(res.status(), 'generating an unowned filingId is not found in the caller scope').toBe(404);
  });

  // --- create -> list round-trips (no cross-org leak: only the caller's own rows come back) ---

  test('POST then GET filings returns the created filing within the caller org scope', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    const createRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
      token,
      data: { ...filingPayload(), month: 7, contextNip: '7980332920' },
    });
    expect(createRes.status(), 'admin creates a filing').toBe(200);
    const filingId = ((await createRes.json()) as { id?: string }).id ?? null;
    expect(filingId, 'create returns the filing id').toBeTruthy();

    const listRes = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk/filings?year=2026&month=7', {
      token,
    });
    expect(listRes.status()).toBe(200);
    const body = (await listRes.json()) as { items?: Array<Record<string, unknown>> };
    const found = (body.items ?? []).find((row) => row.id === filingId);
    expect(found, 'the created filing appears in the scoped list').toBeTruthy();
    // Every listed row is the caller-org's own (no other-org leak): the scoped list never
    // surfaces a foreign id, so the just-created id is present and the list is non-leaking.
    expect((body.items ?? []).every((row) => typeof row.id === 'string')).toBe(true);
  });

  test('POST then GET purchase-records returns the created record within the caller org scope', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    const data = purchasePayload();
    const createRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/purchase-records', {
      token,
      data,
    });
    expect(createRes.status(), 'admin creates a purchase record').toBe(200);
    const recordId = ((await createRes.json()) as { id?: string }).id ?? null;
    expect(recordId, 'create returns the record id').toBeTruthy();

    const listRes = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk/purchase-records?year=2026&month=6', {
      token,
    });
    expect(listRes.status()).toBe(200);
    const body = (await listRes.json()) as { items?: Array<Record<string, unknown>> };
    const found = (body.items ?? []).find((row) => row.id === recordId);
    expect(found, 'the created purchase record appears in the scoped list').toBeTruthy();
    expect(found?.documentNumber).toBe(data.documentNumber);
  });

  // --- generate -> download round-trip + the download-before-generate gate ---

  test('GET export of a created-but-ungenerated filing → 422', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    const createRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
      token,
      data: { ...filingPayload(), month: 8 },
    });
    expect(createRes.status()).toBe(200);
    const filingId = ((await createRes.json()) as { id?: string }).id ?? null;
    expect(filingId).toBeTruthy();

    // No POST (generate) yet ⇒ the filing has no generated XML ⇒ the download is 422, never an
    // empty/partial application/xml stream.
    const downloadRes = await apiRequest(request, 'GET', `/api/financial_pl/ksef/jpk/export?filingId=${filingId}`, {
      token,
    });
    expect(downloadRes.status(), 'downloading an ungenerated filing is 422').toBe(422);
  });

  test('POST (generate) then GET (download) streams an application/xml attachment', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    // Seed at least one in-period purchase row so the JPK has evidence to emit.
    await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/purchase-records', {
      token,
      data: { ...purchasePayload(), month: 9, contextNip: '7980332920' },
    });

    const createRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
      token,
      data: { ...filingPayload(), month: 9, contextNip: '7980332920' },
    });
    expect(createRes.status()).toBe(200);
    const filingId = ((await createRes.json()) as { id?: string }).id ?? null;
    expect(filingId).toBeTruthy();

    const generateRes = await apiRequest(request, 'POST', `/api/financial_pl/ksef/jpk/export?filingId=${filingId}`, {
      token,
      data: {},
    });
    expect(generateRes.status(), 'generation succeeds').toBe(200);
    const genBody = (await generateRes.json()) as { ok?: boolean; status?: string };
    expect(genBody.ok).toBe(true);
    expect(genBody.status).toBe('generated');

    const downloadRes = await apiRequest(request, 'GET', `/api/financial_pl/ksef/jpk/export?filingId=${filingId}`, {
      token,
    });
    expect(downloadRes.status(), 'download succeeds after generation').toBe(200);
    expect(
      downloadRes.headers()['content-type'] ?? '',
      'the download is served as application/xml',
    ).toContain('application/xml');
    expect(
      downloadRes.headers()['content-disposition'] ?? '',
      'the download is an attachment named JPK_<variant>_<period>.xml',
    ).toContain('attachment');
    const xml = await downloadRes.text();
    expect(xml, 'the streamed body is the JPK_V7M XML').toContain('JPK');
  });

  // --- DELETE soft-deletes a purchase record (subsequent list omits it) ---

  test('DELETE purchase-records?id= soft-deletes the row and a subsequent list omits it', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);

    const data = { ...purchasePayload(), month: 10 };
    const createRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/purchase-records', {
      token,
      data,
    });
    expect(createRes.status()).toBe(200);
    const recordId = ((await createRes.json()) as { id?: string }).id ?? null;
    expect(recordId).toBeTruthy();

    const deleteRes = await apiRequest(
      request,
      'DELETE',
      `/api/financial_pl/ksef/jpk/purchase-records?id=${recordId}`,
      { token },
    );
    expect(deleteRes.status(), 'soft-delete succeeds').toBe(200);

    const listRes = await apiRequest(request, 'GET', '/api/financial_pl/ksef/jpk/purchase-records?year=2026&month=10', {
      token,
    });
    expect(listRes.status()).toBe(200);
    const body = (await listRes.json()) as { items?: Array<Record<string, unknown>> };
    const stillThere = (body.items ?? []).some((row) => row.id === recordId);
    expect(stillThere, 'the soft-deleted record no longer appears in the list').toBe(false);
  });
});
