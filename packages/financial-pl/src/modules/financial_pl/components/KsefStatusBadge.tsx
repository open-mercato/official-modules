'use client'

import * as React from 'react'
import { AlertTriangle, Clock, Copy, Check } from 'lucide-react'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * KSeF submission statuses surfaced to the operator. Mirrors the enriched
 * `_financial_pl.ksefStatus` value set produced by the response enricher and the
 * `ksef-status-column` widget. `offline_overdue` is a synthetic UI-only role used
 * when an `offline_issued` row has passed its statutory send-to-KSeF deadline.
 */
export type KsefStatusKey =
  | 'accepted'
  | 'offline_issued'
  | 'ready'
  | 'queued'
  | 'processing'
  | 'rejected'
  | 'not_applicable'

/**
 * Semantic status-role map for the KSeF statuses (DS §22 — `StatusBadge` + a
 * `StatusMap`, never hardcoded colors). `offline_overdue` carries its own role so
 * an overdue offline row reads as an error rather than a (success) `offline_issued`.
 */
export const ksefStatusMap: StatusMap<KsefStatusKey | 'offline_overdue'> = {
  accepted: 'success',
  offline_issued: 'success',
  ready: 'info',
  queued: 'info',
  processing: 'warning',
  rejected: 'error',
  not_applicable: 'neutral',
  offline_overdue: 'error',
}

/** i18n label key per status (incl. the synthetic `offline_overdue`, review M9). */
const ksefStatusLabelKey: Record<KsefStatusKey | 'offline_overdue', string> = {
  accepted: 'financial_pl.status.accepted',
  offline_issued: 'financial_pl.status.offline_issued',
  ready: 'financial_pl.status.ready',
  queued: 'financial_pl.status.queued',
  processing: 'financial_pl.status.processing',
  rejected: 'financial_pl.status.rejected',
  not_applicable: 'financial_pl.status.not_applicable',
  offline_overdue: 'financial_pl.status.offline_overdue',
}

const ksefStatusLabelFallback: Record<KsefStatusKey | 'offline_overdue', string> = {
  accepted: 'Accepted',
  offline_issued: 'Issued offline',
  ready: 'Ready',
  queued: 'Queued',
  processing: 'Processing',
  rejected: 'Rejected',
  not_applicable: 'Not applicable',
  offline_overdue: 'Overdue',
}

/** Format an ISO deadline for display; returns the raw value if it cannot be parsed. */
function formatDeadline(iso: string): string {
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

export type KsefStatusBadgeProps = {
  status: string | null
  ksefNumber?: string | null
  /** For an offline-issued row: the statutory send-to-KSeF deadline (ISO string). */
  offlineSendDeadlineAt?: string | null
}

function isKnownStatus(value: string): value is KsefStatusKey {
  return value in ksefStatusMap
}

/**
 * KSeF status pill for invoice list/detail surfaces. Renders the KSeF state as a DS
 * semantic `StatusBadge` (via `ksefStatusMap`), and on an accepted row the numer KSeF
 * as selectable, copyable text. An overdue offline row escalates to the error role
 * with an inline overdue line. DS tokens only; no hardcoded status colors.
 */
export function KsefStatusBadge({ status, ksefNumber, offlineSendDeadlineAt }: KsefStatusBadgeProps) {
  const t = useT()
  const [copied, setCopied] = React.useState(false)

  if (!status || status === 'not_applicable') return null

  const overdue = isOfflineSendOverdue(status, offlineSendDeadlineAt)
  const showOfflineDeadline = status === 'offline_issued' && Boolean(offlineSendDeadlineAt)
  const roleKey: KsefStatusKey | 'offline_overdue' = overdue
    ? 'offline_overdue'
    : isKnownStatus(status)
      ? status
      : 'not_applicable'
  const variant = ksefStatusMap[roleKey] ?? 'neutral'
  const label = isKnownStatus(status)
    ? t(ksefStatusLabelKey[status], ksefStatusLabelFallback[status])
    : t(`financial_pl.status.${status}`, status)

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
      <StatusBadge variant={variant} dot>
        {label}
      </StatusBadge>
      {showOfflineDeadline && offlineSendDeadlineAt ? (
        overdue ? (
          <span
            className="inline-flex items-center gap-1 text-xs font-medium text-status-error-text"
            title={t('financial_pl.status.offline_overdue_hint', 'Overdue: send to KSeF past the statutory deadline')}
          >
            <AlertTriangle className="size-3.5 text-status-error-icon" aria-hidden="true" />
            {t('financial_pl.status.offline_overdue', 'Overdue')}
            {': '}
            {formatDeadline(offlineSendDeadlineAt)}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            title={t('financial_pl.fields.offlineDeadline', 'Send-to-KSeF deadline')}
          >
            <Clock className="size-3.5" aria-hidden="true" />
            {t('financial_pl.fields.offlineDeadline', 'Deadline')}
            {': '}
            {formatDeadline(offlineSendDeadlineAt)}
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
    </div>
  )
}

export default KsefStatusBadge
