'use client'

import * as React from 'react'
import { Check, Copy, Download, AlertTriangle, Clock } from 'lucide-react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type BadgeVariant = 'success' | 'warning' | 'info' | 'neutral' | 'error'

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  accepted: 'success',
  offline_issued: 'success',
  ready: 'info',
  queued: 'info',
  processing: 'warning',
  rejected: 'error',
  not_applicable: 'neutral',
}

export type KsefStatusCellProps = {
  status: string | null
  ksefNumber: string | null
  submissionId?: string | null
  upoAvailable?: boolean
  /** For an offline-issued row: the statutory send-to-KSeF deadline (ISO string). */
  offlineSendDeadlineAt?: string | null
}

/** Format an ISO deadline for display; returns the raw value if it cannot be parsed. */
export function formatDeadline(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/**
 * An offline-issued row is OVERDUE when its statutory send-to-KSeF deadline is in
 * the past AND the row has not yet been accepted (the retroactive KSeF number lands
 * on acceptance). Accepted/non-offline rows are never overdue. Pure + testable.
 */
export function isOfflineSendOverdue(
  status: string | null,
  offlineSendDeadlineAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (status !== 'offline_issued' || !offlineSendDeadlineAt) return false
  const t = new Date(offlineSendDeadlineAt).getTime()
  if (Number.isNaN(t)) return false
  return t < now
}

/**
 * KSeF status pill for the sales-invoices DataTable. Renders the enriched
 * `_financial_pl` state as a DS semantic status `Badge`, plus — on an accepted
 * row — the numer KSeF as selectable, copyable text and a UPO download link (the
 * legal acceptance receipt). DS tokens only; no hardcoded status colors.
 */
export default function KsefStatusCell({
  status,
  ksefNumber,
  submissionId,
  upoAvailable,
  offlineSendDeadlineAt,
}: KsefStatusCellProps) {
  const t = useT()
  const [copied, setCopied] = React.useState(false)
  if (!status || status === 'not_applicable') return null
  const variant = STATUS_VARIANT[status] ?? 'neutral'
  const label = t(`financial_pl.status.${status}`, status)

  // Offline-issued rows carry a statutory send-to-KSeF deadline. It is OVERDUE when
  // the deadline is in the past and the row has not yet reached an accepted KSeF
  // number (the retroactive number lands on acceptance). Accepted rows never show
  // an overdue alert even if the original deadline has since passed.
  const showOfflineDeadline = status === 'offline_issued' && Boolean(offlineSendDeadlineAt)
  const isOverdue = isOfflineSendOverdue(status, offlineSendDeadlineAt)

  const copyNumber = () => {
    if (!ksefNumber) return
    void navigator.clipboard
      ?.writeText(ksefNumber)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={variant}>{label}</Badge>
      {showOfflineDeadline ? (
        isOverdue ? (
          <span
            className="inline-flex items-center gap-1 text-xs font-medium text-destructive"
            title={t('financial_pl.status.offline_overdue', 'Overdue: send to KSeF past the statutory deadline')}
          >
            <AlertTriangle className="size-3.5" />
            {t('financial_pl.status.offline_overdue', 'Overdue')}
            {': '}
            {formatDeadline(offlineSendDeadlineAt as string)}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            title={t('financial_pl.fields.offlineDeadline', 'Send-to-KSeF deadline')}
          >
            <Clock className="size-3.5" />
            {t('financial_pl.fields.offlineDeadline', 'Deadline')}
            {': '}
            {formatDeadline(offlineSendDeadlineAt as string)}
          </span>
        )
      ) : null}
      {ksefNumber ? (
        <div className="flex items-start gap-1">
          <span className="select-all break-all font-mono text-xs text-muted-foreground" title={ksefNumber}>
            {ksefNumber}
          </span>
          <IconButton
            type="button"
            variant="ghost"
            aria-label={t('financial_pl.actions.copyKsefNumber', 'Copy KSeF number')}
            title={t('financial_pl.actions.copyKsefNumber', 'Copy KSeF number')}
            onClick={copyNumber}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </IconButton>
        </div>
      ) : null}
      {upoAvailable && submissionId ? (
        <a
          href={`/api/financial_pl/ksef/submissions/upo?id=${encodeURIComponent(submissionId)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          <Download className="size-3.5" />
          {t('financial_pl.actions.downloadUpo', 'Download UPO')}
        </a>
      ) : null}
    </div>
  )
}
