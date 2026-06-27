/**
 * JPK_VAT KSeF marking derivation (broszura "JPK_VAT z deklaracją od 1 lutego 2026 r.").
 *
 * From 2026-02-01 each JPK_V7M/V7K(3) evidence row carries a mutually-exclusive KSeF
 * marking. This derives it from the connector's own per-invoice state. It is
 * deliberately CONSERVATIVE: the absence of a KSeF number is NEVER reported as `BFK`
 * (it could be an in-flight invoice) — `BFK` requires an explicit outside-KSeF signal,
 * and an undetermined invoice returns `{ marking: null, pending: true }`.
 *
 *  - `NrKSeF` — accepted in KSeF, the number is reported.
 *  - `OFF`    — issued during an announced KSeF awaria (art. 106nf), no number yet.
 *  - `DI`     — offline24 / niedostępność (art. 106nda/106nh), no number yet (later corrected to NrKSeF).
 *  - `BFK`    — lawfully issued OUTSIDE KSeF (consumer/legacy/pre-obligation).
 */
export type JpkVatMarking = 'NrKSeF' | 'OFF' | 'BFK' | 'DI'

export type JpkVatMarkingResult =
  | { marking: JpkVatMarking; ksefNumber?: string }
  | { marking: null; pending: true }

export type DeriveJpkVatMarkingInput = {
  /** Latest invoice-submission status, or undefined/null when there is no submission. */
  ksefStatus?: string | null
  /** The assigned KSeF number, when accepted. */
  ksefNumber?: string | null
  /** The issuance mode of the submission (online/offline24/awaryjny). */
  mode?: string | null
  /** Explicit operator signal that the invoice was lawfully issued outside KSeF. */
  issuedOutsideKsef?: boolean | null
}

export function deriveJpkVatMarking(input: DeriveJpkVatMarkingInput): JpkVatMarkingResult {
  const ksefNumber = typeof input.ksefNumber === 'string' ? input.ksefNumber.trim() : ''

  // 1. Accepted with a KSeF number → NrKSeF (also the post-acceptance state of an
  //    invoice originally issued offline24/awaria, which is then reported by its number).
  if (input.ksefStatus === 'accepted' && ksefNumber) {
    return { marking: 'NrKSeF', ksefNumber }
  }

  // 2. Explicit outside-KSeF issuance → BFK (never inferred from a missing number).
  if (input.issuedOutsideKsef) {
    return { marking: 'BFK' }
  }

  // 3. Offline/emergency issuance still awaiting a KSeF number.
  if (!ksefNumber) {
    if (input.mode === 'awaryjny') return { marking: 'OFF' }
    if (input.mode === 'offline24') return { marking: 'DI' }
  }

  // 4. Undetermined (queued/processing/ready/no submission) — not yet markable.
  return { marking: null, pending: true }
}
