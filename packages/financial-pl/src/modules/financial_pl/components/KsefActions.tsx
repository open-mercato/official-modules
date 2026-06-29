'use client'

import * as React from 'react'
import { Send, RefreshCw, Download, FileText, WifiOff } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasAllFeatures } from '@open-mercato/shared/security/features'

/** The latest KSeF submission for the invoice, as resolved by the host page. */
export type KsefSubmissionSummary = {
  id: string
  status: string | null
  ksefNumber?: string | null
  upoAvailable?: boolean
}

export type KsefActionsProps = {
  invoiceId: string
  submission?: KsefSubmissionSummary | null
  /** The caller's granted feature ids (wildcard-aware). */
  features: string[]
  /** Invoked after a successful state-changing action so the page can refetch. */
  onChanged?: () => void
}

const FEATURE_SUBMIT = 'financial_pl.submit'
const FEATURE_MANAGE = 'financial_pl.manage'
const FEATURE_VIEW = 'financial_pl.view'

// KSeF statuses for which the submission is terminal-success or in flight, so a
// fresh send / retry is not eligible.
const NON_RETRYABLE_STATUSES = new Set(['accepted', 'queued', 'processing'])

type ActionResponse = { ok?: boolean; message?: string; error?: string }

function resolveMessage(result: ActionResponse | null, key: keyof ActionResponse): string | null {
  const value = result?.[key]
  return typeof value === 'string' ? value : null
}

/**
 * KSeF action bar for an invoice detail surface. Renders feature-gated buttons —
 * Send to KSeF (arm-then-confirm via `useConfirmDialog`), Retry (latest non-accepted
 * submission), Download UPO, Download PDF, Issue offline — wired to the existing
 * `financial_pl` routes via `apiCall` + `useGuardedMutation`. Gating is wildcard-aware
 * (`hasAllFeatures`, never `Array.includes`): Send/Retry → `financial_pl.submit`;
 * Issue-offline → `financial_pl.manage` (matching its route); UPO/PDF → `financial_pl.view`.
 * The UI hides what the caller cannot do; the server routes enforce the same features independently.
 */
export function KsefActions({ invoiceId, submission, features, onChanged }: KsefActionsProps) {
  const t = useT()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [busy, setBusy] = React.useState(false)

  const canSubmit = hasAllFeatures(features, [FEATURE_SUBMIT])
  const canManage = hasAllFeatures(features, [FEATURE_MANAGE])
  const canView = hasAllFeatures(features, [FEATURE_VIEW])

  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.ksef-actions',
  })

  const status = submission?.status ?? null
  const canSend = !status || !NON_RETRYABLE_STATUSES.has(status)
  const retryTarget = submission && !NON_RETRYABLE_STATUSES.has(submission.status ?? '') ? submission : null
  const upoTarget = submission && submission.upoAvailable ? submission : null

  const runAction = React.useCallback(
    async (params: {
      path: string
      body: Record<string, unknown>
      successFallback: string
      errorFallback: string
    }) => {
      setBusy(true)
      try {
        await runMutation({
          operation: async () => {
            const call = await apiCall<ActionResponse>(params.path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(params.body),
            })
            if (!call.ok) {
              throw new Error(resolveMessage(call.result, 'error') ?? t(`financial_pl.errors.actionFailed`, params.errorFallback))
            }
            flash(resolveMessage(call.result, 'message') ?? t('financial_pl.actions.succeeded', params.successFallback), 'success')
            return call
          },
          context: { retryLastMutation },
          mutationPayload: params.body,
        })
        onChanged?.()
      } catch (err) {
        flash(err instanceof Error ? err.message : t('financial_pl.errors.actionFailed', params.errorFallback), 'error')
      } finally {
        setBusy(false)
      }
    },
    [runMutation, retryLastMutation, onChanged, t],
  )

  const handleSend = React.useCallback(async () => {
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
    await runAction({
      path: '/api/financial_pl/ksef/submissions/from-invoice',
      body: { salesInvoiceId: invoiceId },
      successFallback: 'Invoice queued for KSeF submission.',
      errorFallback: 'Failed to send the invoice to KSeF.',
    })
  }, [confirm, runAction, invoiceId, t])

  const handleRetry = React.useCallback(async () => {
    if (!retryTarget) return
    await runAction({
      path: '/api/financial_pl/ksef/submissions/retry',
      body: { id: retryTarget.id },
      successFallback: 'Submission retried.',
      errorFallback: 'Failed to retry the KSeF submission.',
    })
  }, [runAction, retryTarget])

  const handleIssueOffline = React.useCallback(async () => {
    const ok = await confirm({
      title: t('financial_pl.actions.issueOffline', 'Issue offline'),
      text: t(
        'financial_pl.actions.issueOfflineConfirm',
        'Issue this invoice offline (offline24)? It must be sent to KSeF before the statutory deadline.',
      ),
      confirmText: t('financial_pl.actions.issueOffline', 'Issue offline'),
    })
    if (!ok) return
    await runAction({
      path: '/api/financial_pl/ksef/submissions/issue-offline',
      body: { salesInvoiceId: invoiceId, mode: 'offline24' },
      successFallback: 'Invoice issued offline.',
      errorFallback: 'Failed to issue the invoice offline.',
    })
  }, [confirm, runAction, invoiceId, t])

  const openPdf = React.useCallback(() => {
    if (typeof window === 'undefined') return
    const href = `/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=${encodeURIComponent(invoiceId)}`
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [invoiceId])

  const openUpo = React.useCallback(() => {
    if (typeof window === 'undefined' || !upoTarget) return
    const href = `/api/financial_pl/ksef/submissions/upo?id=${encodeURIComponent(upoTarget.id)}`
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [upoTarget])

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canSubmit && canSend ? (
        <Button type="button" disabled={busy} onClick={handleSend}>
          <Send className="mr-1 size-4" />
          {t('financial_pl.actions.sendToKsef', 'Send to KSeF')}
        </Button>
      ) : null}

      {canSubmit && retryTarget ? (
        <Button type="button" variant="outline" disabled={busy} onClick={handleRetry}>
          <RefreshCw className="mr-1 size-4" />
          {t('financial_pl.actions.retry', 'Retry')}
        </Button>
      ) : null}

      {canView && upoTarget ? (
        <Button type="button" variant="outline" disabled={busy} onClick={openUpo}>
          <Download className="mr-1 size-4" />
          {t('financial_pl.actions.downloadUpo', 'Download UPO')}
        </Button>
      ) : null}

      {canView ? (
        <Button type="button" variant="outline" disabled={busy} onClick={openPdf}>
          <FileText className="mr-1 size-4" />
          {t('financial_pl.actions.downloadInvoicePdf', 'Download PDF')}
        </Button>
      ) : null}

      {canManage && canSend ? (
        <Button type="button" variant="outline" disabled={busy} onClick={handleIssueOffline}>
          <WifiOff className="mr-1 size-4" />
          {t('financial_pl.actions.issueOffline', 'Issue offline')}
        </Button>
      ) : null}

      {ConfirmDialogElement}
    </div>
  )
}

export default KsefActions
