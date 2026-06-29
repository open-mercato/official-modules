import type { InjectionRowActionWidget } from '@open-mercato/shared/modules/widgets/injection'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'

type InvoiceRow = {
  id?: string
  documentType?: string | null
  _financial_pl?: { ksefStatus?: string | null } | null
}

type RowActionContext = { t?: TranslateFn }

type FromInvoiceResponse = { ok?: boolean; submissionId?: string; message?: string; error?: string }

// KSeF statuses for which the submission is already in flight or terminal-success,
// so re-sending is blocked (mirrors the DB active-submission unique index).
// `rejected` remains eligible as a Retry; `not_applicable`/`ready`/`offline_issued`
// are likewise eligible.
const BLOCKED_KSEF_STATUSES = new Set(['queued', 'processing', 'accepted'])

// Window (ms) during which a second click on the same row confirms the send.
// The first click arms; a stale arm is ignored so a confirm is always deliberate.
const CONFIRM_WINDOW_MS = 8000

type ArmedSend = { invoiceId: string; armedAt: number }

/**
 * KSeF send row action — queues a KSeF submission for an issued sales invoice by
 * POSTing to the financial_pl from-invoice endpoint. Injected into
 * `data-table:sales.invoices:row-actions`.
 *
 * Submitting to KSeF is an IRREVERSIBLE legal filing, so the action is guarded:
 *
 * 1. Eligibility — proforma documents and invoices already accepted/queued/
 *    processing/sent are refused with a localized toast (no request is made).
 * 2. Confirmation — because a declarative row action cannot host a modal dialog
 *    and `window.confirm` is banned, the first click *arms* the send (localized
 *    warning toast) and a second click on the same row within a short window
 *    confirms it. This keeps an irreversible filing from firing on a single
 *    accidental click without depending on React context.
 * 3. Fallback — when the response is not ok and carries no `error` field, a
 *    localized fallback error toast is shown so the action never silently no-ops.
 *
 * Success / server-validation copy is owned by the server route (returned pre-translated as
 * `message` / `error`), so it is always localized. Client-side guard copy is localized via the
 * host-provided translator (`context.t`) WHEN the row-action host supplies one; the core DataTable
 * row-action context currently passes only `{ navigate }`, so absent `context.t` the guard copy
 * falls back to the built-in English text. The keys below exist in all four locales, so guard copy
 * localizes automatically once the host threads a translator into the row-action context (H7 —
 * full localization of the guard toasts depends on that core contract addition).
 */
const widget: InjectionRowActionWidget = {
  metadata: {
    id: 'financial_pl.injection.ksef-send-action',
    title: 'Send to KSeF',
    description: 'Submits an issued sales invoice to the Polish KSeF system.',
    features: ['financial_pl.submit'],
    priority: 100,
    enabled: true,
  },
  rowActions: [
    {
      id: 'financial_pl.ksef-send',
      label: 'financial_pl.actions.sendToKsef',
      icon: 'send',
      async onSelect(row, context) {
        const invoice = (row ?? {}) as InvoiceRow
        const ctx = (context ?? {}) as RowActionContext
        const translate: TranslateFn = ctx.t ?? ((_key, fallback) => (typeof fallback === 'string' ? fallback : _key))
        if (!invoice.id) return

        const documentType = typeof invoice.documentType === 'string' ? invoice.documentType : null
        if (documentType === 'proforma') {
          flash(
            translate('financial_pl.errors.proformaNotEligible', 'Pro forma invoices cannot be sent to KSeF.'),
            'error',
          )
          return
        }

        const ksefStatus =
          typeof invoice._financial_pl?.ksefStatus === 'string'
            ? invoice._financial_pl.ksefStatus.toLowerCase()
            : null
        if (ksefStatus && BLOCKED_KSEF_STATUSES.has(ksefStatus)) {
          flash(
            translate(
              'financial_pl.errors.alreadySubmitted',
              'This invoice is already submitted to KSeF and cannot be sent again.',
            ),
            'error',
          )
          return
        }

        const store = globalThis as typeof globalThis & { __omKsefArmedSend?: ArmedSend }
        const armed = store.__omKsefArmedSend
        const now = Date.now()
        const isConfirmed =
          armed && armed.invoiceId === invoice.id && now - armed.armedAt <= CONFIRM_WINDOW_MS
        if (!isConfirmed) {
          store.__omKsefArmedSend = { invoiceId: invoice.id, armedAt: now }
          flash(
            translate(
              'financial_pl.actions.sendToKsefConfirm',
              'Sending to KSeF is irreversible. Click "Send to KSeF" again to confirm.',
            ),
            'warning',
          )
          return
        }
        store.__omKsefArmedSend = undefined

        const call = await apiCall<FromInvoiceResponse>('/api/financial_pl/ksef/submissions/from-invoice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ salesInvoiceId: invoice.id }),
        })
        const message = typeof call.result?.message === 'string' ? call.result.message : null
        const error = typeof call.result?.error === 'string' ? call.result.error : null
        if (call.ok) {
          flash(message ?? translate('financial_pl.actions.sendToKsefQueued', 'Invoice queued for KSeF submission.'), 'success')
        } else {
          flash(error ?? translate('financial_pl.errors.sendFailed', 'Failed to send the invoice to KSeF.'), 'error')
        }
      },
    },
  ],
}

export default widget
