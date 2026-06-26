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
  encryptAuthToken,
  encryptInvoiceDocument,
  generateSymmetricKey,
  wrapSymmetricKey,
} from './crypto'
import type { KsefClient, KsefPublicKeyCertificate, KsefStatusResult } from './ksef-client'
import { KsefApiError } from './ksef-client'
import { evaluateInvoiceStatus, type KsefSubmissionStatus } from './status'

// HTTP statuses that mean the auth OPERATION itself is terminally gone (expired/
// unauthorized/forbidden) — distinct from an in-body status.code. Polling past these
// is futile: fail fast as a terminal rejection rather than cycling the queue retry.
const TERMINAL_AUTH_HTTP_STATUSES = new Set([401, 403, 410])

export type KsefSubmissionInput = {
  ksefToken: string
  contextNip: string
  invoiceXml: string
}

export type KsefSubmissionResult = {
  status: KsefSubmissionStatus
  ksefNumber?: string
  upoXml?: string
  sessionReference?: string
  invoiceReference?: string
  lastStatusCode?: number
  duplicate: boolean
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
  const tokenCert = selectCertificate(certs, 'token')
  const symmetricCert = selectCertificate(certs, 'symmetric')
  if (!tokenCert?.certificate || !symmetricCert?.certificate) {
    return { status: 'rejected', duplicate: false, errorMessage: '[internal] KSeF public keys unavailable' }
  }

  const challenge = await client.requestChallenge()
  const encryptedToken = encryptAuthToken(input.ksefToken, challenge.timestampMs, tokenCert.certificate)
  const authInit = await client.authenticateWithToken({
    challenge: challenge.challenge,
    contextNip: input.contextNip,
    encryptedToken,
    publicKeyId: tokenCert.publicKeyId || undefined,
  })

  let authenticated = false
  for (let attempt = 0; attempt < options.authMaxAttempts; attempt += 1) {
    let authStatus
    try {
      authStatus = await client.getAuthStatus(authInit.referenceNumber, authInit.authenticationToken)
    } catch (err) {
      // A raw HTTP 401/403/410 from GET /auth/{ref} (e.g. an expired/redeemed auth
      // operation) means the auth is terminally gone — fail fast instead of letting the
      // error propagate to the subscriber's catch, which would re-queue it forever.
      if (err instanceof KsefApiError && TERMINAL_AUTH_HTTP_STATUSES.has(err.status)) {
        return { status: 'rejected', duplicate: false, errorMessage: `KSeF auth terminated (HTTP ${err.status})` }
      }
      throw err
    }
    if (authStatus.code === 200) {
      authenticated = true
      break
    }
    if (authStatus.code >= 400) {
      return { status: 'rejected', duplicate: false, errorMessage: `KSeF auth failed (${authStatus.code})` }
    }
    await options.wait(options.authDelayMs)
  }
  if (!authenticated) {
    return { status: 'processing', duplicate: false, errorMessage: '[internal] KSeF auth not completed in time' }
  }

  const tokens = await client.redeemToken(authInit.authenticationToken)
  const accessToken = tokens.accessToken

  const material = generateSymmetricKey()
  const session = await client.openOnlineSession({
    accessToken,
    encryptedSymmetricKey: wrapSymmetricKey(material, symmetricCert.certificate),
    initializationVector: material.iv.toString('base64'),
    publicKeyId: symmetricCert.publicKeyId || undefined,
  })

  const encrypted = encryptInvoiceDocument(input.invoiceXml, material)
  const sent = await client.sendOnlineInvoice({
    accessToken,
    sessionReference: session.referenceNumber,
    invoiceHash: encrypted.invoiceHash,
    invoiceSize: encrypted.invoiceSize,
    encryptedDocumentHash: encrypted.encryptedDocumentHash,
    encryptedDocumentSize: encrypted.encryptedDocumentSize,
    encryptedDocumentContent: encrypted.encryptedDocument.toString('base64'),
  })

  await client.closeOnlineSession({ accessToken, sessionReference: session.referenceNumber })

  let evaluation = evaluateInvoiceStatus(0)
  let lastStatus: KsefStatusResult | undefined
  for (let attempt = 0; attempt < options.statusMaxAttempts; attempt += 1) {
    lastStatus = await client.getInvoiceStatus({
      accessToken,
      sessionReference: session.referenceNumber,
      invoiceReference: sent.referenceNumber,
    })
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
