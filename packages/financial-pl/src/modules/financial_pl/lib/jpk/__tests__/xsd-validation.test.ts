/**
 * XSD-validation gate (SPEC-012): build JPK files and validate them against the RAW official
 * schemas (vendored under ../schema) via `xmllint --schema`. This is the binding structural
 * correctness check — the XSD enforces element order/occurs/types the unit tests cannot.
 *
 * Skipped (with a clear log) if `xmllint` is unavailable, so CI without libxml2 still passes;
 * it runs wherever xmllint exists (macOS/Linux ship it).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildJpkXml, type BuildJpkXmlInput } from '../build-jpk-xml'
import { computeJpkDeclaration } from '../compute-declaration'
import { JPK_NAMESPACE, type JpkSprzedazRow, type JpkZakupRow } from '../jpk-codes'

const SCHEMA_DIR = join(__dirname, '..', 'schema')

function hasXmllint(): boolean {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function validate(xml: string, variant: 'V7M' | 'V7K'): string {
  const dir = mkdtempSync(join(tmpdir(), 'jpk-xsd-'))
  const file = join(dir, 'jpk.xml')
  writeFileSync(file, xml)
  const schema = join(SCHEMA_DIR, variant === 'V7M' ? 'JPK_V7M-3.xsd' : 'JPK_V7K-3.xsd')
  try {
    execFileSync('xmllint', ['--noout', '--schema', schema, file], { stdio: 'pipe' })
    return ''
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string }
    return (err.stderr ? err.stderr.toString() : String(e)).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const podmiot1 = { nip: '2481632647', pelnaNazwa: 'Open Mercato Test Sp. z o.o.', email: 'test@example.com' }
const ksef = { kind: 'NrKSeF' as const, value: '2481632647-20261005-3F8DD3400000-57' }

const sprzedaz: JpkSprzedazRow[] = [
  {
    nrKontrahenta: '3755747347', nazwaKontrahenta: 'Buyer A', dowodSprzedazy: 'FV/2026/10/1', dataWystawienia: '2026-10-05',
    dataSprzedazy: '2026-10-05', ksef, typDokumentu: undefined, gtu: { GTU_01: true }, procedures: { TP: true },
    k: { K_19: '1000.00', K_20: '230.00' },
  },
  {
    nrKontrahenta: 'BRAK', nazwaKontrahenta: 'Osoba fizyczna', dowodSprzedazy: 'FV/2026/10/2', dataWystawienia: '2026-10-06',
    ksef: { kind: 'BFK' as const }, k: { K_17: '500.00', K_18: '40.00' },
  },
]
const zakup: JpkZakupRow[] = [
  { nrDostawcy: '5260001246', nazwaDostawcy: 'Supplier', dowodZakupu: 'FZ/1', dataZakupu: '2026-10-03', ksef, k: { K_42: '200.00', K_43: '46.00' } },
]

function fullFile(variant: 'V7M' | 'V7K', month: number, opts: { evidenceOnly?: boolean; declarationOnly?: boolean } = {}): BuildJpkXmlInput {
  const { declaration, ctrl } = computeJpkDeclaration({ variant, sprzedaz, zakup })
  const scope = opts.evidenceOnly ? 'evidence' : opts.declarationOnly ? 'declaration' : 'both'
  // Mirror the resolver: V7K derives the mandatory Kwartal from the evidence month; V7M omits it.
  const kwartal = variant === 'V7K' ? Math.ceil(month / 3) : undefined
  return {
    variant,
    celZlozenia: scope === 'both' ? 1 : 2,
    correctionScope: scope,
    naglowek: { dataWytworzenia: '2026-11-15T10:00:00Z', kodUrzedu: '1471', rok: 2026, miesiac: month, nazwaSystemu: 'Open Mercato' },
    podmiot1,
    deklaracja: scope === 'evidence' ? undefined : { kwartal, pozycje: declaration },
    ewidencja: scope === 'declaration' ? undefined : { sprzedaz, zakup, sprzedazCtrl: ctrl.sprzedazCtrl, zakupCtrl: ctrl.zakupCtrl },
  }
}

const itx = hasXmllint() ? it : it.skip
if (!hasXmllint()) {
  // eslint-disable-next-line no-console
  console.warn('[xsd-validation] xmllint not found — skipping the XSD gate (install libxml2 to enable).')
}

describe('JPK XSD validation gate', () => {
  it('uses the final CRWDE namespaces effective from 2026-02-01', () => {
    expect(JPK_NAMESPACE).toEqual({
      V7M: 'http://crd.gov.pl/wzor/2025/12/19/14090/',
      V7K: 'http://crd.gov.pl/wzor/2025/12/19/14089/',
    })
  })

  itx('JPK_V7M(3) full file (sales + purchases + declaration) validates', () => {
    expect(validate(buildJpkXml(fullFile('V7M', 10)), 'V7M')).toBe('')
  })
  itx('JPK_V7K(3) month-3 full file (Kwartal derived from month) validates', () => {
    expect(validate(buildJpkXml(fullFile('V7K', 12)), 'V7K')).toBe('')
  })
  it('buildJpkXml THROWS for a V7K declaration missing the mandatory Kwartal (fail loud, not silently-invalid)', () => {
    const f = fullFile('V7K', 12)
    expect(() => buildJpkXml({ ...f, deklaracja: { pozycje: f.deklaracja!.pozycje } })).toThrow(/Kwartal/)
  })
  itx('JPK_V7K(3) month-1 evidence-only file validates', () => {
    expect(validate(buildJpkXml(fullFile('V7K', 10, { evidenceOnly: true })), 'V7K')).toBe('')
  })
  itx('JPK_V7M(3) declaration-only correction validates', () => {
    expect(validate(buildJpkXml(fullFile('V7M', 10, { declarationOnly: true })), 'V7M')).toBe('')
  })
})
