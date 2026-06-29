'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
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
import type { InvoiceMeta } from '../../../../../components/PlVatMetaForm'

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
  meta?: (InvoiceMeta & { updatedAt?: string | null }) | null
  submission?: { status?: string | null } | null
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
  const { updatedAt, ...meta } = data.meta ?? {}
  return {
    header: {
      invoiceNumber: toStr(data.invoice?.invoiceNumber),
      issueDate: toDateInput(data.invoice?.issueDate),
      dueDate: toDateInput(data.invoice?.dueDate),
      currencyCode,
      orderId: toStr(data.invoice?.orderId),
    },
    lines: lines.length ? lines : [],
    meta: meta as InvoiceMeta,
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
export default function EditInvoicePage() {
  const t = useT()
  const params = useParams<{ id: string }>()
  const invoiceId = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''
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
