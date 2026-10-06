import {
  TREG_DEFAULT_BASE_URL,
  TREG_DEFAULT_MAX_COST_USD,
  TREG_REQUEST_TIMEOUT_MS,
  type FailureReason,
} from './constants'

export type TregSettings = {
  apiToken: string
  orgSlug: string | null
  baseUrl: string
  maxCostUsd: number
}

export type TregCallMeta = {
  servedBy: string | null
  callId: string | null
  costMicro: number
}

export type TregCallResult =
  | ({ status: 'hit'; output: Record<string, unknown>; raw: unknown } & TregCallMeta)
  | ({ status: 'miss'; raw: unknown } & TregCallMeta)

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class TregError extends Error {
  readonly reason: FailureReason
  readonly httpStatus: number | null

  constructor(reason: FailureReason, message: string, httpStatus: number | null = null) {
    super(message)
    this.name = 'TregError'
    this.reason = reason
    this.httpStatus = httpStatus
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readPositiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isAllowedBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

export function parseTregSettings(credentials: Record<string, unknown> | null | undefined): TregSettings {
  const apiToken = readString(credentials?.apiToken)
  if (!apiToken) {
    throw new TregError('not_configured', '[internal] treg API token is not configured')
  }
  const baseUrl = (readString(credentials?.apiBaseUrl) ?? TREG_DEFAULT_BASE_URL).replace(/\/+$/, '')
  if (!isAllowedBaseUrl(baseUrl)) {
    throw new TregError('not_configured', '[internal] treg API base URL must use https (http is allowed only for localhost)')
  }
  return {
    apiToken,
    orgSlug: readString(credentials?.orgSlug),
    baseUrl,
    maxCostUsd: readPositiveNumber(credentials?.maxCostPerCallUsd) ?? TREG_DEFAULT_MAX_COST_USD,
  }
}

function buildHeaders(settings: TregSettings, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Treg-Token': settings.apiToken,
    Accept: 'application/json',
    ...extra,
  }
  if (settings.orgSlug) headers['X-Treg-Org'] = settings.orgSlug
  return headers
}

function readMeta(response: Response): TregCallMeta {
  const cost = Number(response.headers.get('x-treg-cost-micro') ?? '0')
  return {
    servedBy: response.headers.get('x-treg-served-by'),
    callId: response.headers.get('x-treg-call-id'),
    costMicro: Number.isFinite(cost) && cost > 0 ? Math.round(cost) : 0,
  }
}

function failureFromStatus(status: number): FailureReason {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402) return 'out_of_balance'
  if (status === 409 || status === 429 || status >= 500) return 'provider_unavailable'
  return 'invalid_input'
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function compactBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasValue(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : readString(value) !== null
}

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TREG_REQUEST_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error'
    throw new TregError('provider_unavailable', `[internal] treg request failed: ${message}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function callTregEndpoint(params: {
  settings: TregSettings
  endpointId: string
  body: Record<string, unknown>
  missWhenEmpty: string
  missOnNotFound?: boolean
  idempotencyKey: string
  meta?: Record<string, string>
  fetchImpl?: FetchLike
}): Promise<TregCallResult> {
  const { settings, endpointId } = params
  const extraHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': params.idempotencyKey,
    'X-Treg-Route-Max-Cost': String(settings.maxCostUsd),
  }
  const metaPairs = Object.entries(params.meta ?? {})
    .slice(0, 5)
    .map(([key, value]) => `${key}=${value}`)
  if (metaPairs.length > 0) extraHeaders['X-Treg-Meta'] = metaPairs.join(', ')

  const response = await request(
    `${settings.baseUrl}/call/${encodeURIComponent(endpointId)}`,
    {
      method: 'POST',
      headers: buildHeaders(settings, extraHeaders),
      body: JSON.stringify(compactBody(params.body)),
    },
    params.fetchImpl ?? fetch,
  )
  const meta = readMeta(response)
  const payload = await readBody(response)

  if (response.status === 404 && params.missOnNotFound) {
    return { status: 'miss', raw: payload, ...meta }
  }

  if (!response.ok) {
    const detail = isRecord(payload) ? readString(payload.error) ?? readString(payload.message) : null
    throw new TregError(
      failureFromStatus(response.status),
      `[internal] treg ${endpointId} returned ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    )
  }

  const output = isRecord(payload) && isRecord(payload.output) ? payload.output : null
  const raw = isRecord(payload) && 'raw' in payload ? payload.raw : payload
  const tregInfo = isRecord(payload) && isRecord(payload._treg) ? payload._treg : null
  const servedBy = meta.servedBy ?? readString(tregInfo?.served_by)
  if (!output || !hasValue(output[params.missWhenEmpty])) {
    return { status: 'miss', raw, ...meta, servedBy }
  }
  return { status: 'hit', output, raw, ...meta, servedBy }
}

export type TregBalance = {
  balanceMicro: number | null
}

function findBalanceMicro(payload: unknown): number | null {
  if (!isRecord(payload)) return null
  for (const key of ['balance_micro', 'balanceMicro', 'prepaid_micro']) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  for (const key of ['balance_usd', 'balance']) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1_000_000)
  }
  return null
}

export async function fetchTregBalance(settings: TregSettings, fetchImpl: FetchLike = fetch): Promise<TregBalance> {
  const response = await request(
    `${settings.baseUrl}/billing`,
    { method: 'GET', headers: buildHeaders(settings) },
    fetchImpl,
  )
  const payload = await readBody(response)
  if (!response.ok) {
    throw new TregError(failureFromStatus(response.status), `[internal] treg /billing returned ${response.status}`, response.status)
  }
  return { balanceMicro: findBalanceMicro(payload) }
}
