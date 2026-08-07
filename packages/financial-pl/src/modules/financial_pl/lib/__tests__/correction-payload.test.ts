import { buildCreditMemoPayload } from '../correction-payload'

describe('buildCreditMemoPayload', () => {
  it('copies gross pricing and discount detail through core-accepted fields', () => {
    const payload = buildCreditMemoPayload({
      invoiceId: '11111111-1111-1111-1111-111111111111',
      reason: 'Zwrot',
      currencyCode: 'PLN',
      issueDate: '2026-07-02',
      priceMode: 'gross',
      lines: [
        {
          name: 'Towar',
          quantity: '2',
          unitPriceNet: '81.30',
          unitPriceGross: '100.00',
          discountAmount: '20.00',
          discountPercent: '10.00',
          totalNetAmount: '146.34',
          totalGrossAmount: '180.00',
          currencyCode: 'PLN',
        },
      ],
    })

    expect(payload.metadata).toEqual({
      correctedInvoiceId: '11111111-1111-1111-1111-111111111111',
      priceMode: 'gross',
    })
    expect(payload.lines[0]).toMatchObject({
      unitPriceGross: '100.00',
      totalGrossAmount: '180.00',
      metadata: { discountAmount: '20.00', discountPercent: '10.00' },
    })
  })

  it('always carries the corrected invoice id even when price mode is omitted', () => {
    const payload = buildCreditMemoPayload({
      invoiceId: '22222222-2222-2222-2222-222222222222',
      reason: 'Correction',
      currencyCode: 'PLN',
      lines: [{ name: 'Item', quantity: '1', unitPriceNet: '10', currencyCode: 'PLN' }],
    })

    expect(payload.metadata).toEqual({ correctedInvoiceId: '22222222-2222-2222-2222-222222222222' })
  })
})
