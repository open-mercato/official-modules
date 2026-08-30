import { isValidCurrencyCode, searchCurrencies } from '../currencies'

describe('currencies', () => {
  it('validates ISO currency codes case-insensitively', () => {
    expect(isValidCurrencyCode('pln')).toBe(true)
    expect(isValidCurrencyCode('PLN')).toBe(true)
    expect(isValidCurrencyCode('eur')).toBe(true)
  })

  it('rejects unknown or malformed currency codes', () => {
    expect(isValidCurrencyCode('ZZZ')).toBe(false)
    expect(isValidCurrencyCode('')).toBe(false)
    expect(isValidCurrencyCode('PL')).toBe(false)
    expect(isValidCurrencyCode('pound')).toBe(false)
  })

  it('returns common currencies first for an empty search', () => {
    const options = searchCurrencies('', 6)
    expect(options[0]).toEqual({ value: 'PLN', label: 'PLN — Polish zloty' })
    expect(options).toHaveLength(6)
  })

  it('filters by code or name', () => {
    expect(searchCurrencies('eur').some((option) => option.value === 'EUR')).toBe(true)
  })
})
