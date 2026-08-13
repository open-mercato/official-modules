'use client'

import * as React from 'react'
import { FileWarning } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { DatePicker } from '@open-mercato/ui/primitives/date-picker'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { DialogFooter } from '@open-mercato/ui/primitives/dialog'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT, useLocale } from '@open-mercato/shared/lib/i18n/context'
import { de as deLocale, enUS, es as esLocale, pl as plLocale } from 'date-fns/locale'
import { hasAllFeatures } from '@open-mercato/shared/security/features'
import { cn } from '@open-mercato/shared/lib/utils'
import { InvoiceLinesField, normalizeStoredLine, withComputedTotals, type InvoiceLineInput } from './InvoiceLinesField'
import { buildCreditMemoPayload } from '../lib/correction-payload'

export { buildCreditMemoPayload } from '../lib/correction-payload'
export type { CreditMemoCreatePayload } from '../lib/correction-payload'

const FEATURE_CREDIT_MEMOS = 'sales.credit_memos.manage'

/**
 * date-fns locale for the calendar. Without it the DS DatePicker falls back to US English, so a
 * Polish invoice opened a "July 2026 / Su Mo Tu" calendar.
 */
const DATE_LOCALES = { pl: plLocale, en: enUS, de: deLocale, es: esLocale } as const

/** `Date` → `yyyy-mm-dd` in LOCAL time; `toISOString()` would shift the day across a timezone. */
function toIsoDate(date: Date | null): string | undefined {
  if (!date) return undefined
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Prefill a correction line from an original invoice line. Credit-memo semantics come from the
 * document type, NOT from negative quantities — core's `creditMemoCreateSchema` enforces
 * `quantity >= 0`, so the prefilled quantity is kept POSITIVE. Decimal normalization (DB full-scale
 * "0.0000" → "0", which the ≤2-decimal discount validator would otherwise reject and blank every
 * total) is shared with the editor/detail via `normalizeStoredLine` (QA #36).
 */
export function toCorrectionLine(line: InvoiceLineInput): InvoiceLineInput {
  return normalizeStoredLine(line)
}

type CreditMemoResponse = {
  creditMemoId?: string
  id?: string
  item?: { id?: string }
  error?: string
  message?: string
}
type FromCreditMemoResponse = { ok?: boolean; submissionId?: string; error?: string; message?: string; code?: string }

export type CorrectionFormProps = {
  invoiceId: string
  originalLines: InvoiceLineInput[]
  currencyCode: string
  /** Pricing mode of the corrected original — carried onto the KOR so a gross-priced invoice
   *  corrects in gross mode (FA(3) P_9B/P_11A). The operator may flip it while authoring the KOR.
   *  Absent ⇒ net (the default). */
  priceMode?: 'net' | 'gross'
  features: string[]
  onSubmitted?: () => void
  /** Closes the surrounding dialog from the footer's Cancel button. */
  onCancel?: () => void
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
  originalLines,
  currencyCode,
  priceMode: initialPriceMode,
  features,
  onSubmitted,
  onCancel,
  disabled,
}: CorrectionFormProps) {
  const t = useT()
  const locale = useLocale()
  const dateLocale = DATE_LOCALES[(locale as keyof typeof DATE_LOCALES)] ?? plLocale
  const canManage = hasAllFeatures(features, [FEATURE_CREDIT_MEMOS])

  const [reason, setReason] = React.useState('')
  // Inline, next to the field. The missing reason used to surface only as a toast, which says
  // nothing about WHERE the problem is on a form this tall.
  const [reasonError, setReasonError] = React.useState(false)
  // The net/gross toggle is a CONTROLLED prop of InvoiceLinesField. This form passed neither the
  // value nor a change handler, so the control rendered but could never switch — owning the state
  // here is what makes it work. Seeded from the corrected invoice's own pricing mode.
  const [activePriceMode, setActivePriceMode] = React.useState<'net' | 'gross'>(initialPriceMode ?? 'net')
  // Defaults to today, but exposed: a correction is sometimes dated to the period it belongs to,
  // and the payload has always accepted `issueDate` — only the UI never offered it.
  const [issueDate, setIssueDate] = React.useState<Date | null>(() => new Date())
  const [lines, setLines] = React.useState<InvoiceLineInput[]>(() => originalLines.map(toCorrectionLine))
  const [busy, setBusy] = React.useState(false)
  // Creating the credit memo is irreversible even when the following KSeF request fails. Keep the
  // created id and retry ONLY the send step; otherwise every click would create another orphan KOR.
  const createdCreditMemoIdRef = React.useRef<string | null>(null)
  const [createdCreditMemoId, setCreatedCreditMemoId] = React.useState<string | null>(null)

  /**
   * Recompute each line's net/VAT/gross on every edit, the way the invoice form does. Without this
   * the correction rows showed "Netto: — / VAT: — / Brutto: —" no matter what was typed, so the
   * operator filed an irreversible KSeF correction without ever seeing what it was worth.
   */
  const handleLinesChange = React.useCallback(
    (next: InvoiceLineInput[]) => {
      setLines(next.map((line, index) => withComputedTotals(line, currencyCode, index + 1, activePriceMode)))
    },
    [currencyCode, activePriceMode],
  )

  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.correction',
  })
  const { confirm, ConfirmDialogElement } = useConfirmDialog()

  const busyOrDisabled = busy || Boolean(disabled)
  const formLocked = busyOrDisabled || createdCreditMemoId !== null

  // Running gross total for the footer — the operator should see what the correction is worth
  // without scrolling back through the lines.
  const grossTotal = lines.reduce((sum, line) => {
    const value = Number(line.totalGrossAmount)
    return Number.isFinite(value) ? sum + value : sum
  }, 0)
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  const grossTotalText = money(grossTotal)
  // "Before" comes from the untouched originals the form was seeded with, so the operator can see
  // what the correction actually changes — a KOR is a difference, and showing only the new figures
  // meant filing an irreversible document without ever seeing the delta.
  const originalGrossTotal = originalLines.reduce((sum, line) => {
    const value = Number(line.totalGrossAmount)
    return Number.isFinite(value) ? sum + value : sum
  }, 0)
  const grossDelta = grossTotal - originalGrossTotal
  const deltaText = `${grossDelta > 0 ? '+' : ''}${money(grossDelta)}`

  const handleSubmit = React.useCallback(async () => {
    if (!canManage) return
    if (!reason.trim().length) {
      setReasonError(true)
      document.getElementById('financial_pl-correction-reason')?.focus()
      flash(t('financial_pl.correction.reasonRequired', 'A correction reason is required.'), 'error')
      return
    }
    setReasonError(false)
    // Arm-then-confirm, matching "Send to KSeF" on the invoice itself: issuing a correction files a
    // legal document that cannot be withdrawn, and it fired on a single click while the far less
    // consequential single-invoice send asked first.
    const confirmed = await confirm({
      title: t('financial_pl.correction.submit', 'Issue correction'),
      text: t(
        'financial_pl.correction.confirmDialog',
        'Issuing a correction files it to KSeF and cannot be undone. Issue it now?',
      ),
      confirmText: t('financial_pl.correction.submit', 'Issue correction'),
      variant: 'destructive',
    })
    if (!confirmed) return
    const payload = buildCreditMemoPayload({ invoiceId, reason: reason.trim(), currencyCode, lines, priceMode: activePriceMode, issueDate: toIsoDate(issueDate) })
    setBusy(true)
    try {
      const creditMemoId = await runMutation<string>({
        operation: async () => {
          let id = createdCreditMemoIdRef.current
          if (!id) {
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
            id = create.result?.creditMemoId ?? create.result?.id ?? create.result?.item?.id ?? null
            if (!id) {
              throw new Error(t('financial_pl.correction.createFailed', 'Failed to create the credit memo.'))
            }
            // Set this before the KSeF call: a failed request must leave the form in send-only retry
            // mode, including retries initiated by useGuardedMutation itself.
            createdCreditMemoIdRef.current = id
            setCreatedCreditMemoId(id)
          }
          // The credit memo was just created; its core projection can lag, so the KSeF send may
          // return `source_not_ready` (409). Retry the SAME credit-memo id a few times before
          // surfacing — the server send is idempotent (credit_memo active-unique index), so this
          // never double-files the correction (QA #41).
          const sendOnce = () =>
            apiCall<FromCreditMemoResponse>('/api/financial_pl/ksef/submissions/from-credit-memo', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ creditMemoId: id }),
            })
          let send = await sendOnce()
          for (let attempt = 0; attempt < 4 && !send.ok && send.result?.code === 'source_not_ready'; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
            send = await sendOnce()
          }
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
  }, [canManage, confirm, reason, reasonError, issueDate, lines, invoiceId, currencyCode, activePriceMode, runMutation, retryLastMutation, onSubmitted, t])

  if (!canManage) {
    return (
      <Alert variant="warning">
        {t('financial_pl.correction.featureRequired', 'Issuing a correction requires the credit-memo management permission.')}
      </Alert>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Only this middle band scrolls — header and footer stay put outside it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-correction-reason">
          {t('financial_pl.correction.reason', 'Correction reason')}{' '}
          <span aria-hidden="true" className="text-status-error-text">*</span>
        </label>
        <Textarea
          id="financial_pl-correction-reason"
          value={reason}
          disabled={formLocked}
          aria-invalid={reasonError || undefined}
          aria-describedby={reasonError ? 'financial_pl-correction-reason-error' : undefined}
          onChange={(event) => {
            setReason(event.target.value)
            if (reasonError && event.target.value.trim().length) setReasonError(false)
          }}
          rows={3}
        />
        {reasonError ? (
          <span id="financial_pl-correction-reason-error" className="text-xs text-status-error-text">
            {t('financial_pl.correction.reasonRequired', 'A correction reason is required.')}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-correction-issue-date">
          {t('financial_pl.correction.issueDate', 'Correction date')}
        </label>
        {/*
          The DS DatePicker, not `<input type="date">`: the native control renders the browser's own
          calendar (its own colours, its own "Dzisiaj/Wyczyść" footer), which is not the design
          system and looks nothing like the rest of the form.
        */}
        <DatePicker
          id="financial_pl-correction-issue-date"
          value={issueDate}
          onChange={setIssueDate}
          disabled={formLocked}
          displayFormat="dd.MM.yyyy"
          locale={dateLocale}
          className="w-auto"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {t('financial_pl.correction.lines', 'Correction lines')}
          </span>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
            {t('financial_pl.correction.lineCount', '{count} item(s)', { count: lines.length })}
          </span>
        </span>
        <InvoiceLinesField
          value={lines}
          onChange={handleLinesChange}
          currencyCode={currencyCode}
          priceMode={activePriceMode}
          onPriceModeChange={setActivePriceMode}
          originalLines={originalLines}
          disabled={formLocked}
        />
      </div>

      {createdCreditMemoId ? (
        <Alert variant="warning">
          {t(
            'financial_pl.correction.createdRetryHint',
            'The correction document was created, but KSeF submission did not finish. The fields are locked; retry sends the same correction and will not create a duplicate.',
          )}
        </Alert>
      ) : null}

      {/* Before → after: the whole point of a correction is the difference. */}
      <div className="grid grid-cols-3 gap-3 rounded-md border border-border p-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">
            {t('financial_pl.correction.beforeTotal', 'Before correction')}
          </span>
          <span className="text-sm tabular-nums text-muted-foreground line-through">
            {money(originalGrossTotal)} {currencyCode}
          </span>
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">
            {t('financial_pl.correction.afterTotal', 'After correction')}
          </span>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {grossTotalText} {currencyCode}
          </span>
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">
            {t('financial_pl.correction.delta', 'Difference')}
          </span>
          <span
            className={cn(
              'text-sm font-semibold tabular-nums',
              grossDelta === 0
                ? 'text-muted-foreground'
                : grossDelta > 0
                  ? 'text-status-success-text'
                  : 'text-status-error-text',
            )}
          >
            {deltaText} {currencyCode}
          </span>
        </span>
      </div>

      </div>

      {/*
        The DS `DialogFooter` rather than a hand-rolled bar: it owns the canonical border-t rule and
        spacing, and its `leading` slot is exactly this shape — running totals on the left, the
        decision buttons right-aligned.
      */}
      <DialogFooter
        className="shrink-0 px-6 pb-6 pt-4"
        leading={
          <span className="text-sm text-muted-foreground">
            {t('financial_pl.correction.lineCount', '{count} item(s)', { count: lines.length })}
            {', '}
            {t('financial_pl.lines.totalGross', 'Gross')}: {grossTotalText} {currencyCode}
            {grossDelta !== 0 ? ` (${deltaText} ${currencyCode})` : ''}
          </span>
        }
      >
        {onCancel ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {t('financial_pl.received.cancel', 'Cancel')}
          </Button>
        ) : null}
        <Button type="button" disabled={busyOrDisabled} onClick={handleSubmit}>
          <FileWarning className="mr-1 size-4" />
          {createdCreditMemoId
            ? t('financial_pl.correction.retrySubmission', 'Retry KSeF submission')
            : t('financial_pl.correction.submit', 'Issue correction')}
        </Button>
      </DialogFooter>
      {ConfirmDialogElement}
    </div>
  )
}

export default CorrectionForm
