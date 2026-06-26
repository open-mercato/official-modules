import { parseKsefNumber, isStructurallyValidKsefNumber, KSEF_NUMBER_LENGTH } from '../ksef-number'

describe('KSeF number parsing', () => {
  const valid = '7980332920' + '20260622' + '1A2B3C4D5E6F7AB' + '88'

  it('parses a structurally valid 35-char KSeF number', () => {
    expect(valid.length).toBe(KSEF_NUMBER_LENGTH)
    const parsed = parseKsefNumber(valid)
    expect(parsed).not.toBeNull()
    expect(parsed?.nip).toBe('7980332920')
    expect(parsed?.issueDate).toBe('20260622')
    expect(parsed?.checksum).toBe('88')
  })

  it('rejects wrong length', () => {
    expect(parseKsefNumber('7980332920')).toBeNull()
    expect(parseKsefNumber(valid + 'X')).toBeNull()
  })

  it('rejects an invalid embedded date', () => {
    const badDate = '7980332920' + '20261399' + '1A2B3C4D5E6F7AB' + '88'
    expect(parseKsefNumber(badDate)).toBeNull()
  })

  it('validates structure independently', () => {
    expect(isStructurallyValidKsefNumber(valid)).toBe(true)
    expect(isStructurallyValidKsefNumber('lowercase' + valid.slice(9))).toBe(false)
  })

  it('rejects a non-hex character in the technical/CRC segment (official KsefNumber is [0-9A-F])', () => {
    const nonHex = '7980332920' + '20260622' + '1A2B3C4D5E6F7GZ' + '88'
    expect(nonHex.length).toBe(KSEF_NUMBER_LENGTH)
    expect(isStructurallyValidKsefNumber(nonHex)).toBe(false)
    expect(parseKsefNumber(nonHex)).toBeNull()
  })

  it('tolerates the hyphenated canonical form KSeF presents', () => {
    const hyphenated = '7980332920-20260622-1A2B3C4D5E6F-88'
    expect(isStructurallyValidKsefNumber(hyphenated)).toBe(true)
    const parsed = parseKsefNumber(hyphenated)
    expect(parsed?.nip).toBe('7980332920')
    expect(parsed?.issueDate).toBe('20260622')
    expect(parsed?.checksum).toBe('88')
  })
})
