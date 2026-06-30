/**
 * KSeF 2.0 REST client.
 *
 * Thin, typed wrapper over the KSeF 2.0 `/v2` API. All network access goes
 * through an injectable `KsefTransport` so the client is unit-testable offline
 * and the same code drives the TEST / DEMO / PROD environments by base URL.
 *
 * Endpoint paths and request/response shapes are pinned against the live TEST
 * OpenAPI (https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json, KSeF API v2.6.1):
 * `contextIdentifier.type` is the `Nip` enum value; the auth/access/refresh tokens
 * are `TokenInfo` objects (`{ token, validUntil }`); and `usage` on a public-key
 * certificate is an array of usage enum values. The client tolerates both the
 * object and a bare-string form so it stays resilient across minor schema revisions.
 */
import { FA3_SCHEMA, type KsefEnvironment, type KsefEnvironmentConfig } from '../config'
import { putToAbsoluteUrl } from './http-put'

export type KsefTransportRequest = {
  method: 'GET' | 'POST' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: string
}

export type KsefTransportResponse = {
  status: number
  headers: Record<string, string>
  text: string
}

export type KsefTransport = (req: KsefTransportRequest) => Promise<KsefTransportResponse>

export class KsefApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'KsefApiError'
    this.status = status
    this.body = body
  }
}

/**
 * Raised on HTTP 429 so callers can pace instead of churning. `retryAfterMs` is
 * parsed from the `Retry-After` header (delta-seconds or HTTP-date), capped to a
 * sane default when absent/garbage so a hostile/empty header can never make a
 * caller sleep unbounded.
 */
export class KsefRateLimitError extends KsefApiError {
  readonly retryAfterMs: number
  constructor(message: string, retryAfterMs: number, body: unknown) {
    super(message, 429, body)
    this.name = 'KsefRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

export const DEFAULT_RETRY_AFTER_MS = 5_000
export const MAX_RETRY_AFTER_MS = 60_000

/** Parse a `Retry-After` header value to milliseconds, clamped to [0, MAX]. */
export function parseRetryAfterMs(
  raw: string | undefined,
  now: number = Date.now(),
  maxMs: number = MAX_RETRY_AFTER_MS,
): number {
  if (!raw) return DEFAULT_RETRY_AFTER_MS
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs)
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs - now, 0), maxMs)
  return DEFAULT_RETRY_AFTER_MS
}

export type KsefCertificateEnrollmentData = {
  /** X.500 DN attributes the CSR must mirror (verbatim), as returned by KSeF. */
  commonName?: string
  countryName?: string
  organizationName?: string
  serialNumber?: string
  uniqueIdentifier?: string
  organizationIdentifier?: string
  raw: unknown
}

export type KsefCertificateEnrollmentResult = {
  referenceNumber: string
}

export type KsefCertificateEnrollmentStatus = {
  code: number
  description?: string
  certificateSerialNumber?: string
}

export type KsefCertificateInfo = {
  certificateSerialNumber: string
  name?: string
  type?: string
  status?: string
  validFrom?: string
  validTo?: string
}

export type KsefCertificateType = 'Authentication' | 'Offline'

export type KsefPublicKeyCertificate = {
  publicKeyId: string
  certificate: string
  usage: string[]
  validFrom?: string
}

export type KsefChallenge = {
  challenge: string
  timestampMs: number
}

export type KsefAuthInitResult = {
  referenceNumber: string
  authenticationToken: string
}

export type KsefTokenPair = {
  accessToken: string
  refreshToken?: string
}

export type KsefOpenSessionResult = {
  referenceNumber: string
  validUntil?: string
}

export type KsefSendInvoiceResult = {
  referenceNumber: string
}

export type KsefStatusResult = {
  code: number
  description?: string
  /** KSeF's per-rejection validation messages (`status.details`) — the specific reasons a
   * document was rejected (e.g. the FA(3) element that failed). Surfaced so a rejection is
   * diagnosable instead of only carrying the generic top-level `description`. */
  details?: string[]
  ksefNumber?: string
  /** For a duplicate (440): the KSeF number the original invoice was accepted under. */
  originalKsefNumber?: string
  /** For a duplicate (440): the session the original invoice was accepted in (needed to fetch its UPO). */
  originalSessionReference?: string
}

export type ReceivedInvoiceMetadata = {
  ksefNumber: string
  invoiceNumber?: string
  issueDate?: string
  invoicingDate?: string
  acquisitionDate?: string
  permanentStorageDate?: string
  seller?: { nip?: string; name?: string }
  buyer?: { identifier?: { type?: string; value?: string }; name?: string }
  netAmount?: number
  grossAmount?: number
  vatAmount?: number
  currency?: string
  invoiceType?: string
  invoicingMode?: string
  isSelfInvoicing?: boolean
  invoiceHash?: string
  hashOfCorrectedInvoice?: string
}

export type QueryReceivedInvoicesResult = {
  hasMore: boolean
  isTruncated: boolean
  permanentStorageHwmDate?: string
  invoices: ReceivedInvoiceMetadata[]
}

export type ReceivedInvoiceFilters = {
  subjectType: 'Subject1' | 'Subject2' | 'Subject3' | 'SubjectAuthorized'
  dateRange: {
    dateType: 'Issue' | 'Invoicing' | 'PermanentStorage'
    from: string
    to?: string
    restrictToPermanentStorageHwmDate?: boolean
  }
  sellerNip?: string
  invoiceTypes?: string[]
  invoicingMode?: 'Online' | 'Offline'
}

export type BatchPartUploadRequest = {
  ordinalNumber: number
  url: string
  method: string
  headers?: Record<string, string>
}

export type OpenBatchSessionResult = {
  referenceNumber: string
  partUploadRequests: BatchPartUploadRequest[]
}

/**
 * Default per-request timeout (ms) for live KSeF HTTP calls. The MF TEST gateway
 * can be slow or stall; without an abort a hung connection would block the queue
 * subscriber's handler indefinitely (no retry, no observability).
 */
export const DEFAULT_KSEF_TIMEOUT_MS = 30_000

/**
 * Build a `fetch`-based transport that aborts any request exceeding `timeoutMs`.
 * Exposed as a factory so the subscriber / live runner can tune the deadline; the
 * default instance is used when no transport is injected into `KsefClient`.
 */
export function createFetchTransport(timeoutMs: number = DEFAULT_KSEF_TIMEOUT_MS): KsefTransport {
  return async (req) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      })
      const text = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      return { status: response.status, headers, text }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`[internal] KSeF request timed out after ${timeoutMs}ms: ${req.method} ${req.url}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

export const defaultFetchTransport: KsefTransport = createFetchTransport()

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function hasDefinedValue(record: Record<string, unknown>): boolean {
  return Object.values(record).some((value) => value !== undefined)
}

const KSEF_CONTEXT_NIP_TYPE = 'Nip'

/**
 * Extract a JWT string from a field that KSeF 2.0 returns as a `TokenInfo` object
 * (`{ token, validUntil }`). Falls back to a bare string for resilience.
 */
function pickToken(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (value && typeof value === 'object') {
      const token = (value as Record<string, unknown>).token
      if (typeof token === 'string' && token.length > 0) return token
    }
  }
  return undefined
}

/**
 * The challenge response carries both a numeric `timestampMs` and an ISO
 * `timestamp`; the encrypted auth token must reuse the exact millisecond value
 * KSeF issued, so prefer the integer and only parse the ISO form as a fallback.
 */
function resolveChallengeTimestampMs(record: Record<string, unknown>): number {
  const direct = record.timestampMs
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  const raw = record.timestamp ?? record.challengeTimestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') return Date.parse(raw)
  return Number.NaN
}

function pickStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

function mapReceivedInvoiceMetadata(raw: unknown): ReceivedInvoiceMetadata {
  const record = asRecord(raw)
  const sellerRecord = asRecord(record.seller)
  const buyerRecord = asRecord(record.buyer)
  const buyerIdentifierRecord = asRecord(buyerRecord.identifier)
  const seller = {
    nip: pickString(sellerRecord, 'nip', 'identifier', 'taxIdentifier'),
    name: pickString(sellerRecord, 'name'),
  }
  const buyerIdentifier = {
    type: pickString(buyerIdentifierRecord, 'type'),
    value: pickString(buyerIdentifierRecord, 'value'),
  }
  const buyer = {
    identifier: hasDefinedValue(buyerIdentifier) ? buyerIdentifier : undefined,
    name: pickString(buyerRecord, 'name'),
  }
  return {
    ksefNumber: pickString(record, 'ksefNumber', 'ksefReferenceNumber') ?? '',
    invoiceNumber: pickString(record, 'invoiceNumber'),
    issueDate: pickString(record, 'issueDate'),
    invoicingDate: pickString(record, 'invoicingDate'),
    acquisitionDate: pickString(record, 'acquisitionDate'),
    permanentStorageDate: pickString(record, 'permanentStorageDate'),
    seller: hasDefinedValue(seller) ? seller : undefined,
    buyer: hasDefinedValue(buyer) ? buyer : undefined,
    netAmount: pickNumber(record, 'netAmount'),
    grossAmount: pickNumber(record, 'grossAmount'),
    vatAmount: pickNumber(record, 'vatAmount'),
    currency: pickString(record, 'currency'),
    invoiceType: pickString(record, 'invoiceType'),
    invoicingMode: pickString(record, 'invoicingMode'),
    isSelfInvoicing: pickBoolean(record, 'isSelfInvoicing'),
    invoiceHash: pickString(record, 'invoiceHash'),
    hashOfCorrectedInvoice: pickString(record, 'hashOfCorrectedInvoice'),
  }
}

function mapBatchPartUploadRequest(raw: unknown): BatchPartUploadRequest {
  const record = asRecord(raw)
  const headers = asRecord(record.headers)
  const stringHeaders = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return {
    ordinalNumber: pickNumber(record, 'ordinalNumber') ?? 0,
    url: pickString(record, 'url') ?? '',
    method: pickString(record, 'method') ?? '',
    headers: Object.keys(stringHeaders).length > 0 ? stringHeaders : undefined,
  }
}

export class KsefClient {
  private readonly baseUrl: string
  private readonly environment: KsefEnvironment
  private readonly transport: KsefTransport

  constructor(env: KsefEnvironmentConfig, transport: KsefTransport = defaultFetchTransport) {
    this.baseUrl = `${env.baseUrl}${env.apiPrefix}`
    this.environment = env.environment
    this.transport = transport
  }

  private async request(
    method: KsefTransportRequest['method'],
    path: string,
    options: { token?: string; json?: unknown; xmlBody?: string; accept?: string } = {},
  ): Promise<{ status: number; headers: Record<string, string>; json: unknown; text: string }> {
    const headers: Record<string, string> = { Accept: options.accept ?? 'application/json' }
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    let body: string | undefined
    if (options.xmlBody !== undefined) {
      headers['Content-Type'] = 'application/xml'
      body = options.xmlBody
    } else if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.json)
    }
    const res = await this.transport({ method, url: `${this.baseUrl}${path}`, headers, body })
    const json = parseJson(res.text)
    if (res.status === 429) {
      // Rate limited — surface a typed error carrying the pacing delay so the flow
      // can back off instead of immediately re-queuing (which would churn KSeF).
      const maxEnv = Number(process.env.OM_KSEF_RETRY_AFTER_MAX_MS)
      const maxMs = Number.isFinite(maxEnv) && maxEnv > 0 ? maxEnv : MAX_RETRY_AFTER_MS
      throw new KsefRateLimitError(
        `KSeF ${method} ${path} rate limited (429)`,
        parseRetryAfterMs(res.headers['retry-after'], Date.now(), maxMs),
        json ?? res.text,
      )
    }
    if (res.status >= 400) {
      throw new KsefApiError(`KSeF ${method} ${path} failed with ${res.status}`, res.status, json ?? res.text)
    }
    return { status: res.status, headers: res.headers, json, text: res.text }
  }

  async getPublicKeyCertificates(): Promise<KsefPublicKeyCertificate[]> {
    const { json } = await this.request('GET', '/security/public-key-certificates')
    const list = Array.isArray(json) ? json : asRecord(json).certificates
    if (!Array.isArray(list)) return []
    return list.map((raw) => {
      const record = asRecord(raw)
      return {
        publicKeyId: pickString(record, 'publicKeyId', 'id') ?? '',
        certificate: pickString(record, 'certificate', 'publicKey', 'value') ?? '',
        usage: pickStringArray(record.usage ?? record.type ?? record.purpose),
        validFrom: pickString(record, 'validFrom'),
      }
    })
  }

  async requestChallenge(): Promise<KsefChallenge> {
    // KSeF 2.0 `/auth/challenge` is anonymous (no request body, per the v2.6.1
    // OpenAPI); the context NIP is bound later, in the `/auth/ksef-token` request.
    const { json } = await this.request('POST', '/auth/challenge')
    const record = asRecord(json)
    const challenge = pickString(record, 'challenge')
    const timestampMs = resolveChallengeTimestampMs(record)
    if (!challenge || !Number.isFinite(timestampMs)) {
      throw new KsefApiError('KSeF challenge response missing challenge/timestamp', 502, json)
    }
    return { challenge, timestampMs }
  }

  async authenticateWithToken(params: {
    challenge: string
    contextNip: string
    encryptedToken: string
    publicKeyId?: string
  }): Promise<KsefAuthInitResult> {
    const { json } = await this.request('POST', '/auth/ksef-token', {
      json: {
        challenge: params.challenge,
        contextIdentifier: { type: KSEF_CONTEXT_NIP_TYPE, value: params.contextNip },
        encryptedToken: params.encryptedToken,
        ...(params.publicKeyId ? { publicKeyId: params.publicKeyId } : {}),
      },
    })
    const record = asRecord(json)
    const referenceNumber = pickString(record, 'referenceNumber', 'authenticationReferenceNumber')
    const authenticationToken = pickToken(record, 'authenticationToken', 'token')
    if (!referenceNumber || !authenticationToken) {
      throw new KsefApiError('KSeF token-auth response missing reference/token', 502, json)
    }
    return { referenceNumber, authenticationToken }
  }

  /**
   * Certificate / qualified-signature auth: submit an XAdES-signed AuthTokenRequest.
   * The body is raw signed XML (not JSON). Returns the same {referenceNumber,
   * authenticationToken} shape as the token path, so the poll→redeem flow is shared.
   */
  async authenticateWithXades(signedXml: string): Promise<KsefAuthInitResult> {
    const { json } = await this.request('POST', '/auth/xades-signature', { xmlBody: signedXml })
    const record = asRecord(json)
    const referenceNumber = pickString(record, 'referenceNumber', 'authenticationReferenceNumber')
    const authenticationToken = pickToken(record, 'authenticationToken', 'token')
    if (!referenceNumber || !authenticationToken) {
      throw new KsefApiError('KSeF xades-auth response missing reference/token', 502, json)
    }
    return { referenceNumber, authenticationToken }
  }

  async getAuthStatus(referenceNumber: string, authenticationToken: string): Promise<KsefStatusResult> {
    const { json } = await this.request('GET', `/auth/${encodeURIComponent(referenceNumber)}`, {
      token: authenticationToken,
    })
    const record = asRecord(json)
    const statusRecord = asRecord(record.status ?? record)
    return {
      code: pickNumber(statusRecord, 'code') ?? pickNumber(record, 'code') ?? 0,
      description: pickString(statusRecord, 'description'),
    }
  }

  async redeemToken(authenticationToken: string): Promise<KsefTokenPair> {
    const { json } = await this.request('POST', '/auth/token/redeem', { token: authenticationToken })
    const record = asRecord(json)
    const accessToken = pickToken(record, 'accessToken')
    if (!accessToken) throw new KsefApiError('KSeF redeem response missing accessToken', 502, json)
    return { accessToken, refreshToken: pickToken(record, 'refreshToken') }
  }

  async refreshToken(refreshToken: string): Promise<KsefTokenPair> {
    const { json } = await this.request('POST', '/auth/token/refresh', { token: refreshToken })
    const record = asRecord(json)
    const accessToken = pickToken(record, 'accessToken')
    if (!accessToken) throw new KsefApiError('KSeF refresh response missing accessToken', 502, json)
    return { accessToken, refreshToken: pickToken(record, 'refreshToken') ?? refreshToken }
  }

  async openOnlineSession(params: {
    accessToken: string
    encryptedSymmetricKey: string
    initializationVector: string
    publicKeyId?: string
  }): Promise<KsefOpenSessionResult> {
    const { json } = await this.request('POST', '/sessions/online', {
      token: params.accessToken,
      json: {
        formCode: {
          systemCode: FA3_SCHEMA.systemCode,
          schemaVersion: FA3_SCHEMA.schemaVersion,
          value: FA3_SCHEMA.formCode,
        },
        encryption: {
          encryptedSymmetricKey: params.encryptedSymmetricKey,
          initializationVector: params.initializationVector,
          ...(params.publicKeyId ? { publicKeyId: params.publicKeyId } : {}),
        },
      },
    })
    const record = asRecord(json)
    const referenceNumber = pickString(record, 'referenceNumber', 'sessionReferenceNumber')
    if (!referenceNumber) throw new KsefApiError('KSeF open-session response missing referenceNumber', 502, json)
    return { referenceNumber, validUntil: pickString(record, 'validUntil') }
  }

  async sendOnlineInvoice(params: {
    accessToken: string
    sessionReference: string
    invoiceHash: string
    invoiceSize: number
    encryptedDocumentHash: string
    encryptedDocumentSize: number
    encryptedDocumentContent: string
    offlineMode?: boolean
  }): Promise<KsefSendInvoiceResult> {
    const { json } = await this.request(
      'POST',
      `/sessions/online/${encodeURIComponent(params.sessionReference)}/invoices`,
      {
        token: params.accessToken,
        json: {
          invoiceHash: params.invoiceHash,
          invoiceSize: params.invoiceSize,
          encryptedInvoiceHash: params.encryptedDocumentHash,
          encryptedInvoiceSize: params.encryptedDocumentSize,
          encryptedInvoiceContent: params.encryptedDocumentContent,
          // The KSeF 2.0 `SendInvoiceRequest` requires `offlineMode`; for an online
          // session submission it is always `false` (offline24/awaryjny is Phase E2).
          offlineMode: params.offlineMode ?? false,
        },
      },
    )
    const record = asRecord(json)
    const referenceNumber = pickString(record, 'referenceNumber', 'invoiceReferenceNumber', 'elementReferenceNumber')
    if (!referenceNumber) throw new KsefApiError('KSeF send-invoice response missing referenceNumber', 502, json)
    return { referenceNumber }
  }

  async closeOnlineSession(params: { accessToken: string; sessionReference: string }): Promise<void> {
    await this.request(
      'POST',
      `/sessions/online/${encodeURIComponent(params.sessionReference)}/close`,
      { token: params.accessToken },
    )
  }

  async openBatchSession(params: {
    accessToken: string
    formCode: { systemCode: string; schemaVersion: string; value: string }
    encryption: { encryptedSymmetricKey: string; initializationVector: string }
    batchFile: { fileSize: number; fileHash: string }
    fileParts: Array<{ ordinalNumber: number; fileName: string; fileSize: number; fileHash: string }>
  }): Promise<OpenBatchSessionResult> {
    const { json } = await this.request('POST', '/sessions/batch', {
      token: params.accessToken,
      json: {
        formCode: params.formCode,
        encryption: params.encryption,
        batchFile: params.batchFile,
        fileParts: params.fileParts,
      },
    })
    const record = asRecord(json)
    const referenceNumber = pickString(record, 'referenceNumber', 'sessionReferenceNumber')
    if (!referenceNumber) throw new KsefApiError('KSeF open-batch-session response missing referenceNumber', 502, json)
    const uploadRequests = record.partUploadRequests
    return {
      referenceNumber,
      partUploadRequests: Array.isArray(uploadRequests) ? uploadRequests.map(mapBatchPartUploadRequest) : [],
    }
  }

  async uploadBatchPart(req: BatchPartUploadRequest, encryptedBytes: Uint8Array | Buffer): Promise<void> {
    const result = await putToAbsoluteUrl(req.url, encryptedBytes, req.headers ?? {})
    if (!result.ok) {
      throw new KsefApiError(
        `KSeF batch part upload failed with ${result.status}`,
        result.status,
        result.bodyText ?? '',
      )
    }
  }

  async closeBatchSession(params: { accessToken: string; referenceNumber: string }): Promise<void> {
    await this.request(
      'POST',
      `/sessions/batch/${encodeURIComponent(params.referenceNumber)}/close`,
      { token: params.accessToken },
    )
  }

  async getSessionStatus(params: { accessToken: string; sessionReference: string }): Promise<KsefStatusResult> {
    const { json } = await this.request(
      'GET',
      `/sessions/${encodeURIComponent(params.sessionReference)}`,
      { token: params.accessToken },
    )
    const record = asRecord(json)
    const statusRecord = asRecord(record.status ?? record)
    return {
      code: pickNumber(statusRecord, 'code') ?? pickNumber(record, 'code') ?? 0,
      description: pickString(statusRecord, 'description'),
    }
  }

  async getSessionInvoices(params: { accessToken: string; referenceNumber: string }): Promise<unknown> {
    const { json } = await this.request(
      'GET',
      `/sessions/${encodeURIComponent(params.referenceNumber)}/invoices`,
      { token: params.accessToken },
    )
    return json
  }

  async getInvoiceStatus(params: {
    accessToken: string
    sessionReference: string
    invoiceReference: string
  }): Promise<KsefStatusResult> {
    const { json } = await this.request(
      'GET',
      `/sessions/${encodeURIComponent(params.sessionReference)}/invoices/${encodeURIComponent(params.invoiceReference)}`,
      { token: params.accessToken },
    )
    const record = asRecord(json)
    const statusRecord = asRecord(record.status ?? record)
    const extensions = asRecord(statusRecord.extensions)
    return {
      code: pickNumber(statusRecord, 'code') ?? pickNumber(record, 'code') ?? 0,
      description: pickString(statusRecord, 'description'),
      details: Array.isArray(statusRecord.details)
        ? statusRecord.details.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
      ksefNumber:
        pickString(record, 'ksefNumber', 'ksefReferenceNumber') ??
        pickString(statusRecord, 'ksefNumber', 'ksefReferenceNumber') ??
        pickString(extensions, 'ksefNumber', 'ksefReferenceNumber'),
      originalKsefNumber: pickString(extensions, 'originalKsefNumber'),
      originalSessionReference: pickString(extensions, 'originalSessionReferenceNumber'),
    }
  }

  async getInvoiceUpo(params: {
    accessToken: string
    sessionReference: string
    invoiceReference: string
  }): Promise<string> {
    const { text } = await this.request(
      'GET',
      `/sessions/${encodeURIComponent(params.sessionReference)}/invoices/${encodeURIComponent(params.invoiceReference)}/upo`,
      { token: params.accessToken, accept: 'application/xml' },
    )
    return text
  }

  /**
   * Fetch a UPO by KSeF number, scoped to the session the invoice was accepted in.
   * Used to recover the receipt of an already-registered invoice when a fresh send
   * returns a 440 duplicate — the original lives in an EARLIER session, so the
   * caller must pass that session's reference (from `status.extensions`), not the
   * current one. There is no session-less UPO endpoint in KSeF 2.0.
   */
  async getInvoiceUpoByKsefNumber(params: {
    accessToken: string
    sessionReference: string
    ksefNumber: string
  }): Promise<string> {
    const { text } = await this.request(
      'GET',
      `/sessions/${encodeURIComponent(params.sessionReference)}/invoices/ksef/${encodeURIComponent(params.ksefNumber)}/upo`,
      { token: params.accessToken, accept: 'application/xml' },
    )
    return text
  }

  async queryReceivedInvoices(params: {
    accessToken: string
    filters: ReceivedInvoiceFilters
    pageOffset?: number
    pageSize?: number
    sortOrder?: 'Asc' | 'Desc'
  }): Promise<QueryReceivedInvoicesResult> {
    const query = new URLSearchParams({
      pageOffset: String(params.pageOffset ?? 0),
      pageSize: String(params.pageSize ?? 10),
      sortOrder: params.sortOrder ?? 'Asc',
    })
    const { json } = await this.request('POST', `/invoices/query/metadata?${query.toString()}`, {
      token: params.accessToken,
      json: params.filters,
    })
    const record = asRecord(json)
    const invoices = Array.isArray(record.invoices) ? record.invoices.map(mapReceivedInvoiceMetadata) : []
    return {
      hasMore: pickBoolean(record, 'hasMore') ?? false,
      isTruncated: pickBoolean(record, 'isTruncated') ?? false,
      permanentStorageHwmDate: pickString(record, 'permanentStorageHwmDate'),
      invoices,
    }
  }

  async downloadInvoiceByKsefNumber(params: { accessToken: string; ksefNumber: string }): Promise<string> {
    const { text } = await this.request(
      'GET',
      `/invoices/ksef/${encodeURIComponent(params.ksefNumber)}`,
      { token: params.accessToken, accept: 'application/xml' },
    )
    return text
  }

  // --- KSeF certificate enrollment (the durable, post-2027 credential) ---

  async getCertificateLimits(accessToken: string): Promise<unknown> {
    const { json } = await this.request('GET', '/certificates/limits', { token: accessToken })
    return json
  }

  /**
   * The X.500 DN attributes the CSR must carry, verbatim. KSeF only serves this to
   * an XAdES-authenticated subject (not a token session), so the enrollment command
   * must pre-check that the org has a certificate/qualified credential.
   */
  async getCertificateEnrollmentData(accessToken: string): Promise<KsefCertificateEnrollmentData> {
    const { json } = await this.request('GET', '/certificates/enrollments/data', { token: accessToken })
    const r = asRecord(json)
    return {
      commonName: pickString(r, 'commonName'),
      countryName: pickString(r, 'countryName'),
      organizationName: pickString(r, 'organizationName'),
      serialNumber: pickString(r, 'serialNumber'),
      uniqueIdentifier: pickString(r, 'uniqueIdentifier'),
      organizationIdentifier: pickString(r, 'organizationIdentifier'),
      raw: json,
    }
  }

  async enrollCertificate(params: {
    accessToken: string
    csr: string
    certificateType: KsefCertificateType
    certificateName: string
    validFrom?: string
  }): Promise<KsefCertificateEnrollmentResult> {
    const { json } = await this.request('POST', '/certificates/enrollments', {
      token: params.accessToken,
      json: {
        certificateName: params.certificateName,
        certificateType: params.certificateType,
        csr: params.csr,
        ...(params.validFrom ? { validFrom: params.validFrom } : {}),
      },
    })
    const referenceNumber = pickString(asRecord(json), 'referenceNumber')
    if (!referenceNumber) throw new KsefApiError('KSeF enroll response missing referenceNumber', 502, json)
    return { referenceNumber }
  }

  async getCertificateEnrollmentStatus(params: {
    accessToken: string
    referenceNumber: string
  }): Promise<KsefCertificateEnrollmentStatus> {
    const { json } = await this.request(
      'GET',
      `/certificates/enrollments/${encodeURIComponent(params.referenceNumber)}`,
      { token: params.accessToken },
    )
    const record = asRecord(json)
    const statusRecord = asRecord(record.status ?? record)
    return {
      code: pickNumber(statusRecord, 'code') ?? pickNumber(record, 'code') ?? 0,
      description: pickString(statusRecord, 'description'),
      certificateSerialNumber: pickString(record, 'certificateSerialNumber'),
    }
  }

  /** Download issued certificate(s) (DER, Base64) by serial number. */
  async retrieveCertificates(params: { accessToken: string; serialNumbers: string[] }): Promise<unknown> {
    const { json } = await this.request('POST', '/certificates/retrieve', {
      token: params.accessToken,
      json: { certificateSerialNumbers: params.serialNumbers },
    })
    return json
  }

  async queryCertificates(params: { accessToken: string; filter?: Record<string, unknown> }): Promise<KsefCertificateInfo[]> {
    const { json } = await this.request('POST', '/certificates/query', {
      token: params.accessToken,
      json: params.filter ?? {},
    })
    const list = Array.isArray(json) ? json : (asRecord(json).certificates ?? asRecord(json).items)
    if (!Array.isArray(list)) return []
    return list.map((raw) => {
      const r = asRecord(raw)
      return {
        certificateSerialNumber: pickString(r, 'certificateSerialNumber', 'serialNumber') ?? '',
        name: pickString(r, 'name', 'certificateName'),
        type: pickString(r, 'type', 'certificateType'),
        status: pickString(r, 'status'),
        validFrom: pickString(r, 'validFrom'),
        validTo: pickString(r, 'validTo'),
      }
    })
  }

  async revokeCertificate(params: { accessToken: string; serialNumber: string; reason?: string }): Promise<void> {
    await this.request('POST', `/certificates/${encodeURIComponent(params.serialNumber)}/revoke`, {
      token: params.accessToken,
      json: params.reason ? { revocationReason: params.reason } : {},
    })
  }

  /**
   * TEST-only self-onboarding: provision a fictional person context (NIP + PESEL).
   * The `/testdata/*` endpoints exist only on the TEST environment, so this throws
   * on DEMO/PROD to prevent an accidental call against a real environment.
   */
  async createTestPerson(params: {
    nip: string
    pesel: string
    description?: string
    isBailiff?: boolean
  }): Promise<unknown> {
    if (this.environment !== 'test') {
      throw new Error('[internal] KSeF test-data endpoints are only available on the TEST environment')
    }
    const { json } = await this.request('POST', '/testdata/person', {
      json: {
        nip: params.nip,
        pesel: params.pesel,
        isBailiff: params.isBailiff ?? false,
        description: params.description ?? 'Open Mercato integration test context',
      },
    })
    return json
  }
}
