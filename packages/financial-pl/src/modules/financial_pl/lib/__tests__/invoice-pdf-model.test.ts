import { buildInvoicePdfModel } from '../invoice-pdf-model'
import type { Fa3Document } from '../fa3'

const seller = { nip: '2481632647', name: 'Sprzedawca Sp. z o.o.', countryCode: 'PL', addressLine1: 'ul. Łączna 1, 00-001 Warszawa' }
const buyer = { nip: '3755747347', name: 'Nabywca S.A.', countryCode: 'PL', addressLine1: 'ul. Żółta 2, 30-001 Kraków' }

function invoiceDoc(): Fa3Document {
  return {
    model: {
      createdAt: '2026-02-01T10:00:00Z', seller, buyer, invoiceNumber: 'OM-1', issueDate: '2026-02-01', currencyCode: 'PLN',
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }, { rate: 8, net: '50.00', vat: '4.00' }], totalGross: '177.00',
    },
    lines: [
      { lineNumber: 1, name: 'Usługa A', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
      { lineNumber: 2, name: 'Usługa B', unit: 'szt', quantity: '1', unitNetPrice: '50.00', netValue: '50.00', vatRate: 8 },
    ],
  }
}

describe('buildInvoicePdfModel', () => {
  it('maps an accepted VAT invoice with totals + per-line VAT', () => {
    const m = buildInvoicePdfModel(invoiceDoc(), { ksefNumber: '2481632647-20260201-ABC-09', ksefStatus: 'accepted', notice: 'Wizualizacja...' })
    expect(m.title).toBe('FAKTURA')
    expect(m.totalNet).toBe('150.00')
    expect(m.totalVat).toBe('27.00')
    expect(m.totalGross).toBe('177.00')
    expect(m.lines[0]).toMatchObject({ lp: 1, vatRateLabel: '23%', vat: '23.00', gross: '123.00' })
    expect(m.lines[1]).toMatchObject({ vatRateLabel: '8%', vat: '4.00', gross: '54.00' })
    expect(m.vatSummary).toHaveLength(2)
    expect(m.ksef).toEqual({ number: '2481632647-20260201-ABC-09', label: '2481632647-20260201-ABC-09', status: 'accepted' })
  })

  it('labels OFFLINE when no KSeF number is assigned', () => {
    const m = buildInvoicePdfModel(invoiceDoc(), { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })
    expect(m.ksef.number).toBeUndefined()
    expect(m.ksef.label).toBe('OFFLINE')
  })

  it('maps a transfer payment block for the PDF view', () => {
    const doc = invoiceDoc()
    doc.model.payment = {
      formaCode: '6',
      terminDate: '2026-07-14',
      bankAccount: 'PL61109010140000071219812874',
    }
    const m = buildInvoicePdfModel(doc, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })
    expect(m.payment).toMatchObject({
      methodLabel: 'Przelew',
      term: '2026-07-14',
      account: 'PL61109010140000071219812874',
    })
  })

  it('maps cash and marks the payment as paid when paidDate is set', () => {
    const doc = invoiceDoc()
    doc.model.payment = { formaCode: '1', paidDate: '2026-07-01' }
    const m = buildInvoicePdfModel(doc, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })
    expect(m.payment).toMatchObject({ methodLabel: 'Gotówka', paid: true })
  })

  it('uses other payment description when no FormaPlatnosci code is set', () => {
    const doc = invoiceDoc()
    doc.model.payment = { otherDescription: 'Za pobraniem' }
    const m = buildInvoicePdfModel(doc, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })
    expect(m.payment?.methodLabel).toBe('Za pobraniem')
  })

  it('omits the payment key when the FA(3) model has no payment block', () => {
    const m = buildInvoicePdfModel(invoiceDoc(), { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })
    expect('payment' in m).toBe(false)
  })

  it('handles a KOR correction with negative amounts', () => {
    const doc = invoiceDoc()
    doc.model.invoiceKind = 'KOR'
    doc.model.vatBreakdown = [{ rate: 23, net: '-100.00', vat: '-23.00' }]
    doc.model.totalGross = '-123.00'
    doc.model.correction = { reason: 'Korekta ilości', correctedInvoices: [{ correctedIssueDate: '2026-01-01', correctedInvoiceNumber: 'OM-0', correctedKsefNumber: 'X' }] }
    doc.lines = [{ lineNumber: 1, name: 'Usługa A', unit: 'szt', quantity: '-1', unitNetPrice: '100.00', netValue: '-100.00', vatRate: 23 }]
    const m = buildInvoicePdfModel(doc, { ksefNumber: 'KOR-NO', ksefStatus: 'accepted', notice: 'x' })
    expect(m.title).toBe('FAKTURA KORYGUJĄCA')
    expect(m.totalNet).toBe('-100.00')
    expect(m.totalVat).toBe('-23.00')
    expect(m.lines[0].vat).toBe('-23.00')
    expect(m.lines[0].gross).toBe('-123.00')
    expect(m.correctionReason).toBe('Korekta ilości')
  })

  it('renders zw/np/oo rate labels with zero line VAT', () => {
    const doc = invoiceDoc()
    doc.lines = [{ lineNumber: 1, name: 'Zwolniona', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 'zw' }]
    const m = buildInvoicePdfModel(doc, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })
    expect(m.lines[0].vatRateLabel).toBe('zw')
    expect(m.lines[0].vat).toBe('0.00')
    expect(m.lines[0].gross).toBe('100.00')
  })
})
