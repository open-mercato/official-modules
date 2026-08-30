import { fa3InvoiceSchema, invoicePaymentSchema, type Fa3InvoiceInput } from '../../data/validators'
import { buildFa3XmlFromInput } from '../build-submission'

const seller = {
  nip: '2481632647',
  name: 'Seller Sp. z o.o.',
  countryCode: 'PL',
  addressLine1: 'ul. Seller 1, Gdansk',
}

const buyer = {
  nip: '3755747347',
  name: 'Buyer S.A.',
  countryCode: 'PL',
  addressLine1: 'ul. Buyer 2, Krakow',
}

function buildXml(
  payment?: NonNullable<Fa3InvoiceInput['payment']>,
  overrides: Partial<Fa3InvoiceInput> = {},
): string {
  const input = fa3InvoiceSchema.parse({
    invoiceNumber: 'FV/2026/06/30',
    issueDate: '2026-06-30',
    currencyCode: 'PLN',
    seller,
    buyer,
    vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
    totalGross: '123.00',
    lines: [
      {
        lineNumber: 1,
        name: 'Consulting service',
        quantity: '1',
        unitNetPrice: '100.00',
        netValue: '100.00',
        vatRate: 23,
      },
    ],
    ...overrides,
    ...(payment ? { payment } : {}),
  })
  return buildFa3XmlFromInput(input, { systemInfo: 'financial_pl-test' })
}

describe('FA(3) payment block', () => {
  it('emits transfer method, due date, and bank account', () => {
    const xml = buildXml({
      method: 'transfer',
      terminDate: '2026-07-14',
      bankAccount: 'PL61109010140000071219812874',
    })

    expect(xml).toContain('<Platnosc>')
    expect(xml).toContain('<FormaPlatnosci>6</FormaPlatnosci>')
    expect(xml).toContain('<TerminPlatnosci><Termin>2026-07-14</Termin></TerminPlatnosci>')
    expect(xml).toContain('<RachunekBankowy><NrRB>PL61109010140000071219812874</NrRB>')
  })

  it('emits cash method with paid marker and payment date', () => {
    const xml = buildXml({ method: 'cash', paid: true, paidDate: '2026-06-30' })

    expect(xml).toContain('<FormaPlatnosci>1</FormaPlatnosci>')
    expect(xml).toContain('<Zaplacono>1</Zaplacono><DataZaplaty>2026-06-30</DataZaplaty>')
  })

  it('emits other method as PlatnoscInna with description and no FormaPlatnosci', () => {
    const xml = buildXml({ method: 'other', methodOther: 'Za pobraniem' })

    expect(xml).toContain('<PlatnoscInna>1</PlatnoscInna><OpisPlatnosci>Za pobraniem</OpisPlatnosci>')
    expect(xml).not.toContain('<FormaPlatnosci>')
  })

  it('omits Platnosc when no payment is provided', () => {
    const xml = buildXml()

    expect(xml).not.toContain('<Platnosc>')
  })

  it('places Platnosc after the last FaWiersz and before Zamowienie', () => {
    const xml = buildXml(
      { method: 'transfer', terminDate: '2026-07-14' },
      {
        order: {
          totalValue: '123.00',
          lines: [
            {
              lineNumber: 1,
              name: 'Ordered service',
              quantity: '1',
              unitNetPrice: '100.00',
              netValue: '100.00',
              vatRate: 23,
            },
          ],
        },
      },
    )

    const lastLineEnd = xml.lastIndexOf('</FaWiersz>')
    const paymentStart = xml.indexOf('<Platnosc>')
    const orderStart = xml.indexOf('<Zamowienie>')
    const faEnd = xml.indexOf('</Fa>')

    expect(lastLineEnd).toBeGreaterThanOrEqual(0)
    expect(paymentStart).toBeGreaterThan(lastLineEnd)
    expect(paymentStart).toBeLessThan(faEnd)
    expect(orderStart).toBeGreaterThan(paymentStart)
  })
})

describe('invoicePaymentSchema conditional validity', () => {
  it('requires paidDate when paid is true', () => {
    expect(invoicePaymentSchema.safeParse({ method: 'transfer', paid: true }).success).toBe(false)
  })

  it('requires methodOther when method is other', () => {
    expect(invoicePaymentSchema.safeParse({ method: 'other' }).success).toBe(false)
  })
})
