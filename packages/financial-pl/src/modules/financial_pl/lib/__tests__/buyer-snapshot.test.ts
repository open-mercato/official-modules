import { buyerToSnapshot, snapshotToBuyer, buyerFromMetadata } from '../buyer-snapshot'

describe('buyerToSnapshot', () => {
  it('omits empty fields and trims values', () => {
    expect(
      buyerToSnapshot({ companyName: ' Acme ', nip: '', addressLine1: 'Street 1', countryCode: 'PL' }),
    ).toEqual({ companyName: 'Acme', addressLine1: 'Street 1', countryCode: 'PL' })
  })

  it('returns undefined for an empty buyer', () => {
    expect(buyerToSnapshot({})).toBeUndefined()
    expect(buyerToSnapshot({ companyName: '   ' })).toBeUndefined()
    // Only a defaulted countryCode and no identifying field ⇒ empty (code-jury, Kimi).
    expect(buyerToSnapshot({ countryCode: 'PL' })).toBeUndefined()
    expect(buyerToSnapshot({ countryCode: 'PL', nip: '   ' })).toBeUndefined()
  })

  it('normalises the NIP to bare digits and the country to upper-case (so FA(3) accepts them)', () => {
    const snap = buyerToSnapshot({ nip: '525-234-40-78', countryCode: 'de', companyName: 'X' })
    expect(snap?.nip).toBe('5252344078')
    expect(snap?.countryCode).toBe('DE')
  })

  it('round-trips through snapshotToBuyer (the exact keys buildBuyer reads)', () => {
    const buyer = {
      companyName: 'Acme',
      nip: '5252344078',
      addressLine1: 'Street 1',
      addressLine2: 'Suite 2',
      postalCode: '00-843',
      city: 'Warszawa',
      countryCode: 'DE',
    }
    expect(snapshotToBuyer(buyerToSnapshot(buyer))).toEqual(buyer)
  })
})

describe('snapshotToBuyer', () => {
  it('reads the name/taxId + snake_case aliases buildBuyer accepts', () => {
    expect(
      snapshotToBuyer({
        name: 'X',
        tax_id: '5252344078',
        address_line1: 'S 1',
        postal_code: '00-001',
        city: 'K',
        country: 'PL',
      }),
    ).toEqual({
      companyName: 'X',
      nip: '5252344078',
      addressLine1: 'S 1',
      addressLine2: '',
      postalCode: '00-001',
      city: 'K',
      countryCode: 'PL',
    })
  })

  it('defaults country to PL when absent', () => {
    expect(snapshotToBuyer({}).countryCode).toBe('PL')
  })
})

describe('buyerFromMetadata', () => {
  it('reads metadata.buyerSnapshot (ignoring other metadata keys)', () => {
    expect(buyerFromMetadata({ buyerSnapshot: { companyName: 'A' }, ksefHint: 1 }).companyName).toBe('A')
  })

  it('falls back to the legacy metadata.buyer key', () => {
    expect(buyerFromMetadata({ buyer: { name: 'B' } }).companyName).toBe('B')
  })

  it('handles null / non-object metadata gracefully', () => {
    expect(buyerFromMetadata(null).companyName).toBe('')
    expect(buyerFromMetadata(undefined).countryCode).toBe('PL')
    expect(buyerFromMetadata('garbage').companyName).toBe('')
  })
})
