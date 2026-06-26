import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import {
  fa3InvoiceSchema,
  type Fa3AnnotationsInput,
  type Fa3InvoiceInput,
  type Fa3PartyInput,
} from '../data/validators'
import { isMappedFa3VatRate, type Fa3VatRate } from '../lib/fa3'

/**
 * Minimal query-engine surface this resolver depends on. The caller resolves the
 * platform `queryEngine` from DI and passes it in `deps` — financial_pl reads
 * sales data ONLY through the query engine (no cross-module ORM relation/import,
 * §4/§21). Result fields come back snake_cased (the storage column names).
 */
export type ResolveFa3QueryEngine = {
  query: <TRow = Record<string, unknown>>(
    entityId: string,
    opts: {
      tenantId: string
      organizationIds?: Array<string | null>
      filters?: Record<string, unknown>
      page?: { page: number; pageSize: number }
      sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>
    },
  ) => Promise<{ items?: TRow[] }>
}

export type ResolveFa3Deps = {
  queryEngine: ResolveFa3QueryEngine
  /** Seller NIP from the ksef_pl integration credential `contextNip`. */
  contextNip: string
  /** Optional override of the seller party (name/address) when the caller knows it. */
  seller?: Partial<Fa3PartyInput>
  /** Optional i18n hook so a missing-buyer rejection surfaces a localized message. */
  translate?: (key: string, fallback?: string) => string
}

export type ResolveFa3Args = {
  salesInvoiceId: string
  organizationId: string
  tenantId: string
}

type InvoiceRow = Record<string, unknown>
type InvoiceLineRow = Record<string, unknown>

const BUYER_REQUIRED_DEFAULT =
  'This invoice has no buyer details. Add the buyer to the invoice before submitting it to KSeF.'
const SELLER_REQUIRED_DEFAULT =
  'KSeF seller (Podmiot1) identity is not configured. Set the seller name and address on the KSeF integration before submitting.'
const DOCUMENT_TYPE_UNSUPPORTED_DEFAULT =
  'Only standard VAT invoices can be submitted to KSeF yet. Correction, advance, and final invoices are not supported.'
const CURRENCY_UNSUPPORTED_DEFAULT =
  'Only PLN invoices can be submitted to KSeF yet. Foreign-currency invoices are not supported.'
const VAT_RATE_UNSUPPORTED_DEFAULT =
  'This invoice uses a VAT rate that cannot be mapped to a KSeF FA(3) field. Use a standard Polish VAT rate.'

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Two-letter ISO country code (uppercased); falls back to PL for unknown/long values. */
function normalizeCountryCode(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = asString(candidate)
    if (text && /^[A-Za-z]{2}$/.test(text)) return text.toUpperCase()
  }
  return 'PL'
}

/** Compose a "postal city" address line from a structured address snapshot. */
function composeCityLine(source: Record<string, unknown>): string | null {
  const postal = asString(source.postalCode) ?? asString(source.postal_code)
  const city = asString(source.city)
  const composed = [postal, city].filter((part): part is string => Boolean(part)).join(' ').trim()
  return composed.length > 0 ? composed : null
}

function asNip(value: unknown): string | undefined {
  const text = asString(value)
  if (!text) return undefined
  const digits = text.replace(/[^0-9]/g, '')
  return /^[0-9]{10}$/.test(digits) ? digits : undefined
}

/**
 * Round a numeric(18,4)-precision decimal (string or number) to a 2-dp money
 * string using EXACT BigInt math — no JS float. Parses the decimal text into a
 * scaled integer at 4 fraction digits, applies banker-free half-up rounding to
 * 2 dp, and re-renders with exactly two fraction digits.
 */
export function roundMoneyTo2dp(value: unknown): string {
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : '0'
      : asString(value) ?? '0'
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return '0.00'
  const sign = match[1] === '-' ? -1n : 1n
  const integerPart = match[2]
  const fractionPart = match[3] ?? ''
  const fractionAt4 = (fractionPart + '0000').slice(0, 4)
  const scaledAt4 = BigInt(integerPart) * 10000n + BigInt(fractionAt4 || '0')
  const remainder = scaledAt4 % 100n
  let scaledAt2 = scaledAt4 / 100n
  if (remainder >= 50n) scaledAt2 += 1n
  const signed = sign * scaledAt2
  const negative = signed < 0n
  const magnitude = negative ? -signed : signed
  const whole = magnitude / 100n
  const cents = magnitude % 100n
  const centsText = cents.toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${centsText}`
}

function rateKey(rate: Fa3VatRate): string {
  return typeof rate === 'number' ? String(rate) : rate
}

function normalizeVatRate(value: unknown): Fa3VatRate {
  const text = asString(value)
  if (text === 'zw' || text === 'np' || text === 'oo') return text
  // An absent rate defaults to 0% (a valid bucket); a PRESENT but unparsable rate
  // (e.g. "19%", "foo") must NOT silently coerce to 0 — return NaN so the
  // vat_rate_unsupported gate rejects it instead of emitting a wrong 0% bucket.
  if (text === null && typeof value !== 'number') return 0
  const numeric = typeof value === 'number' ? value : Number(text)
  return Number.isFinite(numeric) ? numeric : Number.NaN
}

/**
 * Resolve the FA(3) seller (Podmiot1) from the caller-supplied seller identity
 * (the `ksef_pl` integration credentials' seller name/address). A KSeF
 * submission MUST carry the real seller — there is no placeholder fallback;
 * when a real name + address is not configured this throws a localized 422
 * (mirroring the buyer guard) rather than filing a knowingly-false Podmiot1.
 */
function buildSeller(deps: ResolveFa3Deps): Fa3PartyInput {
  const name = asString(deps.seller?.name)
  const addressLine1 = asString(deps.seller?.addressLine1)
  if (!name || !addressLine1) {
    const message =
      deps.translate?.('financial_pl.errors.seller_required', SELLER_REQUIRED_DEFAULT) ?? SELLER_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'seller_required' })
  }
  return {
    nip: asNip(deps.contextNip),
    name,
    countryCode: asString(deps.seller?.countryCode) ?? 'PL',
    addressLine1,
    addressLine2: asString(deps.seller?.addressLine2) ?? undefined,
  }
}

/** Read an explicit buyer snapshot from the invoice metadata, if any. */
function readInvoiceBuyerSnapshot(invoice: InvoiceRow): Record<string, unknown> {
  const metadata = asRecord(invoice.metadata)
  return asRecord(metadata.buyerSnapshot ?? metadata.buyer)
}

/**
 * Resolve the FA(3) buyer (Podmiot2) from the invoice's plaintext
 * `metadata.buyerSnapshot` (the `sales_invoice.metadata` jsonb is not encrypted).
 * A KSeF submission MUST carry a real, identifiable buyer — when no name +
 * address can be resolved this throws a 422 (CrudHttpError) rather than
 * submitting an anonymous placeholder to the tax authority. The buyer NIP is
 * optional (FA(3) emits `<BrakID>1</BrakID>` for a buyer without an identifier).
 *
 * NOTE: the linked order's `billing_address_snapshot` / `customer_snapshot` are
 * an ENCRYPTED jsonb on `sales:sales_order` (decrypts to a JSON string, not an
 * object, via the query engine), so they are NOT read here; sourcing the buyer
 * from the order is a deferred follow-up that needs decrypt-and-reparse handling.
 */
function buildBuyer(invoice: InvoiceRow, deps: ResolveFa3Deps): Fa3PartyInput {
  const snapshot = readInvoiceBuyerSnapshot(invoice)

  const name =
    asString(snapshot.companyName) ?? asString(snapshot.company_name) ?? asString(snapshot.name)
  const nip = asNip(snapshot.nip ?? snapshot.taxId ?? snapshot.tax_id)

  const street = asString(snapshot.addressLine1) ?? asString(snapshot.address_line1)
  const cityLine = composeCityLine(snapshot)
  const addressLine1 = street ?? cityLine
  const addressLine2 = street
    ? asString(snapshot.addressLine2) ?? asString(snapshot.address_line2) ?? cityLine ?? undefined
    : asString(snapshot.addressLine2) ?? asString(snapshot.address_line2) ?? undefined

  if (!name || !addressLine1) {
    const message = deps.translate?.('financial_pl.errors.buyer_required', BUYER_REQUIRED_DEFAULT) ?? BUYER_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'buyer_required' })
  }

  return {
    nip,
    name,
    countryCode: normalizeCountryCode(snapshot.countryCode, snapshot.country, snapshot.country_code),
    addressLine1,
    addressLine2,
  }
}

function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = asString(value)
  if (!text) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}

function asFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function toScaledInt(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0
  // Decimal-shifted rounding (matches the invoice editor) so 1.005 → 101, not 100.
  const shifted = Number(`${value}e${decimals}`)
  return Number.isFinite(shifted) ? Math.round(shifted) : Math.round(value * 10 ** decimals)
}

function toCents(value: number): number {
  return toScaledInt(value, 2)
}

/**
 * Bridge the backend invoice UI's `metadata.lines` snapshot into FA(3) line rows when
 * the invoice has no first-class `sales_invoice_line` records (invoices created in the
 * UI store their lines only in `metadata.lines`). Without this a multi-rate UI invoice
 * would collapse into the single header-derived VAT bucket and submit the WRONG VAT
 * breakdown to KSeF. Per-line net/VAT use the same integer-cent math as the editor.
 */
function metadataLinesToRows(invoice: InvoiceRow): InvoiceLineRow[] {
  const rawLines = asRecord(invoice.metadata).lines
  if (!Array.isArray(rawLines)) return []
  const rows: InvoiceLineRow[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = asRecord(rawLines[index])
    const quantity = asFiniteNumber(line.quantity)
    const unitNetPrice = asFiniteNumber(line.unitNetPrice)
    const rateText =
      asString(line.vatRate) ??
      (typeof line.vatRate === 'number' && Number.isFinite(line.vatRate) ? String(line.vatRate) : '0')
    const numericRate =
      rateText === 'zw' || rateText === 'np' || rateText === 'oo' ? null : asFiniteNumber(rateText)
    const quantityScaled = toScaledInt(quantity, 4)
    const unitNetCents = toCents(unitNetPrice)
    // Mirror the invoice editor's exact integer-domain math (quantity at 4 dp) so the
    // FA(3) per-line net can never diverge from the stored invoice header total.
    const netCents = Math.round((quantityScaled * unitNetCents) / 10000)
    const vatCents = numericRate != null ? Math.round((netCents * numericRate) / 100) : 0
    rows.push({
      line_number: index + 1,
      description: asString(line.description) ?? '',
      // Carry the UI line's unit of measure (jednostka) through to FA(3) P_8A. Absent → the
      // serializer falls back to its `szt` default.
      quantity_unit: asString(line.unit) ?? undefined,
      // Emit the SAME normalized precision the net was computed from (quantity 4 dp,
      // unit price 2 dp) so the FA(3) line reconciles internally: round(qty * price) == net.
      quantity: String(quantityScaled / 10000),
      unit_price_net: unitNetCents / 100,
      total_net_amount: (netCents / 100).toFixed(2),
      tax_amount: (vatCents / 100).toFixed(2),
      tax_rate: rateText,
    })
  }
  return rows
}

function buildLines(lineRows: InvoiceLineRow[]): Fa3InvoiceInput['lines'] {
  return lineRows.map((row, index) => {
    const lineNumber =
      typeof row.line_number === 'number' && row.line_number > 0
        ? row.line_number
        : index + 1
    return {
      lineNumber,
      name: asString(row.name) ?? asString(row.description) ?? `Pozycja ${lineNumber}`,
      unit: asString(row.quantity_unit) ?? undefined,
      quantity: asString(row.quantity) ?? '1',
      unitNetPrice: roundMoneyTo2dp(row.unit_price_net),
      netValue: roundMoneyTo2dp(row.total_net_amount),
      vatRate: normalizeVatRate(row.tax_rate),
    }
  })
}

/**
 * Derive a single FA(3) VAT rate from the invoice header net/tax totals, used as
 * the fallback when an invoice carries no lines. Reads the effective rate from the
 * actual tax/net ratio (0% when there is no tax) instead of assuming a flat 23%.
 */
function deriveHeaderVatRate(netScaled: bigint, vatScaled: bigint): Fa3VatRate {
  if (vatScaled === 0n) return 0
  if (netScaled <= 0n) return 23
  return normalizeVatRate(Math.round((Number(vatScaled) / Number(netScaled)) * 100))
}

/** Round a 4-dp-scaled non-negative amount to 2-dp integer cents (half-up). */
function scaled4ToCents2dp(scaledAt4: bigint): bigint {
  const magnitude = scaledAt4 < 0n ? -scaledAt4 : scaledAt4
  const cents = magnitude / 100n
  return magnitude % 100n >= 50n ? cents + 1n : cents
}

/**
 * Whether the header-derived VAT rate reproduces the stored tax EXACTLY in 2-dp
 * money. `deriveHeaderVatRate` rounds the effective rate (e.g. a 7.5% effective
 * rate from net 100.00 / tax 7.50 rounds to "8%"), which would otherwise emit a
 * `P_14` that does not equal `P_13 × rate` — incorrect data to the tax authority.
 * Only the single header-fallback bucket is checked; per-line aggregated buckets
 * legitimately differ by per-line rounding and are not reconciled this way.
 */
function headerVatRateReconciles(netScaled: bigint, vatScaled: bigint, rate: Fa3VatRate): boolean {
  if (typeof rate !== 'number') return true
  const vatCents = scaled4ToCents2dp(vatScaled)
  if (rate === 0) return vatCents === 0n
  const netCents = scaled4ToCents2dp(netScaled)
  const product = netCents * BigInt(rate)
  let expected = product / 100n
  if (product % 100n >= 50n) expected += 1n
  return expected === vatCents
}

/**
 * Aggregate the FA(3) VAT summary by rate from the invoice lines, summing net
 * and tax with exact BigInt math (4-dp scale) before rounding each bucket to 2
 * dp. When no lines are available, fall back to a single VAT entry derived from
 * the invoice header totals so the produced document still satisfies the
 * `min(1)` constraint on `vatBreakdown`.
 */
function buildVatBreakdown(
  lineRows: InvoiceLineRow[],
  invoice: InvoiceRow,
): Fa3InvoiceInput['vatBreakdown'] {
  const buckets = new Map<string, { rate: Fa3VatRate; netScaled: bigint; vatScaled: bigint }>()
  for (const row of lineRows) {
    const rate = normalizeVatRate(row.tax_rate)
    const key = rateKey(rate)
    const existing = buckets.get(key) ?? { rate, netScaled: 0n, vatScaled: 0n }
    existing.netScaled += toScaled4(row.total_net_amount)
    existing.vatScaled += toScaled4(row.tax_amount)
    buckets.set(key, existing)
  }
  if (buckets.size === 0) {
    const netScaled = toScaled4(invoice.grand_total_net_amount)
    const vatScaled = toScaled4(invoice.tax_total_amount)
    return [
      {
        rate: deriveHeaderVatRate(netScaled, vatScaled),
        net: scaled4ToMoney2dp(netScaled),
        vat: scaled4ToMoney2dp(vatScaled),
      },
    ]
  }
  return Array.from(buckets.values()).map((bucket) => ({
    rate: bucket.rate,
    net: scaled4ToMoney2dp(bucket.netScaled),
    vat: scaled4ToMoney2dp(bucket.vatScaled),
  }))
}

function toScaled4(value: unknown): bigint {
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : '0'
      : asString(value) ?? '0'
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return 0n
  const sign = match[1] === '-' ? -1n : 1n
  const fractionAt4 = ((match[3] ?? '') + '0000').slice(0, 4)
  return sign * (BigInt(match[2]) * 10000n + BigInt(fractionAt4 || '0'))
}

function scaled4ToMoney2dp(scaledAt4: bigint): string {
  const negative = scaledAt4 < 0n
  const magnitude = negative ? -scaledAt4 : scaledAt4
  const remainder = magnitude % 100n
  let scaledAt2 = magnitude / 100n
  if (remainder >= 50n) scaledAt2 += 1n
  const whole = scaledAt2 / 100n
  const cents = scaledAt2 % 100n
  return `${negative ? '-' : ''}${whole.toString()}.${cents.toString().padStart(2, '0')}`
}

/**
 * Derive the FA(3) `Adnotacje` flags from the invoice's PL VAT metadata: MPP
 * (split payment) and the VAT-exemption legal basis come from
 * `SalesInvoicePlMeta`. Returns `undefined` when no flag applies, preserving the
 * serializer's schema-minimal defaults. (Reverse charge has no source in the OSS
 * sales model yet — `tax_rate` is numeric, never `oo` — so it stays settable
 * only via the explicit annotations payload.)
 */
function buildAnnotations(meta: Record<string, unknown> | undefined): Fa3AnnotationsInput | undefined {
  const splitPayment =
    typeof meta?.mpp_required === 'boolean'
      ? meta.mpp_required
      : parseBooleanWithDefault(asString(meta?.mpp_required), false)
  const vatExemptionBasis = asString(meta?.vat_exemption_basis) ?? undefined
  if (!splitPayment && !vatExemptionBasis) return undefined
  return {
    ...(splitPayment ? { splitPayment: true } : {}),
    ...(vatExemptionBasis ? { vatExemptionBasis } : {}),
  }
}

/**
 * Resolve a validated FA(3) invoice payload for a sales invoice, reading the
 * invoice, its lines, and the PL meta extension through the platform query
 * engine. The produced object is validated with `fa3InvoiceSchema.parse(...)`
 * before returning so a bad mapping fails loudly rather than reaching KSeF.
 */
export async function resolveFa3FromSalesInvoice(
  deps: ResolveFa3Deps,
  args: ResolveFa3Args,
): Promise<Fa3InvoiceInput> {
  const { queryEngine } = deps
  const { salesInvoiceId, organizationId, tenantId } = args
  const scope = {
    tenantId,
    organizationIds: [organizationId],
  }

  const invoiceResult = await queryEngine.query<InvoiceRow>(E.sales.sales_invoice, {
    ...scope,
    filters: { id: { $eq: salesInvoiceId } },
    page: { page: 1, pageSize: 1 },
  })
  const invoice = invoiceResult.items?.[0]
  if (!invoice) {
    throw new CrudHttpError(404, { error: '[internal] sales invoice not found for FA(3) resolution' })
  }

  // Paginate the lines so an invoice with more than one page of lines still
  // produces a complete FA(3) document (a truncated line set would be an
  // incorrect statutory submission).
  const lineRows: InvoiceLineRow[] = []
  const linePageSize = 100
  for (let page = 1; ; page++) {
    const lineResult = await queryEngine.query<InvoiceLineRow>(E.sales.sales_invoice_line, {
      ...scope,
      filters: { invoice_id: { $eq: salesInvoiceId } },
      page: { page, pageSize: linePageSize },
      sort: [{ field: 'line_number', dir: 'asc' }],
    })
    const batch = lineResult.items ?? []
    lineRows.push(...batch)
    if (batch.length < linePageSize) break
  }

  const metaResult = await queryEngine.query<Record<string, unknown>>(
    'financial_pl:sales_invoice_pl_meta',
    {
      ...scope,
      filters: { sales_invoice_id: { $eq: salesInvoiceId } },
      page: { page: 1, pageSize: 1 },
    },
  )
  const meta = metaResult.items?.[0]

  // Seller (Podmiot1) NIP MUST be the KSeF credential context NIP — the same NIP the
  // submission authenticates with — so a per-invoice meta `context_nip` can no longer
  // override it (that produced a Podmiot1 whose NIP differed from the submission context,
  // which KSeF rejects).
  const seller = buildSeller(deps)

  // Prefer first-class invoice lines; fall back to the UI's metadata.lines snapshot so
  // an invoice authored in the backend (which has no sales_invoice_line rows) still
  // produces a faithful per-rate FA(3) VAT breakdown instead of one collapsed bucket.
  const effectiveLineRows = lineRows.length > 0 ? lineRows : metadataLinesToRows(invoice)

  const issueDate =
    toIsoDate(invoice.issue_date) ?? toIsoDate(invoice.issued_at) ?? new Date().toISOString().slice(0, 10)

  // KSeF E1 send scope: only a standard `vat` invoice in PLN with KSeF-mappable VAT
  // rates can be faithfully serialized as FA(3). Correction/advance/final map to
  // KOR/ZAL/ROZ which require correction/advance/settlement blocks the serializer
  // does not emit; a foreign currency needs KursWaluty + PLN-VAT that is not yet
  // computed; an unmapped rate would drop its VAT bucket. Fail fast with a localized
  // 422 rather than file a malformed/incorrect document with the tax authority.
  const documentType = asString(invoice.document_type) ?? 'vat'
  if (documentType !== 'vat') {
    const message =
      deps.translate?.('financial_pl.errors.document_type_unsupported', DOCUMENT_TYPE_UNSUPPORTED_DEFAULT) ??
      DOCUMENT_TYPE_UNSUPPORTED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'document_type_unsupported' })
  }

  const currencyCode = (asString(invoice.currency_code) ?? 'PLN').toUpperCase()
  if (currencyCode !== 'PLN') {
    const message =
      deps.translate?.('financial_pl.errors.currency_unsupported', CURRENCY_UNSUPPORTED_DEFAULT) ??
      CURRENCY_UNSUPPORTED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'currency_unsupported' })
  }

  const vatBreakdown = buildVatBreakdown(effectiveLineRows, invoice)
  for (const entry of vatBreakdown) {
    if (!isMappedFa3VatRate(entry.rate)) {
      const message =
        deps.translate?.('financial_pl.errors.vat_rate_unsupported', VAT_RATE_UNSUPPORTED_DEFAULT) ??
        VAT_RATE_UNSUPPORTED_DEFAULT
      throw new CrudHttpError(422, { error: message, code: 'vat_rate_unsupported' })
    }
  }
  // Header-only fallback: deriveHeaderVatRate rounds the effective rate, so a
  // non-standard rate (e.g. 7.5%) can round to a mapped rate (8%) and slip past the
  // mapping check above while emitting a P_14 that does not reconcile with P_13.
  // Reject when the rounded rate does not reproduce the stored tax exactly.
  if (effectiveLineRows.length === 0) {
    const headerNet = toScaled4(invoice.grand_total_net_amount)
    const headerVat = toScaled4(invoice.tax_total_amount)
    if (!headerVatRateReconciles(headerNet, headerVat, deriveHeaderVatRate(headerNet, headerVat))) {
      const message =
        deps.translate?.('financial_pl.errors.vat_rate_unsupported', VAT_RATE_UNSUPPORTED_DEFAULT) ??
        VAT_RATE_UNSUPPORTED_DEFAULT
      throw new CrudHttpError(422, { error: message, code: 'vat_rate_unsupported' })
    }
  }
  // FA(3) requires P_15 (Należność ogółem) to equal Σ(P_13_* + P_14_*); KSeF rejects a
  // document whose stated total does not reconcile with its per-rate VAT summary (one of
  // the most common FA(3) validation errors). Derive P_15 from the SAME rounded buckets
  // the summary emits, so the document is internally consistent BY CONSTRUCTION rather than
  // taking the header gross independently. For a line-bearing invoice the bucket sum equals
  // the stored grand_total_gross_amount (the editor / sales calc compute the header the same
  // way); only the header-fallback path can differ by a grosz of rounding, in which case the
  // bucket-derived total is the correct value to file. (Aligning the stored gross to the
  // bucket sum at issue time, to erase even that residual, is a tracked follow-up.)
  const totalGross = scaled4ToMoney2dp(
    vatBreakdown.reduce((sum, entry) => sum + toScaled4(entry.net) + toScaled4(entry.vat), 0n),
  )

  const annotations = buildAnnotations(meta)

  const fa3Invoice: Fa3InvoiceInput = {
    invoiceNumber: asString(invoice.invoice_number) ?? salesInvoiceId,
    issueDate,
    // FA(3) P_6 (data sprzedaży / data dokonania dostawy): prefer the invoice's own sale
    // date captured in the UI (metadata.saleDate); fall back to the issue date when absent
    // (a same-day sale, the most common case) so P_6 is always populated.
    saleDate: toIsoDate(asRecord(invoice.metadata).saleDate) ?? toIsoDate(invoice.issue_date) ?? undefined,
    currencyCode,
    // documentType is gated to `vat` above, so only the standard VAT kind is emitted.
    // KOR/ZAL/ROZ are rejected at the document-type gate until their FA(3) blocks exist.
    invoiceKind: 'VAT',
    seller,
    buyer: buildBuyer(invoice, deps),
    vatBreakdown,
    totalGross,
    lines:
      effectiveLineRows.length > 0
        ? buildLines(effectiveLineRows)
        : [
            {
              lineNumber: 1,
              name: asString(invoice.invoice_number) ?? 'Faktura',
              quantity: '1',
              unitNetPrice: roundMoneyTo2dp(invoice.grand_total_net_amount),
              netValue: roundMoneyTo2dp(invoice.grand_total_net_amount),
              vatRate: deriveHeaderVatRate(
                toScaled4(invoice.grand_total_net_amount),
                toScaled4(invoice.tax_total_amount),
              ),
            },
          ],
    ...(annotations ? { annotations } : {}),
  }

  return fa3InvoiceSchema.parse(fa3Invoice)
}
