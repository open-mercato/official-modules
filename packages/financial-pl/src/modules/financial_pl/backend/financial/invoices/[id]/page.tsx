"use client"

import * as React from 'react'
import Link from 'next/link'
import { Pencil } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasAllFeatures } from '@open-mercato/shared/security/features'
import { KsefStatusBadge } from '../../../../components/KsefStatusBadge'
import { KsefActions } from '../../../../components/KsefActions'
import { CorrectionForm } from '../../../../components/CorrectionForm'
import { PlVatMetaForm, type InvoiceMeta, type ProcedureMarkings } from '../../../../components/PlVatMetaForm'
import type { InvoiceLineInput } from '../../../../components/InvoiceLinesField'
import { buyerFromMetadata } from '../../../../components/BuyerFields'
import type { InvoiceKindColumn } from '../../../../data/entities'
import type { GtuCode, JpkProcedureMarking, JpkTypDokumentu } from '../../../../lib/jpk-markings-codes'

// Wire shapes mirror GET /api/financial_pl/ksef/invoices/[id] → { invoice, lines, meta, submission }.
type InvoiceDetail = {
  id: string
  invoiceNumber: string | null
  orderId: string | null
  statusEntryId: string | null
  status: string | null
  issueDate: string | null
  dueDate: string | null
  currencyCode: string | null
  subtotalNetAmount: string | null
  subtotalGrossAmount: string | null
  taxTotalAmount: string | null
  grandTotalNetAmount: string | null
  grandTotalGrossAmount: string | null
  metadata: Record<string, unknown> | null
}

type InvoiceLineDetail = {
  name: string | null
  quantity: string | null
  quantityUnit: string | null
  unitPriceNet: string | null
  unitPriceGross?: string | null
  discountAmount?: string | null
  discountPercent?: string | null
  taxRate: string | null
  totalNetAmount: string | null
  taxAmount: string | null
  totalGrossAmount: string | null
  currencyCode: string | null
  lineNumber: number | null
  kind: string | null
  sku?: string | null
  metadata?: Record<string, unknown> | null
}

type InvoiceMetaDetail = {
  contextNip: string | null
  ksefStatus: string
  ksefNumber: string | null
  mppRequired: boolean
  vatExemptionBasis: string | null
  issuedOutsideKsef: boolean
  invoiceKind: string
  selfBilling: boolean
  reverseCharge: boolean
  ossProcedure: boolean
  consumptionCountryCode: string | null
  exchangeRate: string | null
  exchangeRateDate: string | null
  advancePayments: InvoiceMeta['advancePayments']
  advanceRefs: InvoiceMeta['advanceRefs']
  gtuCodes: string[]
  wstoEe: boolean
  ied: boolean
  tp: boolean
  ttWnt: boolean
  ttD: boolean
  mrT: boolean
  mrUz: boolean
  i42: boolean
  i63: boolean
  bSpv: boolean
  bSpvDostawa: boolean
  bMpvProwizja: boolean
  docType: string | null
  badDebtReliefPeriod: string | null
  badDebtTerminPlatnosci: string | null
}

type SubmissionDetail = {
  id: string
  status: string
  ksefNumber: string | null
  upoAvailable: boolean
  offlineSendDeadlineAt: string | null
}

type InvoiceDetailResponse = {
  invoice: InvoiceDetail
  lines: InvoiceLineDetail[]
  meta: InvoiceMetaDetail | null
  submission: SubmissionDetail | null
}

type FeatureCheckResponse = { ok: boolean; granted?: string[]; userId?: string }

type InvoicePaymentMethod = 'cash' | 'card' | 'voucher' | 'cheque' | 'credit' | 'transfer' | 'mobile' | 'other'

type InvoicePaymentMetadata = {
  method: InvoicePaymentMethod | string
  methodOther?: string
  termDays?: number
  bankAccount?: string
  bankName?: string
  swift?: string
  paid?: boolean
  paidDate?: string
}

// Features the page evaluates against the current user; the result drives client-side gating
// (KSeF actions, edit lock, correction section). Server routes enforce the same independently.
const PAGE_FEATURES = [
  'financial_pl.view',
  'financial_pl.submit',
  'financial_pl.manage',
  'sales.invoices.manage',
  'sales.credit_memos.manage',
]

// A KSeF submission in one of these states locks header/meta edits (KSeF immutability — corrections only).
const EDIT_LOCK_STATUSES = new Set(['accepted', 'processing'])

// Map the GET payload's flat JPK procedure flags onto the form's procedure-markings map.
const PROCEDURE_FLAG_MAP: ReadonlyArray<[keyof InvoiceMetaDetail, JpkProcedureMarking]> = [
  ['wstoEe', 'WSTO_EE'],
  ['ied', 'IED'],
  ['tp', 'TP'],
  ['ttWnt', 'TT_WNT'],
  ['ttD', 'TT_D'],
  ['mrT', 'MR_T'],
  ['mrUz', 'MR_UZ'],
  ['i42', 'I_42'],
  ['i63', 'I_63'],
  ['bSpv', 'B_SPV'],
  ['bSpvDostawa', 'B_SPV_DOSTAWA'],
  ['bMpvProwizja', 'B_MPV_PROWIZJA'],
]

const INVOICE_KINDS: ReadonlySet<string> = new Set(['vat', 'zal', 'roz', 'upr', 'kor_zal', 'kor_roz'])
const TYP_DOKUMENTU: ReadonlySet<string> = new Set(['RO', 'WEW', 'FP'])
const PAYMENT_PAID_STATUS_MAP: StatusMap<'paid'> = { paid: 'success' }

/** Project the wire meta shape into the controlled `InvoiceMeta` value the form renders. */
function toFormMeta(meta: InvoiceMetaDetail): InvoiceMeta {
  const procedureMarkings: ProcedureMarkings = {}
  for (const [flag, code] of PROCEDURE_FLAG_MAP) {
    if (meta[flag] === true) procedureMarkings[code] = true
  }
  return {
    contextNip: meta.contextNip,
    mppRequired: meta.mppRequired,
    issuedOutsideKsef: meta.issuedOutsideKsef,
    vatExemptionBasis: meta.vatExemptionBasis,
    invoiceKind: INVOICE_KINDS.has(meta.invoiceKind) ? (meta.invoiceKind as InvoiceKindColumn) : undefined,
    selfBilling: meta.selfBilling,
    reverseCharge: meta.reverseCharge,
    ossProcedure: meta.ossProcedure,
    consumptionCountryCode: meta.consumptionCountryCode,
    exchangeRate: meta.exchangeRate,
    exchangeRateDate: meta.exchangeRateDate,
    advancePayments: meta.advancePayments,
    advanceRefs: meta.advanceRefs,
    gtuCodes: meta.gtuCodes as GtuCode[],
    procedureMarkings,
    typDokumentu: meta.docType && TYP_DOKUMENTU.has(meta.docType) ? (meta.docType as JpkTypDokumentu) : null,
    badDebtReliefPeriod: meta.badDebtReliefPeriod,
    badDebtTerminPlatnosci: meta.badDebtTerminPlatnosci,
  }
}

const LINE_KINDS: ReadonlySet<string> = new Set(['product', 'service', 'shipping', 'discount', 'adjustment'])

/** Project the wire line shape into the `InvoiceLineInput` shape the correction form reuses. */
function toLineInput(line: InvoiceLineDetail, currencyFallback: string): InvoiceLineInput {
  return {
    name: line.name ?? '',
    quantity: line.quantity ?? '',
    quantityUnit: line.quantityUnit ?? undefined,
    unitPriceNet: line.unitPriceNet ?? '',
    unitPriceGross: line.unitPriceGross ?? undefined,
    discountAmount: line.discountAmount ?? undefined,
    discountPercent: line.discountPercent ?? undefined,
    taxRate: line.taxRate ?? undefined,
    totalNetAmount: line.totalNetAmount ?? undefined,
    taxAmount: line.taxAmount ?? undefined,
    totalGrossAmount: line.totalGrossAmount ?? undefined,
    currencyCode: line.currencyCode ?? currencyFallback,
    lineNumber: line.lineNumber ?? undefined,
    kind: line.kind && LINE_KINDS.has(line.kind) ? (line.kind as InvoiceLineInput['kind']) : undefined,
    metadata: line.metadata ?? undefined,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function paymentFromMetadata(metadata: Record<string, unknown> | null | undefined): InvoicePaymentMetadata | null {
  const source = asRecord(metadata?.payment)
  if (!source) return null
  const payment: InvoicePaymentMetadata = { method: optionalString(source.method) ?? '' }
  const methodOther = optionalString(source.methodOther)
  const termDays = optionalNumber(source.termDays)
  const bankAccount = optionalString(source.bankAccount)
  const bankName = optionalString(source.bankName)
  const swift = optionalString(source.swift)
  const paidDate = optionalString(source.paidDate)
  if (methodOther) payment.methodOther = methodOther
  if (termDays !== undefined) payment.termDays = termDays
  if (bankAccount) payment.bankAccount = bankAccount
  if (bankName) payment.bankName = bankName
  if (swift) payment.swift = swift
  if (source.paid === true) payment.paid = true
  if (paidDate) payment.paidDate = paidDate
  return payment
}

function formatDate(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatAmount(value: string | null | undefined, currency: string | null | undefined, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  try {
    if (currency && currency.trim().length) {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n)
    }
    return new Intl.NumberFormat(undefined, { style: 'decimal', maximumFractionDigits: 2 }).format(n)
  } catch {
    return value
  }
}

function SummaryField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{children}</span>
    </div>
  )
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

export default function FinancialPlInvoiceDetailPage(props: { params?: { id?: string } }) {
  const t = useT()
  // This app renders backend pages via a `/[...slug]` catch-all that passes the resolved route
  // segment as a synchronous `params` prop (mirrors core `sales/.../[id]/page.tsx`). `useParams()`
  // would return the raw slug array here, not `{ id }`, so read the prop directly.
  const invoiceId = typeof props.params?.id === 'string' ? props.params.id : ''
  const scopeVersion = useOrganizationScopeVersion()

  const [data, setData] = React.useState<InvoiceDetailResponse | null>(null)
  const [loadState, setLoadState] = React.useState<'loading' | 'loaded' | 'not_found' | 'error'>('loading')
  const [grantedFeatures, setGrantedFeatures] = React.useState<string[]>([])
  const [reloadToken, setReloadToken] = React.useState(0)

  const refetch = React.useCallback(() => setReloadToken((token) => token + 1), [])

  // Granted features — same pattern core backend surfaces use (POST /api/auth/feature-check returns
  // the wildcard-resolved `granted` list for the current user, tenant/org scoped). The shared
  // components self-gate against this array via hasAllFeatures.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const call = await apiCall<FeatureCheckResponse>('/api/auth/feature-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ features: PAGE_FEATURES }),
      })
      if (cancelled) return
      setGrantedFeatures(call.ok ? call.result?.granted ?? [] : [])
    })()
    return () => {
      cancelled = true
    }
  }, [scopeVersion])

  React.useEffect(() => {
    let cancelled = false
    setLoadState('loading')
    void (async () => {
      try {
        const call = await apiCall<InvoiceDetailResponse>(
          `/api/financial_pl/ksef/invoices/${encodeURIComponent(invoiceId)}`,
        )
        if (cancelled) return
        if (call.status === 404) {
          setData(null)
          setLoadState('not_found')
          return
        }
        if (!call.ok || !call.result?.invoice) {
          setData(null)
          setLoadState('error')
          return
        }
        setData(call.result)
        setLoadState('loaded')
      } catch (err) {
        if (cancelled) return
        console.error('[internal] financial_pl.invoice.detail load failed', err)
        setData(null)
        setLoadState('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [invoiceId, reloadToken, scopeVersion])

  const canManageInvoices = hasAllFeatures(grantedFeatures, ['sales.invoices.manage'])
  const canIssueCorrection = hasAllFeatures(grantedFeatures, ['sales.credit_memos.manage'])

  // Loading → not-found → error are distinct page states (§10).
  if (loadState === 'loading') {
    return (
      <Page>
        <PageBody>
          <LoadingMessage label={t('financial_pl.invoices.detail.loading', 'Loading invoice…')} />
        </PageBody>
      </Page>
    )
  }

  if (loadState === 'not_found') {
    return (
      <Page>
        <PageBody>
          <ErrorMessage
            label={t('financial_pl.invoices.detail.notFound', 'Invoice not found.')}
            description={t(
              'financial_pl.invoices.detail.notFoundHint',
              'This invoice does not exist or is outside your access scope.',
            )}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/backend/financial/invoices">
                  {t('financial_pl.invoices.detail.backToList', 'Back to invoices')}
                </Link>
              </Button>
            }
          />
        </PageBody>
      </Page>
    )
  }

  if (loadState === 'error' || !data) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage
            label={t('financial_pl.invoices.detail.loadError', 'Failed to load the invoice.')}
            action={
              <Button type="button" variant="outline" size="sm" onClick={refetch}>
                {t('financial_pl.invoices.detail.retry', 'Retry')}
              </Button>
            }
          />
        </PageBody>
      </Page>
    )
  }

  const { invoice, lines, meta, submission } = data
  const currency = invoice.currencyCode ?? ''
  const buyer = buyerFromMetadata(invoice.metadata)
  const hasBuyer = Boolean(buyer.companyName || buyer.nip || buyer.addressLine1)
  const invoiceNote = typeof invoice.metadata?.notes === 'string' ? invoice.metadata.notes : null
  const saleDate = typeof invoice.metadata?.saleDate === 'string' ? invoice.metadata.saleDate : null
  const payment = paymentFromMetadata(invoice.metadata)
  const hasInvoiceNote = Boolean(invoiceNote && invoiceNote.trim().length > 0)
  const submissionStatus = submission?.status ?? null
  const editLocked = submissionStatus != null && EDIT_LOCK_STATUSES.has(submissionStatus)
  const isAccepted = submissionStatus === 'accepted'
  const number = invoice.invoiceNumber ?? invoice.id

  const submissionSummary = submission
    ? {
        id: submission.id,
        status: submission.status,
        ksefNumber: submission.ksefNumber,
        upoAvailable: submission.upoAvailable,
      }
    : null

  const correctionLines = lines.map((line) => toLineInput(line, currency))
  const paymentMethodLabel = payment?.method
    ? payment.method === 'other' && payment.methodOther
      ? `${t(`financial_pl.invoices.form.payment.methods.${payment.method}`, payment.method)} (${payment.methodOther})`
      : t(`financial_pl.invoices.form.payment.methods.${payment.method}`, payment.method)
    : '—'
  const paymentTermText = payment
    ? [
        payment.termDays !== undefined
          ? `${payment.termDays} ${t('financial_pl.invoices.detail.payment.days', 'days')}`
          : null,
        invoice.dueDate ? formatDate(invoice.dueDate) : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' / ') || '—'
    : '—'

  return (
    <Page>
      <PageBody>
        <div className="flex flex-col gap-4">
          {/* Header summary */}
          <section className="rounded-lg border bg-card p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-semibold text-foreground">{number}</h1>
                  <KsefStatusBadge
                    status={submission?.status ?? meta?.ksefStatus ?? null}
                    ksefNumber={submission?.ksefNumber ?? meta?.ksefNumber ?? null}
                    offlineSendDeadlineAt={submission?.offlineSendDeadlineAt ?? null}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canManageInvoices && !editLocked ? (
                  <Button asChild variant="outline">
                    <Link href={`/backend/financial/invoices/${invoice.id}/edit`}>
                      <Pencil className="mr-1 size-4" />
                      {t('financial_pl.invoices.detail.edit', 'Edit')}
                    </Link>
                  </Button>
                ) : editLocked ? (
                  <Button type="button" variant="outline" disabled title={t(
                    'financial_pl.invoices.detail.editLockedHint',
                    'This invoice is accepted by KSeF and can no longer be edited — issue a correction instead.',
                  )}>
                    <Pencil className="mr-1 size-4" />
                    {t('financial_pl.invoices.detail.edit', 'Edit')}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <SummaryField label={t('financial_pl.invoices.detail.issueDate', 'Issue date')}>
                {formatDate(invoice.issueDate)}
              </SummaryField>
              <SummaryField label={t('financial_pl.invoices.detail.saleDate', 'Sale date')}>
                {formatDate(saleDate)}
              </SummaryField>
              <SummaryField label={t('financial_pl.invoices.detail.dueDate', 'Due date')}>
                {formatDate(invoice.dueDate)}
              </SummaryField>
              <SummaryField label={t('financial_pl.invoices.detail.currency', 'Currency')}>
                {currency || '—'}
              </SummaryField>
              <SummaryField label={t('financial_pl.invoices.detail.net', 'Net total')}>
                {formatAmount(invoice.grandTotalNetAmount, currency)}
              </SummaryField>
              <SummaryField label={t('financial_pl.invoices.detail.gross', 'Gross total')}>
                {formatAmount(invoice.grandTotalGrossAmount, currency)}
              </SummaryField>
            </div>

            {hasBuyer ? (
              <div className="mt-4 border-t border-border pt-4">
                <div className="text-xs text-muted-foreground">
                  {t('financial_pl.invoices.detail.buyer', 'Buyer (Nabywca)')}
                </div>
                <div className="mt-1 text-sm text-foreground">
                  {buyer.companyName ? <div className="font-medium">{buyer.companyName}</div> : null}
                  {buyer.nip ? (
                    <div className="text-muted-foreground">
                      {t('financial_pl.buyer.nip', 'Buyer NIP')}: {buyer.nip}
                    </div>
                  ) : null}
                  {buyer.addressLine1 || buyer.postalCode || buyer.city ? (
                    <div className="text-muted-foreground">
                      {[
                        buyer.addressLine1,
                        buyer.addressLine2,
                        [buyer.postalCode, buyer.city].filter(Boolean).join(' '),
                        buyer.countryCode,
                      ]
                        .filter((part) => part && part.trim())
                        .join(', ')}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          {/* KSeF panel */}
          <SectionCard
            title={t('financial_pl.invoices.detail.ksefPanel', 'KSeF')}
            description={t(
              'financial_pl.invoices.detail.ksefPanelHint',
              'Send the invoice to KSeF, retry a failed submission, or download the UPO / PDF.',
            )}
          >
            <KsefActions
              invoiceId={invoice.id}
              submission={submissionSummary}
              features={grantedFeatures}
              onChanged={refetch}
            />
          </SectionCard>

          {/* Line items (read-only) */}
          <SectionCard title={t('financial_pl.invoices.detail.lines', 'Line items')}>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('financial_pl.invoices.detail.line.name', 'Name')}</TableHead>
                    <TableHead className="text-right">
                      {t('financial_pl.invoices.detail.line.quantity', 'Qty')}
                    </TableHead>
                    <TableHead>{t('financial_pl.invoices.detail.line.unit', 'Unit')}</TableHead>
                    <TableHead className="text-right">
                      {t('financial_pl.invoices.detail.line.unitPriceNet', 'Unit price (net)')}
                    </TableHead>
                    <TableHead className="text-right">
                      {t('financial_pl.invoices.detail.line.taxRate', 'VAT %')}
                    </TableHead>
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
                  {lines.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                        {t('financial_pl.invoices.detail.noLines', 'No line items.')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    lines.map((line, index) => (
                      <TableRow key={line.lineNumber ?? index}>
                        <TableCell>{line.name ?? '—'}</TableCell>
                        <TableCell className="text-right">{line.quantity ?? '—'}</TableCell>
                        <TableCell>{line.quantityUnit ?? '—'}</TableCell>
                        <TableCell className="text-right">
                          {formatAmount(line.unitPriceNet, line.currencyCode ?? currency)}
                        </TableCell>
                        <TableCell className="text-right">{line.taxRate ?? '—'}</TableCell>
                        <TableCell className="text-right">
                          {formatAmount(line.totalNetAmount, line.currencyCode ?? currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatAmount(line.taxAmount, line.currencyCode ?? currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatAmount(line.totalGrossAmount, line.currencyCode ?? currency)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </SectionCard>

          {/* PL-VAT meta summary (read-only) */}
          <SectionCard
            title={t('financial_pl.invoices.detail.plVatMeta', 'Polish VAT metadata')}
            description={t(
              'financial_pl.invoices.detail.plVatMetaHint',
              'Read-only summary of the Polish VAT layer attached to this invoice.',
            )}
          >
            {meta ? (
              <PlVatMetaForm value={toFormMeta(meta)} onChange={() => {}} disabled />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('financial_pl.invoices.detail.noPlVatMeta', 'No Polish VAT metadata recorded yet.')}
              </p>
            )}
          </SectionCard>

          {payment ? (
            <SectionCard title={t('financial_pl.invoices.detail.payment.title', 'Payment')}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryField label={t('financial_pl.invoices.detail.payment.method', 'Payment method')}>
                  {paymentMethodLabel}
                </SummaryField>
                <SummaryField label={t('financial_pl.invoices.detail.payment.term', 'Payment term / due date')}>
                  {paymentTermText}
                </SummaryField>
                <SummaryField label={t('financial_pl.invoices.detail.payment.bankAccount', 'Bank account')}>
                  <span className="flex flex-col gap-1">
                    <span>{payment.bankAccount ?? '—'}</span>
                    {payment.bankName ? <span className="text-muted-foreground">{payment.bankName}</span> : null}
                    {payment.swift ? (
                      <span className="text-muted-foreground">
                        {t('financial_pl.invoices.detail.payment.swift', 'SWIFT')}: {payment.swift}
                      </span>
                    ) : null}
                  </span>
                </SummaryField>
                {payment.paid ? (
                  <SummaryField label={t('financial_pl.invoices.detail.payment.paid', 'Paid')}>
                    <span className="flex flex-col items-start gap-1">
                      <StatusBadge variant={PAYMENT_PAID_STATUS_MAP.paid} dot>
                        {t('financial_pl.invoices.detail.payment.paidBadge', 'Paid')}
                      </StatusBadge>
                      {payment.paidDate ? (
                        <span className="text-muted-foreground">{formatDate(payment.paidDate)}</span>
                      ) : null}
                    </span>
                  </SummaryField>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          {hasInvoiceNote ? (
            <SectionCard title={t('financial_pl.invoices.detail.notes', 'Notes (Uwagi)')}>
              <p className="whitespace-pre-wrap text-sm text-foreground">{invoiceNote}</p>
            </SectionCard>
          ) : null}

          {/* Correction (KOR) — shown once accepted, gated client-side on sales.credit_memos.manage */}
          {isAccepted && canIssueCorrection ? (
            <SectionCard
              title={t('financial_pl.invoices.detail.correction', 'Issue correction (KOR)')}
              description={t(
                'financial_pl.invoices.detail.correctionHint',
                'Correct an accepted invoice by issuing a correction (KOR) credit memo to KSeF.',
              )}
            >
              <CorrectionForm
                invoiceId={invoice.id}
                originalInvoiceNumber={number}
                originalLines={correctionLines}
                currencyCode={currency}
                priceMode={invoice.metadata?.priceMode === 'gross' ? 'gross' : undefined}
                features={grantedFeatures}
                onSubmitted={refetch}
              />
            </SectionCard>
          ) : null}
        </div>
      </PageBody>
    </Page>
  )
}
