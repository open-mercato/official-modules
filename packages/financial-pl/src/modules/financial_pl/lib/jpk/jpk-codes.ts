/**
 * JPK_V7M(3) / JPK_V7K(3) field constants, element order, and shared types — the contract
 * for the exporter. Element NAMES and ORDER are taken verbatim from the raw official XSDs
 * (Schemat_JPK_V7M(3)_v1-0E.xsd / V7K), and the K_/P_ semantics from the official brochure
 * ("JPK_VAT z deklaracją od 1 lutego 2026 r."). XSD order is strict — the XML builder MUST
 * emit children in these arrays' order.
 *
 * SPEC-012. Money: evidence K_ fields are 2-dp decimals (XSD TKwotowy, fractionDigits=2);
 * declaration P_ fields are WHOLE PLN (XSD TKwotaC) — round per Ordynacja art. 63 §1.
 */
import { escapeXml } from '../fa3'

export type JpkVariant = 'V7M' | 'V7K'
export type JpkCelZlozenia = 1 | 2
export type JpkCorrectionScope = 'both' | 'declaration' | 'evidence'

/** XSD targetNamespace per variant (from the raw schemas). */
export const JPK_NAMESPACE: Record<JpkVariant, string> = {
  V7M: 'http://crd.gov.pl/wzor/2025/06/18/06181/',
  V7K: 'http://crd.gov.pl/wzor/2025/06/18/06182/',
}

/** Naglowek/KodFormularza fixed attributes per variant. */
export const JPK_FORM_CODE: Record<JpkVariant, { kodSystemowy: string; wersjaSchemy: string }> = {
  V7M: { kodSystemowy: 'JPK_V7M (3)', wersjaSchemy: '1-0E' },
  V7K: { kodSystemowy: 'JPK_V7K (3)', wersjaSchemy: '1-0E' },
}

/** Deklaracja/KodFormularzaDekl fixed attributes per variant. */
export const JPK_DEKL_CODE: Record<JpkVariant, { kodSystemowy: string }> = {
  V7M: { kodSystemowy: 'VAT-7 (23)' },
  V7K: { kodSystemowy: 'VAT-7K (17)' },
}
export const JPK_DEKL_VARIANT: Record<JpkVariant, string> = { V7M: '23', V7K: '17' }

/** GTU markers (value "1"), in XSD order. */
export const JPK_GTU = [
  'GTU_01', 'GTU_02', 'GTU_03', 'GTU_04', 'GTU_05', 'GTU_06', 'GTU_07',
  'GTU_08', 'GTU_09', 'GTU_10', 'GTU_11', 'GTU_12', 'GTU_13',
] as const
export type JpkGtu = (typeof JPK_GTU)[number]

/** Sales procedure markers (value "1"), in XSD order — after GTU, before KorektaPodstawyOpodt. */
export const JPK_SPRZEDAZ_PROCEDURES = [
  'WSTO_EE', 'IED', 'TP', 'TT_WNT', 'TT_D', 'MR_T', 'MR_UZ',
  'I_42', 'I_63', 'B_SPV', 'B_SPV_DOSTAWA', 'B_MPV_PROWIZJA',
] as const
export type JpkSprzedazProcedure = (typeof JPK_SPRZEDAZ_PROCEDURES)[number]

/** Sales K_ amount fields, in XSD order (K_10..K_36, then K_360). */
export const JPK_SPRZEDAZ_K = [
  'K_10', 'K_11', 'K_12', 'K_13', 'K_14', 'K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20',
  'K_21', 'K_22', 'K_23', 'K_24', 'K_25', 'K_26', 'K_27', 'K_28', 'K_29', 'K_30', 'K_31',
  'K_32', 'K_33', 'K_34', 'K_35', 'K_36', 'K_360',
] as const
export type JpkSprzedazK = (typeof JPK_SPRZEDAZ_K)[number]

/** Purchase K_ amount fields, in XSD order. */
export const JPK_ZAKUP_K = ['K_40', 'K_41', 'K_42', 'K_43', 'K_44', 'K_45', 'K_46', 'K_47'] as const
export type JpkZakupK = (typeof JPK_ZAKUP_K)[number]

/** The KSeF identification node — a choice; exactly one is emitted. */
export type JpkKsefNode =
  | { kind: 'NrKSeF'; value: string }
  | { kind: 'OFF' }
  | { kind: 'BFK' }
  | { kind: 'DI' }

export type JpkTypDokumentu = 'RO' | 'WEW' | 'FP'
export type JpkDokumentZakupu = 'MK' | 'VAT_RR' | 'WEW'

/** A built SprzedazWiersz (sales evidence row). Amounts are 2-dp decimal strings (signed). */
export type JpkSprzedazRow = {
  kodKrajuNadaniaTIN?: string
  nrKontrahenta: string // NIP or "BRAK"
  nazwaKontrahenta: string
  dowodSprzedazy: string
  dataWystawienia: string // YYYY-MM-DD
  dataSprzedazy?: string
  ksef: JpkKsefNode
  typDokumentu?: JpkTypDokumentu
  gtu?: Partial<Record<JpkGtu, boolean>>
  procedures?: Partial<Record<JpkSprzedazProcedure, boolean>>
  korektaPodstawyOpodt?: boolean // art. 89a
  terminPlatnosci?: string // art. 89a ust. 1
  dataZaplaty?: string // art. 89a ust. 4
  k?: Partial<Record<JpkSprzedazK, string>>
  sprzedazVatMarza?: string // full gross of a margin supply
}

/** A built ZakupWiersz (purchase evidence row). */
export type JpkZakupRow = {
  kodKrajuNadaniaTIN?: string
  nrDostawcy: string
  nazwaDostawcy: string
  dowodZakupu: string
  dataZakupu: string
  dataWplywu?: string
  ksef: JpkKsefNode
  dokumentZakupu?: JpkDokumentZakupu
  imp?: boolean
  k?: Partial<Record<JpkZakupK, string>>
  zakupVatMarza?: string
}

/** Computed declaration. P_ values are WHOLE-PLN integer strings; absent ⇒ omit (optional). */
export type JpkDeclaration = Partial<Record<string, string>>

/** XSD order of Deklaracja/PozycjeSzczegolowe (64 positions). */
export const JPK_DEKL_ORDER = [
  'P_10', 'P_11', 'P_12', 'P_13', 'P_14', 'P_15', 'P_16', 'P_17', 'P_18', 'P_19', 'P_20',
  'P_21', 'P_22', 'P_23', 'P_24', 'P_25', 'P_26', 'P_27', 'P_28', 'P_29', 'P_30', 'P_31',
  'P_32', 'P_33', 'P_34', 'P_35', 'P_36', 'P_360', 'P_37', 'P_38', 'P_39', 'P_40', 'P_41',
  'P_42', 'P_43', 'P_44', 'P_45', 'P_46', 'P_47', 'P_48', 'P_49', 'P_50', 'P_51', 'P_52',
  'P_53', 'P_54', 'P_540', 'P_55', 'P_56', 'P_560', 'P_58', 'P_59', 'P_60', 'P_61', 'P_62',
  'P_63', 'P_64', 'P_65', 'P_66', 'P_660', 'P_67', 'P_68', 'P_69', 'P_ORDZU',
] as const

// ---------- XML helpers (mirror lib/fa3.ts el()/escape discipline; deterministic) ----------

/** `<tag>escaped</tag>` — value coerced to string. */
export function el(tag: string, value: string | number): string {
  return `<${tag}>${escapeXml(String(value))}</${tag}>`
}

/** A marker element set to "1" when the flag is true; else "" (omitted). */
export function markerEl(tag: string, on: boolean | undefined): string {
  return on ? el(tag, '1') : ''
}

/** Emit `parts` joined, wrapped in `<tag>…</tag>`; if all parts empty, returns "". */
export function wrap(tag: string, parts: string[]): string {
  const inner = parts.join('')
  return inner ? `<${tag}>${inner}</${tag}>` : ''
}

export { escapeXml }
