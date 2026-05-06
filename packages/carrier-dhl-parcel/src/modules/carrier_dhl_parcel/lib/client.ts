// DHL Parcel Gateway API — https://api-gw.dhlparcel.nl
// Authentication uses a proprietary JWT flow (not OAuth2):
//   POST /authenticate/api-key → { accessToken, accessTokenExpiration, refreshToken, refreshTokenExpiration }
//   POST /authenticate/refresh-token → same shape (rotating refresh token)
// Tokens are cached in-memory per userId:accountNumber key.
// Cache is lost on process restart; first request after restart triggers full re-auth (~200ms).

import { dhlErrors } from './errors'

const DHL_DEFAULT_BASE_URL = 'https://api-gw.dhlparcel.nl'
const REFRESH_BUFFER_SECONDS = 60

export type DhlCredentials = {
  userId: string
  apiKey: string
  accountNumber: string
  apiBaseUrl?: string
}

type DhlTokenCacheEntry = {
  accessToken: string
  accessTokenExpiration: number // Unix timestamp (seconds)
  refreshToken: string
  refreshTokenExpiration: number // Unix timestamp (seconds)
}

type DhlAuthResponse = {
  accessToken: string
  accessTokenExpiration: number
  refreshToken: string
  refreshTokenExpiration: number
}

export function resolveBaseUrl(credentials: Record<string, unknown>): string {
  const override = credentials.apiBaseUrl
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim().replace(/\/$/, '')
  }
  return DHL_DEFAULT_BASE_URL
}

export function resolveUserId(credentials: Record<string, unknown>): string {
  const userId = credentials.userId
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw dhlErrors.missingCredential('userId')
  }
  return userId.trim()
}

export function resolveApiKey(credentials: Record<string, unknown>): string {
  const apiKey = credentials.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw dhlErrors.missingCredential('apiKey')
  }
  return apiKey.trim()
}

export function resolveAccountNumber(credentials: Record<string, unknown>): string {
  const accountNumber = credentials.accountNumber
  if (typeof accountNumber !== 'string' || accountNumber.trim().length === 0) {
    throw dhlErrors.missingCredential('accountNumber')
  }
  return accountNumber.trim()
}

// In-memory token cache keyed by `${userId}:${accountNumber}`.
// Two tenants with the same userId and accountNumber share a token —
// this is intentional (they share the same DHL account).
const tokenCache = new Map<string, DhlTokenCacheEntry>()

// In-flight auth promises prevent duplicate concurrent auth requests
// (e.g. from Promise.all([dhlRequest(...), dhlRequest(...)])) from
// both triggering separate POST /authenticate/api-key calls.
const pendingAuthRequests = new Map<string, Promise<DhlTokenCacheEntry>>()

async function authenticate(
  baseUrl: string,
  userId: string,
  apiKey: string,
  accountNumber: string,
): Promise<DhlTokenCacheEntry> {
  const response = await fetch(`${baseUrl}/authenticate/api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      userId,
      key: apiKey,
      accountNumbers: [accountNumber],
    }),
  })
  if (!response.ok) {
    throw dhlErrors.authFailed()
  }
  const data = (await response.json()) as DhlAuthResponse
  return data
}

async function refreshTokenRequest(
  baseUrl: string,
  refreshToken: string,
): Promise<DhlTokenCacheEntry> {
  const response = await fetch(`${baseUrl}/authenticate/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) {
    throw dhlErrors.authFailed()
  }
  const data = (await response.json()) as DhlAuthResponse
  return data
}

export async function getToken(credentials: Record<string, unknown>): Promise<string> {
  const baseUrl = resolveBaseUrl(credentials)
  const userId = resolveUserId(credentials)
  const apiKey = resolveApiKey(credentials)
  const accountNumber = resolveAccountNumber(credentials)

  const cacheKey = `${userId}:${accountNumber}`
  const now = Math.floor(Date.now() / 1000)
  const cached = tokenCache.get(cacheKey)

  if (cached) {
    // Access token still valid (with buffer) — reuse
    if (cached.accessTokenExpiration - now > REFRESH_BUFFER_SECONDS) {
      return cached.accessToken
    }

    // Access token expiring soon — try refresh if refresh token still valid
    if (cached.refreshTokenExpiration > now) {
      try {
        const refreshed = await refreshTokenRequest(baseUrl, cached.refreshToken)
        tokenCache.set(cacheKey, refreshed)
        return refreshed.accessToken
      } catch {
        // Refresh failed — fall through to full re-auth
      }
    }
  }

  // Deduplicate concurrent auth requests (e.g. from Promise.all calls)
  const pending = pendingAuthRequests.get(cacheKey)
  if (pending) {
    const entry = await pending
    return entry.accessToken
  }

  // Full authentication
  const authPromise = authenticate(baseUrl, userId, apiKey, accountNumber)
    .then((entry) => {
      tokenCache.set(cacheKey, entry)
      pendingAuthRequests.delete(cacheKey)
      return entry
    })
    .catch((err: unknown) => {
      pendingAuthRequests.delete(cacheKey)
      throw err
    })

  pendingAuthRequests.set(cacheKey, authPromise)
  const entry = await authPromise
  return entry.accessToken
}

/** Clears the in-memory token cache and pending auth requests. Intended for use in tests only. */
export function clearTokenCache(): void {
  tokenCache.clear()
  pendingAuthRequests.clear()
}

export type DhlRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  query?: Record<string, string>
  accept?: string
}

/**
 * Makes an authenticated JSON request to the DHL Parcel Gateway API.
 * Resolves a fresh (or cached) access token before each call.
 * On 401, retries once after a full re-authentication.
 */
export async function dhlRequest<T>(
  credentials: Record<string, unknown>,
  path: string,
  options: DhlRequestOptions = {},
): Promise<T> {
  const baseUrl = resolveBaseUrl(credentials)

  const doRequest = async (token: string): Promise<Response> => {
    const url = new URL(`${baseUrl}${path}`)
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value)
      }
    }
    return fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: options.accept ?? 'application/json',
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  }

  let token = await getToken(credentials)
  let response = await doRequest(token)

  // On 401, clear cache entry and retry with fresh token once
  if (response.status === 401) {
    const userId = resolveUserId(credentials)
    const accountNumber = resolveAccountNumber(credentials)
    tokenCache.delete(`${userId}:${accountNumber}`)
    token = await getToken(credentials)
    response = await doRequest(token)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw dhlErrors.apiError(response.status, text)
  }

  if (response.status === 204) {
    return undefined as unknown as T
  }

  return response.json() as Promise<T>
}

/**
 * Makes a raw (binary) GET request to the DHL Parcel Gateway API.
 * Returns the raw ArrayBuffer so callers can base64-encode or process as needed.
 */
export async function dhlRequestRaw(
  credentials: Record<string, unknown>,
  path: string,
  accept = 'application/pdf',
  query?: Record<string, string>,
): Promise<ArrayBuffer> {
  const baseUrl = resolveBaseUrl(credentials)
  const token = await getToken(credentials)

  const url = new URL(`${baseUrl}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw dhlErrors.apiError(response.status, text)
  }

  return response.arrayBuffer()
}
