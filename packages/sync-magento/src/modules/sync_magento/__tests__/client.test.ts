import Chance from 'chance'
import {
  resolveBaseUrl,
  resolveAccessToken,
  resolveStoreViewCode,
  MagentoApiError,
  createMagentoClient,
} from '../lib/client'

const chance = new Chance()

describe('resolveBaseUrl', () => {
  it('throws when baseUrl is missing or empty', () => {
    expect(() => resolveBaseUrl({})).toThrow('Magento store URL is required')
    expect(() => resolveBaseUrl({ baseUrl: '' })).toThrow('Magento store URL is required')
    expect(() => resolveBaseUrl({ baseUrl: '   ' })).toThrow('Magento store URL is required')
    expect(() => resolveBaseUrl({ baseUrl: 42 })).toThrow('Magento store URL is required')
  })

  it('trims the URL and removes a trailing slash', () => {
    const host = `https://${chance.domain()}`
    expect(resolveBaseUrl({ baseUrl: host })).toBe(host)
    expect(resolveBaseUrl({ baseUrl: `${host}/` })).toBe(host)
    expect(resolveBaseUrl({ baseUrl: `  ${host}  ` })).toBe(host)
  })
})

describe('resolveAccessToken', () => {
  it('throws when accessToken is missing or empty', () => {
    expect(() => resolveAccessToken({})).toThrow('Magento integration access token is required')
    expect(() => resolveAccessToken({ accessToken: '' })).toThrow('Magento integration access token is required')
    expect(() => resolveAccessToken({ accessToken: '   ' })).toThrow('Magento integration access token is required')
    expect(() => resolveAccessToken({ accessToken: chance.integer() })).toThrow('Magento integration access token is required')
  })

  it('returns a trimmed token', () => {
    const token = chance.guid()
    expect(resolveAccessToken({ accessToken: token })).toBe(token)
    expect(resolveAccessToken({ accessToken: `  ${token}  ` })).toBe(token)
  })

  it('strips a leading Bearer prefix (case-insensitive)', () => {
    const token = chance.guid()
    expect(resolveAccessToken({ accessToken: `Bearer ${token}` })).toBe(token)
    expect(resolveAccessToken({ accessToken: `bearer ${token}` })).toBe(token)
    expect(resolveAccessToken({ accessToken: `BEARER   ${token}` })).toBe(token)
    expect(resolveAccessToken({ accessToken: `  Bearer ${token}  ` })).toBe(token)
  })

  it('throws when the token is only a Bearer prefix with no actual token', () => {
    expect(() => resolveAccessToken({ accessToken: 'Bearer ' })).toThrow('Magento integration access token is required')
    expect(() => resolveAccessToken({ accessToken: 'Bearer   ' })).toThrow('Magento integration access token is required')
  })
})

describe('resolveStoreViewCode', () => {
  it('returns undefined when storeViewCode is missing, empty, or not a string', () => {
    expect(resolveStoreViewCode({})).toBeUndefined()
    expect(resolveStoreViewCode({ storeViewCode: '' })).toBeUndefined()
    expect(resolveStoreViewCode({ storeViewCode: '   ' })).toBeUndefined()
    expect(resolveStoreViewCode({ storeViewCode: 42 })).toBeUndefined()
  })

  it('returns a trimmed store view code', () => {
    const code = chance.word()
    expect(resolveStoreViewCode({ storeViewCode: code })).toBe(code)
    expect(resolveStoreViewCode({ storeViewCode: `  ${code}  ` })).toBe(code)
  })
})

describe('MagentoApiError', () => {
  it('builds a message including the status and body', () => {
    const body = chance.sentence()
    const error = new MagentoApiError(422, body)
    expect(error.name).toBe('MagentoApiError')
    expect(error.status).toBe(422)
    expect(error.body).toBe(body)
    expect(error.message).toBe(`Magento API request failed with status 422: ${body}`)
  })

  it('omits the trailing colon when the body is empty', () => {
    const error = new MagentoApiError(500, '')
    expect(error.message).toBe('Magento API request failed with status 500')
  })
})

describe('createMagentoClient', () => {
  const baseUrl = `https://${chance.domain()}`

  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('throws when required config is missing', () => {
    expect(() => createMagentoClient({})).toThrow('Magento store URL is required')
    expect(() => createMagentoClient({ baseUrl })).toThrow('Magento integration access token is required')
  })

  it('sends GET requests against /rest/V1 with Bearer auth headers', async () => {
    const accessToken = chance.guid()
    const responseBody = { id: chance.guid() }

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(responseBody),
    })

    const client = createMagentoClient({ baseUrl, accessToken })
    const result = await client.get('/store/storeViews')

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${baseUrl}/rest/V1/store/storeViews`)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${accessToken}`)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json')
    expect((init.headers as Record<string, string>)['Store']).toBeUndefined()
    expect(result).toEqual(responseBody)
  })

  it('strips a Bearer prefix stored in the access token before building headers', async () => {
    const rawToken = chance.guid()

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })

    const client = createMagentoClient({ baseUrl, accessToken: `Bearer ${rawToken}` })
    await client.get('/store/storeViews')

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${rawToken}`)
  })

  it('sets the Store header when a storeViewCode is configured', async () => {
    const storeViewCode = chance.word()

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })

    const client = createMagentoClient({ baseUrl, accessToken: chance.guid(), storeViewCode })
    await client.get('/products')

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Store']).toBe(storeViewCode)
  })

  it('serializes the body and uses the requested method for POST/PUT', async () => {
    const payload = { sku: chance.word(), price: chance.floating({ min: 1, max: 100 }) }

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ id: chance.guid() }) })

    const client = createMagentoClient({ baseUrl, accessToken: chance.guid() })
    await client.post('/products', payload)

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(payload))

    jest.resetAllMocks()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
    await client.put('/products/1', payload)
    const [, putInit] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(putInit.method).toBe('PUT')
    expect(putInit.body).toBe(JSON.stringify(payload))
  })

  it('appends query parameters and skips undefined values', async () => {
    const searchCriteria = chance.word()

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })

    const client = createMagentoClient({ baseUrl, accessToken: chance.guid() })
    await client.get('/products', { query: { searchCriteria, missing: undefined } })

    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string]
    expect(url).toContain(`searchCriteria=${encodeURIComponent(searchCriteria)}`)
    expect(url).not.toContain('missing')
  })

  it('returns undefined for 204 No Content responses without parsing JSON', async () => {
    const jsonMock = jest.fn()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204, json: jsonMock })

    const client = createMagentoClient({ baseUrl, accessToken: chance.guid() })
    const result = await client.delete(`/products/${chance.word()}`)

    expect(result).toBeUndefined()
    expect(jsonMock).not.toHaveBeenCalled()
  })

  it('throws MagentoApiError with status and body on non-ok responses', async () => {
    const body = chance.sentence()
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve(body) })

    const client = createMagentoClient({ baseUrl, accessToken: chance.guid() })

    await expect(client.get('/store/storeViews')).rejects.toThrow(`Magento API request failed with status 401: ${body}`)
  })

  it('still throws when the error body cannot be read', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.reject(new Error('stream error')) })

    const client = createMagentoClient({ baseUrl, accessToken: chance.guid() })

    await expect(client.get('/store/storeViews')).rejects.toThrow('Magento API request failed with status 500')
  })
})
