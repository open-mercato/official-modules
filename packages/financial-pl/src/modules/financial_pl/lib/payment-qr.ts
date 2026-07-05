export type ZbpTransferInput = {
  nip?: string
  countryCode?: string
  nrb: string
  amountGrosze: number
  name: string
  title: string
}

function truncateMb(value: string, maxLength: number): string {
  // Strip the field separator ('|') and control chars from free-text fields so a name/title can
  // never inject extra ZBP fields or break the payload; then truncate by Unicode code point.
  const sanitized = value.replace(/[|\r\n\t]/g, ' ')
  return Array.from(sanitized).slice(0, maxLength).join('')
}

export function buildZbpTransferString(input: ZbpTransferInput): string {
  const nip = input.nip?.trim() ?? ''
  if (nip !== '' && !/^\d{10}$/.test(nip)) throw new Error('invalidNip')

  const countryCode = input.countryCode?.trim().toUpperCase() ?? ''
  if (countryCode !== '' && countryCode !== 'PL') throw new Error('invalidCountryCode')

  const nrb = input.nrb.replace(/\s+/g, '')
  if (!/^\d{26}$/.test(nrb)) throw new Error('invalidNrb')

  if (!Number.isInteger(input.amountGrosze) || input.amountGrosze < 0) throw new Error('invalidAmountGrosze')
  const amount = String(input.amountGrosze).padStart(6, '0')

  return [
    nip,
    countryCode,
    nrb,
    amount,
    truncateMb(input.name, 20),
    truncateMb(input.title, 32),
    '',
    '',
    '',
  ].join('|')
}
