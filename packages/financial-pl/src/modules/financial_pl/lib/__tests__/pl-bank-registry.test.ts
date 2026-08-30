import { lookupPolishBank } from '../pl-bank-registry'

const VALID_PKO_NRB = '76102000000000000000000001'

describe('lookupPolishBank', () => {
  it('returns PKO BP info for bank code 1020', () => {
    expect(lookupPolishBank(VALID_PKO_NRB)).toEqual({ name: 'PKO Bank Polski S.A.', swift: 'BPKOPLPW' })
    expect(lookupPolishBank(`PL${VALID_PKO_NRB}`)?.swift).toBe('BPKOPLPW')
  })

  it('returns null for an unknown Polish bank code', () => {
    expect(lookupPolishBank('76999900000000000000000001')).toBeNull()
  })

  it('returns null for non-Polish IBANs', () => {
    expect(lookupPolishBank('DE89370400440532013000')).toBeNull()
  })
})
