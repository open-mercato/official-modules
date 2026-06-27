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
import type { Fa3AnnotationsInput, Fa3InvoiceInput, Fa3PartyInput } from '../data/validators'
import { isMappedFa3VatRate, type Fa3VatRate } from './fa3'

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

export const BUYER_REQUIRED_DEFAULT =
  'This invoice has no buyer details. Add the buyer to the invoice before submitting it to KSeF.'
export const SELLER_REQUIRED_DEFAULT =
  'KSeF seller (Podmiot1) identity is not configured. Set the seller name and address on the KSeF integration before submitting.'
export const VAT_RATE_UNSUPPORTED_DEFAULT =
  'This invoice uses a VAT rate that cannot be mapped to a KSeF FA(3) field. Use a standard Polish VAT rate.'

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
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

export function rateKey(rate: Fa3VatRate): string {
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
export function buildBuyer(invoice: InvoiceRow, deps: Fa3MappingDeps): Fa3PartyInput {
  const snapshot = readInvoiceBuyerSnapshot(invoice)

  const name = asString(snapshot.companyName) ?? asString(snapshot.company_name) ?? asString(snapshot.name)
  const nip = asNip(snapshot.nip ?? snapshot.taxId ?? snapshot.tax_id)

  const street = asString(snapshot.addressLine1) ?? asString(snapshot.address_line1)
  const cityLine = composeCityLine(snapshot)
  const addressLine1 = street ?? cityLine
  const addressLine2 = street
    ? asString(snapshot.addressLine2) ?? asString(snapshot.address_line2) ?? cityLine ?? undefined
    : asString(snapshot.addressLine2) ?? asString(snapshot.address_line2) ?? undefined

  if (!name || !addressLine1) {
    const message =
      deps.translate?.('financial_pl.errors.buyer_required', BUYER_REQUIRED_DEFAULT) ?? BUYER_REQUIRED_DEFAULT
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

export function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = asString(value)
  if (!text) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
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
    const numericRate = rateText === 'zw' || rateText === 'np' || rateText === 'oo' ? null : asFiniteNumber(rateText)
    const quantityScaled = toScaledInt(quantity, 4)
    const unitNetCents = toCents(unitNetPrice)
    const netCents = Math.round((quantityScaled * unitNetCents) / 10000)
    const vatCents = numericRate != null ? Math.round((netCents * numericRate) / 100) : 0
    rows.push({
      line_number: index + 1,
      description: asString(line.description) ?? '',
      quantity_unit: asString(line.unit) ?? undefined,
      quantity: String(quantityScaled / 10000),
      unit_price_net: unitNetCents / 100,
      total_net_amount: (netCents / 100).toFixed(2),
      tax_amount: (vatCents / 100).toFixed(2),
      tax_rate: rateText,
    })
  }
  return rows
}

export function buildLines(lineRows: InvoiceLineRow[]): Fa3InvoiceInput['lines'] {
  return lineRows.map((row, index) => {
    const lineNumber =
      typeof row.line_number === 'number' && row.line_number > 0 ? row.line_number : index + 1
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

/** Derive a single FA(3) VAT rate from header net/tax totals (line-less fallback). */
export function deriveHeaderVatRate(netScaled: bigint, vatScaled: bigint): Fa3VatRate {
  if (vatScaled === 0n) return 0
  if (netScaled <= 0n) return 23
  return normalizeVatRate(Math.round((Number(vatScaled) / Number(netScaled)) * 100))
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
    const netScaled = toScaled4(headerNetField)
    const vatScaled = toScaled4(headerVatField)
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

/** Derive the FA(3) `Adnotacje` flags (MPP + VAT-exemption basis) from PL VAT metadata. */
export function buildAnnotations(meta: Record<string, unknown> | undefined): Fa3AnnotationsInput | undefined {
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
