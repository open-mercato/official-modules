import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';

/**
 * TC-KSEF-006: Invoice PDF visualization (SPEC-008) — auth + validation + unknown-
 * invoice contract.
 * Covers: GET /api/financial_pl/ksef/invoice-pdf.
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the
 * test env (yarn official-modules add financial-pl).
 *
 * Asserts the self-contained HTTP contract (no live KSeF, no issued-invoice fixture
 * chain, no asserting the rendered PDF bytes): authentication, the salesInvoiceId
 * validation guards, and the 404 for an unknown invoice. The PDF rendering itself
 * (FA(3) → display model mapping, KOD I hash/URL, font + QR embedding) is proven by
 * the unit tests (invoice-pdf-model.test.ts, ksef-qr.test.ts, invoice-pdf.test.ts).
 *
 * FUTURE: a multi-submission scenario — issue an invoice, send + accept it, then
 * record a LATER rejected re-submission, and assert the PDF still sources the KSeF
 * number/hash/status from the accepted submission (a later rejected re-submission
 * must NOT mask an accepted one, which would wrongly render OFFLINE and hash
 * unregistered bytes). Needs an accepted-submission fixture + a PDF/QR decoder.
 */
test.describe('TC-KSEF-006: KSeF invoice PDF API', () => {
  test('rejects an unauthenticated invoice-pdf download', async ({ request }) => {
    const anonRes = await request.get(`/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=${randomUUID()}`);
    expect(anonRes.status(), 'unauthenticated invoice-pdf download is rejected').toBe(401);
  });

  test('rejects an invoice-pdf download with no salesInvoiceId', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/invoice-pdf', { token });
    expect(res.status(), 'missing salesInvoiceId returns 400').toBe(400);
  });

  test('rejects an invoice-pdf download with an invalid salesInvoiceId', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'GET', '/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=not-a-uuid', {
      token,
    });
    expect(res.status(), 'invalid salesInvoiceId returns 400').toBe(400);
  });

  test('returns 404 for an unknown invoice', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const res = await apiRequest(request, 'GET', `/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=${randomUUID()}`, {
      token,
    });
    expect(res.status(), 'unknown invoice returns 404').toBe(404);
  });
});
