/**
 * Build a JPK_V7M SprzedazWiersz from a resolved sales document (invoice or credit memo) + its
 * PL VAT metadata. Pure: the resolve layer supplies the per-rate VAT breakdown (from the shared
 * `buildVatBreakdown`), the resolved KSeF node (from `deriveJpkVatMarking`), buyer identity, and
 * the captured GTU/procedure/markers. SPEC-012.
 *
 * Rate→K mapping (output side): 23%→K_19/K_20, 8%(or 7%)→K_17/K_18, 5%→K_15/K_16, 0% domestic→
 * K_13, exempt(zw)→K_10, outside-PL(np)→K_11, domestic reverse-charge(oo, art.17 supplier)→
 * K_31/K_32. The synthetic OSS bucket is DROPPED (OSS distance sales are reported in VIU-DO, not
 * JPK_V7M — brochure K_10/K_11 carve-out). WNT/import (K_23..K_30) come from the purchase side.
 * Credit-memo (korekta) values arrive already signed (differences may be negative).
 */
import type {
  JpkSprzedazRow,
  JpkKsefNode,
  JpkSprzedazK,
  JpkTypDokumentu,
  JpkGtu,
  JpkSprzedazProcedure,
} from './jpk-codes'
import { isEuMemberState } from '../../config'

export type JpkVatBucket = { rate: number | 'zw' | 'np' | 'oo' | 'oss'; net: string; vat: string }

export type BuildSprzedazInput = {
  buyer: { nip?: string | null; name?: string | null; countryCode?: string | null }
  dowodSprzedazy: string
  dataWystawienia: string
  dataSprzedazy?: string | null
  ksef: JpkKsefNode
  vatBreakdown: JpkVatBucket[]
  typDokumentu?: JpkTypDokumentu | null
  gtu?: string[] | null
  procedures?: Partial<Record<JpkSprzedazProcedure, boolean>> | null
  margGross?: string | null // full gross of a margin (MR_T/MR_UZ) supply → SprzedazVAT_Marza
  korekta?: { terminPlatnosci?: string | null; dataZaplaty?: string | null } | null // art. 89a
}

/** Accumulate a (net, vat) pair into the K_ map at the given fields, summing 2-dp decimal strings. */
function add(k: Partial<Record<JpkSprzedazK, string>>, netField: JpkSprzedazK | null, vatField: JpkSprzedazK | null, net: string, vat: string) {
  if (netField) k[netField] = sum2(k[netField], net)
  if (vatField) k[vatField] = sum2(k[vatField], vat)
}

// Lightweight 2-dp decimal-string addition (sign-aware) without pulling the FA(3) BigInt scaler
// here — values are already 2-dp; parse to integer cents, add, reformat.
function toCents(s: string | undefined): bigint {
  if (!s) return 0n
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim())
  if (!m) return 0n
  const frac = ((m[3] ?? '') + '00').slice(0, 2)
  return (m[1] === '-' ? -1n : 1n) * (BigInt(m[2]) * 100n + BigInt(frac))
}
function fromCents(c: bigint): string {
  const neg = c < 0n
  const a = neg ? -c : c
  return `${neg ? '-' : ''}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, '0')}`
}
function sum2(a: string | undefined, b: string): string {
  return fromCents(toCents(a) + toCents(b))
}

const RATE_FIELDS: Record<string, { net: JpkSprzedazK | null; vat: JpkSprzedazK | null }> = {
  '23': { net: 'K_19', vat: 'K_20' },
  '22': { net: 'K_19', vat: 'K_20' },
  '8': { net: 'K_17', vat: 'K_18' },
  '7': { net: 'K_17', vat: 'K_18' },
  '5': { net: 'K_15', vat: 'K_16' },
  '0': { net: 'K_13', vat: null }, // 0% domestic (WDT/export are split by buyer country — see zeroRateNetField)
  zw: { net: 'K_10', vat: null }, // exempt
  np: { net: 'K_11', vat: null }, // outside PL
  oo: { net: 'K_31', vat: 'K_32' }, // domestic reverse charge (art. 17, supplier side)
}

/**
 * Select the K_ field for a 0%-rated sale by destination: a domestic 0% sale files under K_13; the
 * same 0% rate on a cross-border supply is an intra-community supply (WDT → K_21) when the buyer is
 * in another EU member state, or an export (→ K_22) to a third country. A missing/PL buyer country
 * is treated as domestic.
 */
function zeroRateNetField(buyerCountryCode: string | null | undefined): JpkSprzedazK {
  const country = (buyerCountryCode ?? '').trim().toUpperCase()
  if (!country || country === 'PL') return 'K_13'
  return isEuMemberState(country) ? 'K_21' : 'K_22'
}

/**
 * Map a resolved sale to a SprzedazWiersz, or `null` when the document has no JPK_V7M-reportable
 * value (e.g. a purely-OSS distance sale — every bucket is the synthetic `oss` rate).
 */
export function buildSprzedazRow(input: BuildSprzedazInput): JpkSprzedazRow | null {
  const k: Partial<Record<JpkSprzedazK, string>> = {}
  let reportable = false
  for (const b of input.vatBreakdown) {
    if (b.rate === 'oss') continue // VIU-DO, excluded from JPK_V7M
    // A 0% rate splits by destination (domestic K_13 / intra-EU supply K_21 / export K_22); all
    // other rates use the static field map.
    const fields =
      b.rate === 0
        ? { net: zeroRateNetField(input.buyer.countryCode), vat: null }
        : RATE_FIELDS[typeof b.rate === 'number' ? String(b.rate) : b.rate]
    if (!fields) continue
    add(k, fields.net, fields.vat, b.net, b.vat)
    reportable = true
  }
  if (!reportable && !input.margGross) return null

  const gtu: Partial<Record<JpkGtu, boolean>> = {}
  for (const code of input.gtu ?? []) gtu[code as JpkGtu] = true

  const procedures: Partial<Record<JpkSprzedazProcedure, boolean>> = { ...(input.procedures ?? {}) }
  // A margin supply carries its MR_T/MR_UZ marker via `procedures` (set by the resolver); here we
  // additionally surface the full gross in SprzedazVAT_Marza.
  const korekta89a = !!(input.korekta && (input.korekta.terminPlatnosci || input.korekta.dataZaplaty))
  // KorektaPodstawyOpodt's XSD is a sequence with a choice of TerminPlatnosci (art.89a ust.1 —
  // claiming relief on an unpaid debt) OR DataZaplaty (ust.4 — later payment reversing relief):
  // exactly one may appear. Emit at most one, preferring TerminPlatnosci, so a row that happens to
  // carry both dates never produces an XSD-invalid choice violation.
  const terminPlatnosci = input.korekta?.terminPlatnosci ?? undefined
  const dataZaplaty = terminPlatnosci ? undefined : (input.korekta?.dataZaplaty ?? undefined)

  return {
    kodKrajuNadaniaTIN: input.buyer.countryCode ?? undefined,
    nrKontrahenta: (input.buyer.nip && input.buyer.nip.trim()) || 'BRAK',
    nazwaKontrahenta: (input.buyer.name && input.buyer.name.trim()) || 'BRAK',
    dowodSprzedazy: input.dowodSprzedazy,
    dataWystawienia: input.dataWystawienia,
    dataSprzedazy: input.dataSprzedazy ?? undefined,
    ksef: input.ksef,
    typDokumentu: input.typDokumentu ?? undefined,
    gtu: Object.keys(gtu).length ? gtu : undefined,
    procedures: Object.keys(procedures).length ? procedures : undefined,
    korektaPodstawyOpodt: korekta89a || undefined,
    terminPlatnosci,
    dataZaplaty,
    k: Object.keys(k).length ? k : undefined,
    sprzedazVatMarza: input.margGross ?? undefined,
  }
}
