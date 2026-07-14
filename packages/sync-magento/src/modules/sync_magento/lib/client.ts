// Magento REST API v1 documentation:
// https://developer.adobe.com/commerce/webapi/rest/

export function resolveBaseUrl(config: Record<string, unknown>): string {
  const value = config.baseUrl
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Magento store URL is required')
  }
  return value.trim().replace(/\/$/, '')
}

export function resolveAccessToken(config: Record<string, unknown>): string {
  const value = config.accessToken
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Magento integration access token is required')
  }
  const stripped = value.trim().replace(/^Bearer\s*/i, '').trim()
  if (stripped.length === 0) {
    throw new Error('Magento integration access token is required')
  }
  return stripped
}

export function resolveStoreViewCode(config: Record<string, unknown>): string | undefined {
  const value = config.storeViewCode
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export class MagentoApiError extends Error {
  status: number
  body: string

  constructor(status: number, body: string) {
    super(`Magento API request failed with status ${status}${body ? `: ${body}` : ''}`)
    this.name = 'MagentoApiError'
    this.status = status
    this.body = body
  }
}

export type MagentoClientConfig = {
  baseUrl: string
  accessToken: string
  storeViewCode?: string
}

export type MagentoRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

export type MagentoClient = {
  get<T>(path: string, options?: MagentoRequestOptions): Promise<T>
  post<T>(path: string, body?: unknown, options?: Omit<MagentoRequestOptions, 'body'>): Promise<T>
  put<T>(path: string, body?: unknown, options?: Omit<MagentoRequestOptions, 'body'>): Promise<T>
  delete<T>(path: string, options?: MagentoRequestOptions): Promise<T>
}

function buildUrl(baseUrl: string, path: string, query?: MagentoRequestOptions['query']): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${baseUrl}/rest/V1${normalizedPath}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

export function createMagentoClient(config: Record<string, unknown>): MagentoClient {
  const baseUrl = resolveBaseUrl(config)
  const accessToken = resolveAccessToken(config)
  const storeViewCode = resolveStoreViewCode(config)

  async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: MagentoRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (storeViewCode) headers.Store = storeViewCode

    const response = await fetch(buildUrl(baseUrl, path, options.query), {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new MagentoApiError(response.status, text)
    }

    if (response.status === 204) {
      return undefined as unknown as T
    }

    return response.json() as Promise<T>
  }

  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    delete: (path, options) => request('DELETE', path, options),
  }
}
