"use client"

import * as React from 'react'
import Link from 'next/link'
import { Pencil, FileMinus2 } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
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
import { InvoiceDocumentPreview } from '../../../../components/InvoiceDocumentPreview'
import { useInvoiceSettings } from '../../../../components/useInvoiceSettings'
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

type SellerIdentity = {
  name: string | null
  addressLine1: string | null
  addressLine2: string | null
}

type InvoiceDetailResponse = {
  invoice: InvoiceDetail
  lines: InvoiceLineDetail[]
  meta: InvoiceMetaDetail | null
  submission: SubmissionDetail | null
  seller?: SellerIdentity | null
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

/**
 * Trim a stored decimal down to what a reader needs. Quantities and VAT rates come off the wire at
 * full scale (`1.0000`, `23.0000`); the trailing zeros carry no information and only make the
 * column harder to scan, so significant decimals are kept and the rest dropped.
 */
function formatDecimal(value: string | number | null | undefined, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(n)
}

/** VAT rate as a percentage — `23.0000` reads as `23%`. Non-numeric rates (e.g. `zw`) pass through. */
/**
 * A line's discount as text, or null when there is none. Both a percentage and an amount can be
 * present; zero-valued fields are treated as absent so an unused discount never prints "0".
 */
function lineDiscountText(line: InvoiceLineDetail): string | null {
  const percent = Number(line.discountPercent)
  const amount = Number(line.discountAmount)
  const parts: string[] = []
  if (Number.isFinite(percent) && percent > 0) {
    parts.push(`${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(percent)}%`)
  }
  if (Number.isFinite(amount) && amount > 0) {
    parts.push(formatAmount(line.discountAmount, line.currencyCode))
  }
  return parts.length ? parts.join(' / ') : null
}

type VatRateBucket = { rate: string; net: number; vat: number; gross: number }

/**
 * Group the lines by VAT rate and sum each bucket. Art. 106e ust. 1 pkt 12-14 requires an invoice
 * to state the net sale value and the tax amount PER RATE, not just one grand total — a single
 * "VAT 115,00 zł" line is not a lawful summary once more than one rate is in play.
 */
function summarizeVatByRate(lines: InvoiceLineDetail[]): VatRateBucket[] {
  const buckets = new Map<string, VatRateBucket>()
  for (const line of lines) {
    // Group on the raw rate so `zw`/`np` keep their own bucket instead of collapsing into 0%.
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

function formatTaxRate(value: string | number | null | undefined, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}%`
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
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  )
}

export default function FinancialPlInvoiceDetailPage(props: { params?: { id?: string } }) {
  const t = useT()
  // Logo + footer come from invoice settings, not from the invoice: they are how this seller's
  // documents look, and must match what the create preview showed.
  const invoiceSettings = useInvoiceSettings()
  // This app renders backend pages via a `/[...slug]` catch-all that passes the resolved route
  // segment as a synchronous `params` prop (mirrors core `sales/.../[id]/page.tsx`). `useParams()`
  // would return the raw slug array here, not `{ id }`, so read the prop directly.
  const invoiceId = typeof props.params?.id === 'string' ? props.params.id : ''
  const scopeVersion = useOrganizationScopeVersion()

  const [data, setData] = React.useState<InvoiceDetailResponse | null>(null)
  const [loadState, setLoadState] = React.useState<'loading' | 'loaded' | 'not_found' | 'error'>('loading')
  const [grantedFeatures, setGrantedFeatures] = React.useState<string[]>([])
  const [reloadToken, setReloadToken] = React.useState(0)
  // Issuing a correction is the exception, not the routine — the form opens on demand (see below).
  const [correctionOpen, setCorrectionOpen] = React.useState(false)

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

  const { invoice, lines, meta, submission, seller } = data
  const currency = invoice.currencyCode ?? ''
  const buyer = buyerFromMetadata(invoice.metadata)
  const hasBuyer = Boolean(buyer.companyName || buyer.nip || buyer.addressLine1)
  const invoiceNote = typeof invoice.metadata?.notes === 'string' ? invoice.metadata.notes : null
  const saleDate = typeof invoice.metadata?.saleDate === 'string' ? invoice.metadata.saleDate : null
  // Plain consts, not `useMemo`: this code runs after the loading/error early-returns, so a hook
  // here would be conditional and break the Rules of Hooks. The work is a single pass over lines.
  const vatByRate = summarizeVatByRate(lines)
  const isForeignCurrency = currency.trim().toUpperCase() !== '' && currency.trim().toUpperCase() !== 'PLN'
  // VAT restated in PLN at the invoice's own rate; null when either half is missing, so the
  // document shows "—" rather than a number computed from a guessed rate.
  const taxTotalPln = (() => {
    if (!isForeignCurrency) return null
    const tax = Number(invoice.taxTotalAmount)
    const rate = Number(meta?.exchangeRate)
    if (!Number.isFinite(tax) || !Number.isFinite(rate) || rate <= 0) return null
    return tax * rate
  })()
  // Statutory phrases that belong on the printed invoice whenever their flag is set.
  const legalAnnotations = (() => {
    const out: string[] = []
    if (meta?.mppRequired) out.push(t('financial_pl.invoices.detail.annotation.mpp', 'Split payment mechanism'))
    if (meta?.selfBilling) out.push(t('financial_pl.invoices.detail.annotation.selfBilling', 'Self-billing'))
    if (meta?.reverseCharge) {
      out.push(t('financial_pl.invoices.detail.annotation.reverseCharge', 'Reverse charge'))
    }
    if (meta?.vatExemptionBasis?.trim()) {
      out.push(
        `${t('financial_pl.fields.vatExemptionBasis', 'VAT exemption basis')}: ${meta.vatExemptionBasis.trim()}`,
      )
    }
    return out
  })()
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
  return (
    <Page>
      <PageBody>
        <div className="flex flex-col gap-4">
          {/* Header summary */}
          <section className="rounded-lg border bg-card p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              {/* Status sits under the number: the KSeF number it carries is long, and beside the
                  title it pushed the heading around as the status changed. */}
              <div className="flex flex-col items-start gap-2">
                <h1 className="text-xl font-semibold text-foreground">{number}</h1>
                <KsefStatusBadge
                  status={submission?.status ?? meta?.ksefStatus ?? null}
                  ksefNumber={submission?.ksefNumber ?? meta?.ksefNumber ?? null}
                  offlineSendDeadlineAt={submission?.offlineSendDeadlineAt ?? null}
                />
              </div>
              {/*
                Every action for this invoice lives here, at the top. Once KSeF has locked the
                document it is read-only by law — the only way to change it is a correction — so the
                Edit button is not rendered at all rather than shown disabled: a dead control invites
                the click it will refuse. The lock is stated in words under the title instead.
              */}
              <div className="flex flex-wrap items-center gap-2">
                {canManageInvoices && !editLocked ? (
                  <Button asChild variant="outline">
                    <Link href={`/backend/financial/invoices/${invoice.id}/edit`}>
                      <Pencil className="mr-1 size-4" />
                      {t('financial_pl.invoices.detail.edit', 'Edit')}
                    </Link>
                  </Button>
                ) : null}
                {isAccepted && canIssueCorrection ? (
                  <Button type="button" variant="outline" onClick={() => setCorrectionOpen(true)}>
                    <FileMinus2 className="mr-1 size-4" aria-hidden="true" />
                    {t('financial_pl.invoices.detail.correctionOpen', 'Issue correction')}
                  </Button>
                ) : null}
                <KsefActions
                  invoiceId={invoice.id}
                  submission={submissionSummary}
                  features={grantedFeatures}
                  onChanged={refetch}
                />
              </div>
            </div>

          </section>

          {/*
            Two-up below the header: the invoice itself on the left (what the document says), the
            Polish VAT metadata accordion on the right (how it is classified for KSeF/JPK). Stacks
            back to one column under `lg`, where side-by-side would squeeze both.
          */}
          <div className="grid items-start gap-4 lg:grid-cols-5">
            {/*
              Left: the invoice as a document — the layout the buyer receives (header, parties,
              items, totals, note, payment), so the operator checks the same artefact that leaves
              the system rather than a set of admin cards.
            */}
            <InvoiceDocumentPreview
              logoDataUrl={invoiceSettings?.logoDataUrl ?? null}
              footerNote={invoiceSettings?.footerNote ?? null}
              className="lg:col-span-3"
              seller={{ name: seller?.name ?? null, nip: meta?.contextNip ?? null, addressLine1: seller?.addressLine1 ?? null, addressLine2: seller?.addressLine2 ?? null }}
              buyer={{
                name: buyer.companyName ?? null,
                nip: buyer.nip ?? null,
                addressLine1: buyer.addressLine1 ?? null,
                addressLine2: buyer.addressLine2 ?? null,
                postalCode: buyer.postalCode ?? null,
                city: buyer.city ?? null,
                countryCode: buyer.countryCode ?? null,
              }}
              issueDate={invoice.issueDate}
              saleDate={saleDate}
              dueDate={invoice.dueDate}
              currency={currency}
              lines={lines}
              totalNet={invoice.grandTotalNetAmount}
              taxTotal={invoice.taxTotalAmount}
              totalGross={invoice.grandTotalGrossAmount}
              exchangeRate={meta?.exchangeRate ?? null}
              exchangeRateDate={meta?.exchangeRateDate ?? null}
              annotations={legalAnnotations}
              note={invoiceNote}
              payment={payment ? { methodLabel: paymentMethodLabel, bankAccount: payment.bankAccount ?? null, bankName: payment.bankName ?? null, swift: payment.swift ?? null, paid: payment.paid, paidDate: payment.paidDate ?? null } : null}
            />


            {/* PL-VAT meta summary (read-only) — the accordion column */}
            <div className="flex flex-col gap-4 lg:col-span-2">
              <SectionCard title={t('financial_pl.invoices.detail.plVatMeta', 'Polish VAT metadata')}>
                {/* `currencyCode` gates the FX section — without it the form assumed a foreign
                    currency and showed an exchange-rate block on every PLN invoice. */}
                {meta ? (
                  <PlVatMetaForm
                    value={toFormMeta(meta)}
                    onChange={() => {}}
                    disabled
                    hideContextNip
                    currencyCode={currency}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('financial_pl.invoices.detail.noPlVatMeta', 'No Polish VAT metadata recorded yet.')}
                  </p>
                )}
              </SectionCard>
            </div>
          </div>
        </div>
      </PageBody>

      {/* Correction form — on demand, so the detail page stays a read surface by default. */}
      <Dialog open={correctionOpen} onOpenChange={setCorrectionOpen}>
        {/*
            `p-0` + `overflow-hidden` + `gap-0`: the DS DialogContent is itself the scroller, which
            made the body scroll UNDERNEATH the header and footer. Here the dialog no longer
            scrolls — the form's body owns the scrollbar between a fixed header and footer, so each
            band keeps its own padding and the rule sits at the true edge of the scroll area.
          */}
          <DialogContent size="xl" className="gap-0 overflow-hidden p-0 [&>button]:z-20">
          {/*
            `DialogContent` is itself the scroll container (max-h-90vh + overflow-y-auto), so the
            title and the action bar scrolled away on this tall form. Pinning them inside that
            container keeps "which invoice" and the Issue/Cancel buttons on screen while the lines
            scroll. `-m*`/`p*` re-create the content padding so the sticky bands cover it.
          */}
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4 pr-14">
            {/* The number is in the title: the modal covers the page, so without it nothing on
                screen says WHICH invoice is being corrected. */}
            <DialogTitle>
              {t('financial_pl.invoices.detail.correction', 'Issue correction (KOR)')} — {number}
            </DialogTitle>
          </DialogHeader>
          <CorrectionForm
            invoiceId={invoice.id}
            originalLines={correctionLines}
            currencyCode={currency}
            priceMode={invoice.metadata?.priceMode === 'gross' ? 'gross' : undefined}
            features={grantedFeatures}
            onSubmitted={() => {
              setCorrectionOpen(false)
              refetch()
            }}
            onCancel={() => setCorrectionOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </Page>
  )
}
