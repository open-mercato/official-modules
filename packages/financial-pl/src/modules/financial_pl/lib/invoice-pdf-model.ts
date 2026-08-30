/**
 * Pure mapping from the FA(3) document model (the data the connector files to KSeF)
 * to a flat, render-agnostic invoice-display model for the PDF visualization.
 *
 * Money is summed with BigInt cents so KOR (negative) differences are exact and
 * there is no float drift. This module has no DB/DI/network deps and is fully
 * unit-testable.
 */
import type { Fa3Annotations, Fa3Document, Fa3Line, Fa3Party, Fa3VatBucketKey, Fa3VatRate } from './fa3'
import { isValidPolishAccountNumber, normalizeAccountNumber } from './bank-account'
import { buildZbpTransferString } from './payment-qr'
import type { KsefSubmissionStatusColumn } from '../data/entities'

type MarginScheme = NonNullable<Fa3Annotations['marginScheme']>

export type InvoicePartyView = {
  name: string
  nip?: string
  euVatId?: string
  addressLine1: string
  addressLine2?: string
  countryCode: string
}

export type InvoiceLineView = {
  lp: number
  name: string
  unit: string
  quantity: string
  unitNet: string
  discountPct?: string
  discountAmount?: string
  net: string
  vatRateLabel: string
  vat: string
  gross: string
}

export type InvoiceVatSummaryRow = {
  vatRateLabel: string
  net?: string
  vat?: string
  gross: string
}

export type InvoicePdfModel = {
  title: string
  invoiceNumber: string
  issueDate: string
  saleDate?: string
  currencyCode: string
  seller: InvoicePartyView
  buyer: InvoicePartyView
  lines: InvoiceLineView[]
  vatSummary: InvoiceVatSummaryRow[]
  hasDiscounts: boolean
  discountTotal?: string
  marginScheme?: MarginScheme
  marginWordingKey?: MarginScheme
  totalNet: string
  totalVat: string
  totalGross: string
  /** KSeF block: the assigned number, the QR label (number or "OFFLINE"), and status. */
  ksef: { number?: string; label: string; status: KsefSubmissionStatusColumn | string }
  /**
   * Optional second (KOD II) QR descriptor for offline-issued invoices. Present
   * only when an Offline cert-signed KOD II URL exists; absent on the byte-stable
   * online single-QR (KOD I) path. The PDF renderer pairs this with the KOD II QR
   * PNG (`deps.qrIiPng`) and labels it "CERTYFIKAT" (i18n: financial_pl.labels.qrCertyfikat).
   */
  ksefCert?: { label: string }
  /** Optional operator-visible invoice remarks, rendered only when non-empty. */
  notes?: string
  /** Optional payment block (Płatność), rendered only when present. */
  payment?: { methodLabel: string; term?: string; account?: string; bankName?: string; paid?: boolean }
  paymentQr?: { payload: string; label: string }
  correctionReason?: string
  /** The "this is a visualization" footer notice (translated by the caller). */
  notice: string
}

export const MARGIN_WORDING_PL: Record<MarginScheme, string> = {
  travel: 'procedura marży dla biur podróży',
  used_goods: 'procedura marży - towary używane',
  art: 'procedura marży - dzieła sztuki',
  collectibles: 'procedura marży - przedmioty kolekcjonerskie i antyki',
}

const FORMA_LABEL_PL: Record<string, string> = {
  '1': 'Gotówka',
  '2': 'Karta',
  '3': 'Bon',
  '4': 'Czek',
  '5': 'Kredyt',
  '6': 'Przelew',
  '7': 'Płatność mobilna',
}

function toCents(value: string): bigint {
  const s = value.trim()
  const neg = s.startsWith('-')
  const abs = neg ? s.slice(1) : s
  const [intPart, fracRaw = ''] = abs.split('.')
  const frac = (fracRaw + '00').slice(0, 2)
  const cents = BigInt(intPart || '0') * 100n + BigInt(frac || '0')
  return neg ? -cents : cents
}

function fromCents(cents: bigint): string {
  const neg = cents < 0n
  const a = neg ? -cents : cents
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

function sumMoney(values: string[]): string {
  return fromCents(values.reduce((acc, v) => acc + toCents(v), 0n))
}

/** Exact money difference a − b (2dp). Used to recover gross-mode per-line VAT as gross − net,
 *  which is what the resolver/FA(3)/header already carry — recomputing net×rate would drift. */
function diffMoney(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b))
}

/** Per-line VAT = round-half-up(net * rate%, 2dp), by magnitude (sign-preserving). Non-numeric rates
 *  → 0. The rate is taken in basis points (rate × 100) so a FRACTIONAL rate (e.g. Finland 25.5%) is
 *  applied exactly instead of being truncated to a whole percent. */
function lineVat(net: string, rate: Fa3VatRate): string {
  if (typeof rate !== 'number') return '0.00'
  const netCents = toCents(net)
  const sign = netCents < 0n ? -1n : 1n
  const rateBp = BigInt(Math.round(rate * 100)) // basis points: 25.5% → 2550
  const mag = (netCents < 0n ? -netCents : netCents) * rateBp
  const vatMag = (mag + 5000n) / 10000n // ÷100 (percent) ÷100 (bp), round half-up
  return fromCents(sign * vatMag)
}

export function vatRateLabel(rate: Fa3VatBucketKey): string {
  if (typeof rate === 'number') return `${rate}%`
  if (rate === 'margin') return 'marża'
  if (rate === 'oo') return 'o.o.'
  if (rate === 'oss') return 'OSS' // WSTO_EE destination-rate bucket (P_13_5/P_14_5)
  return rate // 'zw' | 'np'
}

function party(p: Fa3Party): InvoicePartyView {
  // A UPR (simplified-invoice) NIP-only buyer legitimately omits Nazwa/Adres; fall back to empty
  // strings so the PDF view stays well-typed (the buyer is then identified by NIP alone).
  return { name: p.name ?? '', nip: p.nip, euVatId: p.euVatId, addressLine1: p.addressLine1 ?? '', addressLine2: p.addressLine2, countryCode: p.countryCode }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const s = value.trim()
    return s ? s : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function lineRecord(line: Fa3Line): Record<string, unknown> {
  return line as unknown as Record<string, unknown>
}

function lineDiscountAmount(line: Fa3Line): string | undefined {
  const row = lineRecord(line)
  return (
    line.discount ??
    optionalString(row.discountAmount) ??
    optionalString(row.discount_amount)
  )
}

function lineDiscountPct(line: Fa3Line): string | undefined {
  const row = lineRecord(line)
  return optionalString(row.discountPct) ?? optionalString(row.discountPercent) ?? optionalString(row.discount_percent)
}

function isNonZeroMoney(value: string | undefined): value is string {
  return value !== undefined && toCents(value) !== 0n
}

function paymentQrPayload(input: {
  seller: InvoicePartyView
  invoiceNumber: string
  currencyCode: string
  totalGross: string
  payment?: { paidDate?: string; bankAccount?: string }
}): string | undefined {
  const bankAccount = input.payment?.bankAccount
  if (input.currencyCode !== 'PLN' || input.payment?.paidDate || !isValidPolishAccountNumber(bankAccount)) return undefined
  const amountGrosze = toCents(input.totalGross)
  if (amountGrosze < 0n || amountGrosze > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  // Normalise the seller NIP to bare digits: it may be stored with a 'PL' prefix or dashes
  // (e.g. 'PL123-456-78-90'). Pass it only when it reduces to exactly 10 digits, else omit the NIP
  // field (the ZBP payload allows an empty NIP). Never let a malformed NIP crash the whole PDF —
  // fall back to no QR on any builder validation error.
  const nipDigits = (input.seller.nip ?? '').replace(/\D/g, '')
  try {
    return buildZbpTransferString({
      nip: /^\d{10}$/.test(nipDigits) ? nipDigits : '',
      countryCode: 'PL',
      nrb: normalizeAccountNumber(bankAccount),
      amountGrosze: Number(amountGrosze),
      name: input.seller.name,
      title: `FV ${input.invoiceNumber}`,
    })
  } catch {
    return undefined
  }
}

export function buildInvoicePdfModel(
  doc: Fa3Document,
  opts: {
    ksefNumber?: string | null
    ksefStatus: KsefSubmissionStatusColumn | string
    notice: string
    /**
     * When set, the invoice carries a cert-signed KOD II QR (offline-issued): the
     * model gains a `ksefCert` block labelled with `qrCertyfikatLabel` (the caller
     * passes the i18n `financial_pl.labels.qrCertyfikat` translation; defaults to
     * the Polish document constant "CERTYFIKAT"). Absent ⇒ byte-stable single-QR
     * (KOD I only) output, unchanged.
     */
    hasKodII?: boolean
    /** i18n `financial_pl.labels.qrOffline` translation for the KOD I OFFLINE label (defaults to "OFFLINE"). */
    qrOfflineLabel?: string
    /** i18n `financial_pl.labels.qrCertyfikat` translation for the KOD II label (defaults to "CERTYFIKAT"). */
    qrCertyfikatLabel?: string
    /** Optional operator note from invoice.metadata.notes. Blank/whitespace-only values are omitted. */
    notes?: string | null
  },
): InvoicePdfModel {
  const { model, lines } = doc
  const isKor = model.invoiceKind === 'KOR' || model.invoiceKind === 'KOR_ZAL' || model.invoiceKind === 'KOR_ROZ'
  const notes = typeof opts.notes === 'string' ? opts.notes.trim() : ''
  const marginScheme = model.annotations?.marginScheme
  const seller = party(model.seller)
  const buyer = party(model.buyer)

  const lineViews: InvoiceLineView[] = lines.map((l) => {
    const isMarginLine = Boolean(marginScheme) || Boolean(l.marginRow)
    // Gross-mode lines (grossValue present, non-margin): VAT is derived FROM gross, so the exact
    // per-line VAT is gross − net (what the resolver/FA(3)/header carry). Net-mode lines keep the
    // net×rate computation unchanged (BC). Margin lines show no VAT.
    const vat = isMarginLine
      ? ''
      : l.grossValue
        ? diffMoney(l.grossValue, l.netValue)
        : lineVat(l.netValue, l.vatRate)
    const gross = l.grossValue ?? (isMarginLine ? l.netValue : sumMoney([l.netValue, vat]))
    const discountAmount = lineDiscountAmount(l)
    const discountPct = lineDiscountPct(l)
    return {
      lp: l.lineNumber,
      name: l.name,
      unit: l.unit ?? 'szt',
      quantity: l.quantity,
      unitNet: isMarginLine ? (l.unitGrossPrice ?? l.unitNetPrice) : l.unitNetPrice,
      ...(discountPct ? { discountPct } : {}),
      ...(discountAmount ? { discountAmount } : {}),
      net: isMarginLine ? gross : l.netValue,
      vatRateLabel: isMarginLine ? 'marża' : vatRateLabel(l.vatRate),
      vat,
      gross,
    }
  })
  const discountAmounts = lineViews.map((l) => l.discountAmount).filter(isNonZeroMoney)
  const hasDiscounts = discountAmounts.length > 0

  const vatSummary: InvoiceVatSummaryRow[] = marginScheme
    ? [{ vatRateLabel: MARGIN_WORDING_PL[marginScheme], gross: model.totalGross }]
    : model.vatBreakdown.map((e) => ({
        vatRateLabel: vatRateLabel(e.rate),
        net: e.net,
        vat: e.vat,
        gross: sumMoney([e.net, e.vat]),
      }))

  const number = opts.ksefNumber ?? undefined
  // KOD I keeps its existing label logic: the assigned number, else the OFFLINE
  // label (the i18n qrOffline translation when supplied, else the document constant).
  const offlineLabel = opts.qrOfflineLabel ?? 'OFFLINE'
  const pay = model.payment
  const paymentView =
    pay && (pay.formaCode || pay.otherDescription || pay.terminDate || pay.paidDate || pay.bankAccount)
      ? {
          methodLabel: pay.formaCode ? (FORMA_LABEL_PL[pay.formaCode] ?? 'Inny') : (pay.otherDescription ?? 'Inny'),
          ...(pay.terminDate ? { term: pay.terminDate } : {}),
          ...(pay.bankAccount ? { account: pay.bankAccount } : {}),
          ...(pay.bankName ? { bankName: pay.bankName } : {}),
          paid: Boolean(pay.paidDate),
        }
      : undefined
  const paymentQr = paymentQrPayload({
    seller,
    invoiceNumber: model.invoiceNumber,
    currencyCode: model.currencyCode,
    totalGross: model.totalGross,
    payment: pay,
  })
  return {
    title: isKor ? 'FAKTURA KORYGUJĄCA' : 'FAKTURA',
    invoiceNumber: model.invoiceNumber,
    issueDate: model.issueDate,
    saleDate: model.saleDate,
    currencyCode: model.currencyCode,
    seller,
    buyer,
    lines: lineViews,
    vatSummary,
    hasDiscounts,
    ...(hasDiscounts ? { discountTotal: sumMoney(discountAmounts) } : {}),
    ...(marginScheme ? { marginScheme, marginWordingKey: marginScheme } : {}),
    totalNet: sumMoney(model.vatBreakdown.map((e) => e.net)),
    totalVat: sumMoney(model.vatBreakdown.map((e) => e.vat)),
    totalGross: model.totalGross,
    ksef: { number, label: number ?? offlineLabel, status: opts.ksefStatus },
    ...(opts.hasKodII ? { ksefCert: { label: opts.qrCertyfikatLabel ?? 'CERTYFIKAT' } } : {}),
    ...(notes ? { notes } : {}),
    ...(paymentView ? { payment: paymentView } : {}),
    ...(paymentQr ? { paymentQr: { payload: paymentQr, label: 'Zapłać przelewem' } } : {}),
    correctionReason: model.correction?.reason,
    notice: opts.notice,
  }
}
