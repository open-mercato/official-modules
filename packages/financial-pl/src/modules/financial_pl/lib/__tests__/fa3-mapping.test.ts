import {
  buildAdvancePayments,
  buildAdvanceRefs,
  buildAnnotations,
  buildBuyer,
  buildLines,
  buildVatBreakdown,
  buildZamowienie,
  type Fa3MappingDeps,
} from '../fa3-mapping'

const deps: Fa3MappingDeps = { contextNip: '7980332920' }

describe('buildBuyer — UPR (simplified invoice) NIP-only branch', () => {
  it('returns a NIP-only party (no name/address) for a UPR buyer carrying only a NIP', () => {
    const invoice = { metadata: { buyerSnapshot: { nip: '3755747347' } } }
    const buyer = buildBuyer(invoice, deps, { uprNipOnly: true })
    expect(buyer.nip).toBe('3755747347')
    expect(buyer.name).toBeUndefined()
    expect(buyer.addressLine1).toBeUndefined()
  })

  it('still emits the full party for a UPR buyer that DOES carry name + address', () => {
    const invoice = {
      metadata: { buyerSnapshot: { nip: '3755747347', name: 'Klient', addressLine1: 'ul. A 1' } },
    }
    const buyer = buildBuyer(invoice, deps, { uprNipOnly: true })
    expect(buyer.name).toBe('Klient')
    expect(buyer.addressLine1).toBe('ul. A 1')
  })

  it('throws buyer_required for a UPR buyer with neither NIP nor name/address', () => {
    const invoice = { metadata: { buyerSnapshot: {} } }
    expect(() => buildBuyer(invoice, deps, { uprNipOnly: true })).toThrow()
  })

  it('throws buyer_required (unchanged) for a non-UPR buyer without name/address', () => {
    const invoice = { metadata: { buyerSnapshot: { nip: '3755747347' } } }
    expect(() => buildBuyer(invoice, deps)).toThrow()
  })
})

describe('buildAnnotations — self-billing + reverse-charge mapping', () => {
  it('maps self_billing → selfBilling and reverse_charge → reverseCharge', () => {
    const annotations = buildAnnotations({ self_billing: true, reverse_charge: true })
    expect(annotations).toEqual({ selfBilling: true, reverseCharge: true })
  })

  it('accepts string-stored booleans', () => {
    const annotations = buildAnnotations({ self_billing: 'true', reverse_charge: '1' })
    expect(annotations).toEqual({ selfBilling: true, reverseCharge: true })
  })

  it('returns undefined when no annotation flag is set', () => {
    expect(buildAnnotations({})).toBeUndefined()
  })
})

describe('buildLines — OSS / FX carry', () => {
  it('carries ossRate, procedure and fxRate onto an OSS line', () => {
    const lines = buildLines([
      {
        line_number: 1,
        name: 'Distance sale',
        quantity: '1',
        unit_price_net: '100.00',
        total_net_amount: '100.00',
        tax_amount: '19.00',
        tax_rate: '19',
        oss_rate: '19',
        procedure: 'WSTO_EE',
        fx_rate: '4.3210',
      },
    ])
    expect(lines[0].ossRate).toBe('19')
    expect(lines[0].procedure).toBe('WSTO_EE')
    expect(lines[0].fxRate).toBe('4.3210')
  })

  it('leaves a domestic line without OSS markers', () => {
    const lines = buildLines([
      { line_number: 1, name: 'Krajowa', quantity: '1', unit_price_net: '100', total_net_amount: '100', tax_amount: '23', tax_rate: '23' },
    ])
    expect(lines[0].ossRate).toBeUndefined()
    expect(lines[0].procedure).toBeUndefined()
  })
})

describe('buildVatBreakdown — OSS bucket key', () => {
  it('rolls all OSS lines into a single oss bucket regardless of distinct destination rates', () => {
    const breakdown = buildVatBreakdown(
      [
        { total_net_amount: '100.00', tax_amount: '19.00', tax_rate: '19', oss_rate: '19' },
        { total_net_amount: '50.00', tax_amount: '12.00', tax_rate: '24', oss_rate: '24' },
      ],
      '0',
      '0',
    )
    expect(breakdown).toHaveLength(1)
    expect(breakdown[0].rate).toBe('oss')
    expect(breakdown[0].net).toBe('150.00')
    expect(breakdown[0].vat).toBe('31.00')
    expect(breakdown[0].vatPln).toBeUndefined()
  })

  it('keeps OSS lines from merging into a Polish-rate bucket', () => {
    const breakdown = buildVatBreakdown(
      [
        { total_net_amount: '100.00', tax_amount: '23.00', tax_rate: '23' },
        { total_net_amount: '100.00', tax_amount: '19.00', tax_rate: '19', oss_rate: '19' },
      ],
      '0',
      '0',
    )
    const rates = breakdown.map((b) => b.rate).sort()
    expect(rates).toEqual([23, 'oss'])
  })
})

describe('buildVatBreakdown — FX P_14_xW per Polish bucket', () => {
  it('computes vatPln = round(vat × fxRate) with exact BigInt math, and never for the oss bucket', () => {
    const breakdown = buildVatBreakdown(
      [
        { total_net_amount: '100.00', tax_amount: '23.00', tax_rate: '23' },
        { total_net_amount: '100.00', tax_amount: '19.00', tax_rate: '19', oss_rate: '19' },
      ],
      '0',
      '0',
      { fxRate: '4.5000' },
    )
    const polish = breakdown.find((b) => b.rate === 23)
    const oss = breakdown.find((b) => b.rate === 'oss')
    // 23.00 × 4.5 = 103.50
    expect(polish?.vatPln).toBe('103.50')
    expect(oss?.vatPln).toBeUndefined()
  })

  it('does not emit vatPln when no FX rate is supplied (PLN invoice)', () => {
    const breakdown = buildVatBreakdown(
      [{ total_net_amount: '100.00', tax_amount: '23.00', tax_rate: '23' }],
      '0',
      '0',
    )
    expect(breakdown[0].vatPln).toBeUndefined()
  })
})

describe('buildZamowienie — order block mapping', () => {
  it('maps an order snapshot into a Zamowienie input with rounded money and normalized rates', () => {
    const order = buildZamowienie({
      totalValue: '1230.00',
      lines: [
        { name: 'Zaliczka pos. 1', quantity: '2', unitPrice: '500', netValue: '1000', vatRate: '23' },
      ],
    })
    expect(order?.totalValue).toBe('1230.00')
    expect(order?.lines).toHaveLength(1)
    expect(order?.lines[0]).toMatchObject({
      lineNumber: 1,
      name: 'Zaliczka pos. 1',
      quantity: '2',
      unitNetPrice: '500.00',
      netValue: '1000.00',
      vatRate: 23,
    })
  })

  it('returns undefined for an empty/absent order snapshot', () => {
    expect(buildZamowienie(undefined)).toBeUndefined()
    expect(buildZamowienie({ lines: [] })).toBeUndefined()
  })
})

describe('buildAdvancePayments / buildAdvanceRefs', () => {
  it('maps received-advance snapshots into ZaliczkaCzesciowa inputs', () => {
    const payments = buildAdvancePayments([
      { receivedDate: '2026-05-01', amount: '500', fxRate: '4.3' },
      { received_date: '2026-05-10', amount: '300' },
      { amount: '999' }, // skipped — no date
    ])
    expect(payments).toEqual([
      { receivedDate: '2026-05-01', amount: '500.00', fxRate: '4.3' },
      { receivedDate: '2026-05-10', amount: '300.00' },
    ])
  })

  it('maps KSeF-issued and outside-KSeF advance references', () => {
    const refs = buildAdvanceRefs([
      { ksefNumber: '2481632647-20260628-3E8AD3400000-09' },
      { invoiceNumber: 'ZAL/2026/1' },
      {}, // skipped — neither identifier
    ])
    expect(refs).toEqual([
      { ksefNumber: '2481632647-20260628-3E8AD3400000-09' },
      { invoiceNumber: 'ZAL/2026/1' },
    ])
  })
})
