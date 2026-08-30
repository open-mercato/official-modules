/**
 * KSeF reference number (numer KSeF) parsing/validation.
 *
 * Layout (35 chars): NIP(10) + issue date YYYYMMDD(8) + technical part(15) +
 * checksum(2). The checksum algorithm is not published by MF; we validate the
 * structural layout and the embedded NIP/date, and surface the checksum digits
 * without recomputing them.
 */

export const KSEF_NUMBER_LENGTH = 35

export type ParsedKsefNumber = {
  raw: string
  nip: string
  issueDate: string
  technical: string
  checksum: string
}

/** Drop the cosmetic hyphen/space separators KSeF uses when it presents the number. */
function stripSeparators(value: string): string {
  return value.replace(/[\s-]/g, '')
}

export function isStructurallyValidKsefNumber(value: string): boolean {
  const normalized = stripSeparators(value)
  // NIP(10) + issue date YYYYMMDD(8) are decimal digits; the technical + CRC segments
  // are UPPERCASE HEX per the official KsefNumber pattern. Accept both the hyphenated
  // canonical form (de-hyphenates to 32 chars: 18 digits + 14 hex) and the bare 35-char
  // form (18 digits + 17 hex). Admitting non-hex letters (the prior [0-9A-Z]) would pass
  // a malformed number as valid.
  return /^[0-9]{18}([0-9A-F]{14}|[0-9A-F]{17})$/.test(normalized)
}

export function parseKsefNumber(value: string): ParsedKsefNumber | null {
  if (typeof value !== 'string') return null
  const normalized = stripSeparators(value)
  if (normalized.length !== 32 && normalized.length !== KSEF_NUMBER_LENGTH) return null
  if (!isStructurallyValidKsefNumber(normalized)) return null
  const nip = normalized.slice(0, 10)
  const issueDate = normalized.slice(10, 18)
  const checksum = normalized.slice(-2)
  const technical = normalized.slice(18, -2)
  if (!/^[0-9]{8}$/.test(issueDate)) return null
  const month = Number(issueDate.slice(4, 6))
  const day = Number(issueDate.slice(6, 8))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { raw: normalized, nip, issueDate, technical, checksum }
}
