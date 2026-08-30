/**
 * KSeF 2.0 authentication — method-agnostic.
 *
 * Both supported methods end at the same place: a redeemed access token. They
 * differ only in how the `/auth/challenge` is answered:
 *  - `token` — RSA-OAEP-encrypt the KSeF token (crypto.ts) → POST /auth/ksef-token.
 *  - `certificate` — XAdES-sign an AuthTokenRequest (xades.ts) → POST /auth/xades-signature.
 *    The durable credential (tokens sunset 2026-12-31; certificates only from 2027-01-01).
 *
 * Pure with respect to the platform (takes a KsefClient + an injectable `wait`),
 * so it is deterministically unit-testable with a mock transport and reused by
 * the submission flow and the live-TEST runner.
 */
import { encryptAuthToken } from './crypto'
import { buildAuthTokenRequestXml, type KsefSubjectIdentifierType } from './auth-token-request'
import { signAuthTokenRequest } from './xades'
import { KsefApiError, KsefRateLimitError, type KsefClient, type KsefPublicKeyCertificate } from './ksef-client'

export type KsefAuthConfig =
  | { method: 'token'; ksefToken: string; contextNip: string }
  | {
      method: 'certificate'
      contextNip: string
      certificatePem: string
      privateKeyPem: string
      subjectIdentifierType?: KsefSubjectIdentifierType
    }

// HTTP statuses that mean the auth OPERATION itself is terminally gone — polling
// past these is futile; fail fast as a terminal rejection.
const TERMINAL_AUTH_HTTP_STATUSES = new Set([401, 403, 410])

export type AuthPollOptions = {
  authMaxAttempts: number
  authDelayMs: number
  wait: (ms: number) => Promise<void>
}

export type AuthenticateResult =
  | { ok: true; accessToken: string; refreshToken?: string }
  | { ok: false; status: 'rejected' | 'processing'; errorMessage: string }

/**
 * Run one KSeF KSeF call with a single bounded `Retry-After` honor: on 429, wait
 * the server-specified delay (already clamped in the client) once, then retry. A
 * second 429 (or any other error) propagates so the caller's transient-retry path
 * (the subscriber's reset→requeue) takes over. Never loops unbounded.
 */
export async function pace<T>(fn: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof KsefRateLimitError) {
      await wait(err.retryAfterMs)
      return fn()
    }
    throw err
  }
}

export async function authenticate(
  client: KsefClient,
  tokenCert: KsefPublicKeyCertificate | undefined,
  auth: KsefAuthConfig,
  options: AuthPollOptions,
): Promise<AuthenticateResult> {
  const challenge = await pace(() => client.requestChallenge(), options.wait)

  let authInit: { referenceNumber: string; authenticationToken: string }
  if (auth.method === 'token') {
    if (!tokenCert?.certificate) {
      return { ok: false, status: 'rejected', errorMessage: '[internal] KSeF token-encryption public key unavailable' }
    }
    const encryptedToken = encryptAuthToken(auth.ksefToken, challenge.timestampMs, tokenCert.certificate)
    authInit = await pace(
      () =>
        client.authenticateWithToken({
          challenge: challenge.challenge,
          contextNip: auth.contextNip,
          encryptedToken,
          publicKeyId: tokenCert.publicKeyId || undefined,
        }),
      options.wait,
    )
  } else {
    const requestXml = buildAuthTokenRequestXml({
      challenge: challenge.challenge,
      contextNip: auth.contextNip,
      subjectIdentifierType: auth.subjectIdentifierType,
    })
    const signedXml = await signAuthTokenRequest({
      xml: requestXml,
      certificatePem: auth.certificatePem,
      privateKeyPem: auth.privateKeyPem,
    })
    authInit = await pace(() => client.authenticateWithXades(signedXml), options.wait)
  }

  for (let attempt = 0; attempt < options.authMaxAttempts; attempt += 1) {
    let authStatus
    try {
      authStatus = await pace(
        () => client.getAuthStatus(authInit.referenceNumber, authInit.authenticationToken),
        options.wait,
      )
    } catch (err) {
      if (err instanceof KsefApiError && TERMINAL_AUTH_HTTP_STATUSES.has(err.status)) {
        return { ok: false, status: 'rejected', errorMessage: `KSeF auth terminated (HTTP ${err.status})` }
      }
      throw err
    }
    if (authStatus.code === 200) {
      const tokens = await pace(() => client.redeemToken(authInit.authenticationToken), options.wait)
      return { ok: true, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
    }
    if (authStatus.code >= 400) {
      return { ok: false, status: 'rejected', errorMessage: `KSeF auth failed (${authStatus.code})` }
    }
    await options.wait(options.authDelayMs)
  }
  return { ok: false, status: 'processing', errorMessage: '[internal] KSeF auth not completed in time' }
}
