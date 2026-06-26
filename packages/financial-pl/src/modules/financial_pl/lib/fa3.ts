/**
 * FA(3) structured-invoice XML mapper.
 *
 * Produces the KSeF 2.0 FA(3) `<Faktura>` document (namespace
 * http://crd.gov.pl/wzor/2025/06/25/13775/, schema version 1-0E) from a
 * pre-computed, money-exact invoice model. This is a PURE serializer: all
 * amounts arrive as already-rounded decimal strings (the caller does the
 * BigInt money math + VAT aggregation), keeping the mapper deterministic and
 * fully unit-testable.
 *
 * Scope/accuracy note: this emits the structurally required FA(3) subset
 * (Naglowek, Podmiot1/Podmiot2, Fa header totals, Adnotacje markers, FaWiersz
 * lines). The full FA(3) XSD has many optional blocks; the document MUST be
 * validated against the official XSD (published at ksef.podatki.gov.pl) before a
 * production send — KSeF surfaces any schema gap as a rejection status, which
 * the connector records rather than masking.
 */
import { FA3_SCHEMA } from '../config'

export type Fa3VatRate = number | 'zw' | 'np' | 'oo'

export type Fa3Party = {
  nip?: string
  euVatId?: string
  name: string
  countryCode: string
  addressLine1: string
  addressLine2?: string
}

export type Fa3VatBreakdownEntry = {
  rate: Fa3VatRate
  net: string
  vat: string
}

export type Fa3Annotations = {
  /** Split-payment mechanism (MPP) → P_18A. */
  splitPayment?: boolean
  /** Reverse charge (odwrotne obciążenie) → P_18. */
  reverseCharge?: boolean
  /** VAT exemption legal basis → Zwolnienie/P_19 + P_19C. */
  vatExemptionBasis?: string
}

export type Fa3Line = {
  lineNumber: number
  name: string
  unit?: string
  quantity: string
  unitNetPrice: string
  netValue: string
  vatRate: Fa3VatRate
}

export type Fa3InvoiceModel = {
  createdAt: string
  systemInfo?: string
  seller: Fa3Party
  buyer: Fa3Party
  invoiceNumber: string
  issueDate: string
  saleDate?: string
  currencyCode: string
  invoiceKind?: 'VAT' | 'KOR' | 'ZAL' | 'ROZ' | 'UPR'
  vatBreakdown: Fa3VatBreakdownEntry[]
  totalGross: string
  annotations?: Fa3Annotations
}

export type Fa3Document = {
  model: Fa3InvoiceModel
  lines: Fa3Line[]
}

const VAT_NET_FIELD: Record<string, string> = {
  '23': 'P_13_1',
  '22': 'P_13_1',
  '8': 'P_13_2',
  '7': 'P_13_2',
  '5': 'P_13_3',
  '0': 'P_13_6_1',
  zw: 'P_13_7',
  np: 'P_13_8',
  // Reverse charge / odwrotne obciążenie (domestic, art. 17) → P_13_10. P_13_9 is
  // intra-EU services (art. 100 ust. 1 pkt 4), a different statutory field — emitting
  // the reverse-charge net under P_13_9 would mis-state the invoice.
  oo: 'P_13_10',
}

const VAT_TAX_FIELD: Record<string, string> = {
  '23': 'P_14_1',
  '22': 'P_14_1',
  '8': 'P_14_2',
  '7': 'P_14_2',
  '5': 'P_14_3',
}

/**
 * FA(3) requires the VAT-summary fields to appear in ascending schema order
 * (P_13_1/P_14_1, P_13_2/P_14_2, …, P_13_6_1, P_13_7, P_13_8, P_13_10), so the
 * breakdown is sorted by this rank before serialization regardless of the order
 * the caller supplies it in — an out-of-order sequence is an XSD validity error.
 */
const VAT_FIELD_RANK: Record<string, number> = {
  '23': 1,
  '22': 1,
  '8': 2,
  '7': 2,
  '5': 3,
  '0': 6,
  zw: 7,
  np: 8,
  oo: 10,
}

/**
 * Whether a VAT rate maps to a known FA(3) VAT-summary field (`P_13_x`). A rate
 * with no mapping (e.g. a blended header-derived 19%) would serialize a gross
 * total with the net/VAT silently dropped from the summary, so callers MUST
 * reject an unmapped rate before serialization rather than emit a wrong document.
 */
export function isMappedFa3VatRate(rate: Fa3VatRate): boolean {
  return VAT_NET_FIELD[typeof rate === 'number' ? String(rate) : rate] !== undefined
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function el(tag: string, value: string): string {
  return `<${tag}>${escapeXml(value)}</${tag}>`
}

function rateKey(rate: Fa3VatRate): string {
  return typeof rate === 'number' ? String(rate) : rate
}

// FA(3) `P_12` (line VAT rate) is the closed `TStawkaPodatku` enumeration. The raw
// internal rate (`0`, `np`) is NOT a member — KSeF rejects `<P_12>0</P_12>` and
// `<P_12>np</P_12>` on XSD validation (only 23/22/8/7/5/4/3, "0 KR"/"0 WDT"/"0 EX",
// "zw", "oo", "np I"/"np II" are valid). Map the internal rate to a valid member:
// standard numeric rates serialize as-is; a 0% line defaults to the domestic-rate code
// "0 KR" (the export codes "0 WDT"/"0 EX" need a transaction type the invoice model does
// not yet carry); `np` defaults to "np I"; `zw`/`oo` are already valid members.
const FA3_LINE_RATE_VALUE: Record<string, string> = {
  '0': '0 KR',
  np: 'np I',
}

function fa3LineVatRateValue(rate: Fa3VatRate): string {
  const key = typeof rate === 'number' ? String(rate) : rate
  return FA3_LINE_RATE_VALUE[key] ?? key
}

function renderParty(tag: string, party: Fa3Party, sellerNipOnly = false): string {
  // FA(3) `TPodmiot1` (seller / Podmiot1) requires a strict NIP + Nazwa identity — it has
  // no `KodUE`/`BrakID` branch, so the buyer's polymorphic identity choice would be
  // XSD-invalid for the seller. `TPodmiot2` (buyer) does allow `NIP | KodUE+NrVatUE |
  // BrakID`. The resolver/schema always set the seller NIP from the credential context
  // NIP, so the NIP is present on every real send path; fail fast (never emit an empty
  // `<NIP/>`, which is also XSD-invalid) rather than serialize a malformed Podmiot1.
  let identity: string
  if (sellerNipOnly) {
    if (!party.nip) throw new Error('[internal] FA(3) seller (Podmiot1) requires a NIP identity')
    identity = el('NIP', party.nip)
  } else {
    identity = party.nip
      ? el('NIP', party.nip)
      : party.euVatId
        ? `<KodUE>${escapeXml(party.euVatId.slice(0, 2))}</KodUE>${el('NrVatUE', party.euVatId.slice(2))}`
        : '<BrakID>1</BrakID>'
  }
  const addressLines = [el('AdresL1', party.addressLine1)]
  if (party.addressLine2) addressLines.push(el('AdresL2', party.addressLine2))
  // FA(3) added two MANDATORY trailing flags to the BUYER element (Podmiot2) that did not
  // exist in FA(2): JST (is the buyer a subordinate JST/local-government unit) and GV (is
  // the buyer a VAT-group member). For an ordinary domestic buyer both are "2" (No).
  // Omitting them makes KSeF reject Podmiot2 as "incomplete content" (status 450). They
  // must come last, JST before GV, and do NOT exist on Podmiot1 (seller). Value "1" would
  // additionally require a Podmiot3 with the matching role — deferred (out of scope here).
  const buyerFlags = tag === 'Podmiot2' ? [el('JST', '2'), el('GV', '2')] : []
  return [
    `<${tag}>`,
    '<DaneIdentyfikacyjne>',
    identity,
    el('Nazwa', party.name),
    '</DaneIdentyfikacyjne>',
    '<Adres>',
    el('KodKraju', party.countryCode),
    ...addressLines,
    '</Adres>',
    ...buyerFlags,
    `</${tag}>`,
  ].join('')
}

function renderVatBreakdown(entries: Fa3VatBreakdownEntry[]): string {
  const ordered = [...entries].sort(
    (a, b) => (VAT_FIELD_RANK[rateKey(a.rate)] ?? 99) - (VAT_FIELD_RANK[rateKey(b.rate)] ?? 99),
  )
  const parts: string[] = []
  for (const entry of ordered) {
    const key = rateKey(entry.rate)
    const netField = VAT_NET_FIELD[key]
    if (netField) parts.push(el(netField, entry.net))
    const taxField = VAT_TAX_FIELD[key]
    if (taxField) parts.push(el(taxField, entry.vat))
  }
  return parts.join('')
}

function renderLine(line: Fa3Line): string {
  return [
    '<FaWiersz>',
    el('NrWierszaFa', String(line.lineNumber)),
    el('P_7', line.name),
    el('P_8A', line.unit ?? 'szt'),
    el('P_8B', line.quantity),
    el('P_9A', line.unitNetPrice),
    el('P_11', line.netValue),
    el('P_12', fa3LineVatRateValue(line.vatRate)),
    '</FaWiersz>',
  ].join('')
}

/**
 * Annotation block (Adnotacje). FA(3) requires the procedure markers to be
 * present, so each absent marker defaults to "2" (does not apply) to keep a
 * minimal sales invoice schema-complete. Polish statutory specifics carried on
 * the SalesInvoicePlMeta extension drive the meaningful markers:
 *   - P_18A — mechanizm podzielonej płatności (MPP / split payment)
 *   - P_18  — odwrotne obciążenie (reverse charge)
 *   - Zwolnienie/P_19 + P_19C — VAT exemption with its legal basis (else P_19N)
 * NOTE: in FA(2)/FA(3) the MPP marker is P_18A, not P_18 (P_18 is reverse
 * charge) — emitting MPP on P_18 would mis-state the invoice.
 */
function renderAnnotations(annotations?: Fa3Annotations): string {
  const reverseCharge = annotations?.reverseCharge ? '1' : '2'
  const splitPayment = annotations?.splitPayment ? '1' : '2'
  const exemptionBasis = annotations?.vatExemptionBasis?.trim()
  const zwolnienie = exemptionBasis
    ? '<Zwolnienie>' + el('P_19', '1') + el('P_19C', exemptionBasis) + '</Zwolnienie>'
    : '<Zwolnienie>' + el('P_19N', '1') + '</Zwolnienie>'
  return [
    '<Adnotacje>',
    el('P_16', '2'),
    el('P_17', '2'),
    el('P_18', reverseCharge),
    el('P_18A', splitPayment),
    zwolnienie,
    '<NoweSrodkiTransportu>' + el('P_22N', '1') + '</NoweSrodkiTransportu>',
    el('P_23', '2'),
    '<PMarzy>' + el('P_PMarzyN', '1') + '</PMarzy>',
    '</Adnotacje>',
  ].join('')
}

export function buildFa3Xml(doc: Fa3Document): string {
  const { model, lines } = doc
  if (lines.length === 0) {
    throw new Error('[internal] FA(3) invoice must have at least one line')
  }
  // DataWytworzeniaFa is an xsd:dateTime; the official KSeF FA examples use a
  // second-precision instant with no milliseconds fraction. Normalise here (the single
  // XML emission point) so EVERY caller — the production submission builder and the live
  // smoke test alike — emits an XSD-valid value regardless of the createdAt it passes.
  const createdAt = model.createdAt.replace(/\.\d+(Z|[+-]\d{2}:\d{2})$/, '$1')
  const naglowek = [
    '<Naglowek>',
    `<KodFormularza kodSystemowy="${FA3_SCHEMA.systemCode}" wersjaSchemy="${FA3_SCHEMA.schemaVersion}">${FA3_SCHEMA.formCode}</KodFormularza>`,
    el('WariantFormularza', String(FA3_SCHEMA.variant)),
    el('DataWytworzeniaFa', createdAt),
    el('SystemInfo', model.systemInfo ?? 'Open Mercato'),
    '</Naglowek>',
  ].join('')

  const fa = [
    '<Fa>',
    el('KodWaluty', model.currencyCode),
    el('P_1', model.issueDate),
    el('P_2', model.invoiceNumber),
    model.saleDate ? el('P_6', model.saleDate) : '',
    renderVatBreakdown(model.vatBreakdown),
    el('P_15', model.totalGross),
    renderAnnotations(model.annotations),
    el('RodzajFaktury', model.invoiceKind ?? 'VAT'),
    ...lines.map(renderLine),
    '</Fa>',
  ].join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Faktura xmlns="${FA3_SCHEMA.targetNamespace}">`,
    naglowek,
    renderParty('Podmiot1', model.seller, true),
    renderParty('Podmiot2', model.buyer),
    fa,
    '</Faktura>',
  ].join('')
}
