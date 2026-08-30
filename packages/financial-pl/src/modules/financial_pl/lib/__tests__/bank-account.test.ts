import { isValidBankAccount, isValidIban, isValidPolishAccountNumber, normalizeAccountNumber } from '../bank-account'

const VALID_POLISH_NRB = '76102000000000000000000001'

describe('bank-account', () => {
  it('normalizes account numbers to uppercase alphanumerics', () => {
    expect(normalizeAccountNumber(' pl 76 1020-0000 0000 0000 0000 0001 ')).toBe(`PL${VALID_POLISH_NRB}`)
  })

  it('validates known IBAN numbers', () => {
    expect(isValidIban('DE89370400440532013000')).toBe(true)
    expect(isValidIban('GB82WEST12345698765432')).toBe(true)
    expect(isValidIban('DE89370400440532013001')).toBe(false)
  })

  it('validates Polish NRB numbers with the IBAN mod-97 checksum', () => {
    expect(isValidPolishAccountNumber(VALID_POLISH_NRB)).toBe(true)
    expect(isValidPolishAccountNumber(VALID_POLISH_NRB.slice(0, 25))).toBe(false)
    expect(isValidPolishAccountNumber(`77${VALID_POLISH_NRB.slice(2)}`)).toBe(false)
  })

  it('accepts either a bare Polish NRB or a full IBAN', () => {
    expect(isValidBankAccount(VALID_POLISH_NRB)).toBe(true)
    expect(isValidBankAccount(`PL${VALID_POLISH_NRB}`)).toBe(true)
    expect(isValidBankAccount('GB82WEST12345698765432')).toBe(true)
    expect(isValidBankAccount(`PL77${VALID_POLISH_NRB.slice(2)}`)).toBe(false)
  })
})
