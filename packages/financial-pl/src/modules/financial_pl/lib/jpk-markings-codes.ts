/**
 * JPK_VAT sales-register marking codes (pure-JPK; never part of the FA(3) XML).
 *
 * Single source of truth for the GTU goods/services group codes, the JPK procedure
 * markings, and the `TypDokumentu` document-type codes used by the JPK_V7M/V7K(3)
 * evidence rows. The PL-meta entity, the invoice-meta API zod schema, the
 * `pl-vat-meta-fields` widget and the future JPK_VAT export all derive their
 * accepted-value sets from the constants below.
 *
 * Per the JPK brochure these are sales-register flags captured at invoice time;
 * the cross-field constraints (e.g. GTU not allowed on a `RO` row) are enforced at
 * JPK-export time, not at capture. Capture rejects only structurally-invalid codes.
 */

/** GTU goods/services group codes `GTU_01`..`GTU_13`. */
export const GTU_CODES = [
  'GTU_01',
  'GTU_02',
  'GTU_03',
  'GTU_04',
  'GTU_05',
  'GTU_06',
  'GTU_07',
  'GTU_08',
  'GTU_09',
  'GTU_10',
  'GTU_11',
  'GTU_12',
  'GTU_13',
] as const

export type GtuCode = (typeof GTU_CODES)[number]

/**
 * The 12 JPK procedure markings. Two of these (self-billing → FA(3) `P_17`,
 * reverse charge → FA(3) `P_18`) are *also* FA(3) `Adnotacje` and are wired
 * through `buildAnnotations`; the rest are pure-JPK sales-register flags.
 */
export const JPK_PROCEDURE_MARKINGS = [
  'WSTO_EE',
  'IED',
  'TP',
  'TT_WNT',
  'TT_D',
  'MR_T',
  'MR_UZ',
  'I_42',
  'I_63',
  'B_SPV',
  'B_SPV_DOSTAWA',
  'B_MPV_PROWIZJA',
] as const

export type JpkProcedureMarking = (typeof JPK_PROCEDURE_MARKINGS)[number]

/** `TypDokumentu` JPK document-type codes (`RO` daily report, `WEW` internal, `FP` invoice-to-receipt). */
export const JPK_TYP_DOKUMENTU = ['RO', 'WEW', 'FP'] as const

export type JpkTypDokumentu = (typeof JPK_TYP_DOKUMENTU)[number]

export function isGtuCode(value: unknown): value is GtuCode {
  return typeof value === 'string' && (GTU_CODES as readonly string[]).includes(value)
}

export function isJpkProcedureMarking(value: unknown): value is JpkProcedureMarking {
  return typeof value === 'string' && (JPK_PROCEDURE_MARKINGS as readonly string[]).includes(value)
}

export function isJpkTypDokumentu(value: unknown): value is JpkTypDokumentu {
  return typeof value === 'string' && (JPK_TYP_DOKUMENTU as readonly string[]).includes(value)
}
