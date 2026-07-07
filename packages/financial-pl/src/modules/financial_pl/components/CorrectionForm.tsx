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
import { buildCreditMemoPayload } from '../lib/correction-payload'

export { buildCreditMemoPayload } from '../lib/correction-payload'
export type { CreditMemoCreatePayload } from '../lib/correction-payload'

const FEATURE_CREDIT_MEMOS = 'sales.credit_memos.manage'

/**
 * Prefill a correction line from an original invoice line. Credit-memo semantics come from the
 * document type, NOT from negative quantities — core's `creditMemoCreateSchema` enforces
 * `quantity >= 0`, so the prefilled quantity is kept POSITIVE.
 */
export function toCorrectionLine(line: InvoiceLineInput): InvoiceLineInput {
  return { ...line }
}

type CreditMemoResponse = {
  creditMemoId?: string
  id?: string
  item?: { id?: string }
  error?: string
  message?: string
}
type FromCreditMemoResponse = { ok?: boolean; submissionId?: string; error?: string; message?: string }

export type CorrectionFormProps = {
  invoiceId: string
  originalInvoiceNumber: string
  originalLines: InvoiceLineInput[]
  currencyCode: string
  /** Pricing mode of the corrected original — carried onto the KOR so a gross-priced invoice
   *  corrects in gross mode (FA(3) P_9B/P_11A). The operator may flip it while authoring the KOR.
   *  Absent ⇒ net (the default). */
  priceMode?: 'net' | 'gross'
  features: string[]
  onSubmitted?: () => void
  disabled?: boolean
}

/**
 * Correction (KOR) authoring form. Captures a reason + editable correction lines
 * (prefilled from the original invoice lines with POSITIVE quantities, reusing `InvoiceLinesField`).
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
  priceMode: initialPriceMode,
  features,
  onSubmitted,
  disabled,
}: CorrectionFormProps) {
  const t = useT()
  const canManage = hasAllFeatures(features, [FEATURE_CREDIT_MEMOS])

  const [reason, setReason] = React.useState('')
  const [lines, setLines] = React.useState<InvoiceLineInput[]>(() => originalLines.map(toCorrectionLine))
  const [priceMode, setPriceMode] = React.useState<'net' | 'gross'>(initialPriceMode ?? 'net')
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
    const payload = buildCreditMemoPayload({ invoiceId, reason: reason.trim(), currencyCode, lines, priceMode })
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
          const id = create.result?.creditMemoId ?? create.result?.id ?? create.result?.item?.id
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
  }, [canManage, reason, lines, invoiceId, currencyCode, priceMode, runMutation, retryLastMutation, onSubmitted, t])

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
        <InvoiceLinesField
          value={lines}
          onChange={setLines}
          currencyCode={currencyCode}
          disabled={busyOrDisabled}
          priceMode={priceMode}
          onPriceModeChange={setPriceMode}
        />
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
