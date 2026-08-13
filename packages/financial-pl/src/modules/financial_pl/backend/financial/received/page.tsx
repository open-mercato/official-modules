"use client"

import * as React from 'react'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { RefreshCw, FileText, Coins, Wallet } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { InvoiceStatCard } from '../../../components/InvoiceStatCard'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { IsoDatePicker } from '../../../components/IsoDatePicker'
import { InvoiceScopeTabs } from '../../../components/InvoiceScopeTabs'

type ReceivedInvoiceListItem = {
  id?: string | null
  issuerNip?: string | null
  issuerName?: string | null
  ksefNumber?: string | null
  issueDate?: string | null
  acquisitionDate?: string | null
  invoiceType?: string | null
  grossAmount?: string | number | null
  currency?: string | null
  linkedPurchaseRecordId?: string | null
}

type ReceivedInvoiceSummary = {
  count: number
  totalGross: string
  vatTotal: string
  correctionCount: number
  capped: boolean
}

type ReceivedInvoiceListResponse = {
  items?: ReceivedInvoiceListItem[]
  total?: number
  page?: number
  pageSize?: number
  summary?: ReceivedInvoiceSummary
}

type ReceivedInvoiceRow = {
  id: string
  issuerNip: string | null
  issuerName: string | null
  ksefNumber: string
  issueDate: string | null
  acquisitionDate: string | null
  invoiceType: string | null
  grossAmount: number | null
  currency: string | null
  linkedPurchaseRecordId: string | null
}

type SyncResponse = { ok?: boolean; synced?: number; error?: string }
type MaterializeResponse = { purchaseRecordId?: string; error?: string }

const PAGE_SIZE = 25

const DEFAULT_CURRENCY = 'PLN'

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

function toDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function defaultSyncRange() {
  const dateTo = new Date()
  const dateFrom = new Date(dateTo)
  dateFrom.setDate(dateFrom.getDate() - 30)
  return { dateFrom: toDateInputValue(dateFrom), dateTo: toDateInputValue(dateTo) }
}

export default function FinancialPlReceivedInvoicesPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const initialSyncRange = React.useMemo(() => defaultSyncRange(), [])
  const [rows, setRows] = React.useState<ReceivedInvoiceRow[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [search, setSearch] = React.useState('')
  const [summary, setSummary] = React.useState<ReceivedInvoiceSummary | null>(null)
  const [isLoading, setLoading] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [syncOpen, setSyncOpen] = React.useState(false)
  const [dateFrom, setDateFrom] = React.useState(initialSyncRange.dateFrom)
  const [dateTo, setDateTo] = React.useState(initialSyncRange.dateTo)
  const [isSyncing, setSyncing] = React.useState(false)
  const [ledgerBusyKsefNumber, setLedgerBusyKsefNumber] = React.useState<string | null>(null)

  // Same heading as the Sales tab: the Sprzedaż/Zakupy control already states which side is open,
  // and a title that changes with the tab is itself part of the jump.
  const title = t('financial_pl.nav.invoices', 'Invoices')

  const queryParams = React.useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(PAGE_SIZE))
    if (search.trim()) params.set('search', search.trim())
    return params.toString()
  }, [page, search])

  const mapInvoice = React.useCallback((item: ReceivedInvoiceListItem): ReceivedInvoiceRow => {
    const ksefNumber = typeof item.ksefNumber === 'string' ? item.ksefNumber : ''
    const id = typeof item.id === 'string' && item.id ? item.id : ksefNumber
    return {
      id,
      issuerNip: item.issuerNip ?? null,
      issuerName: item.issuerName ?? null,
      ksefNumber,
      issueDate: item.issueDate ?? null,
      acquisitionDate: item.acquisitionDate ?? null,
      invoiceType: item.invoiceType ?? null,
      grossAmount: toNumber(item.grossAmount),
      currency: item.currency ?? null,
      linkedPurchaseRecordId: item.linkedPurchaseRecordId ?? null,
    }
  }, [])

  const loadReceivedInvoices = React.useCallback(async () => {
    setLoading(true)
    try {
      const call = await apiCall<ReceivedInvoiceListResponse>(
        `/api/financial_pl/ksef/received-invoices?${queryParams}`,
      )
      if (!call.ok) {
        flash(t('financial_pl.received.errors.load', 'Failed to load received invoices.'), 'error')
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
      console.error('financial_pl.received.list', err)
      flash(t('financial_pl.received.errors.load', 'Failed to load received invoices.'), 'error')
      setRows([])
      setTotal(0)
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [mapInvoice, queryParams, t])

  React.useEffect(() => {
    void loadReceivedInvoices()
  }, [loadReceivedInvoices, reloadToken, scopeVersion])

  const refresh = React.useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  const handleSearchChange = React.useCallback((value: string) => {
    setSearch(value)
    setPage(1)
  }, [])

  const openSyncDialog = React.useCallback(() => {
    const range = defaultSyncRange()
    setDateFrom(range.dateFrom)
    setDateTo(range.dateTo)
    setSyncOpen(true)
  }, [])

  const handleSync = React.useCallback(async () => {
    if (isSyncing) return
    if (!dateFrom || !dateTo) {
      flash(t('financial_pl.received.errors.dateRangeRequired', 'Select both dates before syncing.'), 'error')
      return
    }
    if (dateFrom > dateTo) {
      flash(t('financial_pl.received.errors.dateRangeOrder', 'The start date must be before the end date.'), 'error')
      return
    }
    setSyncing(true)
    try {
      const call = await apiCall<SyncResponse>('/api/financial_pl/ksef/received-invoices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo }),
      })
      if (!call.ok) {
        throw new Error(
          call.result?.error ?? t('financial_pl.received.errors.sync', 'Failed to sync received invoices.'),
        )
      }
      const synced = typeof call.result?.synced === 'number' ? call.result.synced : 0
      flash(
        t('financial_pl.received.syncedCount', 'Synced {count} received invoices.', { count: synced }),
        'success',
      )
      setSyncOpen(false)
      refresh()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : t('financial_pl.received.errors.sync', 'Failed to sync received invoices.'),
        'error',
      )
    } finally {
      setSyncing(false)
    }
  }, [dateFrom, dateTo, isSyncing, refresh, t])

  const handleSyncDialogKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSyncOpen(false)
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void handleSync()
      }
    },
    [handleSync],
  )

  const handleViewXml = React.useCallback(
    (row: ReceivedInvoiceRow) => {
      if (!row.ksefNumber) {
        flash(t('financial_pl.received.errors.missingKsefNumber', 'This invoice has no KSeF number.'), 'error')
        return
      }
      const url = `/api/financial_pl/ksef/received-invoices/${encodeURIComponent(row.ksefNumber)}/xml`
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      document.body.appendChild(link)
      link.click()
      link.remove()
    },
    [t],
  )

  const handleAddToLedger = React.useCallback(
    async (row: ReceivedInvoiceRow) => {
      if (!row.ksefNumber) {
        flash(t('financial_pl.received.errors.missingKsefNumber', 'This invoice has no KSeF number.'), 'error')
        return
      }
      if (ledgerBusyKsefNumber === row.ksefNumber) return
      setLedgerBusyKsefNumber(row.ksefNumber)
      try {
        const call = await apiCall<MaterializeResponse>(
          `/api/financial_pl/ksef/received-invoices/${encodeURIComponent(row.ksefNumber)}/to-purchase-record`,
          { method: 'POST', headers: { 'content-type': 'application/json' } },
        )
        if (!call.ok) {
          throw new Error(
            call.result?.error ??
              t('financial_pl.received.errors.addToLedger', 'Failed to add invoice to the purchase ledger.'),
          )
        }
        flash(t('financial_pl.received.addedToLedger', 'Added to purchase ledger.'), 'success')
        refresh()
      } catch (err) {
        flash(
          err instanceof Error
            ? err.message
            : t('financial_pl.received.errors.addToLedger', 'Failed to add invoice to the purchase ledger.'),
          'error',
        )
      } finally {
        setLedgerBusyKsefNumber(null)
      }
    },
    [ledgerBusyKsefNumber, refresh, t],
  )

  const columns = React.useMemo<ColumnDef<ReceivedInvoiceRow>[]>(
    () => [
      {
        id: 'issuerNip',
        accessorKey: 'issuerNip',
        header: t('financial_pl.received.columns.issuerNip', 'Issuer NIP'),
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.issuerNip ?? '—'}</span>,
      },
      {
        id: 'issuerName',
        accessorKey: 'issuerName',
        header: t('financial_pl.received.columns.issuerName', 'Issuer name'),
        cell: ({ row }) => <span className="font-medium">{row.original.issuerName ?? '—'}</span>,
      },
      {
        id: 'ksefNumber',
        accessorKey: 'ksefNumber',
        header: t('financial_pl.received.columns.ksefNumber', 'KSeF number'),
        cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.ksefNumber}</span>,
      },
      {
        id: 'issueDate',
        accessorKey: 'issueDate',
        header: t('financial_pl.received.columns.issueDate', 'Issue date'),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{formatDate(row.original.issueDate)}</span>
        ),
      },
      {
        id: 'acquisitionDate',
        accessorKey: 'acquisitionDate',
        header: t('financial_pl.received.columns.acquisitionDate', 'Receipt date'),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{formatDate(row.original.acquisitionDate)}</span>
        ),
      },
      {
        id: 'invoiceType',
        accessorKey: 'invoiceType',
        header: t('financial_pl.received.columns.invoiceType', 'Invoice type'),
        cell: ({ row }) => <span className="text-sm">{row.original.invoiceType ?? '—'}</span>,
      },
      {
        id: 'grossAmount',
        accessorKey: 'grossAmount',
        header: t('financial_pl.received.columns.grossAmount', 'Gross amount'),
        cell: ({ row }) => <span className="text-sm">{formatCurrency(row.original.grossAmount, row.original.currency)}</span>,
      },
      {
        id: 'currency',
        accessorKey: 'currency',
        header: t('financial_pl.received.columns.currency', 'Currency'),
        cell: ({ row }) => <span className="text-sm">{row.original.currency ?? '—'}</span>,
      },
    ],
    [t],
  )

  const formatSummaryAmount = React.useCallback(
    (value: string) => formatCurrency(Number(value), DEFAULT_CURRENCY, '—'),
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
          Empty DataTable header band removed + page-level header, mirroring the sales-invoices list
          (title + Sync moved to the page header; the DS still renders the now-empty header-content row
          off its toolbar injection spot, so hide that row + its divider). Scoped to this table's handle.
        */}
        <style>{`[data-component-handle="data-table:financial_pl.received_invoices"] > div:first-child > div:first-child{display:none!important}[data-component-handle="data-table:financial_pl.received_invoices"] > div:first-child > div:nth-child(2){margin-top:0!important;padding-top:0!important;border-top:0!important}`}</style>
        {/* Page header — title + Sync CTA (consistent with the sales-invoices list) */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          </div>
          <Button onClick={openSyncDialog} disabled={isSyncing}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {t('financial_pl.received.sync', 'Sync')}
          </Button>
        </div>
        {/* Mirrors the Sales controls row height so the KPI cards and table below start at the
            same y on both tabs. */}
        <div className="mb-4 flex min-h-9 flex-wrap items-center justify-between gap-3">
          <InvoiceScopeTabs scope="received" />
        </div>
        {/* Summary stat cards — mirror the sales tab's KPI row so the table sits at the same height
            when switching scopes (no content jump). */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <InvoiceStatCard
            icon={FileText}
            label={t('financial_pl.received.summary.invoices', 'Received invoices')}
            value={summary ? formatSummaryCount(summary.count) : '—'}
            sub={
              summary && summary.correctionCount > 0
                ? t('financial_pl.received.summary.corrections', '{count} corrections', {
                    count: summary.correctionCount,
                  })
                : undefined
            }
          />
          <InvoiceStatCard
            icon={Coins}
            label={t('financial_pl.received.summary.grossValue', 'Gross value')}
            value={summary ? formatSummaryAmount(summary.totalGross) : '—'}
          />
          <InvoiceStatCard
            icon={Wallet}
            label={t('financial_pl.received.summary.vatDeductible', 'Deductible VAT')}
            value={summary ? formatSummaryAmount(summary.vatTotal) : '—'}
          />
        </div>
        {summary?.capped ? (
          <p className="mb-4 -mt-1 text-xs text-muted-foreground">
            {t('financial_pl.received.summaryCapped', 'Totals cover the first 1000 invoices')}
          </p>
        ) : null}
        <DataTable<ReceivedInvoiceRow>
          stickyActionsColumn
          extensionTableId="financial_pl.received_invoices"
          columnChooser={{ auto: true }}
          perspective={{ tableId: 'financial_pl.received_invoices' }}
          columns={columns}
          data={rows}
          isLoading={isLoading}
          searchValue={search}
          onSearchChange={handleSearchChange}
          searchPlaceholder={t('financial_pl.received.search', 'Search received invoices…')}
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total,
            totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            onPageChange: setPage,
          }}
          rowActions={(row) => (
            <RowActions
              items={[
                {
                  id: 'viewXml',
                  label: t('financial_pl.received.viewXml', 'View XML'),
                  onSelect: () => handleViewXml(row),
                },
                {
                  id: 'addToLedger',
                  label: t('financial_pl.received.addToLedger', 'Add to purchase ledger'),
                  onSelect: () => {
                    void handleAddToLedger(row)
                  },
                },
              ]}
            />
          )}
          emptyState={
            <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
              <p className="max-w-md">
                {t(
                  'financial_pl.received.emptyHint',
                  'No received invoices yet. Received invoices (Faktury otrzymane) are pulled from KSeF for invoices issued to your NIP — click “Sync” and pick a date range to fetch them.',
                )}
              </p>
              <Button variant="outline" onClick={openSyncDialog} disabled={isSyncing}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t('financial_pl.received.sync', 'Sync')}
              </Button>
            </div>
          }
        />
      </PageBody>

      <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
        <DialogContent onKeyDown={handleSyncDialogKeyDown}>
          <DialogHeader>
            <DialogTitle>{t('financial_pl.received.syncTitle', 'Sync received invoices')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="received-sync-date-from">{t('financial_pl.received.dateFrom', 'Date from')}</Label>
              <IsoDatePicker
                id="received-sync-date-from"
                value={dateFrom}
                onChange={setDateFrom}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="received-sync-date-to">{t('financial_pl.received.dateTo', 'Date to')}</Label>
              <IsoDatePicker
                id="received-sync-date-to"
                value={dateTo}
                onChange={setDateTo}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSyncOpen(false)} disabled={isSyncing}>
              {t('financial_pl.received.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() => {
                void handleSync()
              }}
              disabled={isSyncing}
            >
              {t('financial_pl.received.sync', 'Sync')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  )
}
