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

/**
 * VAT-summary bucket key. A numeric Polish rate, one of the special string codes, or the
 * synthetic `'oss'` key used to roll every OSS / WSTO_EE consumer-country line into the
 * single dedicated `P_13_5`/`P_14_5` bucket (no `W` PLN-converted variant).
 */
export type Fa3VatBucketKey = Fa3VatRate | 'oss'

export type Fa3Party = {
  nip?: string
  euVatId?: string
  /**
   * Party name (Nazwa). Required for the seller and for every buyer EXCEPT a UPR
   * (simplified-invoice) NIP-only buyer, where it is omitted; the validator enforces presence
   * for the non-UPR paths, so the serializer treats it as optional only to support that case.
   */
  name?: string
  countryCode: string
  /** First address line (AdresL1). Optional only for a UPR NIP-only buyer (see `name`). */
  addressLine1?: string
  addressLine2?: string
}

export type Fa3VatBreakdownEntry = {
  /** The bucket rate. Use the synthetic `'oss'` key for the OSS / WSTO_EE summary bucket. */
  rate: Fa3VatBucketKey
  net: string
  vat: string
  /**
   * PLN-converted output VAT (`P_14_xW`) for a Polish-rate bucket on a foreign-currency
   * invoice (art. 106e ust. 11). Emitted immediately after the bucket's `P_14_x`. The OSS
   * bucket never carries a `W` variant, so this is ignored for `rate === 'oss'`.
   */
  vatPln?: string
}

export type Fa3Annotations = {
  /** Split-payment mechanism (MPP) → P_18A. */
  splitPayment?: boolean
  /** Reverse charge (odwrotne obciążenie) → P_18. */
  reverseCharge?: boolean
  /** VAT exemption legal basis → Zwolnienie/P_19 + P_19C. */
  vatExemptionBasis?: string
  /** Self-billing (samofakturowanie, art. 106d) → P_17 ('1' when self-billed, else '2'). */
  selfBilling?: boolean
}

export type Fa3Line = {
  lineNumber: number
  name: string
  unit?: string
  quantity: string
  unitNetPrice: string
  netValue: string
  vatRate: Fa3VatRate
  /**
   * OSS / WSTO_EE destination-country VAT rate as a decimal string (e.g. '19' for DE 19%).
   * When set, the line is an OSS line: `P_12` is omitted and `P_12_XII` + `Procedura=WSTO_EE`
   * are emitted instead.
   */
  ossRate?: string
  /** Line procedure marker. Only `WSTO_EE` (OSS) is FA(3)-native at the line level. */
  procedure?: 'WSTO_EE'
  /** Foreign-currency exchange rate to PLN (→ `KursWaluty`) for an FX invoice. */
  fxRate?: string
}

/** A single row of the `Zamowienie` (order) block carried by an advance (ZAL / KOR_ZAL). */
export type Fa3OrderLine = {
  /** NrWierszaZam — order-line ordinal. */
  lineNumber: number
  /** P_7Z — order-line description. */
  name?: string
  /** P_8AZ — unit of measure. */
  unit?: string
  /** P_8BZ — quantity. */
  quantity?: string
  /** P_9AZ — net unit price. */
  unitNetPrice?: string
  /** P_11NettoZ — net value. */
  netValue?: string
  /** P_11VatZ — VAT amount. */
  vatValue?: string
  /** P_12Z — VAT rate (reuses the `TStawkaPodatku` mapping). */
  vatRate?: Fa3VatRate
  /** GTUZ — GTU marking on the ordered position. */
  gtu?: string
  /** StanPrzedZ — pre-correction state flag (for KOR_ZAL). */
  stanPrzed?: boolean
}

/** The `Zamowienie` (order) block: total value + the ordered rows. */
export type Fa3Order = {
  /** WartoscZamowienia — order total value. */
  totalValue: string
  lines: Fa3OrderLine[]
}

/** A received-advance payment row (→ `ZaliczkaCzesciowa`) for a ZAL invoice. */
export type Fa3AdvancePayment = {
  /** P_6Z — the date the advance was received (YYYY-MM-DD). */
  receivedDate: string
  /** P_15Z — the advance amount documented. */
  amount: string
  /** KursWalutyZW — FX rate for this advance (optional). */
  fxRate?: string
}

/**
 * A reference to a prior advance invoice (→ `FakturaZaliczkowa`) for a ROZ settlement.
 * Mirrors the KOR `NrKSeF`/`NrKSeFN` choice: a KSeF-issued advance carries
 * `NrKSeFFaZaliczkowej`; an outside-KSeF advance emits `NrKSeFZN=1` + `NrFaZaliczkowej`.
 */
export type Fa3AdvanceInvoiceRef = {
  /** NrKSeFFaZaliczkowej — the advance invoice's KSeF number (KSeF-issued branch). */
  ksefNumber?: string
  /** NrFaZaliczkowej — the advance invoice number (outside-KSeF branch). */
  invoiceNumber?: string
}

/** A single corrected-invoice reference inside FA(3) `DaneFaKorygowanej`. */
export type Fa3CorrectionReference = {
  /** DataWystFaKorygowanej — issue date of the corrected (original) invoice (YYYY-MM-DD). */
  correctedIssueDate: string
  /** NrFaKorygowanej — invoice number of the corrected (original) invoice. */
  correctedInvoiceNumber: string
  /**
   * NrKSeFFaKorygowanej — the corrected invoice's KSeF number when it was issued in
   * KSeF (emits the `NrKSeF=1` choice branch). When absent, the corrected invoice was
   * issued outside KSeF (legacy/offline) and the `NrKSeFN=1` marker is emitted instead.
   */
  correctedKsefNumber?: string
}

/**
 * FA(3) correction block (emitted after `RodzajFaktury` for `RodzajFaktury=KOR`).
 * Child order matches schemat_FA(3)_v1-0E.xsd:
 *   PrzyczynaKorekty? → TypKorekty? → DaneFaKorygowanej[] → OkresFaKorygowanej?
 */
export type Fa3Correction = {
  /** PrzyczynaKorekty — free-text reason for the correction (optional in FA(3)). */
  reason?: string
  /**
   * TypKorekty — VAT-ledger effect: 1 = effective on the original-invoice date,
   * 2 = effective on the correction-invoice date, 3 = other/mixed (optional).
   */
  correctionType?: 1 | 2 | 3
  /** DaneFaKorygowanej — at least one corrected-invoice reference (FA(3) allows many). */
  correctedInvoices: Fa3CorrectionReference[]
  /** OkresFaKorygowanej — period for a collective rebate correction (optional). */
  period?: string
  /**
   * P_15ZK — for `KOR_ZAL`/`KOR_ROZ`, the payment amount (ZAL) / amount-remaining (ROZ)
   * before the correction. Emitted after `DaneFaKorygowanej` and before `OkresFaKorygowanej`.
   */
  preCorrectionPaymentAmount?: string
  /** KursWalutyZK — FX rate accompanying `P_15ZK` for a foreign-currency correction. */
  preCorrectionFxRate?: string
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
  invoiceKind?: 'VAT' | 'KOR' | 'ZAL' | 'ROZ' | 'UPR' | 'KOR_ZAL' | 'KOR_ROZ'
  vatBreakdown: Fa3VatBreakdownEntry[]
  totalGross: string
  annotations?: Fa3Annotations
  /** Present only for correction invoices (RodzajFaktury=KOR family). */
  correction?: Fa3Correction
  /**
   * Self-billing (samofakturowanie) shortcut. The serializer drives `P_17` from
   * `annotations.selfBilling`; this top-level flag is folded into the annotation block.
   */
  selfBilling?: boolean
  /** ZaliczkaCzesciowa — received-advance payments documented by a ZAL invoice. */
  advancePayments?: Fa3AdvancePayment[]
  /** FakturaZaliczkowa — references to the prior advance invoices netted by a ROZ. */
  advanceInvoiceRefs?: Fa3AdvanceInvoiceRef[]
  /** Zamowienie — order block carried by an advance (ZAL / KOR_ZAL). */
  order?: Fa3Order
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
  // OSS / WSTO_EE consumer-country net → the dedicated P_13_5 bucket, emitted once
  // regardless of how many distinct destination rates appear on the invoice.
  oss: 'P_13_5',
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
  // OSS / WSTO_EE consumer-country VAT → P_14_5. No `W` (PLN-converted) variant exists
  // for the OSS bucket — it is reported in the consumer-country currency only.
  oss: 'P_14_5',
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
  // OSS bucket (P_13_5/P_14_5) ranks after the Polish reduced rates (5 → rank 3) and
  // before the 0% bucket (P_13_6_1 → rank 6), matching the ascending XSD field order.
  oss: 5,
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
export function isMappedFa3VatRate(rate: Fa3VatBucketKey): boolean {
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

function rateKey(rate: Fa3VatBucketKey): string {
  return typeof rate === 'number' ? String(rate) : rate
}

/** Sign-aware 2-dp decimal-string addition via integer cents (no float) — used to merge VAT
 *  buckets that target the same FA(3) summary field. */
function sumMoney2(a: string, b: string): string {
  const toCents = (s: string): bigint => {
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim())
    if (!m) return 0n
    const frac = ((m[3] ?? '') + '00').slice(0, 2)
    return (m[1] === '-' ? -1n : 1n) * (BigInt(m[2]) * 100n + BigInt(frac))
  }
  const cents = toCents(a) + toCents(b)
  const neg = cents < 0n
  const mag = neg ? -cents : cents
  return `${neg ? '-' : ''}${(mag / 100n).toString()}.${(mag % 100n).toString().padStart(2, '0')}`
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

function renderParty(tag: string, party: Fa3Party, sellerNipOnly = false, nipOnlyBuyer = false): string {
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
  const addressLines = [el('AdresL1', party.addressLine1 ?? '')]
  if (party.addressLine2) addressLines.push(el('AdresL2', party.addressLine2))
  // FA(3) added two MANDATORY trailing flags to the BUYER element (Podmiot2) that did not
  // exist in FA(2): JST (is the buyer a subordinate JST/local-government unit) and GV (is
  // the buyer a VAT-group member). For an ordinary domestic buyer both are "2" (No).
  // Omitting them makes KSeF reject Podmiot2 as "incomplete content" (status 450). They
  // must come last, JST before GV, and do NOT exist on Podmiot1 (seller). Value "1" would
  // additionally require a Podmiot3 with the matching role — deferred (out of scope here).
  const buyerFlags = tag === 'Podmiot2' ? [el('JST', '2'), el('GV', '2')] : []
  // A simplified-invoice (UPR) buyer (Podmiot2) may carry a NIP-only identity: the optional
  // `Nazwa` and the whole `Adres` block are omitted, while the mandatory trailing JST/GV
  // flags are still emitted. The identity choice above already requires a NIP for this path.
  const identityChildren = nipOnlyBuyer
    ? [identity]
    : [identity, el('Nazwa', party.name ?? '')]
  const addressBlock = nipOnlyBuyer
    ? []
    : ['<Adres>', el('KodKraju', party.countryCode), ...addressLines, '</Adres>']
  return [
    `<${tag}>`,
    '<DaneIdentyfikacyjne>',
    ...identityChildren,
    '</DaneIdentyfikacyjne>',
    ...addressBlock,
    ...buyerFlags,
    `</${tag}>`,
  ].join('')
}

function renderVatBreakdown(entries: Fa3VatBreakdownEntry[]): string {
  // Merge buckets that target the SAME FA(3) summary field before emitting — a legacy and a current
  // rate can share a field (22% + 23% → P_13_1, 7% + 8% → P_13_2). Emitting two P_13_1/P_14_1
  // elements is XSD-invalid, so sum net/vat/vatPln into one entry per field (M5).
  const mergedByField = new Map<string, Fa3VatBreakdownEntry>()
  for (const entry of entries) {
    const key = rateKey(entry.rate)
    const fieldKey = VAT_NET_FIELD[key] ?? VAT_TAX_FIELD[key] ?? key
    const existing = mergedByField.get(fieldKey)
    if (!existing) {
      mergedByField.set(fieldKey, { ...entry })
    } else {
      existing.net = sumMoney2(existing.net, entry.net)
      existing.vat = sumMoney2(existing.vat, entry.vat)
      if (entry.vatPln !== undefined) existing.vatPln = sumMoney2(existing.vatPln ?? '0.00', entry.vatPln)
    }
  }
  const ordered = [...mergedByField.values()].sort(
    (a, b) => (VAT_FIELD_RANK[rateKey(a.rate)] ?? 99) - (VAT_FIELD_RANK[rateKey(b.rate)] ?? 99),
  )
  const parts: string[] = []
  for (const entry of ordered) {
    const key = rateKey(entry.rate)
    const netField = VAT_NET_FIELD[key]
    if (netField) parts.push(el(netField, entry.net))
    const taxField = VAT_TAX_FIELD[key]
    if (taxField) {
      parts.push(el(taxField, entry.vat))
      // FX: emit the PLN-converted VAT (`P_14_xW`) right after the Polish-rate `P_14_x`
      // (art. 106e ust. 11). The OSS bucket (P_14_5) has no `W` variant, so it is skipped.
      if (key !== 'oss' && entry.vatPln !== undefined) {
        parts.push(el(`${taxField}W`, entry.vatPln))
      }
    }
  }
  return parts.join('')
}

function renderLine(line: Fa3Line): string {
  const isOss = line.ossRate !== undefined
  const parts: string[] = [
    '<FaWiersz>',
    el('NrWierszaFa', String(line.lineNumber)),
    el('P_7', line.name),
    el('P_8A', line.unit ?? 'szt'),
    el('P_8B', line.quantity),
    el('P_9A', line.unitNetPrice),
    el('P_11', line.netValue),
  ]
  // OSS / WSTO_EE: the closed-enum `P_12` is omitted in favour of `P_12_XII` (the
  // destination-country rate as a decimal). A domestic line keeps `P_12`.
  if (isOss) {
    parts.push(el('P_12_XII', line.ossRate as string))
  } else {
    parts.push(el('P_12', fa3LineVatRateValue(line.vatRate)))
  }
  // `Procedura` sits after the GTU markings and before `KursWaluty` in the XSD sequence.
  if (line.procedure) parts.push(el('Procedura', line.procedure))
  // FX: per-line exchange rate to PLN.
  if (line.fxRate !== undefined) parts.push(el('KursWaluty', line.fxRate))
  parts.push('</FaWiersz>')
  return parts.join('')
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
  // P_17 — samofakturowanie (self-billing, art. 106d): '1' when the invoice is self-billed
  // (issued by the buyer in the supplier's name), else '2' (does not apply).
  const selfBilling = annotations?.selfBilling ? '1' : '2'
  const exemptionBasis = annotations?.vatExemptionBasis?.trim()
  const zwolnienie = exemptionBasis
    ? '<Zwolnienie>' + el('P_19', '1') + el('P_19C', exemptionBasis) + '</Zwolnienie>'
    : '<Zwolnienie>' + el('P_19N', '1') + '</Zwolnienie>'
  return [
    '<Adnotacje>',
    el('P_16', '2'),
    el('P_17', selfBilling),
    el('P_18', reverseCharge),
    el('P_18A', splitPayment),
    zwolnienie,
    '<NoweSrodkiTransportu>' + el('P_22N', '1') + '</NoweSrodkiTransportu>',
    el('P_23', '2'),
    '<PMarzy>' + el('P_PMarzyN', '1') + '</PMarzy>',
    '</Adnotacje>',
  ].join('')
}

/**
 * Correction block for a `RodzajFaktury=KOR` invoice. Emitted immediately AFTER
 * `RodzajFaktury` and BEFORE the lines, in the exact FA(3) XSD child order:
 *   PrzyczynaKorekty? → TypKorekty? → DaneFaKorygowanej[] → OkresFaKorygowanej?
 * `DaneFaKorygowanej` = DataWystFaKorygowanej, NrFaKorygowanej, then the required
 * choice: the corrected invoice's KSeF number (`<NrKSeF>1</NrKSeF>` +
 * `<NrKSeFFaKorygowanej>`) when known, else the outside-KSeF marker `<NrKSeFN>1</NrKSeFN>`.
 */
function renderCorrection(correction: Fa3Correction): string {
  if (correction.correctedInvoices.length === 0) {
    throw new Error('[internal] FA(3) correction must reference at least one corrected invoice')
  }
  const parts: string[] = []
  const reason = correction.reason?.trim()
  if (reason) parts.push(el('PrzyczynaKorekty', reason))
  if (correction.correctionType) parts.push(el('TypKorekty', String(correction.correctionType)))
  for (const ref of correction.correctedInvoices) {
    const ksefNumber = ref.correctedKsefNumber?.trim()
    const choice = ksefNumber
      ? el('NrKSeF', '1') + el('NrKSeFFaKorygowanej', ksefNumber)
      : el('NrKSeFN', '1')
    parts.push(
      '<DaneFaKorygowanej>',
      el('DataWystFaKorygowanej', ref.correctedIssueDate),
      el('NrFaKorygowanej', ref.correctedInvoiceNumber),
      choice,
      '</DaneFaKorygowanej>',
    )
  }
  // P_15ZK — for KOR_ZAL/KOR_ROZ, the pre-correction payment (ZAL) / amount-remaining
  // (ROZ), with an optional KursWalutyZK for an FX correction. Per the XSD this sits after
  // the DaneFaKorygowanej loop and before OkresFaKorygowanej.
  if (correction.preCorrectionPaymentAmount !== undefined) {
    parts.push(el('P_15ZK', correction.preCorrectionPaymentAmount))
    if (correction.preCorrectionFxRate !== undefined) {
      parts.push(el('KursWalutyZK', correction.preCorrectionFxRate))
    }
  }
  const period = correction.period?.trim()
  if (period) parts.push(el('OkresFaKorygowanej', period))
  return parts.join('')
}

/**
 * `ZaliczkaCzesciowa` — one block per received advance documented by a ZAL invoice.
 * Child order: `P_6Z` (received date), `P_15Z` (amount), `KursWalutyZW?` (FX rate).
 */
function renderZaliczkaCzesciowa(payments: Fa3AdvancePayment[]): string {
  const parts: string[] = []
  for (const p of payments) {
    parts.push(
      '<ZaliczkaCzesciowa>',
      el('P_6Z', p.receivedDate),
      el('P_15Z', p.amount),
    )
    if (p.fxRate !== undefined) parts.push(el('KursWalutyZW', p.fxRate))
    parts.push('</ZaliczkaCzesciowa>')
  }
  return parts.join('')
}

/**
 * `FakturaZaliczkowa` — one block per prior advance referenced by a ROZ settlement.
 * The KSeF-number choice mirrors the KOR `NrKSeF`/`NrKSeFN` choice: a KSeF-issued advance
 * carries `NrKSeFFaZaliczkowej`; an outside-KSeF advance emits `NrKSeFZN=1` + `NrFaZaliczkowej`.
 */
function renderFakturaZaliczkowa(refs: Fa3AdvanceInvoiceRef[]): string {
  const parts: string[] = []
  for (const ref of refs) {
    const ksefNumber = ref.ksefNumber?.trim()
    parts.push('<FakturaZaliczkowa>')
    if (ksefNumber) {
      parts.push(el('NrKSeFFaZaliczkowej', ksefNumber))
    } else {
      parts.push(el('NrKSeFZN', '1'), el('NrFaZaliczkowej', ref.invoiceNumber ?? ''))
    }
    parts.push('</FakturaZaliczkowa>')
  }
  return parts.join('')
}

/**
 * `ZamowienieWiersz` — one ordered position inside the `Zamowienie` block.
 * Child order: `NrWierszaZam, P_7Z?, P_8AZ?, P_8BZ?, P_9AZ?, P_11NettoZ?, P_11VatZ?, P_12Z?,
 * GTUZ?, StanPrzedZ?`. `P_12Z` reuses the line `TStawkaPodatku` mapping.
 */
function renderZamowienieWiersz(row: Fa3OrderLine): string {
  const parts: string[] = ['<ZamowienieWiersz>', el('NrWierszaZam', String(row.lineNumber))]
  if (row.name !== undefined) parts.push(el('P_7Z', row.name))
  if (row.unit !== undefined) parts.push(el('P_8AZ', row.unit))
  if (row.quantity !== undefined) parts.push(el('P_8BZ', row.quantity))
  if (row.unitNetPrice !== undefined) parts.push(el('P_9AZ', row.unitNetPrice))
  if (row.netValue !== undefined) parts.push(el('P_11NettoZ', row.netValue))
  if (row.vatValue !== undefined) parts.push(el('P_11VatZ', row.vatValue))
  if (row.vatRate !== undefined) parts.push(el('P_12Z', fa3LineVatRateValue(row.vatRate)))
  if (row.gtu !== undefined) parts.push(el('GTUZ', row.gtu))
  if (row.stanPrzed) parts.push(el('StanPrzedZ', '1'))
  parts.push('</ZamowienieWiersz>')
  return parts.join('')
}

/**
 * `Zamowienie` — the order block carried by an advance (ZAL / KOR_ZAL).
 * Child order: `WartoscZamowienia` (total) then the `ZamowienieWiersz[]` rows.
 */
function renderZamowienie(order: Fa3Order): string {
  return [
    '<Zamowienie>',
    el('WartoscZamowienia', order.totalValue),
    ...order.lines.map(renderZamowienieWiersz),
    '</Zamowienie>',
  ].join('')
}

export function buildFa3Xml(doc: Fa3Document): string {
  const { model, lines } = doc
  // FaWiersz is optional for an advance (ZAL / KOR_ZAL) that carries its detail in the
  // `Zamowienie` order block instead; every other kind still requires at least one line.
  const advanceWithOrder =
    (model.invoiceKind === 'ZAL' || model.invoiceKind === 'KOR_ZAL') && model.order !== undefined
  if (lines.length === 0 && !advanceWithOrder) {
    throw new Error('[internal] FA(3) invoice must have at least one line')
  }
  // The top-level `selfBilling` shortcut folds into the annotation block (drives P_17).
  const annotations: Fa3Annotations | undefined =
    model.selfBilling !== undefined
      ? { ...model.annotations, selfBilling: model.selfBilling }
      : model.annotations
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
    renderAnnotations(annotations),
    el('RodzajFaktury', model.invoiceKind ?? 'VAT'),
    // Correction block (KOR family) sits between RodzajFaktury and the advance blocks per the XSD.
    model.correction ? renderCorrection(model.correction) : '',
    // Advance→settlement chain: ZaliczkaCzesciowa (ZAL) then FakturaZaliczkowa (ROZ),
    // both before FaWiersz.
    model.advancePayments && model.advancePayments.length > 0
      ? renderZaliczkaCzesciowa(model.advancePayments)
      : '',
    model.advanceInvoiceRefs && model.advanceInvoiceRefs.length > 0
      ? renderFakturaZaliczkowa(model.advanceInvoiceRefs)
      : '',
    ...lines.map(renderLine),
    // Zamowienie (order block) sits after FaWiersz per the XSD.
    model.order ? renderZamowienie(model.order) : '',
    '</Fa>',
  ].join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Faktura xmlns="${FA3_SCHEMA.targetNamespace}">`,
    naglowek,
    renderParty('Podmiot1', model.seller, true),
    // A UPR (simplified) invoice may carry a NIP-only buyer (no Nazwa/Adres). The NIP-only
    // branch requires a buyer NIP; without one we fall back to the full party rendering.
    renderParty('Podmiot2', model.buyer, false, model.invoiceKind === 'UPR' && !!model.buyer.nip),
    fa,
    '</Faktura>',
  ].join('')
}
