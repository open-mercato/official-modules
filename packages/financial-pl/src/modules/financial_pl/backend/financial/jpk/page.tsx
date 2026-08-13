"use client"

import * as React from 'react'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { SortingState } from '@tanstack/react-table'
import { FileCog, Plus, Send } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { FormSection } from '../../../components/FormSection'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { Tag } from '@open-mercato/ui/primitives/tag'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { openKsefDownload } from '../../../lib/ksef-download'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { LoadingMessage } from '@open-mercato/ui/backend/detail/LoadingMessage'
import { ErrorMessage } from '@open-mercato/ui/backend/detail/ErrorMessage'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { IsoDatePicker } from '../../../components/IsoDatePicker'

type JpkVariant = 'V7M' | 'V7K'

type FilingRow = {
  id: string
  variant: string
  year: number
  month: number
  celZlozenia: number
  status: string
  generatedAt: string | null
  submissionReference: string | null
  submittedAt: string | null
  hasUpo: boolean
}

type FilingResponse = {
  items?: Array<Record<string, unknown>>
  total?: number
}

type FilingUpsertResponse = { ok?: boolean; id?: string; error?: string }
type GenerateResponse = { ok?: boolean; filingId?: string; status?: string; error?: string }
type SubmitResponse = { filingId?: string; status?: string; referenceNumber?: string; error?: string }

type PurchaseRecordRow = {
  id: string
  year: number
  month: number
  supplierNip: string | null
  supplierName: string | null
  documentNumber: string
  purchaseDate: string
  netOther: string | null
  vatOther: string | null
}

type PurchaseRecordResponse = {
  items?: Array<Record<string, unknown>>
  total?: number
}

type MutationResponse = { ok?: boolean; id?: string; error?: string }

const PAGE_SIZE = 50

const VARIANTS: readonly JpkVariant[] = ['V7M', 'V7K']
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

const filingStatusMap: StatusMap<'draft' | 'generated' | 'submitted' | 'accepted' | 'rejected'> = {
  draft: 'neutral',
  generated: 'info',
  submitted: 'info',
  accepted: 'success',
  rejected: 'error',
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null
}

function formatPeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function statusVariant(status: string): StatusMap<string>[string] {
  return (filingStatusMap as Record<string, StatusMap<string>[string]>)[status] ?? 'neutral'
}

export default function FinancialPlJpkPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.jpk',
  })
  const mutationContext = React.useMemo(() => ({ retryLastMutation }), [retryLastMutation])

  const currentYear = new Date().getFullYear()
  const [variant, setVariant] = React.useState<JpkVariant>('V7M')
  const [year, setYear] = React.useState<number>(currentYear)
  const [month, setMonth] = React.useState<number>(new Date().getMonth() + 1)
  // Required by resolveJpkFiling: the 4-digit tax-office code (KodUrzedu) that generation/export
  // throws without. contextNip is optional (Podmiot1 falls back to the credential NIP when blank).
  const [kodUrzedu, setKodUrzedu] = React.useState('')
  const [contextNip, setContextNip] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [submittingFilingId, setSubmittingFilingId] = React.useState<string | null>(null)

  // --- Filings ---
  const [filings, setFilings] = React.useState<FilingRow[]>([])
  const [filingsTotal, setFilingsTotal] = React.useState(0)
  const [filingsPage, setFilingsPage] = React.useState(1)
  const [filingsLoading, setFilingsLoading] = React.useState(false)
  const [filingsError, setFilingsError] = React.useState<string | null>(null)

  // --- Purchase records ---
  const [records, setRecords] = React.useState<PurchaseRecordRow[]>([])
  const [recordsTotal, setRecordsTotal] = React.useState(0)
  const [recordsPage, setRecordsPage] = React.useState(1)
  const [recordsLoading, setRecordsLoading] = React.useState(false)
  const [recordsError, setRecordsError] = React.useState<string | null>(null)

  // --- Add purchase record dialog ---
  const emptyRecordForm = React.useMemo(
    () => ({
      year: String(currentYear),
      month: String(new Date().getMonth() + 1),
      documentNumber: '',
      purchaseDate: '',
      supplierNip: '',
      supplierName: '',
      netOther: '',
      vatOther: '',
    }),
    [currentYear],
  )
  const [addOpen, setAddOpen] = React.useState(false)
  const [filingsSorting, setFilingsSorting] = React.useState<SortingState>([{ id: 'period', desc: true }])
  const [recordsSorting, setRecordsSorting] = React.useState<SortingState>([{ id: 'period', desc: true }])
  const handleFilingsSortingChange = React.useCallback((next: SortingState) => {
    setFilingsSorting(next)
    setFilingsPage(1)
  }, [])
  const handleRecordsSortingChange = React.useCallback((next: SortingState) => {
    setRecordsSorting(next)
    setRecordsPage(1)
  }, [])
  const [recordForm, setRecordForm] = React.useState(emptyRecordForm)

  const [reloadToken, setReloadToken] = React.useState(0)
  const refresh = React.useCallback(() => setReloadToken((token) => token + 1), [])

  const updateRecordForm = React.useCallback((key: keyof typeof emptyRecordForm, value: string) => {
    setRecordForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const openAddDialog = React.useCallback(() => {
    setRecordForm(emptyRecordForm)
    setAddOpen(true)
  }, [emptyRecordForm])

  const loadFilings = React.useCallback(async () => {
    setFilingsLoading(true)
    setFilingsError(null)
    try {
      const params = new URLSearchParams({ page: String(filingsPage), pageSize: String(PAGE_SIZE) })
      const activeSort = filingsSorting[0]
      if (activeSort) {
        params.set('sortField', activeSort.id)
        params.set('sortDir', activeSort.desc ? 'desc' : 'asc')
      }
      const call = await apiCall<FilingResponse>(`/api/financial_pl/ksef/jpk/filings?${params.toString()}`)
      if (!call.ok) {
        setFilingsError(t('financial_pl.jpk.filings.errors.load', 'Failed to load JPK filings.'))
        setFilings([])
        setFilingsTotal(0)
        return
      }
      const payload = call.result ?? {}
      const items = Array.isArray(payload.items) ? payload.items : []
      setFilings(
        items.map((item) => ({
          id: asString(item.id) ?? '',
          variant: asString(item.variant) ?? 'V7M',
          year: asNumber(item.year, currentYear),
          month: asNumber(item.month, 1),
          celZlozenia: asNumber(item.celZlozenia, 1),
          status: asString(item.status) ?? 'draft',
          generatedAt: asString(item.generatedAt),
          submissionReference: asString(item.submissionReference),
          submittedAt: asString(item.submittedAt),
          hasUpo: item.hasUpo === true,
        })),
      )
      setFilingsTotal(typeof payload.total === 'number' ? payload.total : items.length)
    } catch (err) {
      console.error('financial_pl.jpk.filings.load', err)
      setFilingsError(t('financial_pl.jpk.filings.errors.load', 'Failed to load JPK filings.'))
    } finally {
      setFilingsLoading(false)
    }
  }, [currentYear, filingsPage, filingsSorting, t])

  const loadRecords = React.useCallback(async () => {
    setRecordsLoading(true)
    setRecordsError(null)
    try {
      const params = new URLSearchParams({ page: String(recordsPage), pageSize: String(PAGE_SIZE) })
      const activeSort = recordsSorting[0]
      if (activeSort) {
        params.set('sortField', activeSort.id)
        params.set('sortDir', activeSort.desc ? 'desc' : 'asc')
      }
      const call = await apiCall<PurchaseRecordResponse>(`/api/financial_pl/ksef/jpk/purchase-records?${params.toString()}`)
      if (!call.ok) {
        setRecordsError(t('financial_pl.jpk.purchaseRecords.errors.load', 'Failed to load purchase records.'))
        setRecords([])
        setRecordsTotal(0)
        return
      }
      const payload = call.result ?? {}
      const items = Array.isArray(payload.items) ? payload.items : []
      setRecords(
        items.map((item) => ({
          id: asString(item.id) ?? '',
          year: asNumber(item.year, currentYear),
          month: asNumber(item.month, 1),
          supplierNip: asString(item.supplierNip),
          supplierName: asString(item.supplierName),
          documentNumber: asString(item.documentNumber) ?? '',
          purchaseDate: asString(item.purchaseDate) ?? '',
          netOther: asString(item.netOther),
          vatOther: asString(item.vatOther),
        })),
      )
      setRecordsTotal(typeof payload.total === 'number' ? payload.total : items.length)
    } catch (err) {
      console.error('financial_pl.jpk.purchaseRecords.load', err)
      setRecordsError(t('financial_pl.jpk.purchaseRecords.errors.load', 'Failed to load purchase records.'))
    } finally {
      setRecordsLoading(false)
    }
  }, [currentYear, recordsPage, t])

  React.useEffect(() => {
    void loadFilings()
  }, [loadFilings, reloadToken, scopeVersion])

  React.useEffect(() => {
    void loadRecords()
  }, [loadRecords, reloadToken, scopeVersion])

  // Generate = create the filing header (POST filings) then run the export (POST export?filingId=).
  const handleGenerate = React.useCallback(async () => {
    // KodUrzedu is required by the resolver — block the round-trip on an invalid/missing value.
    const kod = kodUrzedu.trim()
    if (!/^\d{4}$/.test(kod)) {
      flash(
        t('financial_pl.jpk.generate.kodUrzeduInvalid', 'A 4-digit tax-office code is required.'),
        'error',
      )
      return
    }
    const nip = contextNip.trim()
    setBusy(true)
    let filingCreated = false
    try {
      await runMutation({
        operation: async () => {
          // 1) Upsert the filing header for the selected period/variant.
          const createCall = await apiCall<FilingUpsertResponse>('/api/financial_pl/ksef/jpk/filings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              variant,
              year,
              month,
              celZlozenia: 1,
              correctionScope: 'both',
              kodUrzedu: kod,
              ...(nip ? { contextNip: nip } : {}),
            }),
          })
          if (!createCall.ok || !createCall.result?.id) {
            throw new Error(
              createCall.result?.error
                ?? t('financial_pl.jpk.filings.errors.create', 'Failed to create the JPK filing.'),
            )
          }
          filingCreated = true
          const filingId = createCall.result.id
          // 2) Generate the XML for the freshly-created filing.
          const generateCall = await apiCall<GenerateResponse>(
            `/api/financial_pl/ksef/jpk/export?filingId=${encodeURIComponent(filingId)}`,
            { method: 'POST' },
          )
          if (!generateCall.ok) {
            throw new Error(
              generateCall.result?.error
                ?? t('financial_pl.jpk.filings.errors.generate', 'Failed to generate the JPK XML.'),
            )
          }
          return generateCall
        },
        context: mutationContext,
        mutationPayload: { action: 'generate', variant, year, month, kodUrzedu: kod, contextNip: nip || null },
      })
      flash(t('financial_pl.jpk.filings.messages.generated', 'JPK filing generated.'), 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : t('financial_pl.jpk.filings.errors.generate', 'Failed to generate the JPK XML.')
      // If the header was created but generation failed, show a partial-success message; the finally
      // block still refreshes so the created filing is visible for a manual re-generate (QA #34).
      flash(
        filingCreated
          ? t('financial_pl.jpk.filings.messages.createdNotGenerated', 'The JPK filing was created, but generating its XML failed. Retry generation from the list.')
          : message,
        'error',
      )
    } finally {
      // Refresh once the filing header exists — even if generation failed — so a created-but-not-
      // generated filing is not hidden until a manual reload (QA #34).
      if (filingCreated) refresh()
      setBusy(false)
    }
  }, [contextNip, kodUrzedu, month, mutationContext, refresh, runMutation, t, variant, year])

  // Download streams the already-generated XML via the blob-aware `openKsefDownload` helper (a JSON
  // error becomes a toast, not raw JSON in a tab). A draft filing has no XML yet (the GET would 422),
  // so prompt the operator to generate it first.
  const [generatingFilingId, setGeneratingFilingId] = React.useState<string | null>(null)

  const handleGenerateXml = React.useCallback(
    async (row: FilingRow) => {
      setGeneratingFilingId(row.id)
      try {
        // The route reads `filingId` from the QUERY STRING, not the body (same contract as its GET).
        const call = await apiCall<{ ok?: boolean; status?: string; error?: string }>(
          `/api/financial_pl/ksef/jpk/export?filingId=${encodeURIComponent(row.id)}`,
          { method: 'POST' },
        )
        if (!call.ok) {
          flash(
            call.result?.error ?? t('financial_pl.jpk.filings.errors.generateFailed', 'Could not generate the filing.'),
            'error',
          )
          return
        }
        flash(t('financial_pl.jpk.filings.generated', 'Filing generated.'), 'success')
        refresh()
      } finally {
        setGeneratingFilingId(null)
      }
    },
    [refresh, t],
  )

  const handleDownload = React.useCallback(
    async (row: FilingRow) => {
      if (row.status === 'draft') {
        flash(
          t('financial_pl.jpk.filings.errors.notGenerated', 'Generate the filing before downloading its XML.'),
          'error',
        )
        return
      }
      // Blob-aware download so a JSON error is a translated toast, not raw JSON in a tab (QA #39).
      const outcome = await openKsefDownload(`/api/financial_pl/ksef/jpk/export?filingId=${encodeURIComponent(row.id)}`)
      if (!outcome.ok) {
        flash(outcome.error ?? t('financial_pl.errors.actionFailed', 'Could not download the JPK XML.'), 'error')
      }
    },
    [t],
  )

  const handleUpoDownload = React.useCallback(async (row: FilingRow) => {
    if (row.status !== 'submitted' || !row.hasUpo) return
    const outcome = await openKsefDownload(`/api/financial_pl/ksef/jpk/upo?filingId=${encodeURIComponent(row.id)}`)
    if (!outcome.ok) {
      flash(outcome.error ?? t('financial_pl.errors.actionFailed', 'Could not open the UPO.'), 'error')
    }
  }, [t])

  const handleSubmit = React.useCallback(
    async (row: FilingRow) => {
      if (row.status !== 'generated') return
      setSubmittingFilingId(row.id)
      try {
        const call = await runMutation({
          operation: async () => {
            const call = await apiCall<SubmitResponse>('/api/financial_pl/ksef/jpk/submit', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ filingId: row.id }),
            })
            if (!call.ok) {
              const fallback =
                call.status === 422
                  ? t('financial_pl.jpkSubmit.signerMissing', 'JPK signer credential is missing.')
                  : t('financial_pl.jpkSubmit.submit', 'Submit to MF')
              throw new Error(call.result?.error ?? fallback)
            }
            return call
          },
          context: mutationContext,
          mutationPayload: { action: 'submit', filingId: row.id },
        })
        const reference = call.result?.referenceNumber ?? row.submissionReference
        const submitted = t('financial_pl.jpkSubmit.submitted', 'Submitted')
        flash(reference ? `${submitted}: ${reference}` : submitted, 'success')
        refresh()
      } catch (err) {
        flash(
          err instanceof Error ? err.message : t('financial_pl.jpkSubmit.signerMissing', 'JPK signer credential is missing.'),
          'error',
        )
      } finally {
        setSubmittingFilingId(null)
      }
    },
    [mutationContext, refresh, runMutation, t],
  )

  const filingColumns = React.useMemo<ColumnDef<FilingRow>[]>(
    () => [
      {
        id: 'variant',
        accessorKey: 'variant',
        header: t('financial_pl.jpk.filings.table.variant', 'Variant'),
        cell: ({ row }) => <span className="font-semibold">{row.original.variant}</span>,
      },
      {
        id: 'period',
        accessorKey: 'year',
        header: t('financial_pl.jpk.filings.table.period', 'Period'),
        cell: ({ row }) => <span className="text-sm">{formatPeriod(row.original.year, row.original.month)}</span>,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: t('financial_pl.jpk.filings.table.status', 'Status'),
        cell: ({ row }) => (
          <StatusBadge variant={statusVariant(row.original.status)} dot>
            {t(`financial_pl.jpk.filings.status.${row.original.status}`, row.original.status)}
          </StatusBadge>
        ),
      },
      {
        id: 'generatedAt',
        accessorKey: 'generatedAt',
        header: t('financial_pl.jpk.filings.table.generatedAt', 'Generated'),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{formatDate(row.original.generatedAt)}</span>
        ),
      },
      {
        id: 'submission',
        header: t('financial_pl.jpkSubmit.submit', 'Submit to MF'),
        enableSorting: false,
        cell: ({ row }) => {
          const filing = row.original
          if (filing.status === 'submitted') {
            return (
              <div className="flex flex-col items-start gap-1.5">
                {filing.submissionReference ? (
                  <span className="font-mono text-xs text-muted-foreground">{filing.submissionReference}</span>
                ) : null}
                <Tag variant={filing.hasUpo ? 'success' : 'neutral'} dot>
                  {filing.hasUpo
                    ? t('financial_pl.jpkSubmit.upoAvailable', 'UPO available')
                    : t('financial_pl.jpkSubmit.upoPending', 'UPO pending')}
                </Tag>
              </div>
            )
          }
          if (filing.status !== 'generated') {
            return <span className="text-sm text-muted-foreground">—</span>
          }
          const isSubmitting = submittingFilingId === filing.id
          return (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || submittingFilingId !== null}
              onClick={() => {
                void handleSubmit(filing)
              }}
            >
              <Send className="h-4 w-4" aria-hidden />
              {isSubmitting
                ? t('financial_pl.jpkSubmit.submitting', 'Submitting')
                : t('financial_pl.jpkSubmit.submit', 'Submit to MF')}
            </Button>
          )
        },
      },
    ],
    [busy, handleSubmit, submittingFilingId, t],
  )

  const recordColumns = React.useMemo<ColumnDef<PurchaseRecordRow>[]>(
    () => [
      {
        id: 'period',
        accessorKey: 'year',
        header: t('financial_pl.jpk.purchaseRecords.table.period', 'Period'),
        cell: ({ row }) => <span className="text-sm">{formatPeriod(row.original.year, row.original.month)}</span>,
      },
      {
        id: 'documentNumber',
        accessorKey: 'documentNumber',
        header: t('financial_pl.jpk.purchaseRecords.table.documentNumber', 'Document'),
        cell: ({ row }) => <span className="font-medium">{row.original.documentNumber}</span>,
      },
      {
        id: 'supplier',
        accessorKey: 'supplierName',
        header: t('financial_pl.jpk.purchaseRecords.table.supplier', 'Supplier'),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-sm">{row.original.supplierName ?? '—'}</span>
            {row.original.supplierNip ? (
              <span className="font-mono text-xs text-muted-foreground">{row.original.supplierNip}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'purchaseDate',
        accessorKey: 'purchaseDate',
        header: t('financial_pl.jpk.purchaseRecords.table.purchaseDate', 'Purchase date'),
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.purchaseDate || '—'}</span>,
      },
      {
        id: 'netOther',
        accessorKey: 'netOther',
        header: t('financial_pl.jpk.purchaseRecords.table.net', 'Net'),
        enableSorting: false,
        cell: ({ row }) => <span className="text-sm">{row.original.netOther ?? '—'}</span>,
      },
      {
        id: 'vatOther',
        accessorKey: 'vatOther',
        header: t('financial_pl.jpk.purchaseRecords.table.vat', 'VAT'),
        enableSorting: false,
        cell: ({ row }) => <span className="text-sm">{row.original.vatOther ?? '—'}</span>,
      },
    ],
    [t],
  )

  const handleAddRecord = React.useCallback(async () => {
    const documentNumber = recordForm.documentNumber.trim()
    const purchaseDate = recordForm.purchaseDate.trim()
    if (!documentNumber || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
      flash(
        t('financial_pl.jpk.purchaseRecords.errors.required', 'Document number and a valid purchase date (YYYY-MM-DD) are required.'),
        'error',
      )
      return
    }
    const payload: Record<string, unknown> = {
      year: Number(recordForm.year) || currentYear,
      month: Number(recordForm.month) || 1,
      documentNumber,
      purchaseDate,
    }
    if (recordForm.supplierNip.trim()) payload.supplierNip = recordForm.supplierNip.trim()
    if (recordForm.supplierName.trim()) payload.supplierName = recordForm.supplierName.trim()
    if (recordForm.netOther.trim()) payload.netOther = recordForm.netOther.trim()
    if (recordForm.vatOther.trim()) payload.vatOther = recordForm.vatOther.trim()
    setBusy(true)
    try {
      await runMutation({
        operation: async () => {
          const call = await apiCall<MutationResponse>('/api/financial_pl/ksef/jpk/purchase-records', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!call.ok) {
            throw new Error(
              call.result?.error
                ?? t('financial_pl.jpk.purchaseRecords.errors.add', 'Failed to add the purchase record.'),
            )
          }
          return call
        },
        context: mutationContext,
        mutationPayload: { action: 'add', documentNumber },
      })
      flash(t('financial_pl.jpk.purchaseRecords.messages.added', 'Purchase record added.'), 'success')
      setAddOpen(false)
      refresh()
    } catch (err) {
      flash(
        err instanceof Error
          ? err.message
          : t('financial_pl.jpk.purchaseRecords.errors.add', 'Failed to add the purchase record.'),
        'error',
      )
    } finally {
      setBusy(false)
    }
  }, [currentYear, mutationContext, recordForm, refresh, runMutation, t])

  const handleDeleteRecord = React.useCallback(
    async (row: PurchaseRecordRow) => {
      const ok = await confirm({
        title: t('financial_pl.jpk.purchaseRecords.delete.title', 'Delete purchase record'),
        text: t(
          'financial_pl.jpk.purchaseRecords.delete.text',
          'Remove this purchase VAT record from the JPK evidence? This cannot be undone.',
        ),
        confirmText: t('financial_pl.jpk.purchaseRecords.delete.confirm', 'Delete'),
        variant: 'destructive',
      })
      if (!ok) return
      try {
        await runMutation({
          operation: async () => {
            const call = await apiCall<MutationResponse>(
              `/api/financial_pl/ksef/jpk/purchase-records?id=${encodeURIComponent(row.id)}`,
              { method: 'DELETE' },
            )
            if (!call.ok) {
              throw new Error(
                call.result?.error
                  ?? t('financial_pl.jpk.purchaseRecords.errors.delete', 'Failed to delete the purchase record.'),
              )
            }
            return call
          },
          context: mutationContext,
          mutationPayload: { action: 'delete', id: row.id },
        })
        flash(t('financial_pl.jpk.purchaseRecords.messages.deleted', 'Purchase record deleted.'), 'success')
        refresh()
      } catch (err) {
        flash(
          err instanceof Error
            ? err.message
            : t('financial_pl.jpk.purchaseRecords.errors.delete', 'Failed to delete the purchase record.'),
          'error',
        )
      }
    },
    [confirm, mutationContext, refresh, runMutation, t],
  )

  return (
    <Page>
      <PageBody>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold">{t('financial_pl.nav.jpk', 'JPK_V7')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('financial_pl.jpk.subtitle', 'Generate and download JPK_V7M/V7K filings and stage purchase VAT records.')}
            </p>
          </div>

          <FormSection
            icon={<FileCog className="size-4" />}
            title={t('financial_pl.jpk.generate.title', 'Generate filing')}
            className="mx-1 sm:mx-2"
            bodyClassName="p-4"
          >
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jpk-variant">{t('financial_pl.jpk.generate.variant', 'Variant')}</Label>
                  <Select value={variant} onValueChange={(value) => setVariant(value as JpkVariant)}>
                    <SelectTrigger id="jpk-variant" className="w-40">
                      <SelectValue placeholder={t('financial_pl.jpk.generate.variant', 'Variant')} />
                    </SelectTrigger>
                    <SelectContent>
                      {VARIANTS.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jpk-year">{t('financial_pl.jpk.generate.year', 'Year')}</Label>
                  <Input
                    id="jpk-year"
                    type="number"
                    className="w-32"
                    min={2026}
                    max={2100}
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value) || currentYear)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jpk-month">{t('financial_pl.jpk.generate.month', 'Month')}</Label>
                  <Select value={String(month)} onValueChange={(value) => setMonth(Number(value) || 1)}>
                    <SelectTrigger id="jpk-month" className="w-32">
                      <SelectValue placeholder={t('financial_pl.jpk.generate.month', 'Month')} />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {String(m).padStart(2, '0')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jpk-kod-urzedu">{t('financial_pl.jpk.generate.kodUrzedu', 'Tax office code')}</Label>
                  <Input
                    id="jpk-kod-urzedu"
                    className="w-32"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="0000"
                    value={kodUrzedu}
                    onChange={(e) => setKodUrzedu(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jpk-context-nip">{t('financial_pl.jpk.generate.contextNip', 'Context NIP (optional)')}</Label>
                  <Input
                    id="jpk-context-nip"
                    className="w-44"
                    inputMode="numeric"
                    value={contextNip}
                    onChange={(e) => setContextNip(e.target.value)}
                  />
                </div>
                <Button onClick={handleGenerate} disabled={busy}>
                  <FileCog className="h-4 w-4" aria-hidden />
                  {t('financial_pl.jpk.generate.action', 'Generate')}
                </Button>
              </div>
          </FormSection>

          <div className="flex flex-col gap-3">
            {filingsError ? (
              <ErrorMessage label={filingsError} />
            ) : (
              <DataTable<FilingRow>
                stickyActionsColumn
                title={t('financial_pl.jpk.filings.title', 'Filings')}
                columns={filingColumns}
                data={filings}
                sortable
                manualSorting
                sorting={filingsSorting}
                onSortingChange={handleFilingsSortingChange}
                isLoading={filingsLoading}
                pagination={{
                  page: filingsPage,
                  pageSize: PAGE_SIZE,
                  total: filingsTotal,
                  totalPages: Math.max(1, Math.ceil(filingsTotal / PAGE_SIZE)),
                  onPageChange: setFilingsPage,
                }}
                refreshButton={{
                  label: t('financial_pl.jpk.filings.refresh', 'Refresh'),
                  onRefresh: refresh,
                  isRefreshing: filingsLoading,
                }}
                rowActions={(row) => (
                  <RowActions
                    items={[
                      ...(row.status === 'draft'
                        ? [{
                            id: 'generate',
                            label:
                              generatingFilingId === row.id
                                ? t('financial_pl.jpk.filings.actions.generating', 'Generating…')
                                : t('financial_pl.jpk.filings.actions.generate', 'Generate XML'),
                            onSelect: () => void handleGenerateXml(row),
                          }]
                        : []),
                      {
                        id: 'download',
                        label: t('financial_pl.jpk.filings.actions.download', 'Download XML'),
                        onSelect: () => handleDownload(row),
                      },
                      ...(row.status === 'submitted' && row.hasUpo
                        ? [{
                            id: 'download-upo',
                            label: t('financial_pl.jpk.filings.actions.downloadUpo', 'Download UPO'),
                            onSelect: () => handleUpoDownload(row),
                          }]
                        : []),
                    ]}
                  />
                )}
                emptyState={
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    {t('financial_pl.jpk.filings.empty', 'No JPK filings yet. Generate one above.')}
                  </div>
                }
              />
            )}
          </div>

          <div className="flex flex-col gap-3">
            {recordsError ? (
              <ErrorMessage label={recordsError} />
            ) : (
              <DataTable<PurchaseRecordRow>
                stickyActionsColumn
                title={t('financial_pl.jpk.purchaseRecords.title', 'Purchase records')}
                sortable
                manualSorting
                sorting={recordsSorting}
                onSortingChange={handleRecordsSortingChange}
                actions={
                  <Button variant="secondary" onClick={openAddDialog}>
                    <Plus className="h-4 w-4" aria-hidden />
                    {t('financial_pl.jpk.purchaseRecords.add', 'Add record')}
                  </Button>
                }
                columns={recordColumns}
                data={records}
                isLoading={recordsLoading}
                pagination={{
                  page: recordsPage,
                  pageSize: PAGE_SIZE,
                  total: recordsTotal,
                  totalPages: Math.max(1, Math.ceil(recordsTotal / PAGE_SIZE)),
                  onPageChange: setRecordsPage,
                }}
                refreshButton={{
                  label: t('financial_pl.jpk.purchaseRecords.refresh', 'Refresh'),
                  onRefresh: refresh,
                  isRefreshing: recordsLoading,
                }}
                rowActions={(row) => (
                  <RowActions
                    items={[
                      {
                        id: 'delete',
                        label: t('financial_pl.jpk.purchaseRecords.actions.delete', 'Delete'),
                        onSelect: () => handleDeleteRecord(row),
                        destructive: true,
                      },
                    ]}
                  />
                )}
                emptyState={
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    {t('financial_pl.jpk.purchaseRecords.empty', 'No purchase records staged yet.')}
                  </div>
                }
              />
            )}
          </div>

          {busy ? <LoadingMessage label={t('financial_pl.jpk.generate.busy', 'Generating JPK filing…')} /> : null}
          {submittingFilingId ? (
            <LoadingMessage label={t('financial_pl.jpkSubmit.submitting', 'Submitting')} />
          ) : null}
        </div>
      </PageBody>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('financial_pl.jpk.purchaseRecords.add.title', 'Add purchase record')}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-year">{t('financial_pl.jpk.purchaseRecords.form.year', 'Year')}</Label>
              <Input
                id="rec-year"
                type="number"
                min={2026}
                max={2100}
                value={recordForm.year}
                onChange={(e) => updateRecordForm('year', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-month">{t('financial_pl.jpk.purchaseRecords.form.month', 'Month')}</Label>
              <Select value={recordForm.month} onValueChange={(value) => updateRecordForm('month', value)}>
                <SelectTrigger id="rec-month">
                  <SelectValue placeholder={t('financial_pl.jpk.purchaseRecords.form.month', 'Month')} />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {String(m).padStart(2, '0')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-document">{t('financial_pl.jpk.purchaseRecords.form.documentNumber', 'Document number')}</Label>
              <Input
                id="rec-document"
                value={recordForm.documentNumber}
                onChange={(e) => updateRecordForm('documentNumber', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-date">{t('financial_pl.jpk.purchaseRecords.form.purchaseDate', 'Purchase date')}</Label>
              <IsoDatePicker
                id="rec-date"
                value={recordForm.purchaseDate}
                onChange={(next) => updateRecordForm('purchaseDate', next)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-nip">{t('financial_pl.jpk.purchaseRecords.form.supplierNip', 'Supplier NIP')}</Label>
              <Input
                id="rec-nip"
                inputMode="numeric"
                value={recordForm.supplierNip}
                onChange={(e) => updateRecordForm('supplierNip', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-supplier">{t('financial_pl.jpk.purchaseRecords.form.supplierName', 'Supplier name')}</Label>
              <Input
                id="rec-supplier"
                value={recordForm.supplierName}
                onChange={(e) => updateRecordForm('supplierName', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-net">{t('financial_pl.jpk.purchaseRecords.form.net', 'Net (other)')}</Label>
              <Input
                id="rec-net"
                inputMode="decimal"
                value={recordForm.netOther}
                onChange={(e) => updateRecordForm('netOther', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rec-vat">{t('financial_pl.jpk.purchaseRecords.form.vat', 'VAT (other)')}</Label>
              <Input
                id="rec-vat"
                inputMode="decimal"
                value={recordForm.vatOther}
                onChange={(e) => updateRecordForm('vatOther', e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={busy}>
              {t('financial_pl.jpk.purchaseRecords.form.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleAddRecord} disabled={busy}>
              {t('financial_pl.jpk.purchaseRecords.form.save', 'Add record')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {ConfirmDialogElement}
    </Page>
  )
}
