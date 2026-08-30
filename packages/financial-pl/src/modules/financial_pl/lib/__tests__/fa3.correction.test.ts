import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFa3Xml, type Fa3Document } from '../fa3'

function correctionDocument(overrides: Partial<Fa3Document['model']['correction']> = {}): Fa3Document {
  return {
    model: {
      createdAt: '2026-06-27T10:00:00Z',
      seller: { nip: '2481632647', name: 'Sprzedawca Sp. z o.o.', countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
      buyer: { nip: '3755747347', name: 'Nabywca Sp. z o.o.', countryCode: 'PL', addressLine1: 'ul. Kliencka 2', addressLine2: '00-002 Krakow' },
      invoiceNumber: 'KOR/2026/06/1',
      issueDate: '2026-06-27',
      currencyCode: 'PLN',
      invoiceKind: 'KOR',
      vatBreakdown: [{ rate: 23, net: '-40.00', vat: '-9.20' }],
      totalGross: '-49.20',
      correction: {
        reason: 'Korekta ilosci',
        correctionType: 2,
        correctedInvoices: [
          { correctedIssueDate: '2026-06-20', correctedInvoiceNumber: 'FV/2026/06/1', correctedKsefNumber: '2481632647-20260620-AABBCC-DDEEFF-11' },
        ],
        ...overrides,
      },
    },
    lines: [
      { lineNumber: 1, name: 'Usluga', unit: 'szt', quantity: '-1', unitNetPrice: '40.00', netValue: '-40.00', vatRate: 23 },
    ],
  }
}

describe('FA(3) correction (KOR) serialization', () => {
  it('emits RodzajFaktury=KOR with the correction block in the exact XSD order', () => {
    const xml = buildFa3Xml(correctionDocument())
    expect(xml).toContain('<RodzajFaktury>KOR</RodzajFaktury>')
    // Order: RodzajFaktury → PrzyczynaKorekty → TypKorekty → DaneFaKorygowanej → FaWiersz.
    const order = ['<RodzajFaktury>', '<PrzyczynaKorekty>', '<TypKorekty>', '<DaneFaKorygowanej>', '<FaWiersz>'].map(
      (tag) => xml.indexOf(tag),
    )
    expect(order.every((pos) => pos >= 0)).toBe(true)
    expect([...order]).toEqual([...order].sort((a, b) => a - b))
  })

  it('references an in-KSeF original via NrKSeF=1 + NrKSeFFaKorygowanej', () => {
    const xml = buildFa3Xml(correctionDocument())
    const block = xml.slice(xml.indexOf('<DaneFaKorygowanej>'), xml.indexOf('</DaneFaKorygowanej>'))
    expect(block).toContain('<DataWystFaKorygowanej>2026-06-20</DataWystFaKorygowanej>')
    expect(block).toContain('<NrFaKorygowanej>FV/2026/06/1</NrFaKorygowanej>')
    expect(block).toContain('<NrKSeF>1</NrKSeF>')
    expect(block).toContain('<NrKSeFFaKorygowanej>2481632647-20260620-AABBCC-DDEEFF-11</NrKSeFFaKorygowanej>')
    expect(block).not.toContain('<NrKSeFN>')
  })

  it('references an outside-KSeF (legacy) original via NrKSeFN=1 when no KSeF number is known', () => {
    const xml = buildFa3Xml(
      correctionDocument({ correctedInvoices: [{ correctedIssueDate: '2025-12-01', correctedInvoiceNumber: 'PAPIER/2025/12/9' }] }),
    )
    const block = xml.slice(xml.indexOf('<DaneFaKorygowanej>'), xml.indexOf('</DaneFaKorygowanej>'))
    expect(block).toContain('<NrKSeFN>1</NrKSeFN>')
    expect(block).not.toContain('<NrKSeF>1</NrKSeF>')
    expect(block).not.toContain('<NrKSeFFaKorygowanej>')
  })

  it('omits PrzyczynaKorekty / TypKorekty when absent (both optional in FA(3))', () => {
    const xml = buildFa3Xml(
      correctionDocument({ reason: undefined, correctionType: undefined }),
    )
    expect(xml).toContain('<DaneFaKorygowanej>')
    expect(xml).not.toContain('<PrzyczynaKorekty>')
    expect(xml).not.toContain('<TypKorekty>')
  })

  it('throws when a correction references no corrected invoice', () => {
    const doc = correctionDocument()
    doc.model.correction = { reason: 'x', correctedInvoices: [] }
    expect(() => buildFa3Xml(doc)).toThrow()
  })

  // Regulation-critical: validate the generated correction against the official FA(3) XSD.
  // Gated on OM_KSEF_FA3_XSD (path to schemat_FA(3)_v1-0E.xsd) + an available xmllint, so it
  // runs in environments that provide the schema and is skipped (not failed) elsewhere.
  const xsdPath = process.env.OM_KSEF_FA3_XSD
  const maybe = xsdPath ? it : it.skip
  maybe('validates a KOR document against the official FA(3) XSD (xmllint)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa3-kor-'))
    const file = join(dir, 'kor.xml')
    writeFileSync(file, buildFa3Xml(correctionDocument()))
    // Throws (non-zero exit) if validation fails; the assertion is "does not throw".
    execFileSync('xmllint', ['--noout', '--schema', xsdPath as string, file], { stdio: 'pipe' })
  })
})
