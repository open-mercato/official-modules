/**
 * Maps KSeF 2.0 numeric session/invoice status codes onto the connector's
 * domain status enum. Codes verified against the CIRFMF/ksef-docs status model
 * and the live TEST OpenAPI; the catalogue beyond the well-known codes is open,
 * so unknown codes default to `processing` (never silently to `accepted`).
 */

export type KsefSubmissionStatus =
  | 'not_applicable'
  | 'ready'
  | 'queued'
  | 'processing'
  | 'accepted'
  | 'rejected'
  | 'offline_issued'

export type KsefStatusEvaluation = {
  status: KsefSubmissionStatus
  /** Terminal = no further polling needed. */
  terminal: boolean
  /** A duplicate of an already-accepted invoice (KSeF returns the original number). */
  duplicate: boolean
}

const ACCEPTED = 200
const SESSION_IN_PROGRESS = 100
const SESSION_BATCH_PROCESSING = 150

// 440 at the INVOICE scope means the submitted invoice is a DUPLICATE of one
// already registered in KSeF (detection key: seller NIP + RodzajFaktury + invoice
// number). The original invoice IS legally accepted — the 440 status carries
// `status.extensions.originalKsefNumber` + `originalSessionReferenceNumber`, from
// which the caller recovers the original KSeF number and its UPO. So at the
// invoice scope 440 is an `accepted` DUPLICATE (never a rejection — a retry or
// redelivery of an already-accepted invoice must not be reported as failed). The
// caller still only finalizes `accepted` once it has fetched the UPO. At the
// SESSION scope 440 is a terminal failure (cancelled/timed out), handled separately.
const INVOICE_DUPLICATE = 440

const accepted = (duplicate: boolean): KsefStatusEvaluation => ({ status: 'accepted', terminal: true, duplicate })
const rejected: KsefStatusEvaluation = { status: 'rejected', terminal: true, duplicate: false }
const processing: KsefStatusEvaluation = { status: 'processing', terminal: false, duplicate: false }

export function evaluateInvoiceStatus(code: number): KsefStatusEvaluation {
  if (code === ACCEPTED) return accepted(false)
  if (code === INVOICE_DUPLICATE) return accepted(true)
  if (code >= 400) return rejected
  return processing
}

export function evaluateSessionStatus(code: number): KsefStatusEvaluation {
  if (code === ACCEPTED) return accepted(false)
  if (code === SESSION_IN_PROGRESS || code === SESSION_BATCH_PROCESSING) return processing
  // 440 (cancelled/timeout), 445 (validation error), 420 (invoice-limit exceeded)
  // and any other 4xx are terminal session failures.
  if (code >= 400) return rejected
  return processing
}
