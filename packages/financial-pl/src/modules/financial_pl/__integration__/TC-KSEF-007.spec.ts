import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-KSEF-007: FA(3) advanced document types, self-billing, OSS/WSTO_EE and the
 * GTU/JPK markings (SPEC-009) — invoice-meta HTTP contract + the from-invoice
 * validation contract.
 *
 * Covers: GET/PUT /api/financial_pl/ksef/invoice-meta (the SPEC-009 additive fields)
 *         POST     /api/financial_pl/ksef/submissions/from-invoice (OSS / ZAL meta)
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the test
 * env (yarn official-modules add financial-pl). `admin` holds `financial_pl.*`;
 * `employee` holds only `financial_pl.view` (see setup.ts) — used for the 403 below.
 *
 * Asserts the self-contained HTTP contract only (no live Ministry of Finance KSeF
 * API, no issued-invoice fixture chain). The PUT row is keyed by salesInvoiceId and
 * has no FK into core `sales`, so a random UUID round-trips faithfully. The
 * from-invoice path resolves the FA(3) document from the actual sales invoice, so an
 * unknown invoice id yields a non-2xx (404/409/422) rather than a live send — the
 * accepted-shape and 422 error-code outcomes for OSS/ZAL serialization are proven by
 * the resolver/validator/serializer unit tests (resolve-fa3-from-invoice.test.ts,
 * validators.test.ts, fa3.test.ts).
 */

const ALL_PROCEDURE_MARKINGS = [
  'WSTO_EE',
  'IED',
  'TP',
  'TT_WNT',
  'TT_D',
  'MR_T',
  'MR_UZ',
  'I_42',
  'I_63',
  'B_SPV',
  'B_SPV_DOSTAWA',
  'B_MPV_PROWIZJA',
] as const;

test.describe('TC-KSEF-007: FA(3) advanced doc-types + OSS + GTU/JPK markings API', () => {
  test('rejects an unauthenticated invoice-meta read', async ({ request }) => {
    const anonRes = await request.get(
      `/api/financial_pl/ksef/invoice-meta?salesInvoiceId=${randomUUID()}`,
    );
    expect(anonRes.status(), 'unauthenticated read is rejected').toBe(401);
  });

  test('rejects an unauthenticated invoice-meta write', async ({ request }) => {
    const anonRes = await request.put('/api/financial_pl/ksef/invoice-meta', {
      data: { salesInvoiceId: randomUUID(), invoiceKind: 'zal' },
    });
    expect(anonRes.status(), 'unauthenticated write is rejected').toBe(401);
  });

  test('rejects an invoice-meta write without the manage feature (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
      token,
      data: { salesInvoiceId: randomUUID(), invoiceKind: 'vat' },
    });
    expect(res.status(), 'employee (view-only) cannot write invoice meta').toBe(403);
  });

  test('rejects an invalid invoice kind (400)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
      token,
      data: { salesInvoiceId: randomUUID(), invoiceKind: 'not_a_kind' },
    });
    expect(res.status(), 'an unknown invoiceKind returns 400').toBe(400);
  });

  test('rejects an invalid GTU code (400)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
      token,
      data: { salesInvoiceId: randomUUID(), gtuCodes: ['GTU_99'] },
    });
    expect(res.status(), 'an unknown GTU code returns 400').toBe(400);
  });

  test('round-trips the SPEC-009 fields (PUT then GET echo the new shape)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const salesInvoiceId = randomUUID();

    const procedureMarkings = Object.fromEntries(ALL_PROCEDURE_MARKINGS.map((c) => [c, false]));
    procedureMarkings.WSTO_EE = true;
    procedureMarkings.TP = true;

    const payload = {
      salesInvoiceId,
      invoiceKind: 'roz',
      selfBilling: true,
      reverseCharge: true,
      ossProcedure: true,
      consumptionCountryCode: 'DE',
      exchangeRate: '4.3210',
      exchangeRateDate: '2026-06-20',
      advancePayments: [{ receivedDate: '2026-05-10', amount: '100.00', fxRate: '4.3000' }],
      advanceRefs: [{ ksefNumber: '1111111111-20260510-AAAAAA-BB' }],
      orderSnapshot: {
        totalValue: '300.00',
        lines: [{ name: 'Prepaid item', quantity: '1', unitPrice: '300.00', netValue: '300.00', vatRate: '23' }],
      },
      // a duplicate GTU code must be deduped by the API
      gtuCodes: ['GTU_01', 'GTU_12', 'GTU_01'],
      procedureMarkings,
      typDokumentu: 'WEW',
    };

    const putRes = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
      token,
      data: payload,
    });
    expect(putRes.status(), 'a valid SPEC-009 meta write returns 200').toBe(200);
    const putBody = (await putRes.json()) as { ok?: boolean; item?: Record<string, unknown> };
    expect(putBody.ok).toBe(true);
    const saved = putBody.item ?? {};
    expect(saved.invoiceKind).toBe('roz');
    expect(saved.selfBilling).toBe(true);
    expect(saved.reverseCharge).toBe(true);
    expect(saved.ossProcedure).toBe(true);
    expect(saved.consumptionCountryCode).toBe('DE');
    expect(saved.typDokumentu).toBe('WEW');
    expect(saved.gtuCodes).toEqual(['GTU_01', 'GTU_12']);
    expect((saved.procedureMarkings as Record<string, boolean>).WSTO_EE).toBe(true);
    expect((saved.procedureMarkings as Record<string, boolean>).TP).toBe(true);
    expect((saved.procedureMarkings as Record<string, boolean>).IED).toBe(false);
    expect(Array.isArray(saved.advancePayments)).toBe(true);
    expect(Array.isArray(saved.advanceRefs)).toBe(true);
    expect(saved.orderSnapshot, 'order snapshot is echoed').toBeTruthy();

    const getRes = await apiRequest(
      request,
      'GET',
      `/api/financial_pl/ksef/invoice-meta?salesInvoiceId=${encodeURIComponent(salesInvoiceId)}`,
      { token },
    );
    expect(getRes.status()).toBe(200);
    const getBody = (await getRes.json()) as { item?: Record<string, unknown> };
    const fetched = getBody.item ?? {};
    expect(fetched.invoiceKind).toBe('roz');
    expect(fetched.ossProcedure).toBe(true);
    expect(fetched.consumptionCountryCode).toBe('DE');
    expect(fetched.gtuCodes).toEqual(['GTU_01', 'GTU_12']);
    expect((fetched.procedureMarkings as Record<string, boolean>).WSTO_EE).toBe(true);
    expect(fetched.typDokumentu).toBe('WEW');
  });

  test('from-invoice for an OSS-marked invoice does not live-send (non-2xx contract)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const salesInvoiceId = randomUUID();

    // Mark the (otherwise unknown) invoice as an OSS distance sale, then attempt a send.
    const metaRes = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
      token,
      data: { salesInvoiceId, ossProcedure: true, consumptionCountryCode: 'DE' },
    });
    expect(metaRes.status(), 'OSS meta is accepted').toBe(200);

    const sendRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-invoice', {
      token,
      data: { salesInvoiceId, contextNip: '7980332920', environment: 'test' },
    });
    // No live KSeF: an unknown/unissued invoice is a clear non-2xx (404/409/422),
    // never an accepted send.
    expect([404, 409, 422], 'OSS send for an unknown invoice is a clear non-2xx').toContain(sendRes.status());
  });

  test('from-invoice for a ZAL-marked invoice does not live-send (non-2xx contract)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const salesInvoiceId = randomUUID();

    const metaRes = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
      token,
      data: {
        salesInvoiceId,
        invoiceKind: 'zal',
        orderSnapshot: {
          totalValue: '300.00',
          lines: [{ name: 'Prepaid item', netValue: '300.00', vatRate: '23' }],
        },
        advancePayments: [{ receivedDate: '2026-05-10', amount: '100.00' }],
      },
    });
    expect(metaRes.status(), 'ZAL meta is accepted').toBe(200);

    const sendRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/from-invoice', {
      token,
      data: { salesInvoiceId, contextNip: '7980332920', environment: 'test' },
    });
    expect([404, 409, 422], 'ZAL send for an unknown invoice is a clear non-2xx').toContain(sendRes.status());
  });
});
