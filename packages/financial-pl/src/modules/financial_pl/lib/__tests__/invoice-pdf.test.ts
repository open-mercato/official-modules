import { renderInvoicePdf } from '../invoice-pdf'
import { generateQrPng } from '../invoice-qr'
import { loadInvoiceFontBytes } from '../fonts/liberation-sans-regular.font'
import { buildInvoicePdfModel } from '../invoice-pdf-model'
import { buildKodIUrl } from '../ksef-qr'
import type { Fa3Document } from '../fa3'

function sampleDoc(): Fa3Document {
  return {
    model: {
      createdAt: '2026-02-01T10:00:00Z',
      // Polish diacritics in names exercise the embedded Unicode font.
      seller: { nip: '2481632647', name: 'Łąka Źródło Sp. z o.o.', countryCode: 'PL', addressLine1: 'ul. Żółw 1, Gdańsk' },
      buyer: { nip: '3755747347', name: 'Ćma Ńiań S.A.', countryCode: 'PL', addressLine1: 'ul. Óśmin 2, Kraków' },
      invoiceNumber: 'OM-PDF-1', issueDate: '2026-02-01', currencyCode: 'PLN',
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }], totalGross: '123.00',
    },
    lines: [{ lineNumber: 1, name: 'Usługa testowa ąęćńóśźżł', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
  }
}

function sampleModel(ksefNumber: string | null) {
  return buildInvoicePdfModel(sampleDoc(), { ksefNumber, ksefStatus: ksefNumber ? 'accepted' : 'queued', notice: 'Wizualizacja faktury ustrukturyzowanej; dokumentem źródłowym jest faktura w KSeF.' })
}

// Offline-issued invoice: no KSeF number (KOD I labelled OFFLINE) + a cert-signed KOD II.
function sampleOfflineModel() {
  return buildInvoicePdfModel(sampleDoc(), {
    ksefNumber: null,
    ksefStatus: 'offline_issued',
    notice: 'Wizualizacja faktury ustrukturyzowanej; dokumentem źródłowym jest faktura w KSeF.',
    hasKodII: true,
  })
}

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 // %PDF

describe('renderInvoicePdf', () => {
  it('renders a valid PDF with the embedded Polish font + KOD I QR', async () => {
    const url = buildKodIUrl({ environment: 'test', sellerNip: '2481632647', issueDate: '2026-02-01', invoiceXml: '<Faktura/>' })
    const qrPng = await generateQrPng(url)
    const bytes = await renderInvoicePdf(sampleModel('2481632647-20260201-ABC-09'), { fontBytes: loadInvoiceFontBytes(), qrPng })
    expect(isPdf(bytes)).toBe(true)
    expect(bytes.length).toBeGreaterThan(2000)
  })

  it('renders without a QR (OFFLINE / not yet sent)', async () => {
    const bytes = await renderInvoicePdf(sampleModel(null), { fontBytes: loadInvoiceFontBytes() })
    expect(isPdf(bytes)).toBe(true)
  })

  it('renders the dual QR (KOD I OFFLINE + KOD II CERTYFIKAT) for an offline-issued invoice', async () => {
    const model = sampleOfflineModel()
    // The model carries the KOD II descriptor; KOD I keeps the OFFLINE label.
    expect(model.ksef.label).toBe('OFFLINE')
    expect(model.ksefCert?.label).toBe('CERTYFIKAT')
    const kodIUrl = buildKodIUrl({ environment: 'test', sellerNip: '2481632647', issueDate: '2026-02-01', invoiceXml: '<Faktura/>' })
    const kodIIUrl = 'qr-test.ksef.mf.gov.pl/certificate/Nip/2481632647/2481632647/0123ABCD/HASH/SIG'
    const [qrPng, qrIiPng] = await Promise.all([generateQrPng(kodIUrl), generateQrPng(kodIIUrl)])
    const bytes = await renderInvoicePdf(model, { fontBytes: loadInvoiceFontBytes(), qrPng, qrIiPng })
    expect(isPdf(bytes)).toBe(true)
    expect(bytes.length).toBeGreaterThan(2000)
  })

  it('keeps the single-QR (KOD I only) output byte-identical when there is no KOD II', async () => {
    const url = buildKodIUrl({ environment: 'test', sellerNip: '2481632647', issueDate: '2026-02-01', invoiceXml: '<Faktura/>' })
    const qrPng = await generateQrPng(url)
    const model = sampleModel('2481632647-20260201-ABC-09')
    expect(model.ksefCert).toBeUndefined()
    // Supplying a KOD II PNG but no ksefCert block in the model must NOT draw a second QR
    // nor alter the bytes — the second QR renders only when BOTH are present.
    const a = await renderInvoicePdf(model, { fontBytes: loadInvoiceFontBytes(), qrPng })
    const b = await renderInvoicePdf(model, { fontBytes: loadInvoiceFontBytes(), qrPng, qrIiPng: await generateQrPng('qr-test.ksef.mf.gov.pl/certificate/x') })
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
  })

  it('draws the second QR (differs from single-QR) when the model HAS ksefCert AND qrIiPng is supplied', async () => {
    const url = buildKodIUrl({ environment: 'test', sellerNip: '2481632647', issueDate: '2026-02-01', invoiceXml: '<Faktura/>' })
    const qrPng = await generateQrPng(url)
    // Single-QR baseline (offline model rendered WITHOUT the KOD II PNG).
    const offlineModel = sampleOfflineModel()
    expect(offlineModel.ksefCert?.label).toBe('CERTYFIKAT')
    const single = await renderInvoicePdf(offlineModel, { fontBytes: loadInvoiceFontBytes(), qrPng })
    // Both present ⇒ the second QR is drawn ⇒ the bytes differ and it is a valid PDF.
    const qrIiPng = await generateQrPng('qr-test.ksef.mf.gov.pl/certificate/Nip/2481632647/2481632647/0123ABCD/HASH/SIG')
    const dual = await renderInvoicePdf(offlineModel, { fontBytes: loadInvoiceFontBytes(), qrPng, qrIiPng })
    expect(isPdf(dual)).toBe(true)
    expect(Buffer.compare(Buffer.from(single), Buffer.from(dual))).not.toBe(0)
  })
})

describe('generateQrPng', () => {
  it('produces PNG bytes', async () => {
    const png = await generateQrPng('https://qr-test.ksef.mf.gov.pl/invoice/2481632647/01-02-2026/abc')
    // PNG signature
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})

describe('bundled font', () => {
  it('loads a non-trivial TTF', () => {
    const bytes = loadInvoiceFontBytes()
    expect(bytes.length).toBeGreaterThan(50000)
  })
})
