import { deriveJpkVatMarking } from '../jpk-vat-marking'

describe('deriveJpkVatMarking', () => {
  it('returns NrKSeF with the number when accepted with a KSeF number', () => {
    expect(
      deriveJpkVatMarking({ ksefStatus: 'accepted', ksefNumber: '2481632647-20260620-AABBCC-DDEEFF-11', mode: 'online' }),
    ).toEqual({ marking: 'NrKSeF', ksefNumber: '2481632647-20260620-AABBCC-DDEEFF-11' })
  })

  it('returns NrKSeF even for an offline24 invoice once it has a number (post-acceptance correction)', () => {
    expect(deriveJpkVatMarking({ ksefStatus: 'accepted', ksefNumber: 'X', mode: 'offline24' })).toEqual({
      marking: 'NrKSeF',
      ksefNumber: 'X',
    })
  })

  it('returns BFK only when explicitly flagged as issued outside KSeF', () => {
    expect(deriveJpkVatMarking({ ksefStatus: null, ksefNumber: null, issuedOutsideKsef: true })).toEqual({ marking: 'BFK' })
  })

  it('returns OFF for an awaryjny issuance without a number yet', () => {
    expect(deriveJpkVatMarking({ ksefStatus: 'offline_issued', ksefNumber: null, mode: 'awaryjny' })).toEqual({ marking: 'OFF' })
  })

  it('returns DI for an offline24 issuance without a number yet', () => {
    expect(deriveJpkVatMarking({ ksefStatus: 'offline_issued', ksefNumber: null, mode: 'offline24' })).toEqual({ marking: 'DI' })
  })

  it('returns pending (null) — never BFK — for an in-flight invoice with no number', () => {
    expect(deriveJpkVatMarking({ ksefStatus: 'processing', ksefNumber: null, mode: 'online' })).toEqual({
      marking: null,
      pending: true,
    })
  })

  it('returns pending (null) when there is no submission at all and no outside-KSeF flag', () => {
    expect(deriveJpkVatMarking({})).toEqual({ marking: null, pending: true })
  })

  it('prefers NrKSeF over a stale issuedOutsideKsef flag (the invoice was actually sent)', () => {
    expect(deriveJpkVatMarking({ ksefStatus: 'accepted', ksefNumber: 'X', issuedOutsideKsef: true })).toEqual({
      marking: 'NrKSeF',
      ksefNumber: 'X',
    })
  })
})
