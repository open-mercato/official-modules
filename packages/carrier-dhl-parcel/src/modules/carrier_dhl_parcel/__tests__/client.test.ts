import Chance from 'chance'
import {
  resolveBaseUrl,
  resolveUserId,
  resolveApiKey,
  resolveAccountNumber,
  getToken,
  clearTokenCache,
  dhlRequest,
} from '../lib/client'

const chance = new Chance()

const DHL_DEFAULT_BASE_URL = 'https://api-gw.dhlparcel.nl'

function makeCredentials(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: chance.guid(),
    apiKey: chance.guid(),
    accountNumber: chance.integer({ min: 10000000, max: 99999999 }).toString(),
    ...overrides,
  }
}

function makeAuthResponse(overrides: Partial<{
  accessToken: string
  accessTokenExpiration: number
  refreshToken: string
  refreshTokenExpiration: number
}> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    accessToken: chance.guid(),
    accessTokenExpiration: now + 900,   // 15 minutes from now
    refreshToken: chance.guid(),
    refreshTokenExpiration: now + 604800, // 7 days from now
    ...overrides,
  }
}

describe('resolveBaseUrl', () => {
  it('returns the DHL production default when no override is set', () => {
    expect(resolveBaseUrl({})).toBe(DHL_DEFAULT_BASE_URL)
    expect(resolveBaseUrl({ apiBaseUrl: '' })).toBe(DHL_DEFAULT_BASE_URL)
    expect(resolveBaseUrl({ apiBaseUrl: '   ' })).toBe(DHL_DEFAULT_BASE_URL)
    expect(resolveBaseUrl({ apiBaseUrl: 42 })).toBe(DHL_DEFAULT_BASE_URL)
  })

  it('returns a trimmed override URL without trailing slash', () => {
    const host = `https://${chance.domain()}`
    expect(resolveBaseUrl({ apiBaseUrl: host })).toBe(host)
    expect(resolveBaseUrl({ apiBaseUrl: `${host}/` })).toBe(host)
    expect(resolveBaseUrl({ apiBaseUrl: `  ${host}  ` })).toBe(host)
  })
})

describe('resolveUserId', () => {
  it('returns trimmed userId from credentials', () => {
    const id = chance.guid()
    expect(resolveUserId({ userId: id })).toBe(id)
    expect(resolveUserId({ userId: `  ${id}  ` })).toBe(id)
  })

  it('throws when userId is missing or empty', () => {
    expect(() => resolveUserId({})).toThrow('userId')
    expect(() => resolveUserId({ userId: '' })).toThrow('userId')
    expect(() => resolveUserId({ userId: '   ' })).toThrow('userId')
    expect(() => resolveUserId({ userId: null })).toThrow('userId')
  })
})

describe('resolveApiKey', () => {
  it('returns trimmed apiKey from credentials', () => {
    const key = chance.guid()
    expect(resolveApiKey({ apiKey: key })).toBe(key)
    expect(resolveApiKey({ apiKey: `  ${key}  ` })).toBe(key)
  })

  it('throws when apiKey is missing or empty', () => {
    expect(() => resolveApiKey({})).toThrow('apiKey')
    expect(() => resolveApiKey({ apiKey: '' })).toThrow('apiKey')
    expect(() => resolveApiKey({ apiKey: '   ' })).toThrow('apiKey')
  })
})

describe('resolveAccountNumber', () => {
  it('returns trimmed accountNumber from credentials', () => {
    const num = '01234567'
    expect(resolveAccountNumber({ accountNumber: num })).toBe(num)
    expect(resolveAccountNumber({ accountNumber: `  ${num}  ` })).toBe(num)
  })

  it('throws when accountNumber is missing or empty', () => {
    expect(() => resolveAccountNumber({})).toThrow('accountNumber')
    expect(() => resolveAccountNumber({ accountNumber: '' })).toThrow('accountNumber')
  })
})

describe('getToken', () => {
  beforeEach(() => {
    clearTokenCache()
    jest.resetAllMocks()
  })

  it('fetches a new token via POST /authenticate/api-key on first call', async () => {
    const credentials = makeCredentials()
    const authResponse = makeAuthResponse()

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(authResponse),
    })

    const token = await getToken(credentials)

    expect(token).toBe(authResponse.accessToken)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/authenticate/api-key')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.userId).toBe(credentials.userId)
    expect(body.key).toBe(credentials.apiKey)
    expect(body.accountNumbers).toContain(credentials.accountNumber)
  })

  it('returns cached token on second call without re-fetching', async () => {
    const credentials = makeCredentials()
    const authResponse = makeAuthResponse()

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(authResponse),
    })

    const token1 = await getToken(credentials)
    const token2 = await getToken(credentials)

    expect(token1).toBe(authResponse.accessToken)
    expect(token2).toBe(authResponse.accessToken)
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1)
  })

  it('refreshes token when within 60 seconds of expiry', async () => {
    const credentials = makeCredentials()
    const now = Math.floor(Date.now() / 1000)

    // Initial auth — token expires in 30 seconds (within buffer)
    const initialAuth = makeAuthResponse({
      accessTokenExpiration: now + 30,
      refreshTokenExpiration: now + 604800,
    })
    const refreshedAuth = makeAuthResponse()

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(initialAuth),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(refreshedAuth),
      })

    // First call — triggers full auth
    await getToken(credentials)

    // Second call — token is near expiry, triggers refresh
    const token = await getToken(credentials)

    expect(token).toBe(refreshedAuth.accessToken)
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2)
    const refreshCall = (global.fetch as jest.Mock).mock.calls[1] as [string, RequestInit]
    expect(refreshCall[0]).toContain('/authenticate/refresh-token')
    const body = JSON.parse(refreshCall[1].body as string)
    expect(body.refreshToken).toBe(initialAuth.refreshToken)
  })

  it('falls back to full re-auth when refresh token fails', async () => {
    const credentials = makeCredentials()
    const now = Math.floor(Date.now() / 1000)

    const initialAuth = makeAuthResponse({
      accessTokenExpiration: now + 30, // near expiry — triggers refresh
      refreshTokenExpiration: now + 604800,
    })
    const freshAuth = makeAuthResponse()

    global.fetch = jest.fn()
      // Initial auth
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(initialAuth),
      })
      // Refresh fails
      .mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') })
      // Full re-auth succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(freshAuth),
      })

    await getToken(credentials) // initial auth
    const token = await getToken(credentials) // refresh → falls back to full re-auth

    expect(token).toBe(freshAuth.accessToken)
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(3)
  })

  it('throws authFailed when credentials are invalid', async () => {
    const credentials = makeCredentials()

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid credentials'),
    })

    await expect(getToken(credentials)).rejects.toThrow('DHL authentication failed')
  })

  it('uses separate cache entries for different userId:accountNumber pairs', async () => {
    const cred1 = makeCredentials()
    const cred2 = makeCredentials()
    const auth1 = makeAuthResponse()
    const auth2 = makeAuthResponse()

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(auth1) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(auth2) })

    const token1 = await getToken(cred1)
    const token2 = await getToken(cred2)

    expect(token1).toBe(auth1.accessToken)
    expect(token2).toBe(auth2.accessToken)
    expect(token1).not.toBe(token2)
  })
})

describe('dhlRequest', () => {
  beforeEach(() => {
    clearTokenCache()
    jest.resetAllMocks()
  })

  it('sends GET request with Bearer token and correct headers', async () => {
    const credentials = makeCredentials()
    const authResponse = makeAuthResponse()
    const responseBody = { items: [] }

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(authResponse) }) // auth
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(responseBody) }) // request

    const result = await dhlRequest(credentials, '/capabilities/business')

    expect(result).toEqual(responseBody)
    const [, authInit] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(authInit.method).toBe('POST')
    const [reqUrl, reqInit] = (global.fetch as jest.Mock).mock.calls[1] as [string, RequestInit]
    expect(reqUrl).toContain('/capabilities/business')
    expect(reqInit.method).toBe('GET') // client explicitly sets method: options.method ?? 'GET'
    expect((reqInit.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${authResponse.accessToken}`,
    )
  })

  it('appends query parameters to the URL', async () => {
    const credentials = makeCredentials()
    const authResponse = makeAuthResponse()

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(authResponse) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) })

    await dhlRequest(credentials, '/capabilities/business', {
      query: { fromCountry: 'NL', toCountry: 'DE' },
    })

    const [url] = (global.fetch as jest.Mock).mock.calls[1] as [string]
    expect(url).toContain('fromCountry=NL')
    expect(url).toContain('toCountry=DE')
  })

  it('sends POST request with serialized body', async () => {
    const credentials = makeCredentials()
    const authResponse = makeAuthResponse()
    const payload = { shipmentId: chance.guid() }

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(authResponse) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ ok: true }) })

    await dhlRequest(credentials, '/shipments', { method: 'POST', body: payload })

    const [, init] = (global.fetch as jest.Mock).mock.calls[1] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(payload))
  })

  it('retries once with fresh token on 401', async () => {
    const credentials = makeCredentials()
    const auth1 = makeAuthResponse()
    const auth2 = makeAuthResponse()
    const responseBody = { ok: true }

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(auth1) }) // initial auth
      .mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') }) // 401 on request
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(auth2) }) // re-auth
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(responseBody) }) // retry

    const result = await dhlRequest(credentials, '/test')
    expect(result).toEqual(responseBody)
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(4)
  })

  it('throws on non-ok responses after retry', async () => {
    const credentials = makeCredentials()
    const authResponse = makeAuthResponse()

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(authResponse) })
      .mockResolvedValueOnce({ ok: false, status: 422, text: () => Promise.resolve('Bad request') })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(authResponse) }) // re-auth after 401 won't happen here since it's 422
      .mockResolvedValueOnce({ ok: false, status: 422, text: () => Promise.resolve('Bad request') })

    // 422 is not 401, so no retry — throws immediately
    await expect(dhlRequest(credentials, '/shipments', { method: 'POST' })).rejects.toThrow(
      'DHL Parcel API error 422',
    )
  })
})
