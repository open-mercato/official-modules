'use client'

import * as React from 'react'
import Link from 'next/link'
import { SearchX } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { InvoiceForm, IssueCorrectionLink, type InvoiceFormValue } from './InvoiceForm'
import { withComputedTotals, type InvoiceLineInput } from '../../../../../components/InvoiceLinesField'
import { buyerFromMetadata } from '../../../../../components/BuyerFields'
import type { InvoiceMeta, ProcedureMarkings } from '../../../../../components/PlVatMetaForm'
import type { InvoiceKindColumn } from '../../../../../data/entities'
import type { GtuCode, JpkProcedureMarking, JpkTypDokumentu } from '../../../../../lib/jpk-markings-codes'

const DEFAULT_CURRENCY = 'PLN'

// KSeF statuses that make an invoice immutable (corrections only). Editing/saving is locked when
// the latest submission is accepted (legally on file) or processing (in flight).
const LOCKED_KSEF_STATUSES = new Set(['accepted', 'processing'])

/** Wire shape of GET /api/financial_pl/ksef/invoices/<id> ({ invoice, lines, meta, submission }). */
type InvoiceDetailResponse = {
  invoice?: {
    id?: string | null
    invoiceNumber?: string | null
    issueDate?: string | null
    dueDate?: string | null
    currencyCode?: string | null
    orderId?: string | null
    metadata?: Record<string, unknown> | null
  } | null
  lines?: Array<{
    name?: string | null
    quantity?: string | number | null
    quantityUnit?: string | null
    unitPriceNet?: string | number | null
    taxRate?: string | number | null
    totalNetAmount?: string | number | null
    taxAmount?: string | number | null
    totalGrossAmount?: string | number | null
    currencyCode?: string | null
    lineNumber?: number | null
    kind?: string | null
  }> | null
  meta?: (InvoiceMetaWire & { updatedAt?: string | null }) | null
  submission?: { status?: string | null } | null
}

/**
 * Flat wire shape of `meta` from GET /api/financial_pl/ksef/invoices/<id>: JPK procedure markings
 * are individual booleans (not a nested map), `docType` (not `typDokumentu`), and `orderSnapshot`
 * carried directly. Must be projected onto the form's `InvoiceMeta` before rendering.
 */
type InvoiceMetaWire = {
  contextNip?: string | null
  mppRequired?: boolean
  issuedOutsideKsef?: boolean
  vatExemptionBasis?: string | null
  invoiceKind?: string | null
  selfBilling?: boolean
  reverseCharge?: boolean
  ossProcedure?: boolean
  consumptionCountryCode?: string | null
  exchangeRate?: string | null
  exchangeRateDate?: string | null
  advancePayments?: InvoiceMeta['advancePayments']
  advanceRefs?: InvoiceMeta['advanceRefs']
  orderSnapshot?: InvoiceMeta['orderSnapshot']
  gtuCodes?: string[]
  wstoEe?: boolean
  ied?: boolean
  tp?: boolean
  ttWnt?: boolean
  ttD?: boolean
  mrT?: boolean
  mrUz?: boolean
  i42?: boolean
  i63?: boolean
  bSpv?: boolean
  bSpvDostawa?: boolean
  bMpvProwizja?: boolean
  docType?: string | null
  badDebtReliefPeriod?: string | null
  badDebtTerminPlatnosci?: string | null
}

// Maps the wire's flat JPK procedure flags onto the form's procedure-markings map. Mirrors the
// detail page's PROCEDURE_FLAG_MAP so edit + read views project the same shape.
const PROCEDURE_FLAG_MAP: ReadonlyArray<[keyof InvoiceMetaWire, JpkProcedureMarking]> = [
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

/** Project the flat wire meta into the controlled `InvoiceMeta` the PlVatMetaForm edits. */
function toFormMeta(meta: InvoiceMetaWire): InvoiceMeta {
  const procedureMarkings: ProcedureMarkings = {}
  for (const [flag, code] of PROCEDURE_FLAG_MAP) {
    if (meta[flag] === true) procedureMarkings[code] = true
  }
  return {
    contextNip: meta.contextNip ?? null,
    mppRequired: meta.mppRequired,
    issuedOutsideKsef: meta.issuedOutsideKsef,
    vatExemptionBasis: meta.vatExemptionBasis ?? null,
    invoiceKind:
      meta.invoiceKind && INVOICE_KINDS.has(meta.invoiceKind) ? (meta.invoiceKind as InvoiceKindColumn) : undefined,
    selfBilling: meta.selfBilling,
    reverseCharge: meta.reverseCharge,
    ossProcedure: meta.ossProcedure,
    consumptionCountryCode: meta.consumptionCountryCode ?? null,
    exchangeRate: meta.exchangeRate ?? null,
    exchangeRateDate: meta.exchangeRateDate ?? null,
    advancePayments: meta.advancePayments,
    advanceRefs: meta.advanceRefs,
    orderSnapshot: meta.orderSnapshot ?? null,
    gtuCodes: (meta.gtuCodes ?? []) as GtuCode[],
    procedureMarkings,
    typDokumentu: meta.docType && TYP_DOKUMENTU.has(meta.docType) ? (meta.docType as JpkTypDokumentu) : null,
    badDebtReliefPeriod: meta.badDebtReliefPeriod ?? null,
    badDebtTerminPlatnosci: meta.badDebtTerminPlatnosci ?? null,
  }
}

function toStr(value: string | number | null | undefined, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function toDateInput(value: string | null | undefined): string {
  if (!value) return ''
  // Accept both ISO timestamps and plain YYYY-MM-DD; CrudForm date fields want YYYY-MM-DD.
  return value.length >= 10 ? value.slice(0, 10) : value
}

const ALLOWED_LINE_KINDS = new Set(['product', 'service', 'shipping', 'discount', 'adjustment'])

function toLineKind(value: string | null | undefined): InvoiceLineInput['kind'] {
  return value && ALLOWED_LINE_KINDS.has(value) ? (value as InvoiceLineInput['kind']) : 'product'
}

/** Map the detail response into the controlled InvoiceForm value (header + lines + meta). */
function mapResponseToFormValue(data: InvoiceDetailResponse): InvoiceFormValue {
  const currencyCode = toStr(data.invoice?.currencyCode, DEFAULT_CURRENCY) || DEFAULT_CURRENCY
  const lines: InvoiceLineInput[] = (data.lines ?? []).map((line, index) =>
    withComputedTotals(
      {
        name: toStr(line.name),
        quantity: toStr(line.quantity, '1'),
        quantityUnit: line.quantityUnit ?? '',
        unitPriceNet: toStr(line.unitPriceNet, '0'),
        taxRate: line.taxRate != null ? toStr(line.taxRate) : '',
        currencyCode,
        kind: toLineKind(line.kind),
      },
      currencyCode,
      index + 1,
    ),
  )
  const { updatedAt, ...wireMeta } = data.meta ?? {}
  return {
    header: {
      invoiceNumber: toStr(data.invoice?.invoiceNumber),
      issueDate: toDateInput(data.invoice?.issueDate),
      dueDate: toDateInput(data.invoice?.dueDate),
      currencyCode,
      orderId: toStr(data.invoice?.orderId),
    },
    buyer: buyerFromMetadata(data.invoice?.metadata),
    lines: lines.length ? lines : [],
    meta: data.meta ? toFormMeta(wireMeta) : {},
    metadata: data.invoice?.metadata ?? null,
    metaUpdatedAt: updatedAt ?? null,
  }
}

/**
 * Edit-invoice page (SPEC-013). Prefills from GET /api/financial_pl/ksef/invoices/<id> (header via
 * core, lines via the QueryEngine, plus PL-VAT meta + the latest KSeF submission), then renders the
 * shared {@link InvoiceForm} in edit mode.
 *
 * If the latest KSeF submission is `accepted` or `processing` the invoice is immutable: the form is
 * rendered READ-ONLY with a lock Alert and an "Issue a correction" link to the detail page. The
 * server-side interceptor enforces the same rule regardless of this UI guard.
 */
export default function EditInvoicePage(props: { params?: { id?: string } }) {
  const t = useT()
  // Backend pages are served by the app's `/[...slug]` catch-all, which passes the resolved route
  // segment as a synchronous `params` prop (mirrors core `sales/.../[id]/page.tsx`). `useParams()`
  // returns the raw slug array here, not `{ id }`, so read the prop directly.
  const invoiceId = typeof props.params?.id === 'string' ? props.params.id : ''
  const scopeVersion = useOrganizationScopeVersion()

  const [status, setStatus] = React.useState<'loading' | 'ready' | 'notFound' | 'error'>('loading')
  const [formValue, setFormValue] = React.useState<InvoiceFormValue | null>(null)
  const [ksefStatus, setKsefStatus] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!invoiceId) {
      setStatus('notFound')
      return
    }
    let cancelled = false
    setStatus('loading')
    void (async () => {
      try {
        const call = await apiCall<InvoiceDetailResponse>(
          `/api/financial_pl/ksef/invoices/${encodeURIComponent(invoiceId)}`,
        )
        if (cancelled) return
        if (call.status === 404 || (call.ok && !call.result?.invoice)) {
          setStatus('notFound')
          return
        }
        if (!call.ok || !call.result) {
          setStatus('error')
          return
        }
        setFormValue(mapResponseToFormValue(call.result))
        setKsefStatus(call.result.submission?.status ?? null)
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        console.error('[internal] financial_pl.invoices.edit load failed', err)
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [invoiceId, scopeVersion])

  const locked = ksefStatus != null && LOCKED_KSEF_STATUSES.has(ksefStatus)

  const lockNotice = locked ? (
    <Alert status="warning" style="light">
      <AlertTitle>{t('financial_pl.invoices.edit.lockedKsefTitle', 'Invoice locked by KSeF')}</AlertTitle>
      <AlertDescription>
        {t(
          'financial_pl.invoice.lockedKsef',
          'This invoice has an accepted or in-progress KSeF submission and cannot be edited. Issue a correction (KOR) instead.',
        )}
      </AlertDescription>
      <div className="mt-2">
        <IssueCorrectionLink
          invoiceId={invoiceId}
          label={t('financial_pl.invoices.edit.issueCorrection', 'Issue a correction')}
        />
      </div>
    </Alert>
  ) : null

  return (
    <Page>
      <PageBody>
        {status === 'loading' ? (
          <LoadingMessage label={t('financial_pl.invoices.edit.loading', 'Loading invoice…')} />
        ) : status === 'notFound' ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center px-4">
            <EmptyState
              variant="subtle"
              icon={<SearchX className="h-6 w-6" aria-hidden />}
              title={t('financial_pl.invoices.edit.notFound', 'Invoice not found.')}
              actions={
                <Button asChild variant="outline" size="sm">
                  <Link href="/backend/financial/invoices">
                    {t('financial_pl.invoices.edit.backToList', 'Back to invoices')}
                  </Link>
                </Button>
              }
            />
          </div>
        ) : status === 'error' ? (
          <ErrorMessage label={t('financial_pl.invoices.edit.loadError', 'Failed to load the invoice.')} />
        ) : formValue ? (
          <InvoiceForm
            invoiceId={invoiceId}
            initialValue={formValue}
            readOnly={locked}
            lockNotice={lockNotice}
          />
        ) : null}
      </PageBody>
    </Page>
  )
}
