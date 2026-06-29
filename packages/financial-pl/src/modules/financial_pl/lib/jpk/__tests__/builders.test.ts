import { buildSprzedazRow } from '../build-sprzedaz'
import { buildZakupRows } from '../build-zakup'
import { computeJpkDeclaration } from '../compute-declaration'
import { buildJpkXml } from '../build-jpk-xml'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ksef = { kind: 'NrKSeF' as const, value: '2481632647-20261005-3F8DD3400000-57' }
const buyer = { nip: '3755747347', name: 'Buyer', countryCode: 'PL' }
const base = { buyer, dowodSprzedazy: 'FV/1', dataWystawienia: '2026-10-05', ksef }

describe('buildSprzedazRow (rate → K mapping)', () => {
  it('maps 23% to K_19/K_20', () => {
    const row = buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 23, net: '1000.00', vat: '230.00' }] })
    expect(row?.k).toEqual({ K_19: '1000.00', K_20: '230.00' })
  })
  it('maps 8%→K_17/18, 5%→K_15/16, exempt→K_10, reverse-charge→K_31/32', () => {
    expect(buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 8, net: '100.00', vat: '8.00' }] })?.k).toEqual({ K_17: '100.00', K_18: '8.00' })
    expect(buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 5, net: '100.00', vat: '5.00' }] })?.k).toEqual({ K_15: '100.00', K_16: '5.00' })
    expect(buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 'zw', net: '100.00', vat: '0.00' }] })?.k).toEqual({ K_10: '100.00' })
    expect(buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 'oo', net: '100.00', vat: '23.00' }] })?.k).toEqual({ K_31: '100.00', K_32: '23.00' })
  })
  it('DROPS the OSS bucket (VIU-DO) and returns null for a purely-OSS sale', () => {
    expect(buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 'oss', net: '100.00', vat: '19.00' }] })).toBeNull()
    const mixed = buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }, { rate: 'oss', net: '50.00', vat: '9.50' }] })
    expect(mixed?.k).toEqual({ K_19: '100.00', K_20: '23.00' }) // OSS dropped
  })
  it('carries BRAK for a no-NIP consumer + GTU/markers', () => {
    const row = buildSprzedazRow({ ...base, buyer: { name: null, nip: null }, vatBreakdown: [{ rate: 23, net: '10.00', vat: '2.30' }], gtu: ['GTU_01'], procedures: { TP: true } })
    expect(row?.nrKontrahenta).toBe('BRAK')
    expect(row?.gtu).toEqual({ GTU_01: true })
    expect(row?.procedures).toEqual({ TP: true })
  })
})

describe('buildZakupRows (input + self-assessment)', () => {
  const sup = { supplier: { nip: '5260001246', name: 'Supplier', countryCode: 'PL' }, dowodZakupu: 'FZ/1', dataZakupu: '2026-10-03', ksef }
  it('domestic purchase → only a ZakupWiersz (K_42/K_43)', () => {
    const { zakup, sprzedaz } = buildZakupRows({ ...sup, transactionClass: 'domestic', netOther: '200.00', vatOther: '46.00' })
    expect(zakup.k).toEqual({ K_42: '200.00', K_43: '46.00' })
    expect(sprzedaz).toBeUndefined()
  })
  it('WNT → ZakupWiersz (K_42/K_43) + self-assessment SprzedazWiersz (K_23/K_24)', () => {
    const { zakup, sprzedaz } = buildZakupRows({
      ...sup, supplier: { nip: 'DE123456789', name: 'EU Supplier', countryCode: 'DE' },
      transactionClass: 'wnt', netOther: '1000.00', vatOther: '230.00', selfAssessedNet: '1000.00', selfAssessedVat: '230.00',
    })
    expect(zakup.k).toEqual({ K_42: '1000.00', K_43: '230.00' })
    expect(sprzedaz?.k).toEqual({ K_23: '1000.00', K_24: '230.00' })
  })
})

function validate(xml: string): string {
  let bin = ''
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); bin = 'xmllint' } catch { return '' }
  const dir = mkdtempSync(join(tmpdir(), 'jpk-b-'))
  const file = join(dir, 'j.xml'); writeFileSync(file, xml)
  try { execFileSync(bin, ['--noout', '--schema', join(__dirname, '..', 'schema', 'JPK_V7M-3.xsd'), file], { stdio: 'pipe' }); return '' }
  catch (e: unknown) { const x = e as { stderr?: Buffer }; return (x.stderr?.toString() ?? String(e)).trim() }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('XSD-grouped base/VAT pairs are emitted together even when VAT is zero (code-jury regression)', () => {
  it('K_42 with no VAT → K_42 + K_43=0.00; WNT zero-VAT → P_23 + P_24 pair; XSD-valid', () => {
    // Purchase with a net but no VAT → the K_42/K_43 group must carry both (K_43=0.00).
    const { zakup } = buildZakupRows({ supplier: { nip: '5260001246' }, dowodZakupu: 'FZ/9', dataZakupu: '2026-10-03', ksef, transactionClass: 'domestic', netOther: '100.00' })
    expect(zakup.k).toEqual({ K_42: '100.00', K_43: '0.00' })
    // A WNT self-assessment with zero output VAT → SprzedazWiersz K_23 + K_24=0.00; declaration P_23 + P_24.
    const { sprzedaz, zakup: z2 } = buildZakupRows({ supplier: { nip: 'DE1', countryCode: 'DE' }, dowodZakupu: 'FZ/10', dataZakupu: '2026-10-03', ksef, transactionClass: 'wnt', netOther: '200.00', vatOther: '0.00', selfAssessedNet: '200.00', selfAssessedVat: '0.00' })
    const { declaration, ctrl } = computeJpkDeclaration({ variant: 'V7M', sprzedaz: [sprzedaz!], zakup: [z2] })
    expect(declaration.P_23).toBe('200')
    expect(declaration.P_24).toBe('0') // pair member emitted even though zero
    const xml = buildJpkXml({
      variant: 'V7M', celZlozenia: 1, correctionScope: 'both',
      naglowek: { dataWytworzenia: '2026-11-15T10:00:00Z', kodUrzedu: '1471', rok: 2026, miesiac: 10 },
      podmiot1: { nip: '2481632647', pelnaNazwa: 'OM', email: 't@e.pl' },
      deklaracja: { pozycje: declaration },
      ewidencja: { sprzedaz: [sprzedaz!], zakup: [z2], sprzedazCtrl: ctrl.sprzedazCtrl, zakupCtrl: ctrl.zakupCtrl },
    })
    expect(validate(xml)).toBe('')
  })
})

describe('builders → XSD-valid file', () => {
  it('a WNT purchase produces an XSD-valid V7M file (dual rows)', () => {
    const { zakup, sprzedaz } = buildZakupRows({
      supplier: { nip: 'DE123456789', name: 'EU Supplier', countryCode: 'DE' }, dowodZakupu: 'FZ/1', dataZakupu: '2026-10-03', ksef,
      transactionClass: 'wnt', netOther: '1000.00', vatOther: '230.00', selfAssessedNet: '1000.00', selfAssessedVat: '230.00',
    })
    const sale = buildSprzedazRow({ ...base, vatBreakdown: [{ rate: 23, net: '500.00', vat: '115.00' }] })!
    const sprzedazRows = [sale, sprzedaz!]
    const { declaration, ctrl } = computeJpkDeclaration({ variant: 'V7M', sprzedaz: sprzedazRows, zakup: [zakup] })
    const xml = buildJpkXml({
      variant: 'V7M', celZlozenia: 1, correctionScope: 'both',
      naglowek: { dataWytworzenia: '2026-11-15T10:00:00Z', kodUrzedu: '1471', rok: 2026, miesiac: 10 },
      podmiot1: { nip: '2481632647', pelnaNazwa: 'OM Test', email: 't@e.pl' },
      deklaracja: { pozycje: declaration },
      ewidencja: { sprzedaz: sprzedazRows, zakup: [zakup], sprzedazCtrl: ctrl.sprzedazCtrl, zakupCtrl: ctrl.zakupCtrl },
    })
    expect(validate(xml)).toBe('')
  })
})
