/** Normalize a human-typed decimal without enforcing final decimal syntax. Converts ',' → '.',
 *  drops any non-numeric characters, keeps a single leading '-', and keeps only the FIRST decimal
 *  point (so `12.34.56` collapses to `12.3456` rather than producing a NaN-parsing string). */
export function normalizeDecimalInput(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(/,/g, '.')
  let result = ''
  let hasMinus = false
  let hasDot = false

  for (const char of text) {
    if (char >= '0' && char <= '9') {
      result += char
    } else if (char === '.' && !hasDot) {
      result += char
      hasDot = true
    } else if (char === '-' && !hasMinus && result.length === 0) {
      result += char
      hasMinus = true
    }
  }

  return result
}

/** Polish postal code `NN-NNN`. */
export function isValidPolishPostalCode(value: string | null | undefined): boolean {
  return /^\d{2}-\d{3}$/.test((value ?? '').trim())
}

/** SWIFT/BIC: 8 or 11 characters, case-insensitive. */
export function isValidSwift(value: string | null | undefined): boolean {
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test((value ?? '').trim().toUpperCase())
}
