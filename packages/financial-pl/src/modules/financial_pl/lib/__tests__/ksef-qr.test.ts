import { createHash } from 'node:crypto'
import { buildKodIUrl, ksefInvoiceHashBase64Url, toBase64Url, toKodIDate } from '../ksef-qr'

const XML = '<Faktura><Nr>OM-1</Nr></Faktura>'

describe('KOD I QR', () => {
  it('formats the issue date as zero-padded DD-MM-YYYY', () => {
    expect(toKodIDate('2026-02-01')).toBe('01-02-2026')
    expect(toKodIDate('2026-12-09')).toBe('09-12-2026')
    expect(() => toKodIDate('2026/02/01')).toThrow()
  })

  it('hashes the FA(3) XML as base64url(SHA-256) with no +/ or padding', () => {
    const expected = createHash('sha256').update(Buffer.from(XML, 'utf8')).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(ksefInvoiceHashBase64Url(XML)).toBe(expected)
    expect(ksefInvoiceHashBase64Url(XML)).not.toMatch(/[+/=]/)
  })

  it('base64url-encodes raw bytes correctly', () => {
    expect(toBase64Url(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-__-')
  })

  it('builds the full KOD I URL per the official template', () => {
    const url = buildKodIUrl({ environment: 'test', sellerNip: '2481632647', issueDate: '2026-02-01', invoiceXml: XML })
    expect(url).toBe(`https://qr-test.ksef.mf.gov.pl/invoice/2481632647/01-02-2026/${ksefInvoiceHashBase64Url(XML)}`)
  })

  it('uses the prod host for prod', () => {
    const url = buildKodIUrl({ environment: 'prod', sellerNip: '2481632647', issueDate: '2026-02-01', invoiceXml: XML })
    expect(url.startsWith('https://qr.ksef.mf.gov.pl/invoice/')).toBe(true)
  })
})
