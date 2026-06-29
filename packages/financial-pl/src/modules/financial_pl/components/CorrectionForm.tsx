'use client'

import * as React from 'react'
import { FileWarning } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasAllFeatures } from '@open-mercato/shared/security/features'
import { InvoiceLinesField, type InvoiceLineInput } from './InvoiceLinesField'

const FEATURE_CREDIT_MEMOS = 'sales.credit_memos.manage'

/** Negate a decimal-string amount; returns '' for non-parseable input. */
function negateAmount(value: string | undefined): string {
  if (value == null || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return String(-n)
}

/** Prefill a correction line as the negative of an original invoice line (quantity negated). */
export function toNegativeLine(line: InvoiceLineInput): InvoiceLineInput {
  return { ...line, quantity: negateAmount(line.quantity) }
}

type CreditMemoResponse = { id?: string; item?: { id?: string }; error?: string; message?: string }
type FromCreditMemoResponse = { ok?: boolean; submissionId?: string; error?: string; message?: string }

export type CorrectionFormProps = {
  invoiceId: string
  originalInvoiceNumber: string
  originalLines: InvoiceLineInput[]
  currencyCode: string
  features: string[]
  onSubmitted?: () => void
  disabled?: boolean
}

/**
 * Correction (KOR) authoring form. Captures a reason + editable correction lines
 * (prefilled as the negative of the original invoice lines, reusing `InvoiceLinesField`).
 * On submit it creates a `SalesCreditMemo` via core `POST /api/sales/credit-memos`
 * (corrected `invoiceId` + `reason` + lines), then sends it via the existing
 * `submissions/from-credit-memo` route. The trigger is gated on
 * `sales.credit_memos.manage` (wildcard-aware). `useGuardedMutation` + `flash`.
 */
export function CorrectionForm({
  invoiceId,
  originalInvoiceNumber,
  originalLines,
  currencyCode,
  features,
  onSubmitted,
  disabled,
}: CorrectionFormProps) {
  const t = useT()
  const canManage = hasAllFeatures(features, [FEATURE_CREDIT_MEMOS])

  const [reason, setReason] = React.useState('')
  const [lines, setLines] = React.useState<InvoiceLineInput[]>(() => originalLines.map(toNegativeLine))
  const [busy, setBusy] = React.useState(false)

  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.correction',
  })

  const busyOrDisabled = busy || Boolean(disabled)

  const handleSubmit = React.useCallback(async () => {
    if (!canManage) return
    if (!reason.trim().length) {
      flash(t('financial_pl.correction.reasonRequired', 'A correction reason is required.'), 'error')
      return
    }
    const payload = { invoiceId, reason: reason.trim(), lines }
    setBusy(true)
    try {
      const creditMemoId = await runMutation<string>({
        operation: async () => {
          const create = await apiCall<CreditMemoResponse>('/api/sales/credit-memos', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!create.ok) {
            throw new Error(
              (typeof create.result?.error === 'string' ? create.result.error : null) ??
                t('financial_pl.correction.createFailed', 'Failed to create the credit memo.'),
            )
          }
          const id = create.result?.id ?? create.result?.item?.id
          if (!id) {
            throw new Error(t('financial_pl.correction.createFailed', 'Failed to create the credit memo.'))
          }
          const send = await apiCall<FromCreditMemoResponse>('/api/financial_pl/ksef/submissions/from-credit-memo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ creditMemoId: id }),
          })
          if (!send.ok) {
            throw new Error(
              (typeof send.result?.error === 'string' ? send.result.error : null) ??
                t('financial_pl.correction.sendFailed', 'Failed to send the correction to KSeF.'),
            )
          }
          flash(
            (typeof send.result?.message === 'string' ? send.result.message : null) ??
              t('financial_pl.actions.sendCorrectionToKsefQueued', 'Correction queued for KSeF submission.'),
            'success',
          )
          return id
        },
        context: { retryLastMutation },
        mutationPayload: payload,
      })
      if (creditMemoId) onSubmitted?.()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : t('financial_pl.correction.sendFailed', 'Failed to send the correction to KSeF.'),
        'error',
      )
    } finally {
      setBusy(false)
    }
  }, [canManage, reason, lines, invoiceId, runMutation, retryLastMutation, onSubmitted, t])

  if (!canManage) {
    return (
      <Alert variant="warning">
        {t('financial_pl.correction.featureRequired', 'Issuing a correction requires the credit-memo management permission.')}
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info">
        {t('financial_pl.correction.intro', 'Issue a correction (KOR) against invoice {{number}}.', {
          number: originalInvoiceNumber,
        })}
      </Alert>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-correction-reason">
          {t('financial_pl.correction.reason', 'Correction reason')}
        </label>
        <Textarea
          id="financial_pl-correction-reason"
          value={reason}
          disabled={busyOrDisabled}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">
          {t('financial_pl.correction.lines', 'Correction lines')}
        </span>
        <InvoiceLinesField value={lines} onChange={setLines} currencyCode={currencyCode} disabled={busyOrDisabled} />
      </div>

      <div className="flex">
        <Button type="button" disabled={busyOrDisabled} onClick={handleSubmit}>
          <FileWarning className="mr-1 size-4" />
          {t('financial_pl.correction.submit', 'Issue correction')}
        </Button>
      </div>
    </div>
  )
}

export default CorrectionForm
