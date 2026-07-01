"use client"

import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
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

type ReceivedInvoiceListResponse = {
  items?: ReceivedInvoiceListItem[]
  total?: number
  page?: number
  pageSize?: number
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
  const [isLoading, setLoading] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [syncOpen, setSyncOpen] = React.useState(false)
  const [dateFrom, setDateFrom] = React.useState(initialSyncRange.dateFrom)
  const [dateTo, setDateTo] = React.useState(initialSyncRange.dateTo)
  const [isSyncing, setSyncing] = React.useState(false)
  const [ledgerBusyKsefNumber, setLedgerBusyKsefNumber] = React.useState<string | null>(null)

  const title = t('financial_pl.received.title', 'Received invoices')
  const subtitle = t(
    'financial_pl.received.subtitle',
    'Review invoices received through KSeF and add them to the purchase ledger.',
  )

  const queryParams = React.useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(PAGE_SIZE))
    return params.toString()
  }, [page])

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
        return
      }
      const payload = call.result ?? {}
      const items = Array.isArray(payload.items) ? payload.items : []
      setRows(items.map((item) => mapInvoice(item)))
      setTotal(typeof payload.total === 'number' ? payload.total : items.length)
    } catch (err) {
      console.error('financial_pl.received.list', err)
      flash(t('financial_pl.received.errors.load', 'Failed to load received invoices.'), 'error')
      setRows([])
      setTotal(0)
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

  return (
    <Page>
      <PageBody>
        <DataTable<ReceivedInvoiceRow>
          stickyActionsColumn
          title={(
            <div className="flex flex-col">
              <span>{title}</span>
              <span className="text-sm font-normal text-muted-foreground">{subtitle}</span>
            </div>
          )}
          actions={(
            <Button onClick={openSyncDialog} disabled={isSyncing}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t('financial_pl.received.sync', 'Sync')}
            </Button>
          )}
          columns={columns}
          data={rows}
          isLoading={isLoading}
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total,
            totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            onPageChange: setPage,
          }}
          refreshButton={{
            label: t('financial_pl.received.refresh', 'Refresh'),
            onRefresh: refresh,
            isRefreshing: isLoading,
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
              <Input
                id="received-sync-date-from"
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="received-sync-date-to">{t('financial_pl.received.dateTo', 'Date to')}</Label>
              <Input
                id="received-sync-date-to"
                type="date"
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
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
