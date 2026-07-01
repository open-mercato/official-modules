/** Strip spaces and non-alphanumerics; uppercase. */
export function normalizeAccountNumber(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase()
}

function expandIbanForChecksum(value: string): string {
  let expanded = ''
  for (const char of value.slice(4) + value.slice(0, 4)) {
    if (char >= '0' && char <= '9') {
      expanded += char
    } else {
      expanded += String(char.charCodeAt(0) - 55)
    }
  }
  return expanded
}

/** Valid IBAN: 15-34 chars, ISO 7064 mod-97 checksum equals 1. */
export function isValidIban(value: string | null | undefined): boolean {
  const iban = normalizeAccountNumber(value)
  if (iban.length < 15 || iban.length > 34) return false
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false
  return BigInt(expandIbanForChecksum(iban)) % 97n === 1n
}

/** Valid Polish NRB: exactly 26 digits; validated as the IBAN `PL` + NRB. */
export function isValidPolishAccountNumber(value: string | null | undefined): boolean {
  const digits = normalizeAccountNumber(value)
  return /^\d{26}$/.test(digits) && isValidIban(`PL${digits}`)
}

/** Accept either a bare 26-digit Polish NRB or a full IBAN with country prefix. */
export function isValidBankAccount(value: string | null | undefined): boolean {
  const normalized = normalizeAccountNumber(value)
  if (/^\d{26}$/.test(normalized)) return isValidPolishAccountNumber(normalized)
  return isValidIban(normalized)
}
