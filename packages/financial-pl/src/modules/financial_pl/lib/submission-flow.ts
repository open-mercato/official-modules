/**
 * End-to-end KSeF 2.0 send-only submission flow.
 *
 * Orchestrates the full runbook against one environment:
 *   public keys -> challenge -> token auth (poll) -> redeem access token ->
 *   open online session -> encrypt invoice -> send -> close -> poll invoice
 *   status -> fetch UPO + KSeF number.
 *
 * Pure with respect to the platform (no DB / DI): it takes a `KsefClient`, the
 * MF crypto helpers, and an injectable `wait` so it is deterministically
 * unit-testable with a mock transport, and is reused verbatim by both the
 * persistent subscriber (production path) and the live-TEST smoke runner.
 */
import {
  encryptInvoiceDocument,
  generateSymmetricKey,
  wrapSymmetricKey,
} from './crypto'
import { KsefApiError, type KsefClient, type KsefPublicKeyCertificate, type KsefStatusResult } from './ksef-client'
import { authenticate, pace, type KsefAuthConfig } from './ksef-auth'
import { evaluateInvoiceStatus, type KsefSubmissionStatus } from './status'

export type { KsefAuthConfig } from './ksef-auth'

export type KsefSubmissionInput = {
  /** Token or certificate auth — resolved per organization by the caller. */
  auth: KsefAuthConfig
  invoiceXml: string
  /**
   * Offline-issuance send flag (SPEC-010). When `true` the document was issued
   * offline (offline24/awaryjny) and this is the deferred initial send — KSeF's
   * `SendInvoiceRequest.offlineMode` is set so the invoice gets its KSeF number
   * retroactively. Defaults to `false` (the byte-identical online path).
   */
  offlineMode?: boolean
}

export type KsefSubmissionResult = {
  status: KsefSubmissionStatus
  ksefNumber?: string
  upoXml?: string
  sessionReference?: string
  invoiceReference?: string
  lastStatusCode?: number
  duplicate: boolean
  /** A re-poll found no KSeF record for the stored reference → the caller should re-send. */
  notFound?: boolean
  errorMessage?: string
}

export type KsefPollOptions = {
  authMaxAttempts: number
  authDelayMs: number
  statusMaxAttempts: number
  statusDelayMs: number
  wait: (ms: number) => Promise<void>
}

export const DEFAULT_POLL_OPTIONS: KsefPollOptions = {
  authMaxAttempts: 20,
  authDelayMs: 1500,
  statusMaxAttempts: 30,
  statusDelayMs: 2000,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function selectCertificate(
  certs: KsefPublicKeyCertificate[],
  usageNeedle: string,
): KsefPublicKeyCertificate | undefined {
  // Match strictly on the certificate's declared usage and pick the newest valid
  // one. If nothing matches we return undefined (the caller fails fast with a clear
  // "public keys unavailable" error) rather than silently encrypting with a
  // wrong-purpose key.
  const matches = certs.filter((cert) => cert.usage.some((usage) => usage.toLowerCase().includes(usageNeedle)))
  return [...matches].sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0]
}

export async function submitInvoiceToKsef(
  client: KsefClient,
  input: KsefSubmissionInput,
  options: KsefPollOptions = DEFAULT_POLL_OPTIONS,
): Promise<KsefSubmissionResult> {
  const certs = await client.getPublicKeyCertificates()
  // The symmetric-key wrap is required for every send regardless of auth method;
  // the token-encryption cert is only needed for the token auth path.
  const symmetricCert = selectCertificate(certs, 'symmetric')
  const tokenCert = selectCertificate(certs, 'token')
  if (!symmetricCert?.certificate) {
    return { status: 'rejected', duplicate: false, errorMessage: '[internal] KSeF public keys unavailable' }
  }

  const auth = await authenticate(client, tokenCert, input.auth, options)
  if (!auth.ok) {
    return { status: auth.status, duplicate: false, errorMessage: auth.errorMessage }
  }
  const accessToken = auth.accessToken

  const material = generateSymmetricKey()
  const session = await client.openOnlineSession({
    accessToken,
    encryptedSymmetricKey: wrapSymmetricKey(material, symmetricCert.certificate),
    initializationVector: material.iv.toString('base64'),
    publicKeyId: symmetricCert.publicKeyId || undefined,
  })

  const encrypted = encryptInvoiceDocument(input.invoiceXml, material)
  const sent = await pace(
    () =>
      client.sendOnlineInvoice({
        accessToken,
        sessionReference: session.referenceNumber,
        invoiceHash: encrypted.invoiceHash,
        invoiceSize: encrypted.invoiceSize,
        encryptedDocumentHash: encrypted.encryptedDocumentHash,
        encryptedDocumentSize: encrypted.encryptedDocumentSize,
        encryptedDocumentContent: encrypted.encryptedDocument.toString('base64'),
        offlineMode: input.offlineMode ?? false,
      }),
    options.wait,
  )

  await client.closeOnlineSession({ accessToken, sessionReference: session.referenceNumber })

  let evaluation = evaluateInvoiceStatus(0)
  let lastStatus: KsefStatusResult | undefined
  for (let attempt = 0; attempt < options.statusMaxAttempts; attempt += 1) {
    lastStatus = await pace(
      () =>
        client.getInvoiceStatus({
          accessToken,
          sessionReference: session.referenceNumber,
          invoiceReference: sent.referenceNumber,
        }),
      options.wait,
    )
    evaluation = evaluateInvoiceStatus(lastStatus.code)
    if (evaluation.terminal) break
    await options.wait(options.statusDelayMs)
  }

  const lastStatusCode = lastStatus?.code ?? 0
  const result: KsefSubmissionResult = {
    status: evaluation.status,
    sessionReference: session.referenceNumber,
    invoiceReference: sent.referenceNumber,
    lastStatusCode,
    duplicate: evaluation.duplicate,
  }

  if (evaluation.status === 'accepted') {
    await finalizeAccepted(client, accessToken, session.referenceNumber, sent.referenceNumber, lastStatus, result)
  } else if (evaluation.status === 'rejected') {
    const reason = lastStatus?.description ? `: ${lastStatus.description}` : ''
    // Append KSeF's per-rejection validation messages so the failure is diagnosable
    // (the generic top-level description alone — e.g. "Błąd weryfikacji semantyki" — does
    // not say WHICH element failed).
    const details = lastStatus?.details?.length ? ` — ${lastStatus.details.join('; ')}` : ''
    result.errorMessage = `KSeF rejected the invoice (status ${lastStatusCode})${reason}${details}`
  } else if (!evaluation.terminal) {
    // The status poll exhausted its attempts while KSeF was still processing. Record
    // why so the persisted `processing` row is diagnosable (not mistaken for success)
    // and a later retry re-polls it. Without this the stuck row carries no error.
    result.errorMessage = `[internal] KSeF still processing after ${options.statusMaxAttempts} status checks (last status ${lastStatusCode}); a retry will re-poll`
  }

  return result
}

/**
 * Finalize an invoice KSeF accepted at the status level. A submission is only ever
 * reported `accepted` once its UPO (the signed acceptance receipt) is in hand:
 *  - a fresh acceptance (200) takes its number + UPO from the current session;
 *  - a duplicate (440) was accepted in an EARLIER session, so its number + UPO are
 *    recovered from `status.extensions.original*` via the by-KSeF-number endpoint.
 * If the UPO cannot be obtained (transient fetch failure, or a 440 without the
 * original references), the result is left as `processing` — never a phantom
 * `accepted` without a receipt, and never `rejected` for an invoice KSeF holds —
 * so a retry re-polls/re-sends and heals it.
 */
async function finalizeAccepted(
  client: KsefClient,
  accessToken: string,
  sessionReference: string,
  invoiceReference: string,
  status: KsefStatusResult | undefined,
  result: KsefSubmissionResult,
): Promise<void> {
  try {
    if (result.duplicate) {
      const originalNumber = status?.originalKsefNumber
      const originalSession = status?.originalSessionReference
      if (!originalNumber || !originalSession) {
        result.status = 'processing'
        result.errorMessage = '[internal] KSeF duplicate (440) without recoverable original references; will re-poll'
        return
      }
      result.ksefNumber = originalNumber
      result.upoXml = await client.getInvoiceUpoByKsefNumber({
        accessToken,
        sessionReference: originalSession,
        ksefNumber: originalNumber,
      })
    } else {
      result.ksefNumber = status?.ksefNumber
      result.upoXml = await client.getInvoiceUpo({ accessToken, sessionReference, invoiceReference })
    }
    if (!result.upoXml) {
      result.status = 'processing'
      result.errorMessage = '[internal] KSeF accepted but UPO not yet available; will re-poll'
    }
  } catch (err) {
    result.status = 'processing'
    result.errorMessage = err instanceof Error ? `[internal] UPO fetch failed: ${err.message}` : '[internal] UPO fetch failed'
  }
}

/**
 * Re-poll a submission that already reached KSeF (its session + invoice reference
 * were persisted) WITHOUT re-sending — the strongest no-duplicate recovery. It
 * authenticates, polls the invoice status, and finalizes (KSeF number + UPO).
 *
 * Returns the standard result; the caller (ksef-repoll subscriber) writes a
 * terminal `accepted`/`rejected` and, for a non-terminal outcome or `notFound`
 * (KSeF has no record of the reference — e.g. the send never actually landed),
 * falls back to the duplicate-safe re-send path.
 */
export async function repollSubmission(
  client: KsefClient,
  auth: KsefAuthConfig,
  refs: { sessionReference: string; invoiceReference: string },
  options: KsefPollOptions = DEFAULT_POLL_OPTIONS,
): Promise<KsefSubmissionResult> {
  const base: KsefSubmissionResult = {
    status: 'processing',
    duplicate: false,
    sessionReference: refs.sessionReference,
    invoiceReference: refs.invoiceReference,
  }

  const certs = await client.getPublicKeyCertificates()
  const tokenCert = selectCertificate(certs, 'token')
  const authed = await authenticate(client, tokenCert, auth, options)
  if (!authed.ok) {
    return { ...base, status: authed.status, errorMessage: authed.errorMessage }
  }
  const accessToken = authed.accessToken

  let evaluation = evaluateInvoiceStatus(0)
  let lastStatus: KsefStatusResult | undefined
  for (let attempt = 0; attempt < options.statusMaxAttempts; attempt += 1) {
    try {
      lastStatus = await pace(
        () => client.getInvoiceStatus({ accessToken, sessionReference: refs.sessionReference, invoiceReference: refs.invoiceReference }),
        options.wait,
      )
    } catch (err) {
      if (err instanceof KsefApiError && err.status === 404) {
        // KSeF has no record of this reference — the original send never landed.
        // Signal a re-send fallback rather than stranding the row.
        return { ...base, notFound: true, errorMessage: '[internal] KSeF has no record of this reference; will re-send' }
      }
      throw err
    }
    evaluation = evaluateInvoiceStatus(lastStatus.code)
    if (evaluation.terminal) break
    await options.wait(options.statusDelayMs)
  }

  const result: KsefSubmissionResult = {
    ...base,
    status: evaluation.status,
    duplicate: evaluation.duplicate,
    lastStatusCode: lastStatus?.code ?? 0,
  }
  if (evaluation.status === 'accepted') {
    await finalizeAccepted(client, accessToken, refs.sessionReference, refs.invoiceReference, lastStatus, result)
  } else if (evaluation.status === 'rejected') {
    const reason = lastStatus?.description ? `: ${lastStatus.description}` : ''
    const details = lastStatus?.details?.length ? ` — ${lastStatus.details.join('; ')}` : ''
    result.errorMessage = `KSeF rejected the invoice (status ${result.lastStatusCode})${reason}${details}`
  }
  return result
}
