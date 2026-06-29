import { buildFa3XmlFromInput } from '../build-submission'
import { fa3InvoiceSchema } from '../../data/validators'

// Regression for the SPEC-009 send-path wiring: buildFa3XmlFromInput is the SOLE production
// FA(3) builder (sendCommand + issueOfflineCommand). It must thread the advance/settlement/order
// blocks through to the serializer — earlier it dropped them, so a ZAL threw "must have at least
// one line" (no Zamowienie) and a ROZ filed without FakturaZaliczkowa. These tests drive the REAL
// builder (not a mock) so that regression can't return.
const seller = { nip: '2481632647', name: 'Sprzedawca Sp. z o.o.', countryCode: 'PL', addressLine1: 'ul. A 1, Gdańsk' }
const buyer = { nip: '3755747347', name: 'Nabywca S.A.', countryCode: 'PL', addressLine1: 'ul. B 2, Kraków' }

describe('buildFa3XmlFromInput threads the advanced FA(3) document-type blocks', () => {
  it('ZAL emits the Zamowienie order block (FaWiersz optional) and RodzajFaktury=ZAL', () => {
    const input = fa3InvoiceSchema.parse({
      invoiceNumber: 'ZAL-1', issueDate: '2026-06-29', currencyCode: 'PLN', invoiceKind: 'ZAL',
      seller, buyer,
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }], totalGross: '123.00', lines: [],
      order: { totalValue: '123.00', lines: [{ lineNumber: 1, name: 'Zamówiona usługa', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }] },
      advancePayments: [{ receivedDate: '2026-06-29', amount: '123.00' }],
    })
    const xml = buildFa3XmlFromInput(input)
    expect(xml).toContain('<RodzajFaktury>ZAL</RodzajFaktury>')
    expect(xml).toContain('<Zamowienie>')
    expect(xml).toContain('<ZaliczkaCzesciowa>')
  })

  it('ROZ emits the FakturaZaliczkowa reference to the prior advance and RodzajFaktury=ROZ', () => {
    const input = fa3InvoiceSchema.parse({
      invoiceNumber: 'ROZ-1', issueDate: '2026-06-29', currencyCode: 'PLN', invoiceKind: 'ROZ',
      seller, buyer,
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }], totalGross: '123.00',
      lines: [{ lineNumber: 1, name: 'Pozycja końcowa', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
      advanceInvoiceRefs: [{ ksefNumber: '2481632647-20260629-09DDD1000000-DA', amount: '123.00' }],
    })
    const xml = buildFa3XmlFromInput(input)
    expect(xml).toContain('<RodzajFaktury>ROZ</RodzajFaktury>')
    expect(xml).toContain('<FakturaZaliczkowa>')
    expect(xml).toContain('NrKSeFFaZaliczkowej')
  })

  it('a plain VAT invoice emits none of the advanced blocks (byte-stable path preserved)', () => {
    const input = fa3InvoiceSchema.parse({
      invoiceNumber: 'FV-1', issueDate: '2026-06-29', currencyCode: 'PLN', invoiceKind: 'VAT',
      seller, buyer,
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }], totalGross: '123.00',
      lines: [{ lineNumber: 1, name: 'Usługa', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
    })
    const xml = buildFa3XmlFromInput(input)
    expect(xml).not.toContain('<Zamowienie>')
    expect(xml).not.toContain('<ZaliczkaCzesciowa>')
    expect(xml).not.toContain('<FakturaZaliczkowa>')
  })
})
