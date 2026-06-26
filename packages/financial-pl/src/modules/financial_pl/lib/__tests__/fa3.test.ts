import { buildFa3Xml, escapeXml, type Fa3Document } from '../fa3'

function sampleDocument(): Fa3Document {
  return {
    model: {
      createdAt: '2026-06-22T10:00:00Z',
      seller: {
        nip: '7980332920',
        name: 'Sprzedawca Sp. z o.o.',
        countryCode: 'PL',
        addressLine1: 'ul. Testowa 1, 00-001 Warszawa',
      },
      buyer: {
        nip: '3755747347',
        name: 'Nabywca <Test> & Co',
        countryCode: 'PL',
        addressLine1: 'ul. Kliencka 2, 00-002 Kraków',
      },
      invoiceNumber: 'FV/2026/06/1',
      issueDate: '2026-06-22',
      currencyCode: 'PLN',
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
      totalGross: '123.00',
    },
    lines: [
      {
        lineNumber: 1,
        name: 'Usługa konsultingowa',
        unit: 'szt',
        quantity: '1',
        unitNetPrice: '100.00',
        netValue: '100.00',
        vatRate: 23,
      },
    ],
  }
}

describe('FA(3) XML mapper', () => {
  it('produces a Faktura document with the FA(3) namespace and header', () => {
    const xml = buildFa3Xml(sampleDocument())
    expect(xml).toContain('<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">')
    expect(xml).toContain('<KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>')
    expect(xml).toContain('<WariantFormularza>3</WariantFormularza>')
  })

  it('emits DataWytworzeniaFa as a second-precision dateTime (drops milliseconds the strict FA(3) XSD rejects)', () => {
    const doc = sampleDocument()
    doc.model.createdAt = '2026-06-25T12:34:56.789Z'
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<DataWytworzeniaFa>2026-06-25T12:34:56Z</DataWytworzeniaFa>')
    expect(xml).not.toContain('.789')
  })

  it('maps parties, totals, and VAT breakdown to FA fields', () => {
    const xml = buildFa3Xml(sampleDocument())
    expect(xml).toContain('<NIP>7980332920</NIP>')
    expect(xml).toContain('<P_2>FV/2026/06/1</P_2>')
    expect(xml).toContain('<P_13_1>100.00</P_13_1>')
    expect(xml).toContain('<P_14_1>23.00</P_14_1>')
    expect(xml).toContain('<P_15>123.00</P_15>')
  })

  it('renders invoice lines and escapes XML-special characters', () => {
    const xml = buildFa3Xml(sampleDocument())
    expect(xml).toContain('<FaWiersz>')
    expect(xml).toContain('<NrWierszaFa>1</NrWierszaFa>')
    expect(xml).toContain('<P_11>100.00</P_11>')
    expect(xml).toContain('Nabywca &lt;Test&gt; &amp; Co')
  })

  it('escapes ampersands, angle brackets, and quotes', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;')
  })

  it('emits VAT-summary fields in ascending schema order regardless of input order', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [
      { rate: 5, net: '50.00', vat: '2.50' },
      { rate: 23, net: '100.00', vat: '23.00' },
      { rate: 8, net: '80.00', vat: '6.40' },
    ]
    const xml = buildFa3Xml(doc)
    const order = ['P_13_1', 'P_14_1', 'P_13_2', 'P_14_2', 'P_13_3', 'P_14_3'].map((tag) => xml.indexOf(`<${tag}>`))
    expect(order.every((pos) => pos >= 0)).toBe(true)
    expect([...order]).toEqual([...order].sort((a, b) => a - b))
  })

  it('maps a 0% rate to the valid P_13_6_1 field (never the non-existent P_13_6)', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [{ rate: 0, net: '100.00', vat: '0.00' }]
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_13_6_1>100.00</P_13_6_1>')
    expect(xml).not.toContain('<P_13_6>')
  })

  it('maps zw → P_13_7, np → P_13_8, and reverse charge (oo) → P_13_10 (never P_13_9), with no P_14 tax field', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [
      { rate: 'zw', net: '100.00', vat: '0.00' },
      { rate: 'np', net: '50.00', vat: '0.00' },
      { rate: 'oo', net: '30.00', vat: '0.00' },
    ]
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_13_7>100.00</P_13_7>')
    expect(xml).toContain('<P_13_8>50.00</P_13_8>')
    // Reverse charge net belongs in P_13_10 (domestic odwrotne obciążenie), not the
    // intra-EU-services field P_13_9.
    expect(xml).toContain('<P_13_10>30.00</P_13_10>')
    expect(xml).not.toContain('<P_13_9>')
    // zw/np/oo carry no output VAT, so no P_14_x is emitted for them.
    expect(xml).not.toMatch(/<P_14_\d>/)
  })

  it('emits line P_12 values from the TStawkaPodatku enum (0 → "0 KR", np → "np I"), never the bare internal rate', () => {
    const doc = sampleDocument()
    doc.lines = [
      { lineNumber: 1, name: 'Standard', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
      { lineNumber: 2, name: 'Zero rate', unit: 'szt', quantity: '1', unitNetPrice: '50.00', netValue: '50.00', vatRate: 0 },
      { lineNumber: 3, name: 'Not taxed', unit: 'szt', quantity: '1', unitNetPrice: '30.00', netValue: '30.00', vatRate: 'np' },
      { lineNumber: 4, name: 'Exempt', unit: 'szt', quantity: '1', unitNetPrice: '20.00', netValue: '20.00', vatRate: 'zw' },
    ]
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_12>23</P_12>')
    expect(xml).toContain('<P_12>0 KR</P_12>')
    expect(xml).toContain('<P_12>np I</P_12>')
    expect(xml).toContain('<P_12>zw</P_12>')
    // The bare internal codes are NOT members of TStawkaPodatku — KSeF rejects them.
    expect(xml).not.toContain('<P_12>0</P_12>')
    expect(xml).not.toContain('<P_12>np</P_12>')
  })

  it('renders the seller (Podmiot1) with a NIP-only identity, never the KodUE/BrakID branch', () => {
    const xml = buildFa3Xml(sampleDocument())
    const podmiot1 = xml.slice(xml.indexOf('<Podmiot1>'), xml.indexOf('</Podmiot1>'))
    // FA(3) TPodmiot1 is strictly NIP + Nazwa — the seller emits a real NIP and never the
    // buyer-only KodUE/BrakID identity choice.
    expect(podmiot1).toContain('<NIP>7980332920</NIP>')
    expect(podmiot1).not.toContain('<KodUE>')
    expect(podmiot1).not.toContain('<BrakID>')
  })

  it('emits the FA(3) mandatory buyer flags JST=2 and GV=2 on Podmiot2 (last, JST before GV), not on Podmiot1', () => {
    const xml = buildFa3Xml(sampleDocument())
    const podmiot2 = xml.slice(xml.indexOf('<Podmiot2>'), xml.indexOf('</Podmiot2>'))
    const podmiot1 = xml.slice(xml.indexOf('<Podmiot1>'), xml.indexOf('</Podmiot1>'))
    // Without JST/GV, KSeF rejects Podmiot2 as "incomplete content" (status 450). They are
    // the last two siblings and only exist on the buyer (Podmiot2), never the seller.
    expect(podmiot2).toContain('<JST>2</JST>')
    expect(podmiot2).toContain('<GV>2</GV>')
    expect(podmiot2.indexOf('</Adres>')).toBeLessThan(podmiot2.indexOf('<JST>'))
    expect(podmiot2.indexOf('<JST>')).toBeLessThan(podmiot2.indexOf('<GV>'))
    expect(podmiot1).not.toContain('<JST>')
    expect(podmiot1).not.toContain('<GV>')
  })

  it('throws (never emits an empty/invalid NIP) when the seller (Podmiot1) has no NIP', () => {
    const doc = sampleDocument()
    // A seller without a NIP cannot form a valid FA(3) TPodmiot1 identity — fail fast
    // rather than serialize an XSD-invalid <NIP/> or fall back to the buyer's KodUE/BrakID.
    doc.model.seller = { euVatId: 'PL7980332920', name: 'Sprzedawca', countryCode: 'PL', addressLine1: 'ul. Testowa 1' }
    expect(() => buildFa3Xml(doc)).toThrow()
  })

  it('keeps the buyer (Podmiot2) polymorphic identity: BrakID when it has no NIP', () => {
    const doc = sampleDocument()
    doc.model.buyer = { name: 'Klient detaliczny', countryCode: 'PL', addressLine1: 'ul. Kliencka 2' }
    const xml = buildFa3Xml(doc)
    const podmiot2 = xml.slice(xml.indexOf('<Podmiot2>'), xml.indexOf('</Podmiot2>'))
    expect(podmiot2).toContain('<BrakID>1</BrakID>')
  })

  it('emits P_6 (sale date) when provided and P_8A (unit of measure) per line', () => {
    const doc = sampleDocument()
    doc.model.saleDate = '2026-06-18'
    doc.lines[0].unit = 'godz'
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_6>2026-06-18</P_6>')
    expect(xml).toContain('<P_8A>godz</P_8A>')
  })

  it('throws when there are no invoice lines', () => {
    const doc = sampleDocument()
    doc.lines = []
    expect(() => buildFa3Xml(doc)).toThrow()
  })
})

describe('FA(3) Adnotacje (annotation markers)', () => {
  it('defaults every procedure marker to "does not apply" when no annotations are provided', () => {
    const xml = buildFa3Xml(sampleDocument())
    expect(xml).toContain('<P_18>2</P_18>')
    expect(xml).toContain('<P_18A>2</P_18A>')
    expect(xml).toContain('<Zwolnienie><P_19N>1</P_19N></Zwolnienie>')
  })

  it('marks the split-payment mechanism (MPP) on P_18A — never on P_18', () => {
    const doc = sampleDocument()
    doc.model.annotations = { splitPayment: true }
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_18A>1</P_18A>')
    expect(xml).toContain('<P_18>2</P_18>')
  })

  it('marks reverse charge (odwrotne obciążenie) on P_18', () => {
    const doc = sampleDocument()
    doc.model.annotations = { reverseCharge: true }
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_18>1</P_18>')
    expect(xml).toContain('<P_18A>2</P_18A>')
  })

  it('emits the Zwolnienie exemption block with its legal basis (P_19 + P_19C)', () => {
    const doc = sampleDocument()
    doc.model.annotations = { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' }
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<Zwolnienie><P_19>1</P_19><P_19C>art. 113 ust. 1 ustawy o VAT</P_19C></Zwolnienie>')
    expect(xml).not.toContain('<P_19N>')
  })
})
