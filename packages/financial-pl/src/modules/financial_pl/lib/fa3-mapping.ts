/**
 * Shared, pure FA(3) mapping helpers used by BOTH resolvers
 * (`resolve-fa3-from-invoice` and `resolve-fa3-from-credit-memo`). Kept in one
 * place so the money/VAT/party math has a single source of truth (a divergence
 * between the standard-invoice and correction paths would file inconsistent
 * statutory amounts). All functions are pure: they take plain rows / deps and
 * return validated FA(3) input fragments, with no I/O.
 */
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import type {
  Fa3AdvancePaymentInput,
  Fa3AdvanceRefInput,
  Fa3AnnotationsInput,
  Fa3InvoiceInput,
  Fa3OrderInput,
  Fa3OrderLineInput,
  Fa3PartyInput,
} from '../data/validators'
import { isMappedFa3VatRate, type Fa3VatBucketKey, type Fa3VatRate } from './fa3'

export type Fa3MappingDeps = {
  /** Seller NIP from the ksef_pl integration credential `contextNip`. */
  contextNip: string
  /** Optional override of the seller party (name/address) from the credential. */
  seller?: Partial<Fa3PartyInput>
  /** Optional i18n hook so a missing-buyer/seller rejection surfaces a localized message. */
  translate?: (key: string, fallback?: string) => string
}

export type InvoiceRow = Record<string, unknown>
export type InvoiceLineRow = Record<string, unknown>
export type Fa3PriceMode = 'net' | 'gross'
export type Fa3MarginScheme = 'travel' | 'used_goods' | 'art' | 'collectibles'

type ComputedLineAmounts = {
  unitNetPrice: string
  unitGrossPrice: string
  netValue: string
  grossValue: string
  vatValue: string
  discount?: string
}

type BuildLineOptions = {
  priceMode?: Fa3PriceMode
  marginScheme?: Fa3MarginScheme
}

export const BUYER_REQUIRED_DEFAULT =
  'This invoice has no buyer details. Add the buyer to the invoice before submitting it to KSeF.'
export const SELLER_REQUIRED_DEFAULT =
  'KSeF seller (Podmiot1) identity is not configured. Set the seller name and address on the KSeF integration before submitting.'
export const VAT_RATE_UNSUPPORTED_DEFAULT =
  'This invoice uses a VAT rate that cannot be mapped to a KSeF FA(3) field. Use a standard Polish VAT rate.'

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Like asString, but keeps finite numbers (the query engine may hydrate pg numeric as number). */
export function asNumericString(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  return asString(value)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Two-letter ISO country code (uppercased); falls back to PL for unknown/long values. */
export function normalizeCountryCode(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = asString(candidate)
    if (text && /^[A-Za-z]{2}$/.test(text)) return text.toUpperCase()
  }
  return 'PL'
}

/** Compose a "postal city" address line from a structured address snapshot. */
export function composeCityLine(source: Record<string, unknown>): string | null {
  const postal = asString(source.postalCode) ?? asString(source.postal_code)
  const city = asString(source.city)
  const composed = [postal, city].filter((part): part is string => Boolean(part)).join(' ').trim()
  return composed.length > 0 ? composed : null
}

export function asNip(value: unknown): string | undefined {
  const text = asString(value)
  if (!text) return undefined
  const digits = text.replace(/[^0-9]/g, '')
  return /^[0-9]{10}$/.test(digits) ? digits : undefined
}

/**
 * Round a numeric(18,4)-precision decimal (string or number) to a 2-dp money
 * string using EXACT BigInt math — no JS float. Sign-preserving (correction
 * differences are legitimately negative).
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

export function rateKey(rate: Fa3VatBucketKey): string {
  return typeof rate === 'number' ? String(rate) : rate
}

export function normalizeVatRate(value: unknown): Fa3VatRate {
  const text = asString(value)
  if (text === 'zw' || text === 'np' || text === 'oo') return text
  // An absent rate defaults to 0%; a PRESENT but unparsable rate returns NaN so the
  // vat_rate_unsupported gate rejects it instead of emitting a wrong 0% bucket.
  if (text === null && typeof value !== 'number') return 0
  const numeric = typeof value === 'number' ? value : Number(text)
  return Number.isFinite(numeric) ? numeric : Number.NaN
}

export function readPriceModeFromMetadata(metadata: unknown): Fa3PriceMode {
  return asString(asRecord(metadata).priceMode) === 'gross' ? 'gross' : 'net'
}

export function normalizeMarginScheme(value: unknown): Fa3MarginScheme | undefined {
  const text = asString(value)
  if (text === 'travel' || text === 'used_goods' || text === 'art' || text === 'collectibles') return text
  return undefined
}

export function lineCarriesTaxRate(row: InvoiceLineRow): boolean {
  // Only a POSITIVE VAT rate marks a real taxable line for the margin mixed-mode guard.
  // Core 0.6.5 persists an omitted line `taxRate` as `0`, and margin lines carry no VAT, so a
  // rate of 0 / null / unset is NOT evidence of a mixed taxable line — treating it as such would
  // reject every valid VAT-margin invoice (all rows persist rate 0). Guard on rate > 0 only.
  if (row.tax_rate === undefined || row.tax_rate === null) return false
  const rate = typeof row.tax_rate === 'number' ? row.tax_rate : Number(asString(row.tax_rate) ?? '')
  return Number.isFinite(rate) && rate > 0
}

function roundDivSigned(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const rounded = (magnitude + denominator / 2n) / denominator
  return negative ? -rounded : rounded
}

function centsToMoney(cents: bigint): string {
  const negative = cents < 0n
  const magnitude = negative ? -cents : cents
  const whole = magnitude / 100n
  const fraction = magnitude % 100n
  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(2, '0')}`
}

function moneyToCents(value: unknown): bigint {
  const text = roundMoneyTo2dp(value)
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(text)
  if (!match) return 0n
  const sign = match[1] === '-' ? -1n : 1n
  return sign * (BigInt(match[2]) * 100n + BigInt(match[3]))
}

function hasMoneyInput(value: unknown): boolean {
  return typeof value === 'number' ? Number.isFinite(value) : asString(value) !== null
}

function subtotalCents(quantity: unknown, unitPrice: unknown): bigint {
  const quantityScaled = toScaled4(quantity)
  const unitCents = moneyToCents(unitPrice)
  return roundDivSigned(quantityScaled * unitCents, 10000n)
}

function numericRateScaled4(value: unknown): bigint | null {
  const rate = normalizeVatRate(value)
  return typeof rate === 'number' && Number.isFinite(rate) ? toScaled4(rate) : null
}

function vatFromNetCents(netCents: bigint, rateValue: unknown): bigint {
  const rateScaled = numericRateScaled4(rateValue)
  return rateScaled === null ? 0n : roundDivSigned(netCents * rateScaled, 100n * 10000n)
}

function vatFromGrossCents(grossCents: bigint, rateValue: unknown): bigint {
  const rateScaled = numericRateScaled4(rateValue)
  if (rateScaled === null) return 0n
  return roundDivSigned(grossCents * rateScaled, 100n * 10000n + rateScaled)
}

function deriveDiscountCents(row: InvoiceLineRow, unitField: 'unit_price_net' | 'unit_price_gross'): bigint {
  if (hasMoneyInput(row.discount_amount)) return moneyToCents(row.discount_amount)
  const percentScaled = toScaled4(row.discount_percent)
  if (percentScaled === 0n) return 0n
  const baseCents = subtotalCents(row.quantity ?? '1', row[unitField])
  return roundDivSigned(baseCents * percentScaled, 100n * 10000n)
}

function computeLineAmounts(row: InvoiceLineRow, opts: BuildLineOptions = {}): ComputedLineAmounts {
  const useGross = opts.priceMode === 'gross' || opts.marginScheme !== undefined
  const unitField = useGross ? 'unit_price_gross' : 'unit_price_net'
  const discountCents = deriveDiscountCents(row, unitField)
  const hasUnit = hasMoneyInput(row[unitField])
  const netUnit = hasMoneyInput(row.unit_price_net) ? row.unit_price_net : row.total_net_amount
  const grossUnit = hasMoneyInput(row.unit_price_gross) ? row.unit_price_gross : row.total_gross_amount

  if (useGross) {
    const grossCents = hasUnit
      ? subtotalCents(row.quantity ?? '1', row.unit_price_gross) - discountCents
      : moneyToCents(row.total_gross_amount)
    const vatCents = opts.marginScheme ? 0n : vatFromGrossCents(grossCents, row.tax_rate)
    const netCents = grossCents - vatCents
    return {
      unitNetPrice: roundMoneyTo2dp(netUnit),
      unitGrossPrice: roundMoneyTo2dp(grossUnit),
      netValue: centsToMoney(netCents),
      grossValue: centsToMoney(grossCents),
      vatValue: centsToMoney(vatCents),
      ...(discountCents !== 0n ? { discount: centsToMoney(discountCents) } : {}),
    }
  }

  // BC: a net-mode line WITHOUT a discount serialises from its STORED totals exactly as before this
  // feature existed (the old buildLines used `row.total_net_amount`/`tax_amount` verbatim). Only a
  // discounted line recomputes net = qty×unit − discount (the new P_10 path). This keeps every
  // pre-existing invoice — where a stored total may differ from qty×unit by a rounding cent —
  // byte-identical.
  const recompute = hasUnit && discountCents !== 0n
  const netCents = recompute
    ? subtotalCents(row.quantity ?? '1', row.unit_price_net) - discountCents
    : moneyToCents(row.total_net_amount)
  const vatCents = recompute
    ? vatFromNetCents(netCents, row.tax_rate)
    : hasMoneyInput(row.tax_amount)
      ? moneyToCents(row.tax_amount)
      : vatFromNetCents(netCents, row.tax_rate)
  const grossCents = netCents + vatCents
  return {
    unitNetPrice: roundMoneyTo2dp(netUnit),
    unitGrossPrice: roundMoneyTo2dp(grossUnit),
    netValue: centsToMoney(netCents),
    grossValue: centsToMoney(grossCents),
    vatValue: centsToMoney(vatCents),
    ...(discountCents !== 0n ? { discount: centsToMoney(discountCents) } : {}),
  }
}

/**
 * Resolve the FA(3) seller (Podmiot1) from the credential seller identity. A KSeF
 * submission MUST carry the real seller — no placeholder fallback; throws a
 * localized 422 when a real name + address is not configured.
 */
export function buildSeller(deps: Fa3MappingDeps): Fa3PartyInput {
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
export function readInvoiceBuyerSnapshot(invoice: InvoiceRow): Record<string, unknown> {
  const metadata = asRecord(invoice.metadata)
  return asRecord(metadata.buyerSnapshot ?? metadata.buyer)
}

/**
 * Resolve the FA(3) buyer (Podmiot2) from the invoice's plaintext
 * `metadata.buyerSnapshot`. A KSeF submission MUST carry a real buyer — throws a
 * 422 when no name + address can be resolved. The buyer NIP is optional (FA(3)
 * emits `<BrakID>1</BrakID>` for a buyer without an identifier).
 */
export function buildBuyer(invoice: InvoiceRow, deps: Fa3MappingDeps, opts: { uprNipOnly?: boolean } = {}): Fa3PartyInput {
  const snapshot = readInvoiceBuyerSnapshot(invoice)

  const name = asString(snapshot.companyName) ?? asString(snapshot.company_name) ?? asString(snapshot.name)
  const nip = asNip(snapshot.nip ?? snapshot.taxId ?? snapshot.tax_id)
  // A non-Polish buyer is identified by an EU VAT ID rather than a NIP. Carried through here so the
  // value the operator typed is the value filed — without this the field would be collected and
  // silently dropped from the document.
  const euVatId = asString(snapshot.euVatId) ?? asString(snapshot.eu_vat_id)

  const street = asString(snapshot.addressLine1) ?? asString(snapshot.address_line1)
  const cityLine = composeCityLine(snapshot)
  const addressLine1 = street ?? cityLine
  const addressLine2 = street
    ? asString(snapshot.addressLine2) ?? asString(snapshot.address_line2) ?? cityLine ?? undefined
    : asString(snapshot.addressLine2) ?? asString(snapshot.address_line2) ?? undefined

  const countryCode = normalizeCountryCode(snapshot.countryCode, snapshot.country, snapshot.country_code)

  // UPR (simplified invoice, art. 106e ust. 5 pkt 3): the buyer may carry a NIP only — no Nazwa
  // and no Adres. When full identity is unavailable, fall back to a NIP-only party (requires a
  // NIP) instead of throwing `buyer_required`. A UPR buyer WITH a full name/address still emits
  // the complete party (the serializer's NIP-only branch is gated on missing name/address).
  if (opts.uprNipOnly && (!name || !addressLine1)) {
    if (!nip) {
      const message =
        deps.translate?.('financial_pl.errors.buyer_required', BUYER_REQUIRED_DEFAULT) ?? BUYER_REQUIRED_DEFAULT
      throw new CrudHttpError(422, { error: message, code: 'buyer_required' })
    }
    return {
      nip,
      countryCode,
      ...(name ? { name } : {}),
      ...(addressLine1 ? { addressLine1 } : {}),
      ...(addressLine2 ? { addressLine2 } : {}),
    }
  }

  if (!name || !addressLine1) {
    const message =
      deps.translate?.('financial_pl.errors.buyer_required', BUYER_REQUIRED_DEFAULT) ?? BUYER_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'buyer_required' })
  }

  return {
    nip,
    ...(euVatId ? { euVatId } : {}),
    name,
    countryCode,
    addressLine1,
    addressLine2,
  }
}

export function toIsoDate(value: unknown): string | undefined {
  const formatLocalIsoDate = (date: Date): string | undefined => {
    if (Number.isNaN(date.getTime())) return undefined
    const year = String(date.getFullYear()).padStart(4, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // Use local components: pg date columns hydrate as local midnight, and UTC conversion shifts Warsaw dates back.
  if (value instanceof Date) return formatLocalIsoDate(value)
  const text = asString(value)
  if (!text) return undefined
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const date = new Date(text)
  return formatLocalIsoDate(date)
}

export function asFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export function toScaledInt(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0
  const shifted = Number(`${value}e${decimals}`)
  return Number.isFinite(shifted) ? Math.round(shifted) : Math.round(value * 10 ** decimals)
}

export function toCents(value: number): number {
  return toScaledInt(value, 2)
}

/**
 * Bridge the backend invoice UI's `metadata.lines` snapshot into FA(3) line rows when
 * the invoice has no first-class line records. Per-line net/VAT use integer-cent math.
 */
export function metadataLinesToRows(invoice: InvoiceRow): InvoiceLineRow[] {
  const metadata = asRecord(invoice.metadata)
  const rawLines = metadata.lines
  if (!Array.isArray(rawLines)) return []
  const priceMode = readPriceModeFromMetadata(metadata)
  const rows: InvoiceLineRow[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = asRecord(rawLines[index])
    const quantity = asFiniteNumber(line.quantity)
    const unitNetPrice = asFiniteNumber(line.unitNetPrice)
    const unitGrossPrice = asFiniteNumber(line.unitGrossPrice)
    const rateText =
      asString(line.vatRate) ??
      (typeof line.vatRate === 'number' && Number.isFinite(line.vatRate) ? String(line.vatRate) : '0')
    const numericRate = rateText === 'zw' || rateText === 'np' || rateText === 'oo' ? null : asFiniteNumber(rateText)
    const quantityScaled = toScaledInt(quantity, 4)
    const unitNetCents = toCents(unitNetPrice)
    const unitGrossCents = toCents(unitGrossPrice)
    const discountAmount = asNumericString(line.discountAmount) ?? asNumericString(line.discount_amount)
    const discountPercent = asNumericString(line.discountPercent) ?? asNumericString(line.discount_percent)
    const baseCents =
      priceMode === 'gross'
        ? Math.round((quantityScaled * unitGrossCents) / 10000)
        : Math.round((quantityScaled * unitNetCents) / 10000)
    const discountCents = discountAmount
      ? Number(moneyToCents(discountAmount))
      : discountPercent
        ? Number(roundDivSigned(BigInt(baseCents) * toScaled4(discountPercent), 100n * 10000n))
        : 0
    const grossCents =
      priceMode === 'gross'
        ? baseCents - discountCents
        : 0
    const grossVatCents =
      priceMode === 'gross' && numericRate != null
        ? Number(vatFromGrossCents(BigInt(grossCents), rateText))
        : 0
    const netCents =
      priceMode === 'gross'
        ? grossCents - grossVatCents
        : baseCents - discountCents
    const vatCents =
      priceMode === 'gross'
        ? grossVatCents
        : numericRate != null
          ? Math.round((netCents * numericRate) / 100)
          : 0
    rows.push({
      line_number: index + 1,
      description: asString(line.description) ?? '',
      quantity_unit: asString(line.unit) ?? undefined,
      quantity: String(quantityScaled / 10000),
      unit_price_net: unitNetCents / 100,
      ...(priceMode === 'gross' ? { unit_price_gross: unitGrossCents / 100 } : {}),
      ...(discountCents !== 0 ? { discount_amount: (discountCents / 100).toFixed(2) } : {}),
      ...(discountPercent ? { discount_percent: discountPercent } : {}),
      total_net_amount: (netCents / 100).toFixed(2),
      tax_amount: (vatCents / 100).toFixed(2),
      total_gross_amount: ((netCents + vatCents) / 100).toFixed(2),
      tax_rate: rateText,
    })
  }
  return rows
}

export function buildLines(lineRows: InvoiceLineRow[], opts: BuildLineOptions = {}): Fa3InvoiceInput['lines'] {
  return lineRows.map((row, index) => {
    const lineNumber =
      typeof row.line_number === 'number' && row.line_number > 0 ? row.line_number : index + 1
    // OSS / WSTO_EE line markers carried on the (resolver-annotated) row: the destination-country
    // rate (`oss_rate`), the procedure marker, and the per-line FX rate to PLN (`fx_rate`). When
    // `oss_rate` is set the serializer omits `P_12` and emits `P_12_XII` + `Procedura=WSTO_EE`.
    const ossRate = asString(row.oss_rate)
    const procedureText = asString(row.procedure)
    const procedure = procedureText === 'WSTO_EE' ? ('WSTO_EE' as const) : undefined
    const fxRate = asNumericString(row.fx_rate)
    const amounts = computeLineAmounts(row, opts)
    const isGrossMethod = opts.priceMode === 'gross' || opts.marginScheme !== undefined
    return {
      lineNumber,
      name: asString(row.name) ?? asString(row.description) ?? `Pozycja ${lineNumber}`,
      unit: asString(row.quantity_unit) ?? undefined,
      quantity: asNumericString(row.quantity) ?? '1',
      unitNetPrice: amounts.unitNetPrice,
      netValue: amounts.netValue,
      vatRate: normalizeVatRate(row.tax_rate),
      ...(isGrossMethod ? { unitGrossPrice: amounts.unitGrossPrice, grossValue: amounts.grossValue } : {}),
      ...(amounts.discount !== undefined ? { discount: amounts.discount } : {}),
      ...(opts.marginScheme ? { marginRow: true } : {}),
      ...(ossRate ? { ossRate } : {}),
      ...(procedure ? { procedure } : {}),
      ...(fxRate ? { fxRate } : {}),
    }
  })
}

/** Derive a single FA(3) VAT rate from header net/tax totals (line-less fallback). Uses absolute
 *  magnitudes so a credit memo's NEGATED header (negative net+vat) derives the SAME rate as the
 *  original sale instead of collapsing to the 23% fallback (M1). */
export function deriveHeaderVatRate(netScaled: bigint, vatScaled: bigint): Fa3VatRate {
  if (vatScaled === 0n) return 0
  const absNet = netScaled < 0n ? -netScaled : netScaled
  const absVat = vatScaled < 0n ? -vatScaled : vatScaled
  if (absNet === 0n) return 23 // VAT but no taxable base — unusual; default to the standard rate
  return normalizeVatRate(Math.round((Number(absVat) / Number(absNet)) * 100))
}

/** Round a 4-dp-scaled amount to 2-dp integer cents (half-up), sign-agnostic magnitude. */
export function scaled4ToCents2dp(scaledAt4: bigint): bigint {
  const magnitude = scaledAt4 < 0n ? -scaledAt4 : scaledAt4
  const cents = magnitude / 100n
  return magnitude % 100n >= 50n ? cents + 1n : cents
}

/** Whether the header-derived VAT rate reproduces the stored tax EXACTLY in 2-dp money. */
export function headerVatRateReconciles(netScaled: bigint, vatScaled: bigint, rate: Fa3VatRate): boolean {
  if (typeof rate !== 'number') return true
  const vatCents = scaled4ToCents2dp(vatScaled)
  if (rate === 0) return vatCents === 0n
  const netCents = scaled4ToCents2dp(netScaled)
  const product = netCents * BigInt(rate)
  let expected = product / 100n
  if (product % 100n >= 50n) expected += 1n
  return expected === vatCents
}

export function toScaled4(value: unknown): bigint {
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

export function scaled4ToMoney2dp(scaledAt4: bigint): string {
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
 * Aggregate the FA(3) VAT summary by rate from invoice/credit-memo lines with exact
 * BigInt math (4-dp scale) before rounding each bucket to 2 dp. When no lines are
 * available, fall back to a single VAT entry derived from the header totals.
 */
export function buildVatBreakdown(
  lineRows: InvoiceLineRow[],
  headerNetField: unknown,
  headerVatField: unknown,
  opts: { fxRate?: string; priceMode?: Fa3PriceMode; marginScheme?: Fa3MarginScheme; headerGrossField?: unknown } = {},
): Fa3InvoiceInput['vatBreakdown'] {
  if (opts.marginScheme) {
    const grossScaled =
      lineRows.length > 0
        ? lineRows.reduce((sum, row) => sum + toScaled4(computeLineAmounts(row, opts).grossValue), 0n)
        : toScaled4(opts.headerGrossField) || toScaled4(headerNetField) + toScaled4(headerVatField)
    return [{ rate: 'margin', net: scaled4ToMoney2dp(grossScaled), vat: '0.00' }]
  }

  // The OSS / WSTO_EE bucket is keyed by the synthetic `'oss'` rate so consumer-country lines
  // NEVER merge into a Polish-rate bucket and roll up into a SINGLE P_13_5/P_14_5 summary
  // regardless of how many distinct destination rates appear (no `W` PLN-converted variant).
  const buckets = new Map<string, { rate: Fa3VatBucketKey; netScaled: bigint; vatScaled: bigint }>()
  for (const row of lineRows) {
    const isOss = asString(row.oss_rate) !== null
    const rate: Fa3VatBucketKey = isOss ? 'oss' : normalizeVatRate(row.tax_rate)
    const key = rateKey(rate)
    const existing = buckets.get(key) ?? { rate, netScaled: 0n, vatScaled: 0n }
    const amounts = computeLineAmounts(row, opts)
    existing.netScaled += toScaled4(amounts.netValue)
    existing.vatScaled += toScaled4(amounts.vatValue)
    buckets.set(key, existing)
  }
  // FX: for a Polish-rate bucket on a foreign-currency invoice, emit the PLN-converted output
  // VAT (`P_14_xW`, art. 106e ust. 11) = round(vat × rate) with EXACT BigInt math. The OSS
  // bucket has no `W` variant, so `vatPln` is never set for it.
  const fxScaled = opts.fxRate ? toScaled4(opts.fxRate) : 0n
  const hasFx = fxScaled > 0n
  if (buckets.size === 0) {
    const netScaled = toScaled4(headerNetField)
    const vatScaled = toScaled4(headerVatField)
    const entry: Fa3InvoiceInput['vatBreakdown'][number] = {
      rate: deriveHeaderVatRate(netScaled, vatScaled),
      net: scaled4ToMoney2dp(netScaled),
      vat: scaled4ToMoney2dp(vatScaled),
    }
    // A header-only (line-less) foreign-currency invoice still owes the PLN-converted output VAT:
    // compute P_14_xW with the same math as the line-based branch (the header rate is never OSS).
    if (hasFx && entry.rate !== 'oss') {
      entry.vatPln = scaled4ToMoney2dp((vatScaled * fxScaled) / 10000n)
    }
    return [entry]
  }
  return Array.from(buckets.values()).map((bucket) => {
    const entry: Fa3InvoiceInput['vatBreakdown'][number] = {
      rate: bucket.rate,
      net: scaled4ToMoney2dp(bucket.netScaled),
      vat: scaled4ToMoney2dp(bucket.vatScaled),
    }
    if (hasFx && bucket.rate !== 'oss' && bucket.rate !== 'margin') {
      // vatScaled (4dp) × fxScaled (4dp) = an 8dp-scaled product; divide by 1e4 back to 4dp,
      // then round to 2dp money via the shared helper.
      const productScaled8 = bucket.vatScaled * fxScaled
      const vatPlnScaled4 = productScaled8 / 10000n
      entry.vatPln = scaled4ToMoney2dp(vatPlnScaled4)
    }
    return entry
  })
}

/** Assert every VAT bucket maps to an FA(3) `P_13_x` field, else throw a localized 422. */
export function assertMappedVatRates(
  vatBreakdown: Fa3InvoiceInput['vatBreakdown'],
  translate?: (key: string, fallback?: string) => string,
): void {
  for (const entry of vatBreakdown) {
    if (!isMappedFa3VatRate(entry.rate)) {
      const message =
        translate?.('financial_pl.errors.vat_rate_unsupported', VAT_RATE_UNSUPPORTED_DEFAULT) ??
        VAT_RATE_UNSUPPORTED_DEFAULT
      throw new CrudHttpError(422, { error: message, code: 'vat_rate_unsupported' })
    }
  }
}

/**
 * Derive the FA(3) `Adnotacje` flags from the PL VAT metadata extension:
 *   - `mpp_required`     → split payment (P_18A)
 *   - `vat_exemption_basis` → VAT-exemption basis (Zwolnienie / P_19 + P_19C)
 *   - `self_billing`     → self-billing / samofakturowanie, art. 106d (P_17)
 *   - `reverse_charge`   → reverse charge / odwrotne obciążenie (P_18)
 * Booleans accept either a real boolean or a stored string ('true'/'1') via the shared parser.
 */
export function buildAnnotations(meta: Record<string, unknown> | undefined): Fa3AnnotationsInput | undefined {
  const flag = (value: unknown): boolean =>
    typeof value === 'boolean' ? value : parseBooleanWithDefault(asString(value), false)
  const splitPayment = flag(meta?.mpp_required)
  const selfBilling = flag(meta?.self_billing)
  const reverseCharge = flag(meta?.reverse_charge)
  const vatExemptionBasis = asString(meta?.vat_exemption_basis) ?? undefined
  const marginScheme = normalizeMarginScheme(meta?.margin_scheme)
  if (!splitPayment && !selfBilling && !reverseCharge && !vatExemptionBasis && !marginScheme) return undefined
  return {
    ...(splitPayment ? { splitPayment: true } : {}),
    ...(reverseCharge ? { reverseCharge: true } : {}),
    ...(selfBilling ? { selfBilling: true } : {}),
    ...(vatExemptionBasis ? { vatExemptionBasis } : {}),
    ...(marginScheme ? { marginScheme } : {}),
  }
}

/**
 * Map the PL-meta `order_snapshot` JSON into the FA(3) `Zamowienie` (order) input carried by an
 * advance (ZAL / KOR_ZAL). Money is rounded to 2dp via the shared BigInt helper; the order-line
 * VAT rate reuses `normalizeVatRate` (only a KSeF-mappable rate is then accepted at parse time).
 * Returns `undefined` when no usable order snapshot is present.
 */
export function buildZamowienie(orderSnapshot: unknown): Fa3OrderInput | undefined {
  const snapshot = asRecord(orderSnapshot)
  const rawLines = Array.isArray(snapshot.lines) ? snapshot.lines : []
  if (rawLines.length === 0) return undefined
  const lines: Fa3OrderLineInput[] = rawLines.map((raw, index) => {
    const row = asRecord(raw)
    const name = asString(row.name) ?? asString(row.description) ?? undefined
    const unit = asString(row.unit) ?? asString(row.quantity_unit) ?? undefined
    const quantity = asNumericString(row.quantity) ?? undefined
    const unitPrice = row.unitPrice ?? row.unit_price ?? row.unitNetPrice
    const netValue = row.netValue ?? row.total_net_amount
    const vatValue = row.vatValue ?? row.tax_amount
    const rateSource = row.vatRate ?? row.tax_rate
    const line: Fa3OrderLineInput = { lineNumber: index + 1 }
    if (name) line.name = name
    if (unit) line.unit = unit
    if (quantity) line.quantity = quantity
    if (unitPrice !== undefined && unitPrice !== null) line.unitNetPrice = roundMoneyTo2dp(unitPrice)
    if (netValue !== undefined && netValue !== null) line.netValue = roundMoneyTo2dp(netValue)
    if (vatValue !== undefined && vatValue !== null) line.vatValue = roundMoneyTo2dp(vatValue)
    if (rateSource !== undefined && rateSource !== null) line.vatRate = normalizeVatRate(rateSource)
    const gtu = asString(row.gtu) ?? undefined
    if (gtu) line.gtu = gtu
    if (row.stanPrzed === true) line.stanPrzed = true
    return line
  })
  const totalValue = roundMoneyTo2dp(
    snapshot.totalValue ?? snapshot.total_value ?? snapshot.totalGross ?? snapshot.total_gross,
  )
  return { totalValue, lines }
}

/**
 * Map the PL-meta `advance_payments` JSON into the FA(3) `ZaliczkaCzesciowa` inputs documented by
 * a ZAL invoice. Each row carries the received date (P_6Z), the advance amount (P_15Z, rounded to
 * 2dp), and an optional FX rate (KursWalutyZW). Malformed/empty rows are skipped.
 */
export function buildAdvancePayments(snapshot: unknown): Fa3AdvancePaymentInput[] {
  const rows = Array.isArray(snapshot) ? snapshot : []
  const payments: Fa3AdvancePaymentInput[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    const receivedDate = toIsoDate(row.receivedDate ?? row.received_date ?? row.date)
    const amountSource = row.amount ?? row.value
    if (!receivedDate || amountSource === undefined || amountSource === null) continue
    const payment: Fa3AdvancePaymentInput = { receivedDate, amount: roundMoneyTo2dp(amountSource) }
    const fxRate = asNumericString(row.fxRate ?? row.fx_rate)
    if (fxRate) payment.fxRate = fxRate
    payments.push(payment)
  }
  return payments
}

/**
 * Map the PL-meta `advance_refs` JSON into the FA(3) `FakturaZaliczkowa` references netted by a ROZ
 * settlement. A KSeF-issued advance carries `ksefNumber`; an outside-KSeF advance carries
 * `invoiceNumber`. Rows with neither identifier are skipped (the parse would reject them anyway).
 */
export function buildAdvanceRefs(snapshot: unknown): Fa3AdvanceRefInput[] {
  const rows = Array.isArray(snapshot) ? snapshot : []
  const refs: Fa3AdvanceRefInput[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    const ksefNumber = asString(row.ksefNumber ?? row.ksef_number) ?? undefined
    const invoiceNumber = asString(row.invoiceNumber ?? row.invoice_number) ?? undefined
    if (!ksefNumber && !invoiceNumber) continue
    refs.push({
      ...(ksefNumber ? { ksefNumber } : {}),
      ...(invoiceNumber ? { invoiceNumber } : {}),
    })
  }
  return refs
}
