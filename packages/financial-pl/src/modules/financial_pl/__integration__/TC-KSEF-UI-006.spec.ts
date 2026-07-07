import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { deleteSalesEntityIfExists } from '@open-mercato/core/helpers/integration/salesFixtures';

/**
 * TC-KSEF-UI-006: commercial-grade editor — NIP company-lookup route + buyer (Nabywca) capture on
 * the core invoice `metadata.buyerSnapshot` (SPEC-014).
 *
 * Covers:
 *   GET /api/financial_pl/ksef/company-lookup — auth gate (401), NIP-checksum validation (400),
 *     and a well-formed fail-open 200 `{ ok }` for a valid (but fictional) NIP (the route never
 *     depends on the external MF register being reachable);
 *   POST/GET round-trip of the buyer snapshot the FA(3) resolver `buildBuyer` reads — author an
 *     invoice carrying `metadata.buyerSnapshot` over the core API, then assert the module's own
 *     detail route returns that snapshot for the editor/detail prefill.
 *
 * Requires the @open-mercato/financial-pl module activated; `admin` holds `financial_pl.*` + core
 * `sales.invoices.manage`. API-level (matches the suite style); the client-side pickers / inline
 * validation are covered by unit tests + the live sandbox preview pass.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// Valid-checksum, fictional NIP (the KSeF TEST taxpayer) — not in the real MF register.
const VALID_NIP = '2481632647';
const BAD_NIP = '1234567890'; // valid shape, invalid checksum

const BUYER = {
  companyName: 'Nabywca Sp. z o.o.',
  nip: '5252344078',
  addressLine1: 'Ul. Testowa 1',
  postalCode: '00-001',
  city: 'Warszawa',
  countryCode: 'PL',
};

function invoiceWithBuyer() {
  return {
    invoiceNumber: `OM-UI6-${suffix()}`,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    metadata: { buyerSnapshot: { ...BUYER } },
    lines: [{ name: 'Usługa A', quantity: 2, unitPriceNet: 50, taxRate: 23, currencyCode: 'PLN' }],
  };
}

test.describe('TC-KSEF-UI-006: NIP company-lookup + buyer capture on metadata', () => {
  test('company-lookup route enforces auth + NIP checksum and fails open', async ({ request }) => {
    // 401 — unauthenticated.
    const anon = await request.get(`/api/financial_pl/ksef/company-lookup?nip=${VALID_NIP}`);
    expect(anon.status(), 'unauthenticated lookup is rejected').toBe(401);

    const token = await getAuthToken(request, 'admin');

    // 400 — invalid NIP checksum (never reaches the external register).
    const bad = await apiRequest(request, 'GET', `/api/financial_pl/ksef/company-lookup?nip=${BAD_NIP}`, { token });
    if (bad.status() === 403) test.skip(true, 'admin lacks financial_pl.view on this DB');
    expect(bad.status(), 'a bad-checksum NIP is rejected with 400').toBe(400);

    // 400 — missing NIP.
    const missing = await apiRequest(request, 'GET', '/api/financial_pl/ksef/company-lookup', { token });
    expect(missing.status(), 'a missing NIP is rejected with 400').toBe(400);

    // 200 — valid-checksum NIP returns a well-formed { ok } regardless of MF reachability (fail-open).
    const ok = await apiRequest(request, 'GET', `/api/financial_pl/ksef/company-lookup?nip=${VALID_NIP}`, { token });
    expect(ok.status(), 'a valid-checksum NIP returns 200 (found / not-found / unavailable)').toBe(200);
    const body = (await ok.json()) as { ok?: unknown; company?: unknown; reason?: unknown };
    expect(typeof body.ok, 'the response carries an ok boolean').toBe('boolean');
    if (body.ok === true) {
      expect(body.company, 'an ok:true response carries a company').toBeTruthy();
      expect((body.company as Record<string, unknown>).accountNumbers, 'bank accounts are not exposed').toBeUndefined();
    } else {
      expect(['not_found', 'unavailable']).toContain(body.reason);
    }
  });

  test('authors an invoice carrying a buyer snapshot and reads it back for prefill', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    let invoiceId: string | null = null;
    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoiceWithBuyer() });
      if (createRes.status() === 403) test.skip(true, 'admin lacks sales.invoices.manage on this DB');
      expect(createRes.status(), 'author a core invoice with a buyer snapshot').toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId, 'create returns the invoice id').toBeTruthy();

      // The module's own detail route returns the core invoice metadata for editor/detail prefill.
      const detailRes = await apiRequest(
        request,
        'GET',
        `/api/financial_pl/ksef/invoices/${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      expect(detailRes.status(), 'detail/edit-prefill read succeeds').toBe(200);
      const detail = (await detailRes.json()) as { invoice?: { metadata?: { buyerSnapshot?: Record<string, unknown> } } };
      const snapshot = detail.invoice?.metadata?.buyerSnapshot;
      expect(snapshot, 'the buyer snapshot round-trips through metadata').toBeTruthy();
      expect(snapshot?.companyName).toBe(BUYER.companyName);
      expect(snapshot?.nip).toBe(BUYER.nip);
      expect(snapshot?.addressLine1).toBe(BUYER.addressLine1);
      expect(snapshot?.city).toBe(BUYER.city);
      expect(snapshot?.postalCode).toBe(BUYER.postalCode);
      expect(snapshot?.countryCode).toBe(BUYER.countryCode);
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
