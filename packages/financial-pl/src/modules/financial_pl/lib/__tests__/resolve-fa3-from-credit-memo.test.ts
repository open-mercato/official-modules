jest.mock('@open-mercato/core/generated-shims/entities.ids.generated', () => ({
  E: {
    sales: {
      sales_invoice: 'sales:sales_invoice',
      sales_invoice_line: 'sales:sales_invoice_line',
      sales_credit_memo: 'sales:sales_credit_memo',
      sales_credit_memo_line: 'sales:sales_credit_memo_line',
    },
  },
  M: {},
}))

import { buildFa3Xml } from '../fa3'
import { resolveFa3FromCreditMemo } from '../resolve-fa3-from-credit-memo'
import type { ResolveFa3QueryEngine } from '../resolve-fa3-from-invoice'

type Rows = Record<string, Array<Record<string, unknown>>>

function makeQueryEngine(rowsByEntity: Rows): ResolveFa3QueryEngine {
  return {
    async query(entityId) {
      return { items: rowsByEntity[entityId] ?? [] }
    },
  }
}

const SELLER = { name: 'Sprzedawca Sp. z o.o.', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' }
const ORIGINAL_INVOICE = {
  id: 'inv-1',
  invoice_number: 'FV/2026/06/1',
  // Original gross = 123.00 — deliberately DIFFERENT from the credit memo's 49.20 so the P_15ZK
  // assertions verify it is the ORIGINAL's pre-correction amount, not the correction's own total.
  grand_total_net_amount: '100.0000',
  tax_total_amount: '23.0000',
  issue_date: '2026-06-20',
  currency_code: 'PLN',
  metadata: { buyerSnapshot: { companyName: 'Nabywca Sp. z o.o.', nip: '3755747347', addressLine1: 'ul. Kliencka 2', city: 'Krakow', postalCode: '00-002' } },
}
const CREDIT_MEMO = {
  id: 'cm-1',
  invoice_id: 'inv-1',
  credit_memo_number: 'KOR/2026/06/1',
  reason: 'Zwrot 1 szt',
  issue_date: '2026-06-27',
  currency_code: 'PLN',
  grand_total_net_amount: '40.0000',
  tax_total_amount: '9.2000',
}
const CREDIT_MEMO_LINE = {
  line_number: 1,
  name: 'Usluga',
  quantity: '1',
  quantity_unit: 'szt',
  unit_price_net: '40.0000',
  total_net_amount: '40.0000',
  tax_amount: '9.2000',
  tax_rate: '23.0000',
}

const baseRows = (overrides: Partial<Rows> = {}): Rows => ({
  'sales:sales_credit_memo': [CREDIT_MEMO],
  'sales:sales_invoice': [ORIGINAL_INVOICE],
  'sales:sales_credit_memo_line': [CREDIT_MEMO_LINE],
  'financial_pl:ksef_submission': [],
  'financial_pl:sales_invoice_pl_meta': [],
  ...overrides,
})

const args = { creditMemoId: 'cm-1', organizationId: 'org-1', tenantId: 'ten-1' }

describe('resolveFa3FromCreditMemo', () => {
  it('builds a KOR referencing the in-KSeF original by NrKSeFFaKorygowanej, with NEGATED amounts', async () => {
    const rows = baseRows({
      'financial_pl:ksef_submission': [
        { document_kind: 'invoice', status: 'accepted', ksef_number: '2481632647-20260620-AABBCC-DDEEFF-11', deleted_at: null, created_at: '2026-06-20' },
      ],
    })
    const { invoice, correctedInvoiceId } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    expect(correctedInvoiceId).toBe('inv-1')
    expect(invoice.invoiceKind).toBe('KOR')
    expect(invoice.correction?.correctedInvoices[0].correctedKsefNumber).toBe('2481632647-20260620-AABBCC-DDEEFF-11')
    expect(invoice.correction?.correctedInvoices[0].correctedInvoiceNumber).toBe('FV/2026/06/1')
    expect(invoice.correction?.reason).toBe('Zwrot 1 szt')
    // Credit memo stores +40.00 / +9.20; the correction files them as negative differences.
    expect(invoice.vatBreakdown[0].net).toBe('-40.00')
    expect(invoice.vatBreakdown[0].vat).toBe('-9.20')
    expect(invoice.totalGross).toBe('-49.20')
    // The reduction sign is on the QUANTITY (−1), with a POSITIVE unit price, and the line
    // net is negative (the standard faktura korygująca representation; P_11 = P_8B × P_9A).
    expect(invoice.lines[0].quantity).toBe('-1')
    expect(invoice.lines[0].unitNetPrice).toBe('40.00')
    expect(invoice.lines[0].netValue).toBe('-40.00')
  })

  it('emits NrKSeFN (no correctedKsefNumber) for an outside-KSeF original when explicitly confirmed', async () => {
    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(baseRows()), contextNip: '2481632647', seller: SELLER },
      { ...args, originalOutsideKsef: true },
    )
    expect(invoice.correction?.correctedInvoices[0].correctedKsefNumber).toBeUndefined()
  })

  it('rejects (409) when the original has a non-accepted submission (never mislabels as legacy)', async () => {
    const rows = baseRows({
      'financial_pl:ksef_submission': [{ document_kind: 'invoice', status: 'processing', ksef_number: null, deleted_at: null, created_at: '2026-06-26' }],
    })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 409, body: { code: 'original_not_accepted' } })
  })

  it('rejects (422) when the original has no KSeF number and is not confirmed outside-KSeF', async () => {
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(baseRows()), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 422, body: { code: 'original_ksef_number_unknown' } })
  })

  it('rejects (422) a credit memo with no reason', async () => {
    const rows = baseRows({ 'sales:sales_credit_memo': [{ ...CREDIT_MEMO, reason: null }] })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, { ...args, originalOutsideKsef: true }),
    ).rejects.toMatchObject({ status: 422, body: { code: 'correction_reason_required' } })
  })

  it('rejects (422) a credit memo not linked to an invoice', async () => {
    const rows = baseRows({ 'sales:sales_credit_memo': [{ ...CREDIT_MEMO, invoice_id: null }] })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 422, body: { code: 'credit_memo_not_linked' } })
  })

  it('uses the immutable metadata link when an older core projection omits invoice_id', async () => {
    const rows = baseRows({
      'sales:sales_credit_memo': [
        { ...CREDIT_MEMO, invoice_id: null, metadata: { correctedInvoiceId: 'inv-1' } },
      ],
    })
    const { correctedInvoiceId } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      { ...args, originalOutsideKsef: true },
    )

    expect(correctedInvoiceId).toBe('inv-1')
  })

  it('does not filter credit-memo lines by the nonexistent deleted_at column', async () => {
    const rows = baseRows()
    const query = jest.fn(async (entityId: string) => ({ items: rows[entityId] ?? [] }))

    await resolveFa3FromCreditMemo(
      { queryEngine: { query } as unknown as ResolveFa3QueryEngine, contextNip: '2481632647', seller: SELLER },
      { ...args, originalOutsideKsef: true },
    )

    const lineQuery = query.mock.calls.find(([entityId]) => entityId === 'sales:sales_credit_memo_line')
    expect(lineQuery?.[1]?.filters).toEqual({ credit_memo_id: { $eq: 'cm-1' } })
  })

  it('rejects (422) a credit memo with no lines', async () => {
    const rows = baseRows({
      'sales:sales_credit_memo_line': [],
      'financial_pl:ksef_submission': [{ document_kind: 'invoice', status: 'accepted', ksef_number: 'X', deleted_at: null, created_at: '2026-06-20' }],
    })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 422, body: { code: 'correction_lines_required' } })
  })

  // SPEC-009: the correction kind is derived from the corrected ORIGINAL's PL-meta invoice_kind.
  const ACCEPTED_ORIGINAL = {
    'financial_pl:ksef_submission': [
      { document_kind: 'invoice', status: 'accepted', ksef_number: '2481632647-20260620-AABBCC-DDEEFF-11', deleted_at: null, created_at: '2026-06-20' },
    ],
  }

  it('derives KOR_ZAL from a corrected ZAL original: carries P_15ZK (pre-correction amount) + the corrected Zamowienie', async () => {
    const rows = baseRows({
      ...ACCEPTED_ORIGINAL,
      'financial_pl:sales_invoice_pl_meta': [
        {
          sales_invoice_id: 'inv-1',
          invoice_kind: 'zal',
          // The original ZAL documented a 49.20 advance payment — its P_15 (paid), which drives P_15ZK
          // and is deliberately distinct from the original invoice gross (123.00).
          advance_payments: [{ receivedDate: '2026-06-19', amount: '49.20' }],
          order_snapshot: {
            totalValue: '49.20',
            lines: [{ name: 'Towar', quantity: '1', unitNetPrice: '40.00', netValue: '40.00', vatValue: '9.20', vatRate: '23' }],
          },
          deleted_at: null,
        },
      ],
    })
    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    expect(invoice.invoiceKind).toBe('KOR_ZAL')
    // P_15ZK = the ORIGINAL ZAL's paid amount = Σ advance_payments (49.20) — NOT the invoice gross
    // (123.00) and NOT the correction's own total (-49.20).
    expect(invoice.correction?.preCorrectionPaymentAmount).toBe('49.20')
    expect(invoice.order?.lines).toHaveLength(1)
    expect(invoice.correction?.correctedInvoices[0].correctedKsefNumber).toBe('2481632647-20260620-AABBCC-DDEEFF-11')
  })

  it('derives KOR_ROZ from a corrected ROZ original: carries P_15ZK + the full (negated) FaWiersz', async () => {
    const rows = baseRows({
      ...ACCEPTED_ORIGINAL,
      'financial_pl:sales_invoice_pl_meta': [
        // The original ROZ netted a 23.00 advance, so its pre-correction residual = 123.00 − 23.00.
        { sales_invoice_id: 'inv-1', invoice_kind: 'roz', advance_refs: [{ amount: '23.00' }], deleted_at: null },
      ],
    })
    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    expect(invoice.invoiceKind).toBe('KOR_ROZ')
    // P_15ZK = the ORIGINAL settlement residual (original gross 123.00 − Σ advances 23.00 = 100.00),
    // NOT the correction's own total (-49.20).
    expect(invoice.correction?.preCorrectionPaymentAmount).toBe('100.00')
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.lines[0].netValue).toBe('-40.00')
  })

  it('full-reversal discounted KOR negates P_10 and P_11', async () => {
    const rows = baseRows({
      ...ACCEPTED_ORIGINAL,
      'sales:sales_credit_memo': [{ ...CREDIT_MEMO, grand_total_net_amount: '180.0000', tax_total_amount: '41.4000' }],
      'sales:sales_credit_memo_line': [
        {
          line_number: 1,
          name: 'Towar z rabatem',
          quantity: '2',
          unit_price_net: '100.0000',
          total_net_amount: '180.0000',
          tax_amount: '41.4000',
          tax_rate: '23.0000',
          metadata: { discountAmount: '20.00', discountPercent: '10.00' },
        },
      ],
    })

    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    const xml = buildFa3Xml({ model: { ...invoice, createdAt: '2026-06-27T10:00:00Z' }, lines: invoice.lines })
    const line = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(line).toContain('<P_8B>-2</P_8B><P_9A>100.00</P_9A><P_10>-20.00</P_10><P_11>-180.00</P_11>')
    expect(invoice.vatBreakdown).toEqual([{ rate: 23, net: '-180.00', vat: '-41.40' }])
  })

  it('full-reversal gross-mode KOR emits negated P_9B/P_11A', async () => {
    const rows = baseRows({
      ...ACCEPTED_ORIGINAL,
      'sales:sales_credit_memo': [
        {
          ...CREDIT_MEMO,
          metadata: { priceMode: 'gross' },
          grand_total_net_amount: '16.2400',
          tax_total_amount: '3.7400',
          grand_total_gross_amount: '19.9800',
        },
      ],
      'sales:sales_credit_memo_line': [
        {
          line_number: 1,
          name: 'Cena brutto',
          quantity: '2',
          unit_price_net: '8.1220',
          unit_price_gross: '9.9900',
          total_gross_amount: '19.9800',
          tax_rate: '23.0000',
        },
      ],
    })

    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    const xml = buildFa3Xml({ model: { ...invoice, createdAt: '2026-06-27T10:00:00Z' }, lines: invoice.lines })
    const line = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(line).toContain('<P_8B>-2</P_8B><P_9B>9.99</P_9B><P_11A>-19.98</P_11A><P_12>23</P_12>')
    expect(line).not.toContain('<P_9A>')
    expect(line).not.toContain('<P_11>')
    expect(invoice.vatBreakdown).toEqual([{ rate: 23, net: '-16.24', vat: '-3.74' }])
  })

  it('full-reversal marża KOR carries PMarzy and negated P_13_11', async () => {
    const rows = baseRows({
      ...ACCEPTED_ORIGINAL,
      'sales:sales_credit_memo': [
        {
          ...CREDIT_MEMO,
          metadata: { priceMode: 'gross' },
          grand_total_net_amount: '180.0000',
          tax_total_amount: '0.0000',
          grand_total_gross_amount: '180.0000',
        },
      ],
      'sales:sales_credit_memo_line': [
        {
          line_number: 1,
          name: 'Towar używany',
          quantity: '2',
          unit_price_gross: '100.0000',
          total_gross_amount: '180.0000',
          metadata: { discountAmount: '20.00' },
        },
      ],
      'financial_pl:sales_invoice_pl_meta': [{ sales_invoice_id: 'inv-1', margin_scheme: 'used_goods', deleted_at: null }],
    })

    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    const xml = buildFa3Xml({ model: { ...invoice, createdAt: '2026-06-27T10:00:00Z' }, lines: invoice.lines })
    expect(xml).toContain('<PMarzy><P_PMarzy>1</P_PMarzy><P_PMarzy_3_1>1</P_PMarzy_3_1></PMarzy>')
    expect(xml).toContain('<P_13_11>-180.00</P_13_11>')
    const line = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(line).toContain('<P_9B>100.00</P_9B><P_10>-20.00</P_10><P_11A>-180.00</P_11A>')
    expect(line).not.toContain('<P_12>')
  })

  it('OSS correction (jury rule 2): a KOR of an OSS original carries the OSS line fields + P_13_5/P_14_5 + FX (negated)', async () => {
    const rows = baseRows({
      ...ACCEPTED_ORIGINAL,
      'sales:sales_credit_memo': [{ ...CREDIT_MEMO, currency_code: 'EUR' }],
      'sales:sales_credit_memo_line': [{ ...CREDIT_MEMO_LINE, tax_rate: '19.0000', tax_amount: '7.6000' }],
      'financial_pl:sales_invoice_pl_meta': [
        {
          sales_invoice_id: 'inv-1',
          invoice_kind: 'vat',
          oss_procedure: true,
          consumption_country_code: 'DE',
          exchange_rate: '4.30',
          deleted_at: null,
        },
      ],
    })
    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    expect(invoice.invoiceKind).toBe('KOR')
    expect(invoice.currencyCode).toBe('EUR')
    // OSS serialization is shared with the invoice path: the OSS bucket + per-line WSTO_EE markers,
    // all as negated differences.
    expect(invoice.vatBreakdown[0].rate).toBe('oss')
    expect(invoice.vatBreakdown[0].net).toBe('-40.00')
    expect(invoice.lines[0].ossRate).toBe('19')
    expect(invoice.lines[0].procedure).toBe('WSTO_EE')
    expect(invoice.lines[0].fxRate).toBe('4.30')
    expect(invoice.exchangeRate).toBe('4.30')
  })
})
