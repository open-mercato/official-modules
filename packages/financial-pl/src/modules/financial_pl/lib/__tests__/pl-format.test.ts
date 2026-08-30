import { isValidPolishPostalCode, isValidSwift, normalizeDecimalInput } from '../pl-format'

describe('pl-format', () => {
  it('normalizes human decimal input for controlled fields', () => {
    expect(normalizeDecimalInput('12,50')).toBe('12.50')
    expect(normalizeDecimalInput('1 200,5')).toBe('1200.5')
    expect(normalizeDecimalInput('12.')).toBe('12.')
    // Only the first decimal point survives, so a stray second separator can't produce a NaN string.
    expect(normalizeDecimalInput('12.34.56')).toBe('12.3456')
    expect(normalizeDecimalInput('1,2,3')).toBe('1.23')
    expect(normalizeDecimalInput('-8,5')).toBe('-8.5')
  })

  it('validates Polish postal codes', () => {
    expect(isValidPolishPostalCode('00-950')).toBe(true)
    expect(isValidPolishPostalCode('00950')).toBe(false)
  })

  it('validates SWIFT/BIC values', () => {
    expect(isValidSwift('BREXPLPWXXX')).toBe(true)
    expect(isValidSwift('bad')).toBe(false)
  })
})
