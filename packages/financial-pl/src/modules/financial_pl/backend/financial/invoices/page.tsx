"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { KsefStatusBadge } from '../../../components/KsefStatusBadge'

type InvoiceListItem = {
  id: string
  invoiceNumber?: string | null
  issueDate?: string | null
  dueDate?: string | null
  currencyCode?: string | null
  grandTotalNetAmount?: number | null
  grandTotalGrossAmount?: number | null
  status?: string | null
  ksefStatus?: string | null
  ksefNumber?: string | null
  upoAvailable?: boolean | null
  offlineSendDeadlineAt?: string | null
  invoiceKind?: string | null
}

type InvoiceListResponse = {
  items?: InvoiceListItem[]
  total?: number
  page?: number
  pageSize?: number
}

type InvoiceRow = {
  id: string
  invoiceNumber: string
  issueDate: string | null
  dueDate: string | null
  currencyCode: string | null
  grandTotalNetAmount: number | null
  grandTotalGrossAmount: number | null
  ksefStatus: string | null
  ksefNumber: string | null
  offlineSendDeadlineAt: string | null
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
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatCurrency(
  amount: number | null | undefined,
  currency: string | null | undefined,
  fallback = '—',
): string {
  if (amount == null || Number.isNaN(amount)) return fallback
  try {
    if (currency && currency.trim().length) {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
    }
    return new Intl.NumberFormat(undefined, { style: 'decimal', maximumFractionDigits: 2 }).format(amount)
  } catch {
    return String(amount)
  }
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
  const [isLoading, setLoading] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)

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
    return params.toString()
  }, [filterValues, page, search])

  const mapInvoice = React.useCallback((item: InvoiceListItem): InvoiceRow => {
    const id = typeof item.id === 'string' ? item.id : ''
    return {
      id,
      invoiceNumber: item.invoiceNumber ?? id,
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
        return
      }
      const payload = call.result ?? {}
      const items = Array.isArray(payload.items) ? payload.items : []
      setRows(items.map((item) => mapInvoice(item)))
      setTotal(typeof payload.total === 'number' ? payload.total : items.length)
    } catch (err) {
      console.error('financial_pl.invoices.list', err)
      flash(t('financial_pl.invoices.list.errors.load', 'Failed to load invoices.'), 'error')
      setRows([])
      setTotal(0)
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

  const handleRefresh = React.useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  const handleRowClick = React.useCallback(
    (row: InvoiceRow) => {
      router.push(`/backend/financial/invoices/${row.id}`)
    },
    [router],
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

  return (
    <Page>
      <PageBody>
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
