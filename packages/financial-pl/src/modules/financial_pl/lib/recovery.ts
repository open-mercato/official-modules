/**
 * Recovery routing for a stale KSeF submission (SPEC-007 reliability hardening).
 *
 * A `processing` row that already carries BOTH a `sessionReference` and an
 * `invoiceReference` provably reached KSeF (the send landed and KSeF returned
 * references). Such a row is recovered by RE-POLLING its status/UPO — the
 * strongest possible no-duplicate guarantee, because nothing is re-sent.
 *
 * A row missing either reference is a true orphan (the send never landed, or
 * crashed before the references were persisted): there is nothing to poll, so
 * it is recovered by the proven duplicate-safe RE-SEND path (KSeF's 440 content
 * de-duplication resolves a content-identical re-send to the original number).
 */
export function chooseRecovery(row: {
  sessionReference?: string | null
  invoiceReference?: string | null
}): 'repoll' | 'resend' {
  const hasSession = typeof row.sessionReference === 'string' && row.sessionReference.length > 0
  const hasInvoice = typeof row.invoiceReference === 'string' && row.invoiceReference.length > 0
  return hasSession && hasInvoice ? 'repoll' : 'resend'
}
