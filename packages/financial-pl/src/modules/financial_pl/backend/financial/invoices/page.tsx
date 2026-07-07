"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Send } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable, type BulkAction } from '@open-mercato/ui/backend/DataTable'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { KsefStatusBadge } from '../../../components/KsefStatusBadge'
import { isInvoiceIssued } from '../../../lib/invoice-status'

type InvoiceListItem = {
  id: string
  invoiceNumber?: string | null
  issueDate?: string | null
  dueDate?: string | null
  currencyCode?: string | null
  grandTotalNetAmount?: string | number | null
  grandTotalGrossAmount?: string | number | null
  status?: string | null
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
  if (!isInvoiceIssued(row.status)) return false
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
  const [selectedPeriod, setSelectedPeriod] = React.useState<MonthPeriod>(() => currentMonthPeriod())
  const [periodMode, setPeriodMode] = React.useState<PeriodMode>('month')
  const [summary, setSummary] = React.useState<InvoiceListSummary | null>(null)
  const [isLoading, setLoading] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.invoices',
  })

  const title = t('financial_pl.nav.invoices', 'Invoices')
  const subtitle = t(
    'financial_pl.invoices.list.subtitle',
    'Review invoices with totals and their KSeF submission status.',
  )

  const statusFilterOptions = React.useMemo(
    () =>
      KSEF_STATUS_FILTER_KEYS.map((key) => ({
        value: key,
        label: t(ksefStatusFilterLabelKey[key], ksefStatusFilterLabelFallback[key]),
      })),
    [t],
  )

  const filters = React.useMemo<FilterDef[]>(
    () => [
      {
        id: 'status',
        label: t('financial_pl.invoices.list.filters.ksefStatus', 'KSeF status'),
        type: 'select',
        options: statusFilterOptions,
      },
    ],
    [statusFilterOptions, t],
  )

  const queryParams = React.useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(PAGE_SIZE))
    if (search.trim()) params.set('search', search.trim())
    const status = typeof filterValues.status === 'string' ? filterValues.status.trim() : ''
    if (status) params.set('status', status)
    if (periodMode === 'month') {
      params.set('issueDateFrom', firstDayOfMonth(selectedPeriod))
      params.set('issueDateTo', lastDayOfMonth(selectedPeriod))
    }
    return params.toString()
  }, [filterValues, page, periodMode, search, selectedPeriod])

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

  const handleFiltersApply = React.useCallback((values: FilterValues) => {
    setFilterValues(values)
    setPage(1)
  }, [])

  const handleFiltersClear = React.useCallback(() => {
    setFilterValues({})
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

  const handleAllInvoices = React.useCallback(() => {
    setPeriodMode('all')
    setPage(1)
  }, [])

  const handleRefresh = React.useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

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
        id: 'issueDate',
        accessorKey: 'issueDate',
        header: t('financial_pl.invoices.list.table.issueDate', 'Issue date'),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{formatDate(row.original.issueDate)}</span>
        ),
      },
      {
        id: 'dueDate',
        accessorKey: 'dueDate',
        header: t('financial_pl.invoices.list.table.dueDate', 'Due date'),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{formatDate(row.original.dueDate)}</span>
        ),
      },
      {
        id: 'grandTotalNetAmount',
        accessorKey: 'grandTotalNetAmount',
        header: t('financial_pl.invoices.list.table.net', 'Net'),
        cell: ({ row }) => (
          <span className="text-sm">
            {formatCurrency(row.original.grandTotalNetAmount, row.original.currencyCode)}
          </span>
        ),
      },
      {
        id: 'grandTotalGrossAmount',
        accessorKey: 'grandTotalGrossAmount',
        header: t('financial_pl.invoices.list.table.gross', 'Gross'),
        cell: ({ row }) => (
          <span className="text-sm">
            {formatCurrency(row.original.grandTotalGrossAmount, row.original.currencyCode)}
          </span>
        ),
      },
      {
        id: 'ksefStatus',
        accessorKey: 'ksefStatus',
        header: t('financial_pl.invoices.list.table.ksefStatus', 'KSeF status'),
        enableSorting: false,
        cell: ({ row }) => (
          <KsefStatusBadge
            status={row.original.ksefStatus}
            ksefNumber={row.original.ksefNumber}
            offlineSendDeadlineAt={row.original.offlineSendDeadlineAt}
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
  const summaryText = React.useMemo(() => {
    if (!summary) return null
    const parts = [
      t('financial_pl.invoices.list.summary.count', '{count} invoices', { count: summary.count }),
      `${t('financial_pl.invoices.list.summary.net', 'Net')} ${formatCurrency(Number(summary.totalNet), null)}`,
      `${t('financial_pl.invoices.list.summary.gross', 'Gross')} ${formatCurrency(Number(summary.totalGross), null)}`,
    ]
    if (summary.capped) {
      parts.push(t('financial_pl.invoices.list.summaryCapped', 'Totals cover the first 1000 invoices'))
    }
    return parts.join(' · ')
  }, [summary, t])

  return (
    <Page>
      <PageBody>
        <div className="mb-4 flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={periodMode === 'all'}
              aria-label={t('financial_pl.invoices.list.period.prev', 'Previous month')}
              onClick={handlePreviousMonth}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <span
              className={
                periodMode === 'all'
                  ? 'min-w-40 text-center text-sm font-semibold text-muted-foreground'
                  : 'min-w-40 text-center text-sm font-semibold'
              }
              aria-disabled={periodMode === 'all'}
            >
              {monthLabel}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={periodMode === 'all'}
              aria-label={t('financial_pl.invoices.list.period.next', 'Next month')}
              onClick={handleNextMonth}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={periodMode === 'month' ? 'default' : 'outline'}
                onClick={handleThisMonth}
              >
                {t('financial_pl.invoices.list.period.thisMonth', 'This month')}
              </Button>
              <Button
                type="button"
                variant={periodMode === 'all' ? 'default' : 'outline'}
                onClick={handleAllInvoices}
              >
                {t('financial_pl.invoices.list.period.allInvoices', 'All invoices')}
              </Button>
            </div>
          </div>
          {summaryText ? (
            <div className="text-sm text-muted-foreground lg:text-right">{summaryText}</div>
          ) : null}
        </div>
        <DataTable<InvoiceRow>
          stickyActionsColumn
          title={(
            <div className="flex flex-col">
              <span>{title}</span>
              <span className="text-sm font-normal text-muted-foreground">{subtitle}</span>
            </div>
          )}
          actions={(
            <Button asChild>
              <Link href="/backend/financial/invoices/create">
                {t('financial_pl.invoices.list.create', 'Create invoice')}
              </Link>
            </Button>
          )}
          columns={columns}
          data={rows}
          bulkActions={bulkActions}
          isLoading={isLoading}
          searchValue={search}
          onSearchChange={handleSearchChange}
          searchPlaceholder={t('financial_pl.invoices.list.search', 'Search invoices…')}
          filters={filters}
          filterValues={filterValues}
          onFiltersApply={handleFiltersApply}
          onFiltersClear={handleFiltersClear}
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total,
            totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            onPageChange: setPage,
          }}
          refreshButton={{
            label: t('financial_pl.invoices.list.refresh', 'Refresh'),
            onRefresh: handleRefresh,
            isRefreshing: isLoading,
          }}
          rowActions={(row) => (
            <RowActions
              items={[
                {
                  id: 'open',
                  label: t('financial_pl.invoices.list.table.open', 'Open'),
                  href: `/backend/financial/invoices/${row.id}`,
                },
                {
                  id: 'edit',
                  label: t('financial_pl.invoices.list.table.edit', 'Edit'),
                  href: `/backend/financial/invoices/${row.id}/edit`,
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
      </PageBody>
    </Page>
  )
}
