import { canIssueInvoiceToKsef, isInvoiceIssued } from '../invoice-status'

describe('invoice KSeF lifecycle', () => {
  it.each([undefined, null, '', 'draft', 'pending', 'sent', 'paid'])('allows explicit issuance from %p', (status) => {
    expect(canIssueInvoiceToKsef(status)).toBe(true)
  })

  it.each(['void', 'voided', 'cancel', 'canceled', 'cancelled', ' VOID '])('blocks canceled state %p', (status) => {
    expect(canIssueInvoiceToKsef(status)).toBe(false)
  })

  it('keeps the stricter issued predicate for non-interactive JPK inclusion', () => {
    expect(isInvoiceIssued('draft')).toBe(false)
    expect(isInvoiceIssued('sent')).toBe(true)
  })
})
