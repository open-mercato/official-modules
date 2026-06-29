import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/modules/core/__integration__/helpers/salesFixtures';

/**
 * TC-KSEF-UI-004: correction (KOR) authoring — credit memo create → send-from-credit-memo
 * (SPEC-013).
 * Covers: POST /api/sales/credit-memos (core; gated sales.credit_memos.manage),
 *         POST /api/financial_pl/ksef/submissions/from-credit-memo (gated financial_pl.submit).
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the test env
 * (yarn official-modules add financial-pl). `admin` holds `financial_pl.*`; `employee` holds
 * only `financial_pl.view`.
 *
 * The KOR flow is: author a SalesCreditMemo against the corrected invoice (corrected invoiceId +
 * reason + lines) over the STABLE core credit-memos API, then dispatch the correction via
 * from-credit-memo. This asserts the gating on BOTH legs — the create requires
 * `sales.credit_memos.manage` (403 without it), the send requires `financial_pl.submit` (403
 * without it) — and the create→send round-trip for an authorized caller. As with the rest of the
 * suite, no live Ministry of Finance KSeF call is made: the actual correction send is the
 * subscriber's job and is NOT asserted (the FA(3) KOR serialization is proven by the unit suite
 * resolve-fa3-from-credit-memo.test.ts / fa3.correction.test.ts); the dispatch contract is
 * asserted here.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function invoicePayload() {
  return {
    invoiceNumber: `OM-UI4-${suffix()}`,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    lines: [{ name: 'Usługa do korekty', quantity: 1, unitPriceNet: 100, taxRate: 23 }],
  };
}

function creditMemoPayload(invoiceId: string) {
  return {
    invoiceId,
    reason: 'Korekta — zwrot części usługi',
    currencyCode: 'PLN',
    issueDate: '2026-06-25',
    lines: [{ name: 'Korekta pozycji', quantity: 1, unitPriceNet: 50, taxRate: 23 }],
  };
}

test.describe('TC-KSEF-UI-004: correction (KOR) — credit memo create + from-credit-memo', () => {
  // --- credit memo create requires sales.credit_memos.manage ---

  test('credit memo create is rejected when unauthenticated (401)', async ({ request }) => {
    const anon = await request.post('/api/sales/credit-memos', {
      data: { invoiceId: randomUUID(), reason: 'x' },
    });
    expect(anon.status(), 'unauthenticated credit memo create is rejected').toBe(401);
  });

  test('credit memo create WITHOUT sales.credit_memos.manage is forbidden (403)', async ({ request }) => {
    // `employee` lacks the core sales.credit_memos.manage feature, so it cannot author the KOR's
    // backing credit memo (the correction action is hidden/disabled without it — SPEC-013).
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/sales/credit-memos', {
      token,
      data: { invoiceId: randomUUID(), reason: 'Korekta' },
    });
    expect(res.status(), 'employee (no sales.credit_memos.manage) cannot create a credit memo').toBe(403);
  });

  // --- from-credit-memo (the KSeF send leg) requires financial_pl.submit ---

  test('from-credit-memo is rejected when unauthenticated (401)', async ({ request }) => {
    const anon = await request.post('/api/financial_pl/ksef/submissions/from-credit-memo', {
      data: { creditMemoId: randomUUID() },
    });
    expect(anon.status(), 'unauthenticated correction send is rejected').toBe(401);
  });

  test('from-credit-memo WITHOUT financial_pl.submit is forbidden (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-credit-memo', {
      token,
      data: { creditMemoId: randomUUID() },
    });
    expect(res.status(), 'employee (no financial_pl.submit) cannot send a correction').toBe(403);
  });

  // --- the full create -> send round-trip for an authorized caller ---

  test('authors a credit memo against the corrected invoice, then dispatches the correction', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let invoiceId: string | null = null;
    let creditMemoId: string | null = null;
    try {
      const invoiceRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      if (invoiceRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(invoiceRes.status()).toBe(201);
      invoiceId = ((await invoiceRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId, 'the corrected invoice is created').toBeTruthy();

      // Author the credit memo (corrected invoiceId + reason + lines).
      const memoRes = await apiRequest(request, 'POST', '/api/sales/credit-memos', {
        token,
        data: creditMemoPayload(invoiceId as string),
      });
      if (memoRes.status() === 403) {
        test.skip(true, 'admin lacks sales.credit_memos.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(memoRes.status(), 'admin authors the KOR credit memo').toBe(201);
      const memoBody = (await memoRes.json()) as { id?: string; creditMemoId?: string };
      creditMemoId = memoBody.creditMemoId ?? memoBody.id ?? null;
      expect(creditMemoId, 'create returns the credit memo id').toBeTruthy();

      // Dispatch the correction. With financial_pl.submit the route is past the gate; without a
      // live KSeF accept of the corrected ORIGINAL it may 409/422 (the KOR resolver requires the
      // original to be accepted), but it must NOT be a 401/403 gate error — that proves the
      // authorized dispatch contract.
      const sendRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-credit-memo', {
        token,
        data: { creditMemoId },
      });
      expect(sendRes.status(), 'admin is NOT gated out of the correction send').not.toBe(403);
      expect(sendRes.status(), 'admin is authenticated for the correction send').not.toBe(401);
      expect([202, 404, 409, 422], 'correction send either queues (202) or hits a KOR resolver guard (4xx)').toContain(
        sendRes.status(),
      );
      if (sendRes.status() === 202) {
        const body = (await sendRes.json()) as { ok?: boolean };
        expect(body.ok).toBe(true);
      }
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/credit-memos', creditMemoId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
