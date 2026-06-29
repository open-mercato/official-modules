import {
  fa3CorrectionReferenceSchema,
  fa3InvoiceSchema,
  jpkPurchaseRecordUpsertSchema,
  jpkFilingUpsertSchema,
  jpkGenerateSchema,
} from '../validators'

// Valid seller/buyer (10-digit + checksum-valid NIPs reused across the FA(3) test suite).
const seller = {
  nip: '7980332920',
  name: 'Sprzedawca Sp. z o.o.',
  countryCode: 'PL',
  addressLine1: 'ul. Testowa 1, 00-001 Warszawa',
} as const
const buyer = {
  nip: '3755747347',
  name: 'Nabywca',
  countryCode: 'PL',
  addressLine1: 'ul. Kliencka 2, 00-002 Kraków',
} as const

type InvoiceOverrides = Partial<Parameters<typeof fa3InvoiceSchema.parse>[0]>

function baseInvoice(overrides: InvoiceOverrides = {}) {
  return {
    invoiceNumber: 'FV/2026/06/1',
    issueDate: '2026-06-28',
    currencyCode: 'PLN',
    seller,
    buyer,
    vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
    totalGross: '123.00',
    lines: [
      { lineNumber: 1, name: 'Pozycja', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
    ],
    ...overrides,
  }
}

// The corrected-invoice KSeF number flows into FA(3) `NrKSeFFaKorygowanej`. KSeF rejects a
// malformed value with a 450 `TNumerKSeF` pattern error; we want that caught locally instead.
describe('fa3CorrectionReferenceSchema.correctedKsefNumber', () => {
  const base = { correctedIssueDate: '2026-06-28', correctedInvoiceNumber: 'OM-FV-2026-0001' }

  it('accepts a real (hyphenated) KSeF number', () => {
    expect(() =>
      fa3CorrectionReferenceSchema.parse({ ...base, correctedKsefNumber: '2481632647-20260628-3E8AD3400000-09' }),
    ).not.toThrow()
  })

  it('rejects a structurally invalid corrected KSeF number (caught before KSeF 450)', () => {
    expect(() =>
      fa3CorrectionReferenceSchema.parse({ ...base, correctedKsefNumber: 'TOTALLY-INVALID-NUMBER' }),
    ).toThrow()
  })

  it('allows an absent corrected KSeF number (original issued outside KSeF → NrKSeFN)', () => {
    expect(() => fa3CorrectionReferenceSchema.parse(base)).not.toThrow()
  })
})

describe('fa3InvoiceSchema — baseline VAT (backward compatibility)', () => {
  it('accepts a standard PLN VAT invoice', () => {
    expect(() => fa3InvoiceSchema.parse(baseInvoice())).not.toThrow()
  })

  it('accepts a standard VAT invoice with the kind explicitly set', () => {
    expect(() => fa3InvoiceSchema.parse(baseInvoice({ invoiceKind: 'VAT' }))).not.toThrow()
  })
})

describe('fa3InvoiceSchema — per-kind requirements', () => {
  it('ZAL requires the order (Zamowienie) block; FaWiersz is optional', () => {
    expect(() => fa3InvoiceSchema.parse(baseInvoice({ invoiceKind: 'ZAL', lines: [] }))).toThrow()
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          invoiceKind: 'ZAL',
          lines: [],
          order: { totalValue: '123.00', lines: [{ lineNumber: 1, name: 'Pos', netValue: '100.00', vatRate: 23 }] },
        }),
      ),
    ).not.toThrow()
  })

  it('ROZ requires advanceInvoiceRefs and at least one FaWiersz', () => {
    expect(() => fa3InvoiceSchema.parse(baseInvoice({ invoiceKind: 'ROZ' }))).toThrow()
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({ invoiceKind: 'ROZ', advanceInvoiceRefs: [{ invoiceNumber: 'ZAL/2026/1' }] }),
      ),
    ).not.toThrow()
  })

  it('KOR_ZAL requires the correction block + preCorrectionPaymentAmount + order', () => {
    // missing correction
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          invoiceKind: 'KOR_ZAL',
          lines: [],
          order: { totalValue: '123.00', lines: [{ lineNumber: 1, name: 'Pos', netValue: '100.00', vatRate: 23 }] },
        }),
      ),
    ).toThrow()
    // missing preCorrectionPaymentAmount
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          invoiceKind: 'KOR_ZAL',
          lines: [],
          order: { totalValue: '123.00', lines: [{ lineNumber: 1, name: 'Pos', netValue: '100.00', vatRate: 23 }] },
          correction: { correctedInvoices: [{ correctedIssueDate: '2026-05-01', correctedInvoiceNumber: 'ZAL/2026/1' }] },
        }),
      ),
    ).toThrow()
    // complete
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          invoiceKind: 'KOR_ZAL',
          lines: [],
          order: { totalValue: '123.00', lines: [{ lineNumber: 1, name: 'Pos', netValue: '100.00', vatRate: 23 }] },
          correction: {
            correctedInvoices: [{ correctedIssueDate: '2026-05-01', correctedInvoiceNumber: 'ZAL/2026/1' }],
            preCorrectionPaymentAmount: '100.00',
          },
        }),
      ),
    ).not.toThrow()
  })

  it('rejects a correction block on a non-correction kind', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          invoiceKind: 'VAT',
          correction: { correctedInvoices: [{ correctedIssueDate: '2026-05-01', correctedInvoiceNumber: 'X' }] },
        }),
      ),
    ).toThrow()
  })
})

describe('fa3InvoiceSchema — UPR (simplified) buyer + threshold', () => {
  it('accepts a NIP-only buyer for UPR', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({ invoiceKind: 'UPR', buyer: { nip: '3755747347', countryCode: 'PL' } }),
      ),
    ).not.toThrow()
  })

  it('rejects a UPR total over the 450 PLN threshold', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          invoiceKind: 'UPR',
          buyer: { nip: '3755747347', countryCode: 'PL' },
          vatBreakdown: [{ rate: 23, net: '500.00', vat: '115.00' }],
          totalGross: '615.00',
          lines: [{ lineNumber: 1, name: 'Pozycja', quantity: '1', unitNetPrice: '500.00', netValue: '500.00', vatRate: 23 }],
        }),
      ),
    ).toThrow()
  })

  it('accepts a UPR total at/under the 450 PLN threshold', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          invoiceKind: 'UPR',
          buyer: { nip: '3755747347', countryCode: 'PL' },
          vatBreakdown: [{ rate: 23, net: '300.00', vat: '69.00' }],
          totalGross: '369.00',
          lines: [{ lineNumber: 1, name: 'Pozycja', quantity: '1', unitNetPrice: '300.00', netValue: '300.00', vatRate: 23 }],
        }),
      ),
    ).not.toThrow()
  })

  it('a non-UPR kind still requires the buyer name + address', () => {
    expect(() =>
      fa3InvoiceSchema.parse(baseInvoice({ buyer: { nip: '3755747347', countryCode: 'PL' } })),
    ).toThrow()
  })
})

describe('fa3InvoiceSchema — OSS / WSTO_EE lines', () => {
  function ossLine(extra: Record<string, unknown> = {}) {
    return {
      lineNumber: 1,
      name: 'Distance sale',
      quantity: '1',
      unitNetPrice: '100.00',
      netValue: '100.00',
      vatRate: 23,
      ossRate: '19',
      ...extra,
    }
  }

  it('accepts an OSS line with ossRate + Procedura=WSTO_EE and an oss bucket', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          currencyCode: 'EUR',
          vatBreakdown: [{ rate: 'oss', net: '100.00', vat: '19.00' }],
          totalGross: '119.00',
          lines: [ossLine({ procedure: 'WSTO_EE', fxRate: '4.30' })],
        }),
      ),
    ).not.toThrow()
  })

  it('rejects an OSS line that omits the Procedura=WSTO_EE marker', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          currencyCode: 'EUR',
          vatBreakdown: [{ rate: 'oss', net: '100.00', vat: '19.00' }],
          totalGross: '119.00',
          lines: [ossLine()],
        }),
      ),
    ).toThrow()
  })

  it('keeps rejecting a truly-unmapped Polish line rate', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          vatBreakdown: [{ rate: 19, net: '100.00', vat: '19.00' }],
          lines: [{ lineNumber: 1, name: 'Pozycja', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 19 }],
        }),
      ),
    ).toThrow()
  })
})

describe('fa3InvoiceSchema — foreign currency (jury resolution 1)', () => {
  it('accepts a PURE-OSS foreign-currency invoice WITHOUT an exchange rate', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          currencyCode: 'EUR',
          vatBreakdown: [{ rate: 'oss', net: '100.00', vat: '19.00' }],
          totalGross: '119.00',
          lines: [
            { lineNumber: 1, name: 'Distance sale', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23, ossRate: '19', procedure: 'WSTO_EE' },
          ],
        }),
      ),
    ).not.toThrow()
  })

  it('requires an exchange rate when a non-PLN invoice carries a Polish-rate bucket', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          currencyCode: 'EUR',
          vatBreakdown: [
            { rate: 23, net: '100.00', vat: '23.00' },
            { rate: 'oss', net: '100.00', vat: '19.00' },
          ],
          totalGross: '242.00',
          lines: [
            { lineNumber: 1, name: 'Krajowa', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
            { lineNumber: 2, name: 'OSS', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23, ossRate: '19', procedure: 'WSTO_EE' },
          ],
        }),
      ),
    ).toThrow()
  })

  it('accepts a non-PLN invoice with a Polish-rate bucket WHEN an exchange rate is supplied', () => {
    expect(() =>
      fa3InvoiceSchema.parse(
        baseInvoice({
          currencyCode: 'EUR',
          exchangeRate: '4.3000',
          vatBreakdown: [
            { rate: 23, net: '100.00', vat: '23.00', vatPln: '98.90' },
            { rate: 'oss', net: '100.00', vat: '19.00' },
          ],
          totalGross: '242.00',
          lines: [
            { lineNumber: 1, name: 'Krajowa', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23, fxRate: '4.3000' },
            { lineNumber: 2, name: 'OSS', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23, ossRate: '19', procedure: 'WSTO_EE', fxRate: '4.3000' },
          ],
        }),
      ),
    ).not.toThrow()
  })
})

describe('JPK validators (SPEC-012)', () => {
  const validKsef = '2481632647-20261005-3F8DD3400000-57'
  const basePurchase = { year: 2026, month: 6, documentNumber: 'FZ/1', purchaseDate: '2026-06-10' }

  describe('jpkPurchaseRecordUpsertSchema', () => {
    it('rejects ksefMarking=NrKSeF without a non-empty nrKsef (empty <NrKSeF/> is XSD-invalid)', () => {
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, ksefMarking: 'NrKSeF' }).success).toBe(false)
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, ksefMarking: 'NrKSeF', nrKsef: '   ' }).success).toBe(false)
    })
    it('accepts ksefMarking=NrKSeF with a structurally valid nrKsef', () => {
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, ksefMarking: 'NrKSeF', nrKsef: validKsef }).success).toBe(true)
    })
    it('rejects a structurally invalid nrKsef', () => {
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, ksefMarking: 'NrKSeF', nrKsef: 'not-a-ksef' }).success).toBe(false)
    })
    it('defaults transactionClass to domestic', () => {
      expect(jpkPurchaseRecordUpsertSchema.parse({ ...basePurchase }).transactionClass).toBe('domestic')
    })
    it('optionalMoneySchema accepts an empty string and rejects > 2 fraction digits', () => {
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, netOther: '' }).success).toBe(true)
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, netOther: '1.234' }).success).toBe(false)
    })
    it('accepts selfAssessedRate (L9 — captured rate for self-assessment)', () => {
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, selfAssessedRate: '23.00' }).success).toBe(true)
    })
    it('rejects out-of-range year/month', () => {
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, year: 2025 }).success).toBe(false)
      expect(jpkPurchaseRecordUpsertSchema.safeParse({ ...basePurchase, month: 13 }).success).toBe(false)
    })
  })

  describe('jpkFilingUpsertSchema', () => {
    const base = { variant: 'V7M' as const, year: 2026, month: 6, kodUrzedu: '0202' }
    it('rejects a non-4-digit kodUrzedu', () => {
      expect(jpkFilingUpsertSchema.safeParse({ ...base, kodUrzedu: '20' }).success).toBe(false)
    })
    it('defaults celZlozenia=1 and correctionScope=both', () => {
      const r = jpkFilingUpsertSchema.parse({ ...base })
      expect(r.celZlozenia).toBe(1)
      expect(r.correctionScope).toBe('both')
    })
    it('L7: rejects a partial correctionScope on a primary filing (celZlozenia=1)', () => {
      expect(jpkFilingUpsertSchema.safeParse({ ...base, celZlozenia: 1, correctionScope: 'declaration' }).success).toBe(false)
      expect(jpkFilingUpsertSchema.safeParse({ ...base, celZlozenia: 1, correctionScope: 'evidence' }).success).toBe(false)
    })
    it('L7: allows a partial correctionScope on a correction filing (celZlozenia=2)', () => {
      expect(jpkFilingUpsertSchema.safeParse({ ...base, celZlozenia: 2, correctionScope: 'declaration' }).success).toBe(true)
    })
    it('accepts an optional contextNip (H4)', () => {
      expect(jpkFilingUpsertSchema.safeParse({ ...base, contextNip: '7980332920' }).success).toBe(true)
    })
    it('rejects out-of-range month/year/quarter', () => {
      expect(jpkFilingUpsertSchema.safeParse({ ...base, month: 0 }).success).toBe(false)
      expect(jpkFilingUpsertSchema.safeParse({ ...base, year: 2025 }).success).toBe(false)
      expect(jpkFilingUpsertSchema.safeParse({ ...base, quarter: 5 }).success).toBe(false)
    })
  })

  describe('jpkGenerateSchema', () => {
    it('requires a uuid filingId', () => {
      expect(jpkGenerateSchema.safeParse({ filingId: 'not-a-uuid' }).success).toBe(false)
      expect(jpkGenerateSchema.safeParse({ filingId: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true)
    })
  })
})
