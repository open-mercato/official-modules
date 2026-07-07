import { buildCreditMemoPayload } from '../../lib/correction-payload'

describe('CorrectionForm correction payload', () => {
  it('carries gross price mode into credit memo metadata', () => {
    const payload = buildCreditMemoPayload({
      invoiceId: 'invoice-1',
      reason: 'Rounding correction',
      currencyCode: 'PLN',
      issueDate: '2026-07-07',
      priceMode: 'gross',
      lines: [
        {
          name: 'Cena brutto',
          quantity: '1',
          quantityUnit: 'szt.',
          unitPriceNet: '100.00',
          unitPriceGross: '123.00',
          taxRate: '23',
          currencyCode: 'PLN',
        },
      ],
    })

    expect(payload.metadata).toEqual({ priceMode: 'gross' })
  })
})
