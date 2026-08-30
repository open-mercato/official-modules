'use client'

import * as React from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * The invoice rendered as the DOCUMENT it will become — parties, dates, lines, VAT breakdown,
 * totals, statutory annotations and payment details.
 *
 * ONE renderer, used by both the saved-invoice detail view and the live preview beside the create
 * form. Keeping a single component is the point: a second, hand-built preview would drift from the
 * document actually filed, and a preview that disagrees with the filing is worse than none.
 */

export type DocumentParty = {
  name?: string | null
  nip?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  postalCode?: string | null
  city?: string | null
  countryCode?: string | null
}

export type DocumentLine = {
  name?: string | null
  quantity?: string | null
  quantityUnit?: string | null
  unitPriceNet?: string | null
  taxRate?: string | null
  discountPercent?: string | null
  discountAmount?: string | null
  totalNetAmount?: string | null
  taxAmount?: string | null
  totalGrossAmount?: string | null
  currencyCode?: string | null
}

export type DocumentPayment = {
  methodLabel?: string | null
  bankAccount?: string | null
  bankName?: string | null
  swift?: string | null
  paid?: boolean
  paidDate?: string | null
}

export type InvoiceDocumentPreviewProps = {
  /** Seller logo as a data URL, from invoice settings. Presentation only — never filed to KSeF. */
  logoDataUrl?: string | null
  /** Free-text footer from invoice settings (register entry, thank-you line, complaints address). */
  footerNote?: string | null
  /** Invoice number. While creating this is the provisional peek, flagged as such. */
  invoiceNumber?: string | null
  /** True when `invoiceNumber` is a preview of the next number, not an assigned one. */
  invoiceNumberProvisional?: boolean
  seller: DocumentParty | null
  buyer: DocumentParty | null
  issueDate: string | null
  saleDate: string | null
  dueDate: string | null
  currency: string
  lines: DocumentLine[]
  totalNet: string | null
  taxTotal: string | null
  totalGross: string | null
  /** Exchange rate + its date; rendered only when the currency is not PLN. */
  exchangeRate?: string | null
  exchangeRateDate?: string | null
  /** Statutory phrases (MPP, self-billing, reverse charge, exemption basis). */
  annotations?: string[]
  note?: string | null
  /** What the document states where a signature line would be, plus the named signatories. */
  signature?: {
    mode?: string | null
    issuerSignatory?: string | null
    recipientSignatory?: string | null
  } | null
  payment?: DocumentPayment | null
  className?: string
}

const PAYMENT_PAID_STATUS_MAP: StatusMap<'paid'> = { paid: 'success' }

function formatDate(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatAmount(
  value: string | null | undefined,
  currency: string | null | undefined,
  fallback = '—',
): string {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  try {
    if (currency && currency.trim().length) {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n)
    }
    return new Intl.NumberFormat(undefined, { style: 'decimal', minimumFractionDigits: 2 }).format(n)
  } catch {
    return String(value)
  }
}

/** Trailing zeros carry no information; keep significant decimals only. */
function formatDecimal(value: string | number | null | undefined, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(n)
}

/** `23.0000` reads as `23%`; a non-numeric rate (`zw`) passes through. */
function formatTaxRate(value: string | number | null | undefined, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}%`
}

function lineDiscountText(line: DocumentLine): string | null {
  const percent = Number(line.discountPercent)
  const amount = Number(line.discountAmount)
  const parts: string[] = []
  if (Number.isFinite(percent) && percent > 0) {
    parts.push(`${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(percent)}%`)
  }
  if (Number.isFinite(amount) && amount > 0) parts.push(formatAmount(line.discountAmount, line.currencyCode))
  return parts.length ? parts.join(' / ') : null
}

type VatRateBucket = { rate: string; net: number; vat: number; gross: number }

/**
 * Net and tax per VAT rate — art. 106e ust. 1 pkt 12-14. Grouped on the RAW rate so `zw`/`np` keep
 * their own bucket instead of collapsing into 0%.
 */
export function summarizeVatByRate(lines: DocumentLine[]): VatRateBucket[] {
  const buckets = new Map<string, VatRateBucket>()
  for (const line of lines) {
    const rate = (line.taxRate ?? '').trim() || '—'
    const bucket = buckets.get(rate) ?? { rate, net: 0, vat: 0, gross: 0 }
    const net = Number(line.totalNetAmount)
    const vat = Number(line.taxAmount)
    const gross = Number(line.totalGrossAmount)
    if (Number.isFinite(net)) bucket.net += net
    if (Number.isFinite(vat)) bucket.vat += vat
    if (Number.isFinite(gross)) bucket.gross += gross
    buckets.set(rate, bucket)
  }
  return [...buckets.values()].sort((a, b) => Number(b.rate) - Number(a.rate))
}

function partyAddress(party: DocumentParty | null): string | null {
  if (!party) return null
  const text = [
    party.addressLine1,
    party.addressLine2,
    [party.postalCode, party.city].filter(Boolean).join(' '),
    party.countryCode,
  ]
    .filter((part) => part && String(part).trim())
    .join(', ')
  return text || null
}

function hasParty(party: DocumentParty | null): boolean {
  return Boolean(party && (party.name || party.nip || party.addressLine1))
}

export function InvoiceDocumentPreview({
  logoDataUrl,
  footerNote,
  invoiceNumber,
  invoiceNumberProvisional,
  seller,
  buyer,
  issueDate,
  saleDate,
  dueDate,
  currency,
  lines,
  totalNet,
  taxTotal,
  totalGross,
  exchangeRate,
  exchangeRateDate,
  annotations = [],
  note,
  signature,
  payment,
  className,
}: InvoiceDocumentPreviewProps) {
  const t = useT()
  const vatByRate = summarizeVatByRate(lines)
  const isForeignCurrency = currency.trim().toUpperCase() !== '' && currency.trim().toUpperCase() !== 'PLN'
  const taxTotalPln = (() => {
    if (!isForeignCurrency) return null
    const tax = Number(taxTotal)
    const rate = Number(exchangeRate)
    if (!Number.isFinite(tax) || !Number.isFinite(rate) || rate <= 0) return null
    return tax * rate
  })()

  return (
    // `@container`: the document renders in a ~60% column, so its internal splits must respond to
    // that width rather than the viewport.
    <article className={`@container rounded-lg border bg-card p-6 ${className ?? ''}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-3">
          {logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data: URL has no remote origin
            // to optimise, and next/image would only add a loader in front of an inline image.
            <img
              src={logoDataUrl}
              alt=""
              aria-hidden="true"
              className="max-h-10 max-w-32 self-center object-contain"
            />
          ) : null}
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('financial_pl.invoices.detail.documentTitle', 'INVOICE')}
          </h2>
        </span>
        {invoiceNumber ? (
          <span className="flex items-baseline gap-2">
            <span className="text-base font-medium tabular-nums text-foreground">{invoiceNumber}</span>
            {invoiceNumberProvisional ? (
              <span className="text-xs text-muted-foreground">
                {t('financial_pl.invoices.create.numberProvisional', '(provisional)')}
              </span>
            ) : null}
          </span>
        ) : null}
      </header>

      {/* Parties and dates as one bordered panel with dividers. */}
      <div className="mt-6 overflow-hidden rounded-md border border-border">
        <div className="grid @md:grid-cols-2">
          <div className="flex flex-col gap-1 border-b border-border p-4 text-sm @md:border-b-0 @md:border-r">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('financial_pl.invoices.detail.billedBy', 'Billed by')}
            </span>
            {seller?.name ? <span className="font-medium text-foreground">{seller.name}</span> : null}
            {seller?.nip ? (
              <span className="text-muted-foreground">
                {t('financial_pl.fields.contextNip', 'Taxpayer NIP')}: {seller.nip}
              </span>
            ) : null}
            {partyAddress(seller) ? (
              <span className="text-muted-foreground">{partyAddress(seller)}</span>
            ) : null}
            {!hasParty(seller) ? <span className="text-muted-foreground">—</span> : null}
          </div>
          <div className="flex flex-col gap-1 p-4 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('financial_pl.invoices.detail.billedTo', 'Billed to')}
            </span>
            {hasParty(buyer) ? (
              <>
                {buyer?.name ? <span className="font-medium text-foreground">{buyer.name}</span> : null}
                {buyer?.nip ? (
                  <span className="text-muted-foreground">
                    {t('financial_pl.buyer.nip', 'Buyer NIP')}: {buyer.nip}
                  </span>
                ) : null}
                {partyAddress(buyer) ? (
                  <span className="text-muted-foreground">{partyAddress(buyer)}</span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </div>
        <div className="grid border-t border-border bg-muted/40 @sm:grid-cols-3">
          <div className="flex flex-col gap-1 border-b border-border p-3 text-center text-sm @sm:border-b-0 @sm:border-r">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('financial_pl.invoices.detail.issueDate', 'Issue date')}
            </span>
            <span className="font-medium tabular-nums text-foreground">{formatDate(issueDate)}</span>
          </div>
          <div className="flex flex-col gap-1 border-b border-border p-3 text-center text-sm @sm:border-b-0 @sm:border-r">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('financial_pl.invoices.detail.saleDate', 'Sale date')}
            </span>
            <span className="font-medium tabular-nums text-foreground">{formatDate(saleDate)}</span>
          </div>
          <div className="flex flex-col gap-1 p-3 text-center text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('financial_pl.invoices.detail.dueDate', 'Due date')}
            </span>
            <span className="font-medium tabular-nums text-foreground">{formatDate(dueDate)}</span>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <div className="text-sm text-muted-foreground">
          {t('financial_pl.invoices.detail.lines', 'Line items')}
        </div>
        <div className="mt-2 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {/* Lp. — a Polish invoice numbers its positions, and a correction refers to them. */}
                <TableHead className="w-8 text-right">
                  {t('financial_pl.invoices.detail.line.no', 'No.')}
                </TableHead>
                <TableHead>{t('financial_pl.invoices.detail.line.name', 'Name')}</TableHead>
                <TableHead className="text-right">
                  {t('financial_pl.invoices.detail.line.quantity', 'Qty')}
                </TableHead>
                <TableHead className="text-right">
                  {t('financial_pl.invoices.detail.line.taxRate', 'VAT %')}
                </TableHead>
                <TableHead className="text-right">
                  {t('financial_pl.invoices.detail.line.net', 'Net')}
                </TableHead>
                <TableHead className="text-right">
                  {t('financial_pl.invoices.detail.line.gross', 'Gross')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    {t('financial_pl.invoices.detail.noLines', 'No line items.')}
                  </TableCell>
                </TableRow>
              ) : (
                lines.map((line, index) => (
                  <TableRow key={index}>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{index + 1}</TableCell>
                    <TableCell>
                      <span className="flex flex-col">
                        <span>{line.name || '—'}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatAmount(line.unitPriceNet, line.currencyCode ?? currency)}
                          {line.quantityUnit ? ` / ${line.quantityUnit}` : ''}
                        </span>
                        {lineDiscountText(line) ? (
                          <span className="text-xs text-muted-foreground">
                            {t('financial_pl.invoices.detail.line.discount', 'Discount')}:{' '}
                            {lineDiscountText(line)}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{formatDecimal(line.quantity)}</TableCell>
                    <TableCell className="text-right">{formatTaxRate(line.taxRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(line.totalNetAmount, line.currencyCode ?? currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(line.totalGrossAmount, line.currencyCode ?? currency)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Only with more than one rate: on a single-rate invoice this restates the line and totals. */}
      {vatByRate.length > 1 ? (
        <div className="mt-6">
          <div className="text-sm text-muted-foreground">
            {t('financial_pl.invoices.detail.vatByRate', 'VAT breakdown by rate')}
          </div>
          <div className="mt-2 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('financial_pl.invoices.detail.line.taxRate', 'VAT %')}</TableHead>
                  <TableHead className="text-right">
                    {t('financial_pl.invoices.detail.line.net', 'Net')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('financial_pl.invoices.detail.line.tax', 'VAT')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('financial_pl.invoices.detail.line.gross', 'Gross')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vatByRate.map((bucket) => (
                  <TableRow key={bucket.rate}>
                    <TableCell>{formatTaxRate(bucket.rate)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(bucket.net.toFixed(2), currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(bucket.vat.toFixed(2), currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(bucket.gross.toFixed(2), currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-2 border-t border-border pt-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('financial_pl.invoices.detail.net', 'Net total')}</span>
          <span className="tabular-nums text-foreground">{formatAmount(totalNet, currency)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('financial_pl.invoices.detail.line.tax', 'VAT')}</span>
          <span className="tabular-nums text-foreground">{formatAmount(taxTotal, currency)}</span>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <span className="font-semibold text-foreground">
            {t('financial_pl.invoices.detail.gross', 'Gross total')}
          </span>
          <span className="text-lg font-semibold tabular-nums text-foreground">
            {formatAmount(totalGross, currency)}
          </span>
        </div>
        {isForeignCurrency ? (
          <>
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-muted-foreground">
                {t('financial_pl.fields.exchangeRate', 'Exchange rate (to PLN)')}
                {exchangeRateDate ? ` (${formatDate(exchangeRateDate)})` : ''}
              </span>
              <span className="tabular-nums text-foreground">
                {exchangeRate ? formatDecimal(exchangeRate) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t('financial_pl.invoices.detail.taxTotalPln', 'VAT in PLN')}
              </span>
              <span className="tabular-nums text-foreground">
                {taxTotalPln != null ? formatAmount(taxTotalPln.toFixed(2), 'PLN') : '—'}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {annotations.length > 0 ? (
        <ul className="mt-6 flex flex-col gap-1 border-t border-border pt-4 text-sm text-foreground">
          {annotations.map((annotation) => (
            <li key={annotation}>{annotation}</li>
          ))}
        </ul>
      ) : null}

      {note && note.trim() ? (
        <p className="mt-6 whitespace-pre-wrap rounded-md border border-border p-3 text-sm text-foreground">
          {note}
        </p>
      ) : null}

      {/* Always rendered: payment method belongs on the document, so its absence must be visible. */}
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4 border-t border-border pt-4 text-sm">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-foreground">
            {t('financial_pl.invoices.detail.payment.method', 'Payment method')}
          </span>
          <span className="text-muted-foreground">{payment?.methodLabel || '—'}</span>
          {payment?.bankAccount ? (
            <span className="font-mono text-muted-foreground">{payment.bankAccount}</span>
          ) : null}
          {payment?.bankName ? <span className="text-muted-foreground">{payment.bankName}</span> : null}
          {payment?.swift ? (
            <span className="text-muted-foreground">
              {t('financial_pl.invoices.detail.payment.swift', 'SWIFT')}: {payment.swift}
            </span>
          ) : null}
        </div>
        {payment?.paid ? (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge variant={PAYMENT_PAID_STATUS_MAP.paid} dot>
              {t('financial_pl.invoices.detail.payment.paidBadge', 'Paid')}
            </StatusBadge>
            {payment.paidDate ? (
              <span className="text-muted-foreground">{formatDate(payment.paidDate)}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Signature footer. Polish VAT invoices have needed no signature since 2004, so this prints
          the chosen statement and any named signatories rather than drawing empty signature lines. */}
      {signature && (signature.mode || signature.issuerSignatory || signature.recipientSignatory) ? (
        <div className="mt-6 grid gap-4 border-t border-border pt-4 text-sm @md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('financial_pl.invoices.detail.signature.issuer', 'Issued by')}
            </span>
            <span className="text-foreground">{signature.issuerSignatory || '—'}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('financial_pl.invoices.detail.signature.recipient', 'Received by')}
            </span>
            <span className="text-foreground">{signature.recipientSignatory || '—'}</span>
          </div>
          {signature.mode ? (
            <span className="text-xs text-muted-foreground @md:col-span-2">
              {t(`financial_pl.invoices.form.signature.modes.${signature.mode}`, signature.mode)}
            </span>
          ) : null}
        </div>
      ) : null}
      {footerNote && footerNote.trim() ? (
        <p className="mt-6 whitespace-pre-line border-t border-border pt-4 text-xs text-muted-foreground">
          {footerNote}
        </p>
      ) : null}
    </article>
  )
}

export default InvoiceDocumentPreview
