jest.mock('@open-mercato/core/generated-shims/entities.ids.generated', () => ({
  E: {
    sales: {
      sales_invoice: 'sales:sales_invoice',
      sales_invoice_line: 'sales:sales_invoice_line',
    },
  },
  M: {},
}))

import { fa3InvoiceSchema } from '../../data/validators'
import {
  resolveFa3FromSalesInvoice,
  roundMoneyTo2dp,
  type ResolveFa3QueryEngine,
} from '../resolve-fa3-from-invoice'

type QueryCall = { entityId: string; opts: Record<string, unknown> }

function makeQueryEngine(rowsByEntity: Record<string, Array<Record<string, unknown>>>): {
  queryEngine: ResolveFa3QueryEngine
  calls: QueryCall[]
} {
  const calls: QueryCall[] = []
  const queryEngine: ResolveFa3QueryEngine = {
    async query(entityId, opts) {
      calls.push({ entityId, opts: opts as Record<string, unknown> })
      return { items: rowsByEntity[entityId] ?? [] }
    },
  }
  return { queryEngine, calls }
}

const SELLER = { name: 'Open Mercato Sp. z o.o.', addressLine1: 'ul. Testowa 1, 00-001 Warszawa' }

const baseInvoice: Record<string, unknown> = {
  id: 'inv-1',
  invoice_number: 'FV/2026/06/1',
  document_type: 'vat',
  is_immutable: true,
  issue_date: '2026-06-20',
  currency_code: 'PLN',
  grand_total_net_amount: '200.0000',
  grand_total_gross_amount: '246.0000',
  tax_total_amount: '46.0000',
  metadata: {
    buyerSnapshot: {
      name: 'Nabywca Sp. z o.o.',
      nip: '3755747347',
      addressLine1: 'ul. Kliencka 2, 00-002 Kraków',
      countryCode: 'PL',
    },
  },
}

describe('roundMoneyTo2dp', () => {
  it('rounds numeric(18,4) strings to 2dp with exact BigInt math', () => {
    expect(roundMoneyTo2dp('100.0000')).toBe('100.00')
    expect(roundMoneyTo2dp('100.005')).toBe('100.01')
    expect(roundMoneyTo2dp('100.004')).toBe('100.00')
    expect(roundMoneyTo2dp('100.125')).toBe('100.13')
    expect(roundMoneyTo2dp('0')).toBe('0.00')
    expect(roundMoneyTo2dp('-1.005')).toBe('-1.01')
    expect(roundMoneyTo2dp(123.4)).toBe('123.40')
  })
})

describe('resolveFa3FromSalesInvoice', () => {
  it('produces a valid Fa3InvoiceInput with 2dp money and aggregated VAT', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [baseInvoice],
      'sales:sales_invoice_line': [
        {
          line_number: 1,
          name: 'Usługa A',
          quantity: '1',
          quantity_unit: 'szt',
          unit_price_net: '100.0000',
          total_net_amount: '100.0000',
          tax_amount: '23.0000',
          tax_rate: '23.0000',
        },
        {
          line_number: 2,
          name: 'Usługa B',
          quantity: '2',
          unit_price_net: '50.0000',
          total_net_amount: '100.0000',
          tax_amount: '23.0000',
          tax_rate: '23.0000',
        },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.seller.nip).toBe('7980332920')
    expect(result.buyer.name).toBe('Nabywca Sp. z o.o.')
    expect(result.buyer.nip).toBe('3755747347')
    expect(result.invoiceNumber).toBe('FV/2026/06/1')
    expect(result.invoiceKind).toBe('VAT')
    expect(result.totalGross).toBe('246.00')
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].unitNetPrice).toBe('100.00')
    expect(result.lines[0].netValue).toBe('100.00')

    expect(result.vatBreakdown).toHaveLength(1)
    expect(result.vatBreakdown[0].rate).toBe(23)
    expect(result.vatBreakdown[0].net).toBe('200.00')
    expect(result.vatBreakdown[0].vat).toBe('46.00')
  })

  it('falls back to metadata.lines for the VAT breakdown when there are no first-class line rows', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          grand_total_net_amount: '150.0000',
          grand_total_gross_amount: '181.0000',
          tax_total_amount: '31.0000',
          metadata: {
            ...(baseInvoice.metadata as Record<string, unknown>),
            lines: [
              { description: 'Towar 23%', quantity: 1, unitNetPrice: 100, vatRate: '23' },
              { description: 'Towar 8%', quantity: 1, unitNetPrice: 50, vatRate: '8' },
            ],
          },
        },
      ],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.lines).toHaveLength(2)
    const rates = result.vatBreakdown.map((bucket) => bucket.rate).sort((a, b) => Number(a) - Number(b))
    expect(rates).toEqual([8, 23])
    const bucket23 = result.vatBreakdown.find((bucket) => bucket.rate === 23)
    const bucket8 = result.vatBreakdown.find((bucket) => bucket.rate === 8)
    expect(bucket23?.net).toBe('100.00')
    expect(bucket23?.vat).toBe('23.00')
    expect(bucket8?.net).toBe('50.00')
    expect(bucket8?.vat).toBe('4.00')
  })

  it('threads metadata.lines unit (jednostka) into the FA(3) line and sale date (P_6) from metadata', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          grand_total_net_amount: '100.0000',
          grand_total_gross_amount: '123.0000',
          tax_total_amount: '23.0000',
          metadata: {
            ...(baseInvoice.metadata as Record<string, unknown>),
            saleDate: '2026-06-18',
            lines: [
              { description: 'Usługa godzinowa', quantity: 2, unit: 'godz', unitNetPrice: 50, vatRate: '23' },
            ],
          },
        },
      ],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.lines[0].unit).toBe('godz')
    // P_6 (data sprzedaży) comes from metadata.saleDate, distinct from the issue date.
    expect(result.saleDate).toBe('2026-06-18')
  })

  it('falls back P_6 (saleDate) to the issue date when metadata.saleDate is absent', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [baseInvoice],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })
    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )
    expect(result.saleDate).toBe('2026-06-20')
  })

  it('computes metadata.lines net with the same 4dp integer-domain math as the editor', async () => {
    // 0.12345 qty @ 98.76 → editor net = round(1235 * 9876 / 10000) cents = 1220 = 12.20.
    // The resolver must match exactly so the FA(3) net never contradicts the header total.
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          metadata: {
            ...(baseInvoice.metadata as Record<string, unknown>),
            lines: [{ description: 'Usługa', quantity: 0.12345, unitNetPrice: 98.76, vatRate: '0' }],
          },
        },
      ],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(result.vatBreakdown).toHaveLength(1)
    expect(result.vatBreakdown[0].rate).toBe(0)
    expect(result.vatBreakdown[0].net).toBe('12.20')
    // The emitted FA(3) line reconciles internally: quantity (4 dp) × unit price (2 dp)
    // rounds to the net, so the line arithmetic and the header total agree.
    expect(result.lines[0].quantity).toBe('0.1235')
    expect(result.lines[0].unitNetPrice).toBe('98.76')
    expect(result.lines[0].netValue).toBe('12.20')
  })

  it('aggregates multiple first-class VAT rates into the FA(3) summary for a VAT invoice', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [baseInvoice],
      'sales:sales_invoice_line': [
        {
          line_number: 1,
          name: 'Towar 23%',
          quantity: '1',
          unit_price_net: '100.0000',
          total_net_amount: '100.0000',
          tax_amount: '23.0000',
          tax_rate: '23.0000',
        },
        {
          line_number: 2,
          name: 'Towar 8%',
          quantity: '1',
          unit_price_net: '50.0000',
          total_net_amount: '50.0000',
          tax_amount: '4.0000',
          tax_rate: '8.0000',
        },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.invoiceKind).toBe('VAT')
    expect(result.vatBreakdown).toHaveLength(2)
    const rate23 = result.vatBreakdown.find((entry) => entry.rate === 23)
    const rate8 = result.vatBreakdown.find((entry) => entry.rate === 8)
    expect(rate23?.net).toBe('100.00')
    expect(rate23?.vat).toBe('23.00')
    expect(rate8?.net).toBe('50.00')
    expect(rate8?.vat).toBe('4.00')
  })

  it('derives P_15 (totalGross) from the per-rate buckets so it reconciles with Σ(P_13+P_14), even when the stored header gross is wrong', async () => {
    const { queryEngine } = makeQueryEngine({
      // Deliberately wrong stored gross — the resolver must emit the bucket-derived total
      // (the FA(3)-internal-consistency requirement KSeF validates), not this value.
      'sales:sales_invoice': [{ ...baseInvoice, grand_total_gross_amount: '999.99' }],
      'sales:sales_invoice_line': [
        { line_number: 1, name: 'A', quantity: '1', unit_price_net: '100.0000', total_net_amount: '100.0000', tax_amount: '23.0000', tax_rate: '23.0000' },
        { line_number: 2, name: 'B', quantity: '1', unit_price_net: '50.0000', total_net_amount: '50.0000', tax_amount: '4.0000', tax_rate: '8.0000' },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    const bucketSum = result.vatBreakdown.reduce((sum, bucket) => sum + Number(bucket.net) + Number(bucket.vat), 0)
    expect(result.totalGross).toBe('177.00')
    expect(Number(result.totalGross)).toBeCloseTo(bucketSum, 2)
  })

  // SPEC-009: the blanket document_type/PLN-only rejects are replaced with a DISPATCH on the
  // explicit PL-meta `invoice_kind`. The cases below assert the new accept paths.
  it('dispatches on the PL-meta invoice_kind=zal: accepts a ZAL with order + received payments (P_15 = paid amount, FaWiersz optional)', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [{ ...baseInvoice }],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [
        {
          invoice_kind: 'zal',
          order_snapshot: {
            totalValue: '246.00',
            lines: [{ name: 'Towar', quantity: '1', unitNetPrice: '200.00', netValue: '200.00', vatValue: '46.00', vatRate: '23' }],
          },
          advance_payments: [{ receivedDate: '2026-06-15', amount: '123.00' }],
        },
      ],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.invoiceKind).toBe('ZAL')
    // FaWiersz is optional for a ZAL (the detail lives in the order block).
    expect(result.lines).toHaveLength(0)
    expect(result.order?.lines).toHaveLength(1)
    expect(result.advancePayments).toHaveLength(1)
    // P_15 = Σ received-payment amounts (the amount PAID this advance documents).
    expect(result.totalGross).toBe('123.00')
  })

  it('dispatches on invoice_kind=roz: accepts a ROZ with full FaWiersz + advance refs and nets P_15 = full gross − Σ advances (netting invariant)', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [{ ...baseInvoice }],
      'sales:sales_invoice_line': [
        { line_number: 1, name: 'Usługa', quantity: '1', unit_price_net: '200.0000', total_net_amount: '200.0000', tax_amount: '46.0000', tax_rate: '23.0000' },
      ],
      'financial_pl:sales_invoice_pl_meta': [
        {
          invoice_kind: 'roz',
          advance_refs: [{ ksefNumber: '2481632647-20260615-AABBCC-DDEEFF-11', amount: '123.00' }],
        },
      ],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.invoiceKind).toBe('ROZ')
    expect(result.lines).toHaveLength(1)
    expect(result.advanceInvoiceRefs).toHaveLength(1)
    // Netting invariant: full gross (246.00) − Σ advances (123.00) = residual 123.00.
    const fullGross = result.vatBreakdown.reduce((sum, b) => sum + Number(b.net) + Number(b.vat), 0)
    expect(fullGross).toBeCloseTo(246, 2)
    expect(result.totalGross).toBe('123.00')
  })

  it('dispatches on invoice_kind=upr: accepts a UPR with a NIP-only buyer under the 450 PLN threshold', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          grand_total_net_amount: '100.0000',
          tax_total_amount: '23.0000',
          grand_total_gross_amount: '123.0000',
          // NIP-only buyer (no name/address) — allowed for UPR.
          metadata: { buyerSnapshot: { nip: '3755747347', countryCode: 'PL' } },
        },
      ],
      'sales:sales_invoice_line': [
        { line_number: 1, name: 'Towar', quantity: '1', unit_price_net: '100.0000', total_net_amount: '100.0000', tax_amount: '23.0000', tax_rate: '23.0000' },
      ],
      'financial_pl:sales_invoice_pl_meta': [{ invoice_kind: 'upr' }],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.invoiceKind).toBe('UPR')
    expect(result.buyer.nip).toBe('3755747347')
    expect(result.buyer.name).toBeUndefined()
  })

  it('dispatches on oss_procedure: emits the OSS (WSTO_EE) bucket from the consumption-country rate + KodWaluty/KursWaluty', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          currency_code: 'EUR',
          grand_total_net_amount: '100.0000',
          tax_total_amount: '19.0000',
          grand_total_gross_amount: '119.0000',
        },
      ],
      'sales:sales_invoice_line': [
        { line_number: 1, name: 'Towar DE', quantity: '1', unit_price_net: '100.0000', total_net_amount: '100.0000', tax_amount: '19.0000', tax_rate: '19.0000' },
      ],
      'financial_pl:sales_invoice_pl_meta': [
        { oss_procedure: true, consumption_country_code: 'DE', exchange_rate: '4.30' },
      ],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    // A pure-OSS invoice rolls into the single OSS bucket; the FX rate is accepted (jury rule 1:
    // no domestic bucket → no P_14_xW requirement, but the rate is still carried through).
    expect(result.currencyCode).toBe('EUR')
    expect(result.vatBreakdown).toHaveLength(1)
    expect(result.vatBreakdown[0].rate).toBe('oss')
    expect(result.vatBreakdown[0].vatPln).toBeUndefined()
    expect(result.lines[0].ossRate).toBe('19')
    expect(result.lines[0].procedure).toBe('WSTO_EE')
    expect(result.lines[0].fxRate).toBe('4.30')
    expect(result.exchangeRate).toBe('4.30')
  })

  it('rejects a non-PLN invoice with a Polish-rate bucket and no exchange rate (jury rule 1: P_14_xW needs a rate)', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [{ ...baseInvoice, currency_code: 'EUR' }],
      'sales:sales_invoice_line': [
        { line_number: 1, name: 'Towar', quantity: '1', unit_price_net: '200.0000', total_net_amount: '200.0000', tax_amount: '46.0000', tax_rate: '23.0000' },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    })
    await expect(
      resolveFa3FromSalesInvoice(
        { queryEngine, contextNip: '7980332920', seller: SELLER },
        { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
      ),
    ).rejects.toThrow()
  })

  it('rejects an unmapped VAT rate with 422 vat_rate_unsupported instead of dropping the bucket', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          metadata: {
            ...(baseInvoice.metadata as Record<string, unknown>),
            lines: [{ description: 'Stawka 19%', quantity: 1, unitNetPrice: 100, vatRate: '19' }],
          },
        },
      ],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })
    await expect(
      resolveFa3FromSalesInvoice(
        { queryEngine, contextNip: '7980332920', seller: SELLER },
        { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'vat_rate_unsupported' } })
  })

  it('rejects a header-only invoice whose effective VAT rate does not reconcile (7.5% rounds to 8%)', async () => {
    // net 100.00 / tax 7.50 = 7.5% effective; deriveHeaderVatRate rounds to 8, which is
    // mapped, but round(100.00 * 8%) = 8.00 != 7.50, so the bucket cannot be faithfully
    // emitted — must 422 rather than send P_14 that contradicts P_13 * rate.
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          metadata: { buyerSnapshot: (baseInvoice.metadata as Record<string, unknown>).buyerSnapshot },
          grand_total_net_amount: '100.0000',
          tax_total_amount: '7.5000',
          grand_total_gross_amount: '107.5000',
        },
      ],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })
    await expect(
      resolveFa3FromSalesInvoice(
        { queryEngine, contextNip: '7980332920', seller: SELLER },
        { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'vat_rate_unsupported' } })
  })

  it('accepts a header-only invoice whose effective rate is exactly a standard rate (8%)', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          metadata: { buyerSnapshot: (baseInvoice.metadata as Record<string, unknown>).buyerSnapshot },
          grand_total_net_amount: '100.0000',
          tax_total_amount: '8.0000',
          grand_total_gross_amount: '108.0000',
        },
      ],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })
    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )
    expect(result.vatBreakdown).toHaveLength(1)
    expect(result.vatBreakdown[0].rate).toBe(8)
    expect(result.vatBreakdown[0].vat).toBe('8.00')
  })

  it('rejects an unparsable metadata.lines VAT rate (e.g. "19%") instead of coercing it to 0%', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          metadata: {
            ...(baseInvoice.metadata as Record<string, unknown>),
            lines: [{ description: 'Bad rate', quantity: 1, unitNetPrice: 100, vatRate: '19%' }],
          },
        },
      ],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })
    await expect(
      resolveFa3FromSalesInvoice(
        { queryEngine, contextNip: '7980332920', seller: SELLER },
        { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'vat_rate_unsupported' } })
  })

  it('rejects with 422 seller_required when no seller identity is configured (no placeholder)', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [baseInvoice],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })
    await expect(
      resolveFa3FromSalesInvoice(
        { queryEngine, contextNip: '7980332920' },
        { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'seller_required' } })
  })

  it('falls back to a header-derived single VAT line when no lines exist', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [baseInvoice],
      'sales:sales_invoice_line': [],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.lines).toHaveLength(1)
    expect(result.vatBreakdown).toHaveLength(1)
    expect(result.vatBreakdown[0].net).toBe('200.00')
    expect(result.totalGross).toBe('246.00')
  })

  it('rejects with a 422 when no buyer can be resolved (never submits a placeholder to KSeF)', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [{ ...baseInvoice, metadata: null }],
      'sales:sales_invoice_line': [
        {
          line_number: 1,
          name: 'Usługa A',
          quantity: '1',
          unit_price_net: '100.0000',
          total_net_amount: '100.0000',
          tax_amount: '23.0000',
          tax_rate: '23.0000',
        },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    await expect(
      resolveFa3FromSalesInvoice(
        { queryEngine, contextNip: '7980332920', seller: SELLER },
        { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'buyer_required' } })
  })

  it('resolves the buyer from the invoice metadata buyer snapshot', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [
        {
          ...baseInvoice,
          metadata: {
            buyerSnapshot: {
              companyName: 'Klient SA',
              nip: '3755747347',
              addressLine1: 'ul. Zamówieniowa 5',
              postalCode: '30-001',
              city: 'Kraków',
              countryCode: 'PL',
            },
          },
        },
      ],
      'sales:sales_invoice_line': [
        {
          line_number: 1,
          name: 'Usługa A',
          quantity: '1',
          unit_price_net: '100.0000',
          total_net_amount: '100.0000',
          tax_amount: '23.0000',
          tax_rate: '23.0000',
        },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(() => fa3InvoiceSchema.parse(result)).not.toThrow()
    expect(result.buyer.name).toBe('Klient SA')
    expect(result.buyer.nip).toBe('3755747347')
    expect(result.buyer.addressLine1).toBe('ul. Zamówieniowa 5')
    expect(result.buyer.addressLine2).toBe('30-001 Kraków')
    expect(result.buyer.countryCode).toBe('PL')
  })

  it('always sources the seller NIP from the credential context, ignoring a divergent PL meta context_nip', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [baseInvoice],
      'sales:sales_invoice_line': [
        {
          line_number: 1,
          name: 'Usługa A',
          quantity: '1',
          unit_price_net: '100.0000',
          total_net_amount: '100.0000',
          tax_amount: '23.0000',
          tax_rate: '23.0000',
        },
      ],
      // A per-invoice meta NIP must NOT become the Podmiot1 NIP — it would diverge from
      // the submission context NIP and KSeF would reject the seller mismatch.
      'financial_pl:sales_invoice_pl_meta': [{ context_nip: '0000000000' }],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(result.seller.nip).toBe('7980332920')
  })

  it('threads MPP + VAT-exemption from the PL meta into FA(3) annotations', async () => {
    const { queryEngine } = makeQueryEngine({
      'sales:sales_invoice': [baseInvoice],
      'sales:sales_invoice_line': [
        {
          line_number: 1,
          name: 'Usługa A',
          quantity: '1',
          unit_price_net: '100.0000',
          total_net_amount: '100.0000',
          tax_amount: '23.0000',
          tax_rate: '23.0000',
        },
      ],
      'financial_pl:sales_invoice_pl_meta': [
        { mpp_required: true, vat_exemption_basis: 'art. 43 ust. 1 ustawy o VAT' },
      ],
    })

    const result = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip: '7980332920', seller: SELLER },
      { salesInvoiceId: 'inv-1', organizationId: 'org-1', tenantId: 'tenant-1' },
    )

    expect(result.annotations).toEqual({
      splitPayment: true,
      vatExemptionBasis: 'art. 43 ust. 1 ustawy o VAT',
    })
  })

  it('throws a 404 CrudHttpError when the invoice is missing', async () => {
    const { queryEngine } = makeQueryEngine({ 'sales:sales_invoice': [] })
    await expect(
      resolveFa3FromSalesInvoice(
        { queryEngine, contextNip: '7980332920', seller: SELLER },
        { salesInvoiceId: 'missing', organizationId: 'org-1', tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('fa3InvoiceSchema E1 send-scope gate (direct submission path)', () => {
  const validFa3 = {
    invoiceNumber: 'INV-1',
    issueDate: '2026-06-23',
    currencyCode: 'PLN',
    seller: { nip: '5260001246', name: 'Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1' },
    buyer: { nip: '7342867148', name: 'Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2' },
    vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
    totalGross: '123.00',
    lines: [{ lineNumber: 1, name: 'Item', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
  }

  it('accepts a standard VAT/PLN invoice with mapped rates', () => {
    expect(fa3InvoiceSchema.safeParse(validFa3).success).toBe(true)
  })

  it('normalizes the currency code to upper case so the serializer never emits a lowercase KodWaluty', () => {
    const parsed = fa3InvoiceSchema.parse({ ...validFa3, currencyCode: 'pln' })
    expect(parsed.currencyCode).toBe('PLN')
  })

  it('rejects a correction kind (KOR) without the required correction block on the direct path', () => {
    // SPEC-009: KOR is now serializable, but only WITH its correction block; absent it → rejected.
    expect(fa3InvoiceSchema.safeParse({ ...validFa3, invoiceKind: 'KOR' }).success).toBe(false)
  })

  it('rejects an advance kind (ZAL) without the required order block on the direct path', () => {
    expect(fa3InvoiceSchema.safeParse({ ...validFa3, invoiceKind: 'ZAL' }).success).toBe(false)
  })

  it('rejects a non-PLN currency with a Polish-rate bucket and no exchange rate on the direct path', () => {
    // SPEC-009 jury rule 1: a non-PLN invoice with a domestic (Polish-rate) bucket needs a rate.
    expect(fa3InvoiceSchema.safeParse({ ...validFa3, currencyCode: 'EUR' }).success).toBe(false)
  })

  it('rejects an unmapped VAT rate in the breakdown or a line on the direct path', () => {
    expect(
      fa3InvoiceSchema.safeParse({ ...validFa3, vatBreakdown: [{ rate: 19, net: '100.00', vat: '19.00' }] }).success,
    ).toBe(false)
    expect(
      fa3InvoiceSchema.safeParse({
        ...validFa3,
        lines: [{ ...validFa3.lines[0], vatRate: 19 }],
      }).success,
    ).toBe(false)
  })

  it('rejects an over-length party name / address line / invoice number before send (FA(3) maxLength)', () => {
    const over512 = 'x'.repeat(513)
    expect(fa3InvoiceSchema.safeParse({ ...validFa3, seller: { ...validFa3.seller, name: over512 } }).success).toBe(false)
    expect(
      fa3InvoiceSchema.safeParse({ ...validFa3, buyer: { ...validFa3.buyer, addressLine1: over512 } }).success,
    ).toBe(false)
    expect(fa3InvoiceSchema.safeParse({ ...validFa3, invoiceNumber: 'I'.repeat(257) }).success).toBe(false)
  })
})
