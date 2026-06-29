/**
 * JPK_V7M(3) / JPK_V7K(3) XML assembler. Emits children in the EXACT order of the official
 * XSDs (vendored under ./schema). Deterministic string concatenation (no indentation), all
 * text escaped. SPEC-012. Validated against the raw XSDs via xmllint (xsd-validation.test.ts).
 *
 * Correction scope (CelZlozenia=2): `both` emits Deklaracja + Ewidencja; `declaration` emits
 * only Deklaracja; `evidence` emits only Ewidencja (brochure l.127-134). V7K: the file Naglowek
 * always carries Miesiac (the evidence month); the quarter lives in Deklaracja/Kwartal, present
 * only on the month-3 file that carries the declaration.
 */
import {
  JPK_NAMESPACE,
  JPK_FORM_CODE,
  JPK_DEKL_CODE,
  JPK_DEKL_VARIANT,
  JPK_GTU,
  JPK_SPRZEDAZ_PROCEDURES,
  JPK_SPRZEDAZ_K,
  JPK_ZAKUP_K,
  JPK_DEKL_ORDER,
  el,
  markerEl,
  type JpkVariant,
  type JpkCelZlozenia,
  type JpkCorrectionScope,
  type JpkKsefNode,
  type JpkSprzedazRow,
  type JpkZakupRow,
  type JpkDeclaration,
} from './jpk-codes'

export type JpkPodmiot1 = {
  nip: string
  pelnaNazwa: string
  email: string
  telefon?: string
}

export type JpkNaglowek = {
  /** xsd:dateTime, must be >= 2026-02-01T00:00:00Z and carry a Z/offset. */
  dataWytworzenia: string
  nazwaSystemu?: string
  kodUrzedu: string
  rok: number
  miesiac: number
}

export type JpkCtrl = { liczbaWierszy: number; podatek: string }

export type BuildJpkXmlInput = {
  variant: JpkVariant
  celZlozenia: JpkCelZlozenia
  correctionScope: JpkCorrectionScope
  naglowek: JpkNaglowek
  podmiot1: JpkPodmiot1
  deklaracja?: { kwartal?: number; pozycje: JpkDeclaration }
  ewidencja?: {
    sprzedaz: JpkSprzedazRow[]
    zakup: JpkZakupRow[]
    sprzedazCtrl: JpkCtrl
    zakupCtrl: JpkCtrl
  }
}

function ksefNode(n: JpkKsefNode): string {
  switch (n.kind) {
    case 'NrKSeF':
      return el('NrKSeF', n.value)
    default:
      return el(n.kind, '1') // OFF | BFK | DI are TWybor1 ("1")
  }
}

function renderNaglowek(input: BuildJpkXmlInput): string {
  const formCode = JPK_FORM_CODE[input.variant]
  const header = input.naglowek
  return (
    '<Naglowek>' +
    `<KodFormularza kodSystemowy="${formCode.kodSystemowy}" wersjaSchemy="${formCode.wersjaSchemy}">JPK_VAT</KodFormularza>` +
    el('WariantFormularza', '3') +
    el('DataWytworzeniaJPK', header.dataWytworzenia) +
    (header.nazwaSystemu ? el('NazwaSystemu', header.nazwaSystemu) : '') +
    `<CelZlozenia poz="P_7">${input.celZlozenia}</CelZlozenia>` +
    el('KodUrzedu', header.kodUrzedu) +
    el('Rok', String(header.rok)) +
    el('Miesiac', String(header.miesiac)) +
    '</Naglowek>'
  )
}

function renderPodmiot1(party: JpkPodmiot1): string {
  // role attribute fixed to the taxpayer; company identity (OsobaNiefizyczna).
  return (
    '<Podmiot1 rola="Podatnik">' +
    '<OsobaNiefizyczna>' +
    el('NIP', party.nip) +
    el('PelnaNazwa', party.pelnaNazwa) +
    el('Email', party.email) +
    (party.telefon ? el('Telefon', party.telefon) : '') +
    '</OsobaNiefizyczna>' +
    '</Podmiot1>'
  )
}

function renderDeklaracja(input: BuildJpkXmlInput): string {
  if (!input.deklaracja) return ''
  const deklCode = JPK_DEKL_CODE[input.variant]
  const pozycje = JPK_DEKL_ORDER.map((p) => {
    const v = input.deklaracja!.pozycje[p]
    return v !== undefined && v !== null && v !== '' ? el(p, v) : ''
  }).join('')
  // V7K: <Kwartal> is MANDATORY in the Deklaracja/Naglowek (XSD has no minOccurs=0). Fail loud
  // rather than emit a silently XSD-invalid legal file when a V7K declaration lacks the quarter.
  if (input.variant === 'V7K' && !input.deklaracja.kwartal) {
    throw new Error('[internal] JPK_V7K declaration requires a quarter (Kwartal 1-4)')
  }
  const kwartal = input.variant === 'V7K' ? el('Kwartal', String(input.deklaracja.kwartal)) : ''
  return (
    '<Deklaracja>' +
    `<Naglowek>` +
    `<KodFormularzaDekl kodSystemowy="${deklCode.kodSystemowy}" kodPodatku="VAT" rodzajZobowiazania="Z" wersjaSchemy="1-0E">${input.variant === 'V7K' ? 'VAT-7K' : 'VAT-7'}</KodFormularzaDekl>` +
    el('WariantFormularzaDekl', JPK_DEKL_VARIANT[input.variant]) +
    kwartal +
    `</Naglowek>` +
    `<PozycjeSzczegolowe>${pozycje}</PozycjeSzczegolowe>` +
    el('Pouczenia', '1') +
    '</Deklaracja>'
  )
}

function renderSprzedazRow(row: JpkSprzedazRow, lp: number): string {
  let xml = '<SprzedazWiersz>'
  xml += el('LpSprzedazy', String(lp))
  if (row.kodKrajuNadaniaTIN) xml += el('KodKrajuNadaniaTIN', row.kodKrajuNadaniaTIN)
  xml += el('NrKontrahenta', row.nrKontrahenta)
  xml += el('NazwaKontrahenta', row.nazwaKontrahenta)
  xml += el('DowodSprzedazy', row.dowodSprzedazy)
  xml += el('DataWystawienia', row.dataWystawienia)
  if (row.dataSprzedazy) xml += el('DataSprzedazy', row.dataSprzedazy)
  xml += ksefNode(row.ksef)
  if (row.typDokumentu) xml += el('TypDokumentu', row.typDokumentu)
  for (const g of JPK_GTU) if (row.gtu?.[g]) xml += markerEl(g, true)
  for (const p of JPK_SPRZEDAZ_PROCEDURES) if (row.procedures?.[p]) xml += markerEl(p, true)
  if (row.korektaPodstawyOpodt) xml += el('KorektaPodstawyOpodt', '1')
  if (row.terminPlatnosci) xml += el('TerminPlatnosci', row.terminPlatnosci)
  if (row.dataZaplaty) xml += el('DataZaplaty', row.dataZaplaty)
  for (const k of JPK_SPRZEDAZ_K) {
    const v = row.k?.[k]
    if (v !== undefined && v !== null && v !== '') xml += el(k, v)
  }
  if (row.sprzedazVatMarza) xml += el('SprzedazVAT_Marza', row.sprzedazVatMarza)
  xml += '</SprzedazWiersz>'
  return xml
}

function renderZakupRow(row: JpkZakupRow, lp: number): string {
  let xml = '<ZakupWiersz>'
  xml += el('LpZakupu', String(lp))
  if (row.kodKrajuNadaniaTIN) xml += el('KodKrajuNadaniaTIN', row.kodKrajuNadaniaTIN)
  xml += el('NrDostawcy', row.nrDostawcy)
  xml += el('NazwaDostawcy', row.nazwaDostawcy)
  xml += el('DowodZakupu', row.dowodZakupu)
  xml += el('DataZakupu', row.dataZakupu)
  if (row.dataWplywu) xml += el('DataWplywu', row.dataWplywu)
  xml += ksefNode(row.ksef)
  if (row.dokumentZakupu) xml += el('DokumentZakupu', row.dokumentZakupu)
  if (row.imp) xml += el('IMP', '1')
  for (const k of JPK_ZAKUP_K) {
    const v = row.k?.[k]
    if (v !== undefined && v !== null && v !== '') xml += el(k, v)
  }
  if (row.zakupVatMarza) xml += el('ZakupVAT_Marza', row.zakupVatMarza)
  xml += '</ZakupWiersz>'
  return xml
}

function renderEwidencja(input: BuildJpkXmlInput): string {
  if (!input.ewidencja) return ''
  const ewidencja = input.ewidencja
  const sprzedaz = ewidencja.sprzedaz.map((r, i) => renderSprzedazRow(r, i + 1)).join('')
  const zakup = ewidencja.zakup.map((r, i) => renderZakupRow(r, i + 1)).join('')
  return (
    '<Ewidencja>' +
    sprzedaz +
    '<SprzedazCtrl>' +
    el('LiczbaWierszySprzedazy', String(ewidencja.sprzedazCtrl.liczbaWierszy)) +
    el('PodatekNalezny', ewidencja.sprzedazCtrl.podatek) +
    '</SprzedazCtrl>' +
    zakup +
    '<ZakupCtrl>' +
    el('LiczbaWierszyZakupow', String(ewidencja.zakupCtrl.liczbaWierszy)) +
    el('PodatekNaliczony', ewidencja.zakupCtrl.podatek) +
    '</ZakupCtrl>' +
    '</Ewidencja>'
  )
}

/** Assemble the full JPK XML string (no XML declaration prefix added; callers may prepend one). */
export function buildJpkXml(input: BuildJpkXmlInput): string {
  const ns = JPK_NAMESPACE[input.variant]
  const emitDekl = input.correctionScope !== 'evidence'
  const emitEwid = input.correctionScope !== 'declaration'
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<JPK xmlns="${ns}" xmlns:etd="http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/09/13/eD/DefinicjeTypy/">` +
    renderNaglowek(input) +
    renderPodmiot1(input.podmiot1) +
    (emitDekl ? renderDeklaracja(input) : '') +
    (emitEwid ? renderEwidencja(input) : '') +
    '</JPK>'
  )
}
