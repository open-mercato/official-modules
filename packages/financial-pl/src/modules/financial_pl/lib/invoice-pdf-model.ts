/**
 * Pure mapping from the FA(3) document model (the data the connector files to KSeF)
 * to a flat, render-agnostic invoice-display model for the PDF visualization.
 *
 * Money is summed with BigInt cents so KOR (negative) differences are exact and
 * there is no float drift. This module has no DB/DI/network deps and is fully
 * unit-testable.
 */
import type { Fa3Document, Fa3Party, Fa3VatRate, Fa3VatBucketKey } from './fa3'
import type { KsefSubmissionStatusColumn } from '../data/entities'

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
  net: string
  vatRateLabel: string
  vat: string
  gross: string
}

export type InvoiceVatSummaryRow = {
  vatRateLabel: string
  net: string
  vat: string
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
  correctionReason?: string
  /** The "this is a visualization" footer notice (translated by the caller). */
  notice: string
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
  if (rate === 'oo') return 'o.o.'
  if (rate === 'oss') return 'OSS' // WSTO_EE destination-rate bucket (P_13_5/P_14_5)
  return rate // 'zw' | 'np'
}

function party(p: Fa3Party): InvoicePartyView {
  // A UPR (simplified-invoice) NIP-only buyer legitimately omits Nazwa/Adres; fall back to empty
  // strings so the PDF view stays well-typed (the buyer is then identified by NIP alone).
  return { name: p.name ?? '', nip: p.nip, euVatId: p.euVatId, addressLine1: p.addressLine1 ?? '', addressLine2: p.addressLine2, countryCode: p.countryCode }
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

  const lineViews: InvoiceLineView[] = lines.map((l) => {
    const vat = lineVat(l.netValue, l.vatRate)
    return {
      lp: l.lineNumber,
      name: l.name,
      unit: l.unit ?? 'szt',
      quantity: l.quantity,
      unitNet: l.unitNetPrice,
      net: l.netValue,
      vatRateLabel: vatRateLabel(l.vatRate),
      vat,
      gross: sumMoney([l.netValue, vat]),
    }
  })

  const vatSummary: InvoiceVatSummaryRow[] = model.vatBreakdown.map((e) => ({
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
  return {
    title: isKor ? 'FAKTURA KORYGUJĄCA' : 'FAKTURA',
    invoiceNumber: model.invoiceNumber,
    issueDate: model.issueDate,
    saleDate: model.saleDate,
    currencyCode: model.currencyCode,
    seller: party(model.seller),
    buyer: party(model.buyer),
    lines: lineViews,
    vatSummary,
    totalNet: sumMoney(model.vatBreakdown.map((e) => e.net)),
    totalVat: sumMoney(model.vatBreakdown.map((e) => e.vat)),
    totalGross: model.totalGross,
    ksef: { number, label: number ?? offlineLabel, status: opts.ksefStatus },
    ...(opts.hasKodII ? { ksefCert: { label: opts.qrCertyfikatLabel ?? 'CERTYFIKAT' } } : {}),
    ...(notes ? { notes } : {}),
    ...(paymentView ? { payment: paymentView } : {}),
    correctionReason: model.correction?.reason,
    notice: opts.notice,
  }
}
