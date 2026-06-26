import { evaluateInvoiceStatus, evaluateSessionStatus } from '../status'

describe('KSeF status evaluation', () => {
  it('treats invoice code 200 as accepted and terminal', () => {
    expect(evaluateInvoiceStatus(200)).toEqual({ status: 'accepted', terminal: true, duplicate: false })
  })

  it('treats invoice code 440 as an accepted duplicate (already in KSeF; number+UPO recovered from extensions)', () => {
    expect(evaluateInvoiceStatus(440)).toEqual({ status: 'accepted', terminal: true, duplicate: true })
  })

  it('treats invoice codes >= 400 (other than duplicate) as rejected', () => {
    expect(evaluateInvoiceStatus(445).status).toBe('rejected')
    expect(evaluateInvoiceStatus(21001).status).toBe('rejected')
  })

  it('treats unknown / in-progress invoice codes as processing, never accepted', () => {
    expect(evaluateInvoiceStatus(100)).toEqual({ status: 'processing', terminal: false, duplicate: false })
    expect(evaluateInvoiceStatus(0).status).toBe('processing')
  })

  it('maps session codes: 200 accepted, 100/150 processing, 4xx rejected', () => {
    expect(evaluateSessionStatus(200).status).toBe('accepted')
    expect(evaluateSessionStatus(100).status).toBe('processing')
    expect(evaluateSessionStatus(150).status).toBe('processing')
    expect(evaluateSessionStatus(445).status).toBe('rejected')
    expect(evaluateSessionStatus(420).status).toBe('rejected')
  })

  it('disambiguates 440 by scope: session=cancelled (rejected), invoice=accepted duplicate', () => {
    expect(evaluateSessionStatus(440).status).toBe('rejected')
    expect(evaluateInvoiceStatus(440)).toEqual({ status: 'accepted', terminal: true, duplicate: true })
  })
})
