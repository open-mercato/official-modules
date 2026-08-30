import { isValidPolishNip, normalizeNip } from '../nip'

describe('isValidPolishNip', () => {
  it('accepts valid NIPs (incl. the KSeF TEST context NIP)', () => {
    expect(isValidPolishNip('2481632647')).toBe(true) // KSeF TEST NIP
    expect(isValidPolishNip('1234563218')).toBe(true)
    expect(isValidPolishNip('123-456-32-18')).toBe(true) // separators normalized
  })

  it('rejects checksum-invalid and malformed NIPs (never filed to KSeF)', () => {
    expect(isValidPolishNip('1234567890')).toBe(false) // 10 digits but bad checksum
    expect(isValidPolishNip('248163264')).toBe(false) // too short
    expect(isValidPolishNip('')).toBe(false)
    expect(isValidPolishNip(null)).toBe(false)
    expect(isValidPolishNip(undefined)).toBe(false)
  })

  it('normalizeNip strips non-digits', () => {
    expect(normalizeNip('248-163-26-47')).toBe('2481632647')
  })
})
