"use client"

import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { ShieldPlus } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
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
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { ErrorMessage } from '@open-mercato/ui/backend/detail/ErrorMessage'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasAllFeatures } from '@open-mercato/shared/security/features'

type CertificateType = 'Authentication' | 'Offline'

type CertificateRow = {
  certificateSerialNumber: string
  name: string | null
  type: string | null
  status: string | null
  validFrom: string | null
  validTo: string | null
}

type CertificateListResponse = { items?: Array<Record<string, unknown>> }
type EnrollResponse = { ok?: boolean; serial?: string; status?: string; message?: string; error?: string }
type RevokeResponse = { ok?: boolean; message?: string; error?: string }
type FeatureCheckResponse = { ok?: boolean; granted?: string[] }

const CERTIFICATE_TYPES: readonly CertificateType[] = ['Authentication', 'Offline']

const FEATURE_MANAGE = 'financial_pl.manage'

const certificateStatusMap: StatusMap<'valid' | 'active' | 'issued' | 'revoked' | 'expired'> = {
  valid: 'success',
  active: 'success',
  issued: 'info',
  revoked: 'error',
  expired: 'warning',
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function statusVariant(status: string | null): StatusMap<string>[string] {
  if (!status) return 'neutral'
  return (certificateStatusMap as Record<string, StatusMap<string>[string]>)[status.toLowerCase()] ?? 'neutral'
}

export default function FinancialPlCertificatesPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.certificates',
  })
  const mutationContext = React.useMemo(() => ({ retryLastMutation }), [retryLastMutation])

  const [rows, setRows] = React.useState<CertificateRow[]>([])
  const [isLoading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [busy, setBusy] = React.useState(false)

  // UI gating (§14): never rely on a server 403 alone to hide the destructive Revoke / Enroll.
  const [canManage, setCanManage] = React.useState(false)

  // Enroll dialog state.
  const [enrollOpen, setEnrollOpen] = React.useState(false)
  const [enrollName, setEnrollName] = React.useState('')
  const [enrollType, setEnrollType] = React.useState<CertificateType>('Authentication')

  const refresh = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await apiCall<FeatureCheckResponse>('/api/auth/feature-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: [FEATURE_MANAGE] }),
        })
        if (cancelled) return
        setCanManage(hasAllFeatures(res.result?.granted ?? [], [FEATURE_MANAGE]))
      } catch {
        if (!cancelled) setCanManage(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const loadCertificates = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const call = await apiCall<CertificateListResponse>('/api/financial_pl/ksef/certificates')
      if (!call.ok) {
        // 409 = no certificate credential configured: surface a friendly, recoverable message.
        const message =
          call.status === 409
            ? t('financial_pl.certificates.errors.noCredential', 'No KSeF certificate credential is configured for this organization.')
            : t('financial_pl.certificates.errors.load', 'Failed to load KSeF certificates.')
        setError(message)
        setRows([])
        return
      }
      const payload = call.result ?? {}
      const items = Array.isArray(payload.items) ? payload.items : []
      setRows(
        items.map((item) => ({
          certificateSerialNumber: asString(item.certificateSerialNumber) ?? '',
          name: asString(item.name),
          type: asString(item.type),
          status: asString(item.status),
          validFrom: asString(item.validFrom),
          validTo: asString(item.validTo),
        })),
      )
    } catch (err) {
      console.error('financial_pl.certificates.load', err)
      setError(t('financial_pl.certificates.errors.load', 'Failed to load KSeF certificates.'))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void loadCertificates()
  }, [loadCertificates, reloadToken, scopeVersion])

  const openEnrollDialog = React.useCallback(() => {
    setEnrollName('')
    setEnrollType('Authentication')
    setEnrollOpen(true)
  }, [])

  const handleEnroll = React.useCallback(async () => {
    const certificateName = enrollName.trim()
    if (!certificateName) {
      flash(t('financial_pl.certificates.enroll.errors.nameRequired', 'A certificate name is required.'), 'error')
      return
    }
    setBusy(true)
    try {
      await runMutation({
        operation: async () => {
          const call = await apiCall<EnrollResponse>('/api/financial_pl/ksef/certificates/enroll', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ certificateName, certificateType: enrollType }),
          })
          if (!call.ok) {
            throw new Error(
              call.result?.error ?? t('financial_pl.certificates.enroll.errors.failed', 'Failed to enroll the certificate.'),
            )
          }
          flash(
            call.result?.message ?? t('financial_pl.certificates.enroll.messages.enrolled', 'KSeF certificate enrolled.'),
            'success',
          )
          return call
        },
        context: mutationContext,
        mutationPayload: { action: 'enroll', certificateName, certificateType: enrollType },
      })
      setEnrollOpen(false)
      refresh()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : t('financial_pl.certificates.enroll.errors.failed', 'Failed to enroll the certificate.'),
        'error',
      )
    } finally {
      setBusy(false)
    }
  }, [enrollName, enrollType, mutationContext, refresh, runMutation, t])

  const handleRevoke = React.useCallback(
    async (row: CertificateRow) => {
      const ok = await confirm({
        title: t('financial_pl.certificates.revoke.title', 'Revoke certificate'),
        text: t(
          'financial_pl.certificates.revoke.text',
          'Revoking a KSeF certificate is irreversible and may disrupt signing. Revoke this certificate now?',
        ),
        confirmText: t('financial_pl.certificates.revoke.confirm', 'Revoke'),
        variant: 'destructive',
      })
      if (!ok) return
      setBusy(true)
      try {
        await runMutation({
          operation: async () => {
            const call = await apiCall<RevokeResponse>('/api/financial_pl/ksef/certificates/revoke', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ serialNumber: row.certificateSerialNumber }),
            })
            if (!call.ok) {
              throw new Error(
                call.result?.error ?? t('financial_pl.certificates.revoke.errors.failed', 'Failed to revoke the certificate.'),
              )
            }
            flash(
              call.result?.message ?? t('financial_pl.certificates.revoke.messages.revoked', 'KSeF certificate revoked.'),
              'success',
            )
            return call
          },
          context: mutationContext,
          mutationPayload: { action: 'revoke', serialNumber: row.certificateSerialNumber },
        })
        refresh()
      } catch (err) {
        flash(
          err instanceof Error
            ? err.message
            : t('financial_pl.certificates.revoke.errors.failed', 'Failed to revoke the certificate.'),
          'error',
        )
      } finally {
        setBusy(false)
      }
    },
    [confirm, mutationContext, refresh, runMutation, t],
  )

  const columns = React.useMemo<ColumnDef<CertificateRow>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('financial_pl.certificates.table.name', 'Name'),
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name ?? row.original.certificateSerialNumber}</span>
        ),
      },
      {
        id: 'serialNumber',
        accessorKey: 'certificateSerialNumber',
        header: t('financial_pl.certificates.table.serialNumber', 'Serial number'),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">{row.original.certificateSerialNumber}</span>
        ),
      },
      {
        id: 'type',
        accessorKey: 'type',
        header: t('financial_pl.certificates.table.type', 'Type'),
        cell: ({ row }) => <span className="text-sm">{row.original.type ?? '—'}</span>,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: t('financial_pl.certificates.table.status', 'Status'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status ? (
            <StatusBadge variant={statusVariant(row.original.status)} dot>
              {t(`financial_pl.certificates.status.${row.original.status.toLowerCase()}`, row.original.status)}
            </StatusBadge>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          ),
      },
      {
        id: 'validTo',
        accessorKey: 'validTo',
        header: t('financial_pl.certificates.table.validTo', 'Valid to'),
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatDate(row.original.validTo)}</span>,
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageBody>
        <div className="flex flex-col gap-3">
          {error ? (
            <ErrorMessage label={error} />
          ) : (
            <DataTable<CertificateRow>
              stickyActionsColumn
              title={(
                <div className="flex flex-col">
                  <span>{t('financial_pl.nav.certificates', 'KSeF certificates')}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {t('financial_pl.certificates.subtitle', 'Enroll, list, and revoke KSeF certificates for this organization.')}
                  </span>
                </div>
              )}
              actions={
                canManage ? (
                  <Button onClick={openEnrollDialog} disabled={busy}>
                    <ShieldPlus className="h-4 w-4" aria-hidden />
                    {t('financial_pl.certificates.enroll.action', 'Enroll certificate')}
                  </Button>
                ) : null
              }
              columns={columns}
              data={rows}
              isLoading={isLoading}
              refreshButton={{
                label: t('financial_pl.certificates.refresh', 'Refresh'),
                onRefresh: refresh,
                isRefreshing: isLoading,
              }}
              rowActions={(row) =>
                canManage ? (
                  <RowActions
                    items={[
                      {
                        id: 'revoke',
                        label: t('financial_pl.certificates.table.actions.revoke', 'Revoke'),
                        onSelect: () => handleRevoke(row),
                        destructive: true,
                      },
                    ]}
                  />
                ) : null
              }
              emptyState={
                <div className="py-10 text-center text-sm text-muted-foreground">
                  {t('financial_pl.certificates.empty', 'No KSeF certificates yet.')}
                </div>
              }
            />
          )}
        </div>
      </PageBody>

      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('financial_pl.certificates.enroll.title', 'Enroll KSeF certificate')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cert-name">{t('financial_pl.certificates.enroll.name', 'Certificate name')}</Label>
              <Input id="cert-name" value={enrollName} onChange={(e) => setEnrollName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cert-type">{t('financial_pl.certificates.enroll.type', 'Type')}</Label>
              <Select value={enrollType} onValueChange={(value) => setEnrollType(value as CertificateType)}>
                <SelectTrigger id="cert-type">
                  <SelectValue placeholder={t('financial_pl.certificates.enroll.type', 'Type')} />
                </SelectTrigger>
                <SelectContent>
                  {CERTIFICATE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`financial_pl.certificates.type.${type.toLowerCase()}`, type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEnrollOpen(false)} disabled={busy}>
              {t('financial_pl.certificates.enroll.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleEnroll} disabled={busy}>
              {t('financial_pl.certificates.enroll.submit', 'Enroll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {ConfirmDialogElement}
    </Page>
  )
}
