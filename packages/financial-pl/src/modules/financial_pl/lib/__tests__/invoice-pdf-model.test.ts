import { MARGIN_WORDING_PL, buildInvoicePdfModel } from '../invoice-pdf-model'
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
    expect(m.hasDiscounts).toBe(false)
    expect(m.discountTotal).toBeUndefined()
    expect(m.totalNet).toBe('150.00')
    expect(m.totalVat).toBe('27.00')
    expect(m.totalGross).toBe('177.00')
    expect(m.lines[0]).toMatchObject({ lp: 1, vatRateLabel: '23%', vat: '23.00', gross: '123.00' })
    expect(m.lines[1]).toMatchObject({ vatRateLabel: '8%', vat: '4.00', gross: '54.00' })
    expect(m.vatSummary).toHaveLength(2)
    expect(m.ksef).toEqual({ number: '2481632647-20260201-ABC-09', label: '2481632647-20260201-ABC-09', status: 'accepted' })
  })

  it('maps discounted line fields and total discount for the PDF view', () => {
    const doc = invoiceDoc()
    doc.model.vatBreakdown = [{ rate: 23, net: '90.00', vat: '20.70' }, { rate: 8, net: '50.00', vat: '4.00' }]
    doc.model.totalGross = '164.70'
    doc.lines[0] = {
      lineNumber: 1,
      name: 'Usługa A',
      unit: 'szt',
      quantity: '1',
      unitNetPrice: '100.00',
      discount: '10.00',
      netValue: '90.00',
      vatRate: 23,
    }
    ;(doc.lines[0] as typeof doc.lines[number] & { discountPercent: string }).discountPercent = '10.00'

    const m = buildInvoicePdfModel(doc, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })

    expect(m.hasDiscounts).toBe(true)
    expect(m.discountTotal).toBe('10.00')
    expect(m.lines[0]).toMatchObject({
      discountPct: '10.00',
      discountAmount: '10.00',
      net: '90.00',
      vat: '20.70',
      gross: '110.70',
    })
  })

  it('collapses a VAT marża invoice to gross-only PDF rows with statutory wording', () => {
    const doc = invoiceDoc()
    doc.model.annotations = { marginScheme: 'used_goods' }
    doc.model.vatBreakdown = [{ rate: 'margin', net: '177.00', vat: '0.00' }]
    doc.model.totalGross = '177.00'
    doc.lines = [{
      lineNumber: 1,
      name: 'Towar używany',
      unit: 'szt',
      quantity: '1',
      unitNetPrice: '177.00',
      unitGrossPrice: '177.00',
      netValue: '177.00',
      grossValue: '177.00',
      vatRate: 'np',
      marginRow: true,
    }]

    const m = buildInvoicePdfModel(doc, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })

    expect(m.marginScheme).toBe('used_goods')
    expect(m.marginWordingKey).toBe('used_goods')
    expect(m.lines[0]).toMatchObject({ unitNet: '177.00', net: '177.00', vatRateLabel: 'marża', vat: '', gross: '177.00' })
    expect(m.vatSummary).toEqual([{ vatRateLabel: MARGIN_WORDING_PL.used_goods, gross: '177.00' }])
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

  it('builds payment QR payload for unpaid PLN invoices with a valid NRB', () => {
    const doc = invoiceDoc()
    doc.model.seller = { ...seller, name: 'Seller SA' }
    doc.model.payment = {
      formaCode: '6',
      terminDate: '2026-07-14',
      bankAccount: '61109010140000071219812874',
    }

    const m = buildInvoicePdfModel(doc, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' })

    expect(m.paymentQr).toEqual({
      label: 'Zapłać przelewem',
      payload: '2481632647|PL|61109010140000071219812874|017700|Seller SA|FV OM-1|||',
    })
  })

  it('omits payment QR for paid, non-PLN, and invalid-NRB invoices', () => {
    const paid = invoiceDoc()
    paid.model.payment = { formaCode: '6', bankAccount: '61109010140000071219812874', paidDate: '2026-07-01' }
    expect(buildInvoicePdfModel(paid, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' }).paymentQr).toBeUndefined()

    const nonPln = invoiceDoc()
    nonPln.model.currencyCode = 'EUR'
    nonPln.model.payment = { formaCode: '6', bankAccount: '61109010140000071219812874' }
    expect(buildInvoicePdfModel(nonPln, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' }).paymentQr).toBeUndefined()

    const invalid = invoiceDoc()
    invalid.model.payment = { formaCode: '6', bankAccount: '123' }
    expect(buildInvoicePdfModel(invalid, { ksefNumber: null, ksefStatus: 'queued', notice: 'x' }).paymentQr).toBeUndefined()
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
