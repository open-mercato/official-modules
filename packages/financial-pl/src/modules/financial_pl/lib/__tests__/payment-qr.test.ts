import { buildZbpTransferString } from '../payment-qr'

describe('buildZbpTransferString', () => {
  it('matches the ZBP reference-compatible payload with empty NIP and country code', () => {
    expect(
      buildZbpTransferString({
        nip: '',
        countryCode: '',
        nrb: '01234567890123456789012345',
        amountGrosze: 14050,
        name: 'Marcin sp. z o.o.',
        title: 'FV 1234/2020',
      }),
    ).toBe('||01234567890123456789012345|014050|Marcin sp. z o.o.|FV 1234/2020|||')
  })

  it('reproduces the upstream bank-qrcode-formatter BuildTest fixture exactly (9 fields, 3 trailing pipes)', () => {
    // Verbatim expected string from MarcinOrlowski/bank-qrcode-formatter tests/BuildTest.php —
    // the reference implementation of the ZBP 2D recommendation.
    expect(
      buildZbpTransferString({
        nip: '',
        countryCode: 'PL',
        nrb: '01234567890123456789012345',
        amountGrosze: 12399,
        name: 'Acme Inc.',
        title: 'Payment title',
      }),
    ).toBe('|PL|01234567890123456789012345|012399|Acme Inc.|Payment title|||')
  })

  it('includes the seller NIP and PL country code variant used by the PDF caller', () => {
    expect(
      buildZbpTransferString({
        nip: '5252674798',
        countryCode: 'PL',
        nrb: '01234567890123456789012345',
        amountGrosze: 14050,
        name: 'Marcin sp. z o.o.',
        title: 'FV 1234/2020',
      }),
    ).toBe('5252674798|PL|01234567890123456789012345|014050|Marcin sp. z o.o.|FV 1234/2020|||')
  })

  it('zero-pads amounts and multi-byte-truncates recipient and title fields', () => {
    expect(
      buildZbpTransferString({
        nrb: '01 2345 6789 0123 4567 8901 2345',
        amountGrosze: 99,
        name: 'Zażółć gęślą jaźń spółka',
        title: 'Faktura za usługi doradcze numer FV/2026/000001',
      }),
    ).toBe('||01234567890123456789012345|000099|Zażółć gęślą jaźń sp|Faktura za usługi doradcze numer|||')
  })

  it('rejects invalid NRB and amount inputs', () => {
    expect(() =>
      buildZbpTransferString({
        nrb: '123',
        amountGrosze: 1,
        name: 'A',
        title: 'B',
      }),
    ).toThrow('invalidNrb')
    expect(() =>
      buildZbpTransferString({
        nrb: '01234567890123456789012345',
        amountGrosze: 1.5,
        name: 'A',
        title: 'B',
      }),
    ).toThrow('invalidAmountGrosze')
  })
})
