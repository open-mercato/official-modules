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

describe('FA(3) VAT summary — buckets sharing a field are merged (M5)', () => {
  it('sums a legacy 22% bucket into the same P_13_1/P_14_1 as 23% (one element each)', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [
      { rate: 23, net: '100.00', vat: '23.00' },
      { rate: 22, net: '50.00', vat: '11.00' },
    ]
    const xml = buildFa3Xml(doc)
    // Exactly one P_13_1 / P_14_1, carrying the summed amounts (not two duplicate elements).
    expect(xml.match(/<P_13_1>/g)).toHaveLength(1)
    expect(xml.match(/<P_14_1>/g)).toHaveLength(1)
    expect(xml).toContain('<P_13_1>150.00</P_13_1>')
    expect(xml).toContain('<P_14_1>34.00</P_14_1>')
  })

  it('merges 7% into 8% (P_13_2/P_14_2) as well', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [
      { rate: 8, net: '100.00', vat: '8.00' },
      { rate: 7, net: '100.00', vat: '7.00' },
    ]
    const xml = buildFa3Xml(doc)
    expect(xml.match(/<P_13_2>/g)).toHaveLength(1)
    expect(xml).toContain('<P_13_2>200.00</P_13_2>')
    expect(xml).toContain('<P_14_2>15.00</P_14_2>')
  })
})

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

  it('emits a discounted net line with P_10 between P_9A and P_11 and discounted VAT sums', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [{ rate: 23, net: '180.00', vat: '41.40' }]
    doc.model.totalGross = '221.40'
    doc.lines = [
      {
        lineNumber: 1,
        name: 'Towar z rabatem',
        unit: 'szt',
        quantity: '2',
        unitNetPrice: '100.00',
        discount: '20.00',
        netValue: '180.00',
        vatRate: 23,
      },
    ]

    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_13_1>180.00</P_13_1>')
    expect(xml).toContain('<P_14_1>41.40</P_14_1>')
    const line = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(line).toContain('<P_9A>100.00</P_9A><P_10>20.00</P_10><P_11>180.00</P_11>')
  })

  it('emits gross-method rows with P_9B/P_11A, keeps P_12, and omits P_9A/P_11', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [{ rate: 23, net: '16.24', vat: '3.74' }]
    doc.model.totalGross = '19.98'
    doc.lines = [
      {
        lineNumber: 1,
        name: 'Cena brutto',
        unit: 'szt',
        quantity: '2',
        unitNetPrice: '8.12',
        unitGrossPrice: '9.99',
        netValue: '16.24',
        grossValue: '19.98',
        vatRate: 23,
      },
    ]

    const xml = buildFa3Xml(doc)
    const line = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(line).toContain('<P_9B>9.99</P_9B><P_11A>19.98</P_11A><P_12>23</P_12>')
    expect(line).not.toContain('<P_9A>')
    expect(line).not.toContain('<P_11>')
    expect(xml).toContain('<P_13_1>16.24</P_13_1>')
    expect(xml).toContain('<P_14_1>3.74</P_14_1>')
  })

  it.each([
    ['travel', 'P_PMarzy_2'],
    ['used_goods', 'P_PMarzy_3_1'],
    ['art', 'P_PMarzy_3_2'],
    ['collectibles', 'P_PMarzy_3_3'],
  ] as const)('emits VAT marża scheme %s as gross-only rows and P_13_11', (scheme, field) => {
    const doc = sampleDocument()
    doc.model.annotations = { marginScheme: scheme }
    doc.model.vatBreakdown = [{ rate: 'margin', net: '100.00', vat: '0.00' }]
    doc.model.totalGross = '100.00'
    doc.lines = [
      {
        lineNumber: 1,
        name: 'Marza',
        unit: 'szt',
        quantity: '1',
        unitNetPrice: '100.00',
        unitGrossPrice: '100.00',
        netValue: '100.00',
        grossValue: '100.00',
        vatRate: 0,
        marginRow: true,
      },
    ]

    const xml = buildFa3Xml(doc)
    expect(xml).toContain(`<PMarzy><P_PMarzy>1</P_PMarzy><${field}>1</${field}></PMarzy>`)
    expect(xml).toContain('<P_13_11>100.00</P_13_11>')
    expect(xml).not.toContain('<P_13_1>')
    expect(xml).not.toContain('<P_14_1>')
    const line = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(line).toContain('<P_9B>100.00</P_9B><P_11A>100.00</P_11A>')
    expect(line).not.toContain('<P_9A>')
    expect(line).not.toContain('<P_11>')
    expect(line).not.toContain('<P_12>')
  })

  it('uses P_10 with gross semantics for discounted VAT marża rows', () => {
    const doc = sampleDocument()
    doc.model.annotations = { marginScheme: 'used_goods' }
    doc.model.vatBreakdown = [{ rate: 'margin', net: '180.00', vat: '0.00' }]
    doc.model.totalGross = '180.00'
    doc.lines = [
      {
        lineNumber: 1,
        name: 'Marza z rabatem',
        unit: 'szt',
        quantity: '2',
        unitNetPrice: '100.00',
        unitGrossPrice: '100.00',
        discount: '20.00',
        netValue: '180.00',
        grossValue: '180.00',
        vatRate: 0,
        marginRow: true,
      },
    ]

    const xml = buildFa3Xml(doc)
    const line = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(line).toContain('<P_9B>100.00</P_9B><P_10>20.00</P_10><P_11A>180.00</P_11A>')
    expect(xml).toContain('<P_13_11>180.00</P_13_11>')
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

describe('FA(3) self-billing (P_17, samofakturowanie)', () => {
  it('drives P_17 from annotations.selfBilling ("1" self-billed, else "2")', () => {
    const yes = sampleDocument()
    yes.model.annotations = { selfBilling: true }
    expect(buildFa3Xml(yes)).toContain('<P_17>1</P_17>')

    const no = sampleDocument()
    no.model.annotations = { selfBilling: false }
    expect(buildFa3Xml(no)).toContain('<P_17>2</P_17>')

    // Default (no annotations) stays "2" (does not apply).
    expect(buildFa3Xml(sampleDocument())).toContain('<P_17>2</P_17>')
  })

  it('folds the top-level model.selfBilling shortcut into the annotation block', () => {
    const doc = sampleDocument()
    doc.model.selfBilling = true
    expect(buildFa3Xml(doc)).toContain('<P_17>1</P_17>')
  })
})

describe('FA(3) OSS / WSTO_EE', () => {
  it('emits an OSS line with P_12_XII + Procedura=WSTO_EE and omits P_12', () => {
    const doc = sampleDocument()
    doc.model.currencyCode = 'EUR'
    doc.lines = [
      {
        lineNumber: 1,
        name: 'Distance sale to DE',
        unit: 'szt',
        quantity: '1',
        unitNetPrice: '100.00',
        netValue: '100.00',
        vatRate: 23,
        ossRate: '19',
        procedure: 'WSTO_EE',
      },
    ]
    doc.model.vatBreakdown = [{ rate: 'oss', net: '100.00', vat: '19.00' }]
    doc.model.totalGross = '119.00'
    const xml = buildFa3Xml(doc)
    const wiersz = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(wiersz).toContain('<P_12_XII>19</P_12_XII>')
    expect(wiersz).toContain('<Procedura>WSTO_EE</Procedura>')
    expect(wiersz).not.toContain('<P_12>')
    // Procedura comes after P_12_XII and before any KursWaluty.
    expect(wiersz.indexOf('<P_12_XII>')).toBeLessThan(wiersz.indexOf('<Procedura>'))
  })

  it('emits the OSS summary bucket P_13_5/P_14_5 ranked between the 5% (P_13_3) and 0% (P_13_6_1) buckets, with no W variant', () => {
    const doc = sampleDocument()
    doc.model.vatBreakdown = [
      { rate: 0, net: '40.00', vat: '0.00' },
      { rate: 'oss', net: '100.00', vat: '19.00' },
      { rate: 5, net: '50.00', vat: '2.50' },
    ]
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_13_5>100.00</P_13_5>')
    expect(xml).toContain('<P_14_5>19.00</P_14_5>')
    expect(xml).not.toContain('<P_14_5W>')
    const order = ['P_13_3', 'P_13_5', 'P_14_5', 'P_13_6_1'].map((t) => xml.indexOf(`<${t}>`))
    expect(order.every((p) => p >= 0)).toBe(true)
    expect([...order]).toEqual([...order].sort((a, b) => a - b))
  })

  it('emits a single OSS bucket regardless of how many distinct consumer rates appear', () => {
    const doc = sampleDocument()
    // The caller pre-aggregates all OSS lines into one synthetic 'oss' bucket; the serializer
    // emits exactly one P_13_5/P_14_5 pair.
    doc.model.vatBreakdown = [{ rate: 'oss', net: '300.00', vat: '57.00' }]
    const xml = buildFa3Xml(doc)
    expect((xml.match(/<P_13_5>/g) ?? []).length).toBe(1)
    expect((xml.match(/<P_14_5>/g) ?? []).length).toBe(1)
  })

  it('emits a per-line KursWaluty when fxRate is set', () => {
    const doc = sampleDocument()
    doc.model.currencyCode = 'EUR'
    doc.lines[0].fxRate = '4.3210'
    const xml = buildFa3Xml(doc)
    const wiersz = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'))
    expect(wiersz).toContain('<KursWaluty>4.3210</KursWaluty>')
  })
})

describe('FA(3) foreign-currency P_14_xW (PLN-converted VAT)', () => {
  it('emits P_14_1W right after P_14_1 for a Polish-rate bucket with vatPln, but never for the OSS bucket', () => {
    const doc = sampleDocument()
    doc.model.currencyCode = 'EUR'
    doc.model.vatBreakdown = [
      { rate: 23, net: '100.00', vat: '23.00', vatPln: '99.36' },
      { rate: 'oss', net: '50.00', vat: '9.50', vatPln: '41.00' },
    ]
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_14_1>23.00</P_14_1><P_14_1W>99.36</P_14_1W>')
    // The OSS bucket carries no W variant even if vatPln is (wrongly) supplied.
    expect(xml).not.toContain('<P_14_5W>')
  })
})

describe('FA(3) document type: VAT — byte-identical baseline', () => {
  // Pins the full <Fa> ... </Fa> block for a plain VAT invoice so any accidental reorder
  // or extra emission on the VAT/KOR path is caught (regulation-critical: a VAT document
  // must serialize byte-identically across this change).
  it('emits the exact VAT <Fa> block in XSD sequence order', () => {
    const xml = buildFa3Xml(sampleDocument())
    const fa = xml.slice(xml.indexOf('<Fa>'), xml.indexOf('</Fa>') + '</Fa>'.length)
    expect(fa).toBe(
      '<Fa>' +
        '<KodWaluty>PLN</KodWaluty>' +
        '<P_1>2026-06-22</P_1>' +
        '<P_2>FV/2026/06/1</P_2>' +
        '<P_13_1>100.00</P_13_1>' +
        '<P_14_1>23.00</P_14_1>' +
        '<P_15>123.00</P_15>' +
        '<Adnotacje>' +
        '<P_16>2</P_16>' +
        '<P_17>2</P_17>' +
        '<P_18>2</P_18>' +
        '<P_18A>2</P_18A>' +
        '<Zwolnienie><P_19N>1</P_19N></Zwolnienie>' +
        '<NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>' +
        '<P_23>2</P_23>' +
        '<PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy>' +
        '</Adnotacje>' +
        '<RodzajFaktury>VAT</RodzajFaktury>' +
        '<FaWiersz>' +
        '<NrWierszaFa>1</NrWierszaFa>' +
        '<P_7>Usługa konsultingowa</P_7>' +
        '<P_8A>szt</P_8A>' +
        '<P_8B>1</P_8B>' +
        '<P_9A>100.00</P_9A>' +
        '<P_11>100.00</P_11>' +
        '<P_12>23</P_12>' +
        '</FaWiersz>' +
        '</Fa>',
    )
  })
})

describe('FA(3) document type: ZAL (advance / faktura zaliczkowa)', () => {
  it('emits ZaliczkaCzesciowa + Zamowienie and allows zero FaWiersz when an order is present', () => {
    const doc: Fa3Document = {
      model: {
        ...sampleDocument().model,
        invoiceKind: 'ZAL',
        totalGross: '123.00',
        advancePayments: [{ receivedDate: '2026-06-20', amount: '123.00' }],
        order: {
          totalValue: '123.00',
          lines: [
            {
              lineNumber: 1,
              name: 'Zamówiona usługa',
              unit: 'szt',
              quantity: '1',
              unitNetPrice: '100.00',
              netValue: '100.00',
              vatValue: '23.00',
              vatRate: 23,
            },
          ],
        },
      },
      lines: [],
    }
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<RodzajFaktury>ZAL</RodzajFaktury>')
    expect(xml).toContain(
      '<ZaliczkaCzesciowa><P_6Z>2026-06-20</P_6Z><P_15Z>123.00</P_15Z></ZaliczkaCzesciowa>',
    )
    expect(xml).toContain(
      '<Zamowienie><WartoscZamowienia>123.00</WartoscZamowienia>' +
        '<ZamowienieWiersz>' +
        '<NrWierszaZam>1</NrWierszaZam>' +
        '<P_7Z>Zamówiona usługa</P_7Z>' +
        '<P_8AZ>szt</P_8AZ>' +
        '<P_8BZ>1</P_8BZ>' +
        '<P_9AZ>100.00</P_9AZ>' +
        '<P_11NettoZ>100.00</P_11NettoZ>' +
        '<P_11VatZ>23.00</P_11VatZ>' +
        '<P_12Z>23</P_12Z>' +
        '</ZamowienieWiersz>' +
        '</Zamowienie>',
    )
    // No FaWiersz when the advance carries its detail in Zamowienie.
    expect(xml).not.toContain('<FaWiersz>')
    // XSD order: ZaliczkaCzesciowa before Zamowienie.
    expect(xml.indexOf('<ZaliczkaCzesciowa>')).toBeLessThan(xml.indexOf('<Zamowienie>'))
  })

  it('emits KursWalutyZW on an advance payment when an FX rate is supplied', () => {
    const base = sampleDocument()
    const doc: Fa3Document = {
      model: {
        ...base.model,
        invoiceKind: 'ZAL',
        currencyCode: 'EUR',
        advancePayments: [{ receivedDate: '2026-06-20', amount: '100.00', fxRate: '4.3000' }],
        order: { totalValue: '100.00', lines: [{ lineNumber: 1, name: 'X' }] },
      },
      lines: [],
    }
    expect(buildFa3Xml(doc)).toContain(
      '<ZaliczkaCzesciowa><P_6Z>2026-06-20</P_6Z><P_15Z>100.00</P_15Z><KursWalutyZW>4.3000</KursWalutyZW></ZaliczkaCzesciowa>',
    )
  })

  it('still throws for a ZAL with neither lines nor an order block', () => {
    const doc: Fa3Document = { model: { ...sampleDocument().model, invoiceKind: 'ZAL' }, lines: [] }
    expect(() => buildFa3Xml(doc)).toThrow()
  })
})

describe('FA(3) document type: ROZ (settlement / faktura rozliczeniowa)', () => {
  it('emits FakturaZaliczkowa refs (KSeF-issued and outside-KSeF) with full FaWiersz', () => {
    const base = sampleDocument()
    const doc: Fa3Document = {
      model: {
        ...base.model,
        invoiceKind: 'ROZ',
        totalGross: '50.00',
        advanceInvoiceRefs: [
          { ksefNumber: '1234567890-20260620-ABCDEF-01' },
          { invoiceNumber: 'FZ/2026/06/9' },
        ],
      },
      lines: base.lines,
    }
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<RodzajFaktury>ROZ</RodzajFaktury>')
    // KSeF-issued advance → NrKSeFFaZaliczkowej.
    expect(xml).toContain(
      '<FakturaZaliczkowa><NrKSeFFaZaliczkowej>1234567890-20260620-ABCDEF-01</NrKSeFFaZaliczkowej></FakturaZaliczkowa>',
    )
    // Outside-KSeF advance → NrKSeFZN=1 + NrFaZaliczkowej (mirrors the KOR NrKSeFN choice).
    expect(xml).toContain(
      '<FakturaZaliczkowa><NrKSeFZN>1</NrKSeFZN><NrFaZaliczkowej>FZ/2026/06/9</NrFaZaliczkowej></FakturaZaliczkowa>',
    )
    expect(xml).toContain('<FaWiersz>')
    // FakturaZaliczkowa precedes FaWiersz.
    expect(xml.indexOf('<FakturaZaliczkowa>')).toBeLessThan(xml.indexOf('<FaWiersz>'))
  })
})

describe('FA(3) document type: UPR (simplified / faktura uproszczona)', () => {
  it('emits a NIP-only Podmiot2 (no Nazwa/Adres) while keeping the trailing JST/GV flags', () => {
    const doc = sampleDocument()
    doc.model.invoiceKind = 'UPR'
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<RodzajFaktury>UPR</RodzajFaktury>')
    const podmiot2 = xml.slice(xml.indexOf('<Podmiot2>'), xml.indexOf('</Podmiot2>') + '</Podmiot2>'.length)
    expect(podmiot2).toBe(
      '<Podmiot2>' +
        '<DaneIdentyfikacyjne><NIP>3755747347</NIP></DaneIdentyfikacyjne>' +
        '<JST>2</JST>' +
        '<GV>2</GV>' +
        '</Podmiot2>',
    )
    expect(podmiot2).not.toContain('<Nazwa>')
    expect(podmiot2).not.toContain('<Adres>')
  })

  it('falls back to a full Podmiot2 for a UPR buyer that has no NIP', () => {
    const doc = sampleDocument()
    doc.model.invoiceKind = 'UPR'
    doc.model.buyer = { name: 'Klient detaliczny', countryCode: 'PL', addressLine1: 'ul. Kliencka 2' }
    const xml = buildFa3Xml(doc)
    const podmiot2 = xml.slice(xml.indexOf('<Podmiot2>'), xml.indexOf('</Podmiot2>'))
    expect(podmiot2).toContain('<Nazwa>Klient detaliczny</Nazwa>')
    expect(podmiot2).toContain('<Adres>')
  })
})

describe('FA(3) document type: OSS-EUR (pure OSS distance sale in EUR)', () => {
  it('emits the exact OSS <Fa> block: P_13_5/P_14_5 summary + P_12_XII/Procedura/KursWaluty line, no P_12', () => {
    const doc: Fa3Document = {
      model: {
        ...sampleDocument().model,
        currencyCode: 'EUR',
        vatBreakdown: [{ rate: 'oss', net: '100.00', vat: '19.00' }],
        totalGross: '119.00',
      },
      lines: [
        {
          lineNumber: 1,
          name: 'Distance sale to DE',
          unit: 'szt',
          quantity: '1',
          unitNetPrice: '100.00',
          netValue: '100.00',
          vatRate: 23,
          ossRate: '19',
          procedure: 'WSTO_EE',
          fxRate: '4.3000',
        },
      ],
    }
    const xml = buildFa3Xml(doc)
    const fa = xml.slice(xml.indexOf('<Fa>'), xml.indexOf('</Fa>') + '</Fa>'.length)
    expect(fa).toContain('<KodWaluty>EUR</KodWaluty>')
    expect(fa).toContain('<P_13_5>100.00</P_13_5><P_14_5>19.00</P_14_5>')
    expect(fa).toContain(
      '<FaWiersz>' +
        '<NrWierszaFa>1</NrWierszaFa>' +
        '<P_7>Distance sale to DE</P_7>' +
        '<P_8A>szt</P_8A>' +
        '<P_8B>1</P_8B>' +
        '<P_9A>100.00</P_9A>' +
        '<P_11>100.00</P_11>' +
        '<P_12_XII>19</P_12_XII>' +
        '<Procedura>WSTO_EE</Procedura>' +
        '<KursWaluty>4.3000</KursWaluty>' +
        '</FaWiersz>',
    )
    expect(fa).not.toContain('<P_12>')
    expect(fa).not.toContain('<P_14_5W>')
  })
})

describe('FA(3) document type: KOR_ZAL / KOR_ROZ (correction tail P_15ZK / KursWalutyZK)', () => {
  it('KOR_ZAL: emits P_15ZK after DaneFaKorygowanej and before OkresFaKorygowanej', () => {
    const base = sampleDocument()
    const doc: Fa3Document = {
      model: {
        ...base.model,
        invoiceKind: 'KOR_ZAL',
        correction: {
          reason: 'Korekta zaliczki',
          correctionType: 1,
          correctedInvoices: [
            { correctedIssueDate: '2026-06-20', correctedInvoiceNumber: 'FZ/2026/06/1', correctedKsefNumber: 'KSEF-1' },
          ],
          preCorrectionPaymentAmount: '123.00',
          period: '2026-06',
        },
        order: { totalValue: '100.00', lines: [{ lineNumber: 1, name: 'Pozycja', vatRate: 23 }] },
      },
      lines: [],
    }
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<RodzajFaktury>KOR_ZAL</RodzajFaktury>')
    expect(xml).toContain('<P_15ZK>123.00</P_15ZK>')
    // Order: DaneFaKorygowanej → P_15ZK → OkresFaKorygowanej.
    expect(xml.indexOf('</DaneFaKorygowanej>')).toBeLessThan(xml.indexOf('<P_15ZK>'))
    expect(xml.indexOf('<P_15ZK>')).toBeLessThan(xml.indexOf('<OkresFaKorygowanej>'))
  })

  it('KOR_ROZ: emits P_15ZK + KursWalutyZK for a foreign-currency settlement correction', () => {
    const base = sampleDocument()
    const doc: Fa3Document = {
      model: {
        ...base.model,
        invoiceKind: 'KOR_ROZ',
        currencyCode: 'EUR',
        correction: {
          correctedInvoices: [
            { correctedIssueDate: '2026-06-21', correctedInvoiceNumber: 'FR/2026/06/1' },
          ],
          preCorrectionPaymentAmount: '50.00',
          preCorrectionFxRate: '4.3000',
        },
      },
      lines: base.lines,
    }
    const xml = buildFa3Xml(doc)
    expect(xml).toContain('<P_15ZK>50.00</P_15ZK><KursWalutyZK>4.3000</KursWalutyZK>')
    // The outside-KSeF corrected reference still emits NrKSeFN=1.
    expect(xml).toContain('<NrKSeFN>1</NrKSeFN>')
  })
})
