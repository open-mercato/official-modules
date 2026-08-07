"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ChevronLeft,
  ChevronRight,
  Send,
  Eye,
  Pencil,
  Printer,
  Mail,
  Plus,
  CalendarDays,
  FileText,
  Coins,
  Wallet,
  AlertTriangle,
  RefreshCw,
  Loader2,
} from 'lucide-react'
import { cn } from '@open-mercato/shared/lib/utils'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable, type BulkAction } from '@open-mercato/ui/backend/DataTable'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { InvoiceRowActions } from '../../../components/InvoiceRowActions'
import { InvoiceScopeTabs } from '../../../components/InvoiceScopeTabs'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { KsefStatusBadge } from '../../../components/KsefStatusBadge'
import { InvoiceStatCard } from '../../../components/InvoiceStatCard'
import { InvoiceEmailDialog, type InvoiceEmailTarget } from '../../../components/InvoiceEmailDialog'
import { canIssueInvoiceToKsef } from '../../../lib/invoice-status'

type InvoiceListItem = {
  id: string
  invoiceNumber?: string | null
  issueDate?: string | null
  dueDate?: string | null
  currencyCode?: string | null
  grandTotalNetAmount?: string | number | null
  grandTotalGrossAmount?: string | number | null
  status?: string | null
  buyerName?: string | null
  buyerNip?: string | null
  ksefStatus?: string | null
  ksefNumber?: string | null
  upoAvailable?: boolean | null
  offlineSendDeadlineAt?: string | null
  invoiceKind?: string | null
}

type InvoiceListSummary = {
  count: number
  totalNet: string
  totalGross: string
  dueTotal: string
  rejectedCount: number
  capped: boolean
}

type InvoiceListResponse = {
  items?: InvoiceListItem[]
  total?: number
  page?: number
  pageSize?: number
  summary?: InvoiceListSummary
}

type BatchSendResponse = {
  ok?: boolean
  progressJobId?: string | null
  count?: number
  message?: string | null
}

type InvoiceRow = {
  id: string
  invoiceNumber: string
  status: string | null
  issueDate: string | null
  dueDate: string | null
  currencyCode: string | null
  grandTotalNetAmount: number | null
  grandTotalGrossAmount: number | null
  buyerName: string | null
  buyerNip: string | null
  ksefStatus: string | null
  ksefNumber: string | null
  offlineSendDeadlineAt: string | null
}

type PeriodMode = 'month' | 'all'

type MonthPeriod = {
  year: number
  month: number
}

const PAGE_SIZE = 50

const DEFAULT_CURRENCY = 'PLN'

// Maps a sortable list column id to the sales-invoice field the API sorts by. KSeF status is
// derived from KsefSubmission (not a sales_invoice column), so it is intentionally absent here.
const SORT_FIELD_BY_COLUMN: Record<string, string> = {
  invoiceNumber: 'invoice_number',
  issueDate: 'issue_date',
  dueDate: 'due_date',
  grandTotalNetAmount: 'grand_total_net_amount',
  grandTotalGrossAmount: 'grand_total_gross_amount',
}

const DEFAULT_SORTING: SortingState = [{ id: 'issueDate', desc: true }]

const KSEF_STATUS_FILTER_KEYS = [
  'accepted',
  'offline_issued',
  'ready',
  'queued',
  'processing',
  'rejected',
  'not_applicable',
] as const

const ksefStatusFilterLabelKey: Record<(typeof KSEF_STATUS_FILTER_KEYS)[number], string> = {
  accepted: 'financial_pl.status.accepted',
  offline_issued: 'financial_pl.status.offline_issued',
  ready: 'financial_pl.status.ready',
  queued: 'financial_pl.status.queued',
  processing: 'financial_pl.status.processing',
  rejected: 'financial_pl.status.rejected',
  not_applicable: 'financial_pl.status.not_applicable',
}

const ksefStatusFilterLabelFallback: Record<(typeof KSEF_STATUS_FILTER_KEYS)[number], string> = {
  accepted: 'Accepted',
  offline_issued: 'Issued offline',
  ready: 'Ready',
  queued: 'Queued',
  processing: 'Processing',
  rejected: 'Rejected',
  not_applicable: 'Not applicable',
}

const BATCH_INELIGIBLE_KSEF_STATUSES = new Set(['accepted', 'processing', 'queued', 'offline_issued'])

// FA(3) invoice kinds (rodzaj faktury), mirroring InvoiceKindColumn; labels via `financial_pl.invoiceKind.*`.
const INVOICE_KIND_FILTER_KEYS = ['vat', 'zal', 'roz', 'upr', 'kor_zal', 'kor_roz'] as const

// Document lifecycle states offered as a filter (matched against the sales_invoice `status` column).
const DOCUMENT_STATUS_FILTER_KEYS = ['draft', 'issued'] as const

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function formatDate(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // Explicit locale AND timezone: SSR renders with the server locale/TZ, so runtime defaults
  // hydration-mismatch against a pl browser (and a west-of-UTC runtime shifts a date-only
  // ISO string, parsed as UTC midnight, back a day). The module is PL-specific — pin both.
  return d.toLocaleDateString('pl-PL', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
}

function formatCurrency(
  amount: number | null | undefined,
  currency: string | null | undefined,
  fallback = '—',
): string {
  if (amount == null || Number.isNaN(amount)) return fallback
  try {
    if (currency && currency.trim().length) {
      return new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).format(amount)
    }
    return new Intl.NumberFormat('pl-PL', { style: 'decimal', maximumFractionDigits: 2 }).format(amount)
  } catch {
    return String(amount)
  }
}

function currentMonthPeriod(): MonthPeriod {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() }
}

function addMonths(period: MonthPeriod, delta: number): MonthPeriod {
  const date = new Date(Date.UTC(period.year, period.month + delta, 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() }
}

function firstDayOfMonth(period: MonthPeriod): string {
  return new Date(Date.UTC(period.year, period.month, 1)).toISOString().slice(0, 10)
}

function lastDayOfMonth(period: MonthPeriod): string {
  return new Date(Date.UTC(period.year, period.month + 1, 0)).toISOString().slice(0, 10)
}

function formatMonthLabel(period: MonthPeriod): string {
  return new Date(Date.UTC(period.year, period.month, 1)).toLocaleDateString('pl-PL', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function isInvoiceEligibleForKsefBatch(row: InvoiceRow): boolean {
  // Match the single-invoice issuance rule: an explicit KSeF action may issue a blank/draft/
  // pending core invoice, while terminal canceled/void states remain blocked.
  if (!canIssueInvoiceToKsef(row.status)) return false
  const ksefStatus = row.ksefStatus?.trim().toLowerCase()
  return !ksefStatus || !BATCH_INELIGIBLE_KSEF_STATUSES.has(ksefStatus)
}

export default function FinancialPlInvoicesPage() {
  const t = useT()
  const router = useRouter()
  const scopeVersion = useOrganizationScopeVersion()
  const [rows, setRows] = React.useState<InvoiceRow[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [search, setSearch] = React.useState('')
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [sorting, setSorting] = React.useState<SortingState>(DEFAULT_SORTING)
  const [emailTarget, setEmailTarget] = React.useState<InvoiceEmailTarget | null>(null)
  const [selectedPeriod, setSelectedPeriod] = React.useState<MonthPeriod>(() => currentMonthPeriod())
  const [periodMode, setPeriodMode] = React.useState<PeriodMode>('month')
  const [summary, setSummary] = React.useState<InvoiceListSummary | null>(null)
  const [isLoading, setLoading] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.invoices',
  })
  const { confirm, ConfirmDialogElement } = useConfirmDialog()

  const title = t('financial_pl.nav.invoices', 'Invoices')

  const statusFilterOptions = React.useMemo(
    () =>
      KSEF_STATUS_FILTER_KEYS.map((key) => ({
        value: key,
        label: t(ksefStatusFilterLabelKey[key], ksefStatusFilterLabelFallback[key]),
      })),
    [t],
  )
  const kindFilterOptions = React.useMemo(
    () =>
      INVOICE_KIND_FILTER_KEYS.map((key) => ({
        value: key,
        label: t(`financial_pl.invoiceKind.${key}`, key.toUpperCase()),
      })),
    [t],
  )
  const documentStatusFilterOptions = React.useMemo(
    () =>
      DOCUMENT_STATUS_FILTER_KEYS.map((key) => ({
        value: key,
        label: t(`financial_pl.invoices.list.filters.docStatus.${key}`, key),
      })),
    [t],
  )

  const readFilterValue = (field: string): string => {
    const value = filterValues[field]
    return typeof value === 'string' && value ? value : 'all'
  }

  const handleFilterChange = React.useCallback((field: string, value: string) => {
    setFilterValues((prev) => ({ ...prev, [field]: value === 'all' ? undefined : value }))
    setPage(1)
  }, [])

  // Shared with the invoice-filters injection widget mounted into the DataTable's `:search-trailing`
  // spot — the widget renders the inline <Select>s (at search-field height) and drives this page's
  // filter state through these callbacks, so the DS DataTable keeps its native search + bulk-action bar.
  const invoiceFiltersInjectionContext = React.useMemo(
    () => ({
      invoiceFilters: [
        {
          id: 'status',
          label: t('financial_pl.invoices.list.filters.ksefStatus', 'KSeF status'),
          allLabel: t('financial_pl.invoices.list.filters.allStatuses', 'All statuses'),
          value: readFilterValue('status'),
          options: statusFilterOptions,
          onChange: (value: string) => handleFilterChange('status', value),
        },
        {
          id: 'kind',
          label: t('financial_pl.fields.invoiceKind', 'Invoice kind'),
          allLabel: t('financial_pl.invoices.list.filters.allKinds', 'All kinds'),
          value: readFilterValue('kind'),
          options: kindFilterOptions,
          onChange: (value: string) => handleFilterChange('kind', value),
        },
        {
          id: 'documentStatus',
          label: t('financial_pl.invoices.list.filters.documentStatus', 'Document status'),
          allLabel: t('financial_pl.invoices.list.filters.allDocStatuses', 'All'),
          value: readFilterValue('documentStatus'),
          options: documentStatusFilterOptions,
          onChange: (value: string) => handleFilterChange('documentStatus', value),
        },
      ],
    }),
    [statusFilterOptions, kindFilterOptions, documentStatusFilterOptions, handleFilterChange, filterValues, t],
  )

  const queryParams = React.useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(PAGE_SIZE))
    if (search.trim()) params.set('search', search.trim())
    const status = typeof filterValues.status === 'string' ? filterValues.status.trim() : ''
    if (status) params.set('status', status)
    const kind = typeof filterValues.kind === 'string' ? filterValues.kind.trim() : ''
    if (kind) params.set('kind', kind)
    const documentStatus =
      typeof filterValues.documentStatus === 'string' ? filterValues.documentStatus.trim() : ''
    if (documentStatus) params.set('documentStatus', documentStatus)
    if (periodMode === 'month') {
      params.set('issueDateFrom', firstDayOfMonth(selectedPeriod))
      params.set('issueDateTo', lastDayOfMonth(selectedPeriod))
    }
    const activeSort = sorting[0]
    const sortField = activeSort ? SORT_FIELD_BY_COLUMN[activeSort.id] : undefined
    if (sortField) {
      params.set('sortField', sortField)
      params.set('sortDir', activeSort.desc ? 'desc' : 'asc')
    }
    return params.toString()
  }, [filterValues, page, periodMode, search, selectedPeriod, sorting])

  const mapInvoice = React.useCallback((item: InvoiceListItem): InvoiceRow => {
    const id = typeof item.id === 'string' ? item.id : ''
    return {
      id,
      invoiceNumber: item.invoiceNumber ?? id,
      status: item.status ?? null,
      issueDate: item.issueDate ?? null,
      dueDate: item.dueDate ?? null,
      currencyCode: item.currencyCode ?? null,
      grandTotalNetAmount: toNumber(item.grandTotalNetAmount),
      grandTotalGrossAmount: toNumber(item.grandTotalGrossAmount),
      buyerName: item.buyerName ?? null,
      buyerNip: item.buyerNip ?? null,
      ksefStatus: item.ksefStatus ?? null,
      ksefNumber: item.ksefNumber ?? null,
      offlineSendDeadlineAt: item.offlineSendDeadlineAt ?? null,
    }
  }, [])

  const loadInvoices = React.useCallback(async () => {
    setLoading(true)
    try {
      const call = await apiCall<InvoiceListResponse>(`/api/financial_pl/ksef/invoices?${queryParams}`)
      if (!call.ok) {
        flash(t('financial_pl.invoices.list.errors.load', 'Failed to load invoices.'), 'error')
        setRows([])
        setTotal(0)
        setSummary(null)
        return
      }
      const payload = call.result ?? {}
      const items = Array.isArray(payload.items) ? payload.items : []
      setRows(items.map((item) => mapInvoice(item)))
      setTotal(typeof payload.total === 'number' ? payload.total : items.length)
      setSummary(payload.summary ?? null)
    } catch (err) {
      console.error('financial_pl.invoices.list', err)
      flash(t('financial_pl.invoices.list.errors.load', 'Failed to load invoices.'), 'error')
      setRows([])
      setTotal(0)
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [mapInvoice, queryParams, t])

  React.useEffect(() => {
    void loadInvoices()
  }, [loadInvoices, reloadToken, scopeVersion])

  const handleSearchChange = React.useCallback((value: string) => {
    setSearch(value)
    setPage(1)
  }, [])

  const handleSortingChange = React.useCallback((next: SortingState) => {
    setSorting(next.length ? next : DEFAULT_SORTING)
    setPage(1)
  }, [])

  const handlePreviousMonth = React.useCallback(() => {
    setSelectedPeriod((period) => addMonths(period, -1))
    setPeriodMode('month')
    setPage(1)
  }, [])

  const handleNextMonth = React.useCallback(() => {
    setSelectedPeriod((period) => addMonths(period, 1))
    setPeriodMode('month')
    setPage(1)
  }, [])

  const handleThisMonth = React.useCallback(() => {
    setSelectedPeriod(currentMonthPeriod())
    setPeriodMode('month')
    setPage(1)
  }, [])


  const handleRefresh = React.useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  // Single-invoice "Send to KSeF" from the row menu — arm-then-confirm (irreversible legal filing),
  // then POST the same from-invoice submission the detail page uses, guarded via runMutation.
  const handleSendToKsef = React.useCallback(
    async (row: InvoiceRow) => {
      const ok = await confirm({
        title: t('financial_pl.actions.sendToKsef', 'Send to KSeF'),
        text: t(
          'financial_pl.actions.sendToKsefConfirmDialog',
          'Sending to KSeF is an irreversible legal filing. Send this invoice now?',
        ),
        confirmText: t('financial_pl.actions.sendToKsef', 'Send to KSeF'),
        variant: 'destructive',
      })
      if (!ok) return
      try {
        await runMutation({
          operation: async () => {
            const response = await apiCall<{ ok?: boolean; error?: string; message?: string }>(
              '/api/financial_pl/ksef/submissions/from-invoice',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ salesInvoiceId: row.id }),
              },
            )
            if (!response.ok || response.result?.ok !== true) {
              throw new Error(response.result?.error || 'send-to-ksef failed')
            }
            return response
          },
          context: { retryLastMutation },
          mutationPayload: { salesInvoiceId: row.id },
        })
        flash(t('financial_pl.actions.sendToKsefQueued', 'Invoice queued for KSeF submission.'), 'success')
        handleRefresh()
      } catch (err) {
        // The from-invoice route returns a human-readable `error` (e.g. missing buyer); surface it so
        // the operator knows what to fix, falling back to a generic message otherwise.
        const message = err instanceof Error && err.message && err.message !== 'send-to-ksef failed' ? err.message : null
        flash(message ?? t('financial_pl.errors.actionFailed', 'The action failed.'), 'error')
      }
    },
    [confirm, runMutation, retryLastMutation, handleRefresh, t],
  )

  const handleRowClick = React.useCallback(
    (row: InvoiceRow) => {
      router.push(`/backend/financial/invoices/${row.id}`)
    },
    [router],
  )

  const bulkActions = React.useMemo<BulkAction<InvoiceRow>[]>(
    () => [
      {
        id: 'financial-pl-batch-send-ksef',
        label: t('financial_pl.invoices.list.batchSend', 'Send selected to KSeF'),
        icon: Send,
        onExecute: async (selectedRows) => {
          const eligibleRows = selectedRows.filter(isInvoiceEligibleForKsefBatch)
          const invoiceIds = eligibleRows.map((row) => row.id).filter((id) => id.trim().length > 0)
          const skippedCount = selectedRows.length - invoiceIds.length

          if (invoiceIds.length === 0) {
            flash(
              t('financial_pl.invoices.list.batchNoneEligible', 'No selected invoices are eligible to send.'),
              'warning',
            )
            return false
          }

          try {
            const call = await runMutation({
              operation: async () => {
                const response = await apiCall<BatchSendResponse>('/api/financial_pl/ksef/submissions/batch', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ invoiceIds }),
                })
                if (!response.ok || response.result?.ok !== true || !response.result?.progressJobId) {
                  throw new Error(t('financial_pl.invoices.list.batchFailed', 'Batch send failed.'))
                }
                return response
              },
              context: { retryLastMutation },
              mutationPayload: { invoiceIds },
            })
            const count = typeof call.result?.count === 'number' ? call.result.count : invoiceIds.length
            if (skippedCount > 0) {
              flash(
                t(
                  'financial_pl.invoices.list.batchSkipped',
                  '{count} selected invoice(s) were skipped because they are not eligible.',
                  { count: skippedCount },
                ),
                'info',
              )
            }
            flash(
              t(
                'financial_pl.invoices.list.batchQueued',
                '{count} invoice(s) queued to KSeF.',
                { count },
              ),
              'success',
            )
            handleRefresh()
            return true
          } catch {
            flash(t('financial_pl.invoices.list.batchFailed', 'Batch send failed.'), 'error')
            return false
          }
        },
      },
    ],
    [handleRefresh, retryLastMutation, runMutation, t],
  )

  const columns = React.useMemo<ColumnDef<InvoiceRow>[]>(
    () => [
      {
        id: 'invoiceNumber',
        accessorKey: 'invoiceNumber',
        header: t('financial_pl.invoices.list.table.number', 'Number'),
        cell: ({ row }) => <span className="font-semibold">{row.original.invoiceNumber}</span>,
      },
      {
        id: 'buyerName',
        accessorKey: 'buyerName',
        header: t('financial_pl.invoices.list.table.buyer', 'Counterparty'),
        enableSorting: false,
        meta: { maxWidth: '120px' },
        cell: ({ row }) =>
          row.original.buyerName || row.original.buyerNip ? (
            <div className="flex flex-col">
              <span className="truncate">{row.original.buyerName ?? '—'}</span>
              {row.original.buyerNip ? (
                <span className="font-mono text-xs text-muted-foreground">{row.original.buyerNip}</span>
              ) : null}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'issueDate',
        accessorKey: 'issueDate',
        header: t('financial_pl.invoices.list.table.issueDate', 'Issue date'),
        cell: ({ row }) => (
          <span className="text-sm tabular-nums text-muted-foreground">{formatDate(row.original.issueDate)}</span>
        ),
      },
      {
        id: 'dueDate',
        accessorKey: 'dueDate',
        header: t('financial_pl.invoices.list.table.dueDate', 'Due date'),
        cell: ({ row }) => (
          <span className="text-sm tabular-nums text-muted-foreground">{formatDate(row.original.dueDate)}</span>
        ),
      },
      {
        id: 'grandTotalNetAmount',
        accessorKey: 'grandTotalNetAmount',
        header: t('financial_pl.invoices.list.table.net', 'Net'),
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {formatCurrency(row.original.grandTotalNetAmount, row.original.currencyCode)}
          </span>
        ),
      },
      {
        id: 'grandTotalGrossAmount',
        accessorKey: 'grandTotalGrossAmount',
        header: t('financial_pl.invoices.list.table.gross', 'Gross'),
        cell: ({ row }) => (
          <span className="text-sm font-medium tabular-nums text-foreground">
            {formatCurrency(row.original.grandTotalGrossAmount, row.original.currencyCode)}
          </span>
        ),
      },
      {
        id: 'ksefStatus',
        accessorKey: 'ksefStatus',
        header: t('financial_pl.invoices.list.table.ksefStatus', 'KSeF status'),
        enableSorting: false,
        meta: { truncate: false },
        cell: ({ row }) => (
          <KsefStatusBadge
            status={row.original.ksefStatus}
            ksefNumber={row.original.ksefNumber}
            offlineSendDeadlineAt={row.original.offlineSendDeadlineAt}
            showKsefNumber={false}
          />
        ),
      },
    ],
    [t],
  )

  const monthLabel = React.useMemo(
    () => formatMonthLabel(selectedPeriod),
    [selectedPeriod],
  )
  const formatSummaryAmount = React.useCallback(
    (value: number) => formatCurrency(value, DEFAULT_CURRENCY, '—'),
    [],
  )
  const formatSummaryCount = React.useCallback(
    (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 }),
    [],
  )

  return (
    <Page>
      <PageBody>
        {/*
          The DataTable's title/actions/refresh all moved to the page header above, leaving an empty
          header band (title placeholder + the redundant "Customize columns" … icon) with a divider.
          The DS still renders that band (it's gated off the toolbar injection spot, no prop to drop
          it), so hide the empty content row + its divider — the search/filter toolbar (a sibling) and
          the row-action kebabs (inside the table) are untouched. Scoped to this table's handle.
        */}
        <style>{`[data-component-handle="data-table:financial_pl.invoices"] > div:first-child > div:first-child{display:none!important}[data-component-handle="data-table:financial_pl.invoices"] > div:first-child > div:nth-child(2){margin-top:0!important;padding-top:0!important;border-top:0!important}`}</style>
        {/* Page header — title, subtitle, primary CTA */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={handleRefresh} disabled={isLoading}>
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
              {t('financial_pl.invoices.list.syncKsef', 'Sync KSeF')}
            </Button>
            <Button asChild>
              <Link href="/backend/financial/invoices/create">
                <Plus className="size-4" aria-hidden="true" />
                {t('financial_pl.invoices.list.create', 'Create invoice')}
              </Link>
            </Button>
          </div>
        </div>

        {/* Scope toggle (Sales / Purchases) + period controls */}
        {/* `min-h-9`: the Purchases tab has no month stepper, so its controls row was 3px shorter and
            everything below it sat higher. Both rows now reserve the same height. */}
        <div className="mb-4 flex min-h-9 flex-wrap items-center justify-between gap-3">
          <InvoiceScopeTabs scope="sent" />
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-stretch rounded-md border border-border bg-card">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-none rounded-l-md"
                disabled={periodMode === 'all'}
                aria-label={t('financial_pl.invoices.list.period.prev', 'Previous month')}
                onClick={handlePreviousMonth}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </Button>
              <span
                className={cn(
                  'flex min-w-36 items-center justify-center border-x border-border px-3 text-center text-sm font-semibold',
                  periodMode === 'all' && 'text-muted-foreground',
                )}
                aria-disabled={periodMode === 'all'}
              >
                {monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-none rounded-r-md"
                disabled={periodMode === 'all'}
                aria-label={t('financial_pl.invoices.list.period.next', 'Next month')}
                onClick={handleNextMonth}
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <Button type="button" variant="outline" onClick={handleThisMonth}>
              <CalendarDays className="size-4" aria-hidden="true" />
              {t('financial_pl.invoices.list.period.thisMonth', 'Current month')}
            </Button>
          </div>
        </div>

        {/* Summary stat cards */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InvoiceStatCard
            icon={FileText}
            label={t('financial_pl.invoices.list.summary.invoices', 'Invoices')}
            value={summary ? formatSummaryCount(summary.count) : '—'}
          />
          <InvoiceStatCard
            icon={Coins}
            label={t('financial_pl.invoices.list.summary.grossValue', 'Gross value')}
            value={summary ? formatSummaryAmount(Number(summary.totalGross)) : '—'}
          />
          <InvoiceStatCard
            icon={Wallet}
            label={t('financial_pl.invoices.list.summary.due', 'Due')}
            value={summary ? formatSummaryAmount(Number(summary.dueTotal)) : '—'}
          />
          <InvoiceStatCard
            icon={AlertTriangle}
            label={t('financial_pl.invoices.list.summary.ksefProblems', 'KSeF problems')}
            value={
              summary && summary.rejectedCount > 0
                ? t('financial_pl.invoices.list.summary.rejected', '{count} rejected', {
                    count: summary.rejectedCount,
                  })
                : t('financial_pl.invoices.list.summary.noProblems', 'None')
            }
            tone={summary && summary.rejectedCount > 0 ? 'danger' : 'default'}
          />
        </div>
        {summary?.capped ? (
          <p className="mb-4 -mt-1 text-xs text-muted-foreground">
            {t('financial_pl.invoices.list.summaryCapped', 'Totals cover the first 1000 invoices')}
          </p>
        ) : null}
        <DataTable<InvoiceRow>
          stickyActionsColumn
          columns={columns}
          data={rows}
          bulkActions={bulkActions}
          sortable
          manualSorting
          sorting={sorting}
          onSortingChange={handleSortingChange}
          isLoading={isLoading}
          searchValue={search}
          onSearchChange={handleSearchChange}
          searchPlaceholder={t('financial_pl.invoices.list.search', 'Search invoices…')}
          extensionTableId="financial_pl.invoices"
          injectionContext={invoiceFiltersInjectionContext}
          columnChooser={{ auto: true }}
          perspective={{ tableId: 'financial_pl.invoices' }}
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total,
            totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            onPageChange: setPage,
          }}
          rowActions={(row) => (
            <InvoiceRowActions
              items={[
                {
                  id: 'open',
                  label: t('financial_pl.invoices.list.table.open', 'Open'),
                  icon: Eye,
                  href: `/backend/financial/invoices/${row.id}`,
                },
                {
                  id: 'edit',
                  label: t('financial_pl.invoices.list.table.edit', 'Edit'),
                  icon: Pencil,
                  href: `/backend/financial/invoices/${row.id}/edit`,
                },
                ...(isInvoiceEligibleForKsefBatch(row)
                  ? [
                      {
                        id: 'send-ksef',
                        label: t('financial_pl.actions.sendToKsef', 'Send to KSeF'),
                        icon: Send,
                        onSelect: () => {
                          void handleSendToKsef(row)
                        },
                      },
                    ]
                  : []),
                {
                  id: 'print',
                  label: t('financial_pl.invoices.list.table.print', 'Print / PDF'),
                  icon: Printer,
                  onSelect: () => {
                    window.open(
                      `/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=${encodeURIComponent(row.id)}&disposition=inline`,
                      '_blank',
                      'noopener,noreferrer',
                    )
                  },
                },
                {
                  id: 'send-email',
                  label: t('financial_pl.invoices.list.table.sendEmail', 'Send by email'),
                  icon: Mail,
                  onSelect: () => setEmailTarget({ id: row.id, invoiceNumber: row.invoiceNumber }),
                },
              ]}
            />
          )}
          onRowClick={handleRowClick}
          emptyState={
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t('financial_pl.invoices.list.empty', 'No invoices yet.')}
            </div>
          }
        />
        <InvoiceEmailDialog target={emailTarget} onClose={() => setEmailTarget(null)} />
        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}
