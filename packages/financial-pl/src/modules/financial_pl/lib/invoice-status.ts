/**
 * Sales-invoice immutability, derived from the core invoice lifecycle.
 *
 * The core `sales` module models an invoice's state with a configurable `status`
 * dictionary (`draft` / `sent` / `paid` / `void` / `canceled` / …); it has NO
 * `is_immutable` column. An invoice becomes immutable (finalized and safe to file
 * with KSeF / JPK) once its status leaves the still-editable set below — mirroring
 * the credit-memo draft gate the JPK resolver already applies (`MEMO_DRAFT_STATUSES`).
 */

/** Statuses in which a sales invoice is still editable, so it MUST NOT be submitted to KSeF or
 *  filed in JPK. Everything else (sent / paid / issued / overdue / …) is treated as issued. */
export const INVOICE_NON_ISSUED_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'void',
  'voided',
  'cancel',
  'canceled',
  'cancelled',
  'pending',
])

/**
 * Whether a core sales invoice is issued (finalized / immutable) per its `status`.
 * A missing/blank status is treated as NOT issued (conservative — never auto-submit
 * or file an invoice whose lifecycle state is unknown).
 */
export function isInvoiceIssued(status: unknown): boolean {
  if (typeof status !== 'string') return false
  const normalized = status.trim().toLowerCase()
  if (!normalized) return false
  return !INVOICE_NON_ISSUED_STATUSES.has(normalized)
}
