/**
 * JPK declaration + control-sum computation (SPEC-012). Aggregates the evidence rows' K_ fields
 * into the VAT-7(23)/VAT-7K(17) declaration P_ positions per the official brochure formulas.
 *
 * Rounding (load-bearing, brochure l.162-168 / Ordynacja art. 63 §1): evidence control sums keep
 * 2 decimals; declaration P_ fields are WHOLE PLN (round half-up on magnitude). Each P_ rate/tax
 * position is rounded individually, then the totals (P_37/P_38/P_48) sum the already-rounded
 * positions. FP rows (faktura do paragonu) are EXCLUDED from the aggregates (the sale is already
 * in the RO collective entry) — they still appear as their own ewidencja row.
 */
import { toScaled4, scaled4ToMoney2dp } from '../fa3-mapping'
import type { JpkSprzedazRow, JpkZakupRow, JpkSprzedazK, JpkZakupK, JpkDeclaration, JpkVariant } from './jpk-codes'

/** Round a 4-dp-scaled BigInt to whole PLN (half-up on magnitude), as a signed integer string. */
export function roundPlnFromScaled4(scaled4: bigint): string {
  const neg = scaled4 < 0n
  const mag = neg ? -scaled4 : scaled4
  let zl = mag / 10000n
  if (mag % 10000n >= 5000n) zl += 1n
  return `${neg && zl > 0n ? '-' : ''}${zl.toString()}`
}

/** Operator-supplied declaration inputs (policy/elections — not derivable from evidence). */
export type JpkDeclarationInputs = {
  /** P_39 — excess input tax carried from the prior period (prior return's P_62). Whole PLN. */
  priorSurplus?: string
  P_49?: string
  P_50?: string
  P_52?: string
  P_54?: string
  P_540?: '1'
  P_55?: '1'
  P_56?: '1'
  P_560?: '1'
  P_58?: '1'
  P_59?: '1'
  P_60?: string
  P_61?: string
  P_63?: '1'
  P_64?: '1'
  P_65?: '1'
  P_66?: '1'
  P_660?: '1'
  P_67?: '1'
  P_ORDZU?: string
}

export type JpkCtrlSums = {
  sprzedazCtrl: { liczbaWierszy: number; podatek: string }
  zakupCtrl: { liczbaWierszy: number; podatek: string }
}

const SPRZEDAZ_K_FIELDS: JpkSprzedazK[] = [
  'K_10', 'K_11', 'K_12', 'K_13', 'K_14', 'K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20', 'K_21',
  'K_22', 'K_23', 'K_24', 'K_25', 'K_26', 'K_27', 'K_28', 'K_29', 'K_30', 'K_31', 'K_32', 'K_33',
  'K_34', 'K_35', 'K_36', 'K_360',
]
const ZAKUP_K_FIELDS: JpkZakupK[] = ['K_40', 'K_41', 'K_42', 'K_43', 'K_44', 'K_45', 'K_46', 'K_47']

function sumField(rows: { k?: Partial<Record<string, string>> }[], field: string): bigint {
  let acc = 0n
  for (const r of rows) {
    const v = r.k?.[field]
    if (v !== undefined && v !== null && v !== '') acc += toScaled4(v)
  }
  return acc
}

/**
 * Compute the evidence control sums and the full declaration from the built rows + operator inputs.
 * `sprzedaz`/`zakup` are the SAME rows passed to the XML builder.
 */
export function computeJpkDeclaration(args: {
  variant: JpkVariant
  sprzedaz: JpkSprzedazRow[]
  zakup: JpkZakupRow[]
  inputs?: JpkDeclarationInputs
}): { declaration: JpkDeclaration; ctrl: JpkCtrlSums } {
  const inputs = args.inputs ?? {}
  // FP rows are excluded from the declaration/ctrl aggregates (double-count guard).
  const nalRows = args.sprzedaz.filter((r) => r.typDokumentu !== 'FP')

  // Per-K 4dp sums.
  const sK: Record<string, bigint> = {}
  for (const f of SPRZEDAZ_K_FIELDS) sK[f] = sumField(nalRows, f)
  const zK: Record<string, bigint> = {}
  for (const f of ZAKUP_K_FIELDS) zK[f] = sumField(args.zakup, f)

  // Control sums (2 dp).
  const podatekNalezny =
    sK.K_16 + sK.K_18 + sK.K_20 + sK.K_24 + sK.K_26 + sK.K_28 + sK.K_30 + sK.K_32 + sK.K_33 + sK.K_34 - sK.K_35 - sK.K_36 - sK.K_360
  const podatekNaliczony = zK.K_41 + zK.K_43 + zK.K_44 + zK.K_45 + zK.K_46 + zK.K_47
  const ctrl: JpkCtrlSums = {
    sprzedazCtrl: { liczbaWierszy: args.sprzedaz.length, podatek: scaled4ToMoney2dp(podatekNalezny) },
    zakupCtrl: { liczbaWierszy: args.zakup.length, podatek: scaled4ToMoney2dp(podatekNaliczony) },
  }

  // Declaration P_ positions — each rounded to whole PLN individually.
  const d: JpkDeclaration = {}
  const pln = (s: bigint) => roundPlnFromScaled4(s)
  const num = (s: string | undefined) => (s ? BigInt(s) : 0n)

  // P_10..P_47 ← like-named K_ sums (whole PLN). The XSD groups several positions into
  // <sequence minOccurs="0"> base/tax PAIRS — if the group is present BOTH members must be
  // emitted (even one of them "0"), else the file is XSD-invalid. So emit each PAIR atomically
  // (both when either is non-zero) and each SINGLE only when non-zero. (TKwotaC allows
  // negatives — corrections may be negative; do NOT clamp.)
  const scaledByP: Record<string, bigint> = {}
  for (const f of SPRZEDAZ_K_FIELDS) scaledByP[`P_${f.slice(2)}`] = sK[f]
  for (const f of ['K_40', 'K_41', 'K_42', 'K_43', 'K_44', 'K_45', 'K_46', 'K_47'] as const) scaledByP[`P_${f.slice(2)}`] = zK[f]
  // XSD-grouped base/tax pairs (JPK_V7M(3) Deklaracja).
  const P_PAIRS: [string, string][] = [
    ['P_11', 'P_12'], ['P_13', 'P_14'], ['P_15', 'P_16'], ['P_17', 'P_18'], ['P_19', 'P_20'],
    ['P_23', 'P_24'], ['P_25', 'P_26'], ['P_27', 'P_28'], ['P_29', 'P_30'], ['P_31', 'P_32'],
    ['P_40', 'P_41'], ['P_42', 'P_43'],
  ]
  const paired = new Set<string>()
  for (const [a, b] of P_PAIRS) {
    paired.add(a)
    paired.add(b)
    const sa = scaledByP[a] ?? 0n
    const sb = scaledByP[b] ?? 0n
    if (sa !== 0n || sb !== 0n) {
      d[a] = pln(sa)
      d[b] = pln(sb)
    }
  }
  for (const [p, scaled] of Object.entries(scaledByP)) {
    if (!paired.has(p) && scaled !== 0n) d[p] = pln(scaled)
  }

  // Rounded values for the totals (sum of already-rounded positions).
  const r = (scaled: bigint) => BigInt(pln(scaled))
  const P_37 =
    r(sK.K_10) + r(sK.K_11) + r(sK.K_13) + r(sK.K_15) + r(sK.K_17) + r(sK.K_19) + r(sK.K_21) + r(sK.K_22) + r(sK.K_23) + r(sK.K_25) + r(sK.K_27) + r(sK.K_29) + r(sK.K_31)
  const P_38 =
    r(sK.K_16) + r(sK.K_18) + r(sK.K_20) + r(sK.K_24) + r(sK.K_26) + r(sK.K_28) + r(sK.K_30) + r(sK.K_32) + r(sK.K_33) + r(sK.K_34) - r(sK.K_35) - r(sK.K_36) - r(sK.K_360)
  if (P_37 !== 0n) d.P_37 = P_37.toString()
  d.P_38 = P_38.toString() // mandatory (zero declaration shows "0")

  // Input side.
  const P_39 = num(inputs.priorSurplus)
  if (P_39 !== 0n) d.P_39 = P_39.toString()
  const P_41 = r(zK.K_41), P_43 = r(zK.K_43), P_44 = r(zK.K_44), P_45 = r(zK.K_45), P_46 = r(zK.K_46), P_47 = r(zK.K_47)
  const P_48 = P_39 + P_41 + P_43 + P_44 + P_45 + P_46 + P_47
  if (P_48 !== 0n) d.P_48 = P_48.toString()

  // Settlement chain.
  const P_49 = num(inputs.P_49), P_50 = num(inputs.P_50), P_52 = num(inputs.P_52)
  if (inputs.P_49) d.P_49 = inputs.P_49
  if (inputs.P_50) d.P_50 = inputs.P_50
  const P_51 = P_38 - P_48 - P_49 - P_50
  d.P_51 = (P_51 > 0n ? P_51 : 0n).toString() // mandatory
  if (inputs.P_52) d.P_52 = inputs.P_52
  const P_53 = P_48 - P_38 + P_52
  if (P_53 > 0n) d.P_53 = P_53.toString()
  // Refund election amounts/markers (operator). P_54 is the to-refund amount; P_62 carries the rest.
  const P_54 = num(inputs.P_54)
  if (inputs.P_54) d.P_54 = inputs.P_54
  for (const m of ['P_540', 'P_55', 'P_56', 'P_560', 'P_58', 'P_59'] as const) if (inputs[m]) d[m] = '1'
  if (inputs.P_60) d.P_60 = inputs.P_60
  if (inputs.P_61) d.P_61 = inputs.P_61
  if (P_53 > 0n) {
    const P_62 = P_53 - P_54
    if (P_62 > 0n) d.P_62 = P_62.toString()
  }

  // Markers (operator).
  for (const m of ['P_63', 'P_64', 'P_65', 'P_66', 'P_660', 'P_67'] as const) if (inputs[m]) d[m] = '1'

  // P_68/P_69 — art. 89a ust.1 bad-debt corrections from the evidence rows (KorektaPodstawyOpodt),
  // base from K_15/K_17/K_19, tax from K_16/K_18/K_20; sign-constrained <= 0.
  const badDebt = nalRows.filter((row) => row.korektaPodstawyOpodt && row.terminPlatnosci)
  const P_68s = sumField(badDebt, 'K_15') + sumField(badDebt, 'K_17') + sumField(badDebt, 'K_19')
  const P_69s = sumField(badDebt, 'K_16') + sumField(badDebt, 'K_18') + sumField(badDebt, 'K_20')
  // P_68/P_69 are an XSD-grouped pair (and TKwotaC allows the negative bad-debt values).
  if (P_68s !== 0n || P_69s !== 0n) {
    d.P_68 = pln(P_68s)
    d.P_69 = pln(P_69s)
  }

  if (inputs.P_ORDZU) d.P_ORDZU = inputs.P_ORDZU
  return { declaration: d, ctrl }
}
