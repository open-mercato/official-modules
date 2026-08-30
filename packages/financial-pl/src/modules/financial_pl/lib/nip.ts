/**
 * Polish NIP (tax id) validation — vendored locally so this official module is SELF-CONTAINED
 * and does not depend on an unreleased `@open-mercato/shared/lib/pl/validation` export (which is
 * not present in any published `@open-mercato/shared` at the declared peer range). The NIP
 * checksum is a fixed legal algorithm: the weighted sum of the first 9 digits mod 11 equals the
 * 10th (control) digit; a remainder of 10 can never be a valid control digit.
 */
const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7] as const

/** Strip spaces/dashes so `123-456-32-18` and `1234563218` normalize alike. */
export function normalizeNip(value: string): string {
  return value.replace(/\D/g, '')
}

/**
 * Validate a Polish NIP by its weighted checksum. Format/length alone is NOT enough — an
 * invalid-but-10-digit NIP (e.g. 1234567890) must fail so it is never filed to KSeF.
 */
export function isValidPolishNip(value: string | null | undefined): boolean {
  if (!value) return false
  const digits = normalizeNip(value)
  if (!/^\d{10}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * NIP_WEIGHTS[i]
  const control = sum % 11
  if (control === 10) return false
  return control === Number(digits[9])
}
