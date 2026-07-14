import Chance from 'chance'
import { normalizeStoreViews, normalizeStockSources, magentoHealthCheck } from '../lib/health'

const chance = new Chance()

describe('normalizeStoreViews', () => {
  it('returns an empty array for non-array input', () => {
    expect(normalizeStoreViews(null)).toEqual([])
    expect(normalizeStoreViews(undefined)).toEqual([])
    expect(normalizeStoreViews({})).toEqual([])
    expect(normalizeStoreViews('default')).toEqual([])
  })

  it('filters out entries without a usable code', () => {
    const result = normalizeStoreViews([
      { code: 'default', name: 'Default Store View' },
      { code: '', name: 'Blank code' },
      { code: '   ', name: 'Whitespace code' },
      { name: 'Missing code' },
      null,
      42,
    ])

    expect(result).toEqual([{ code: 'default', name: 'Default Store View' }])
  })

  it('trims code/name and falls back to the code when name is missing or blank', () => {
    const result = normalizeStoreViews([
      { code: '  fr_fr  ', name: '  French Store  ' },
      { code: 'de_de', name: '' },
      { code: 'pl_pl', name: '   ' },
      { code: 'es_es' },
    ])

    expect(result).toEqual([
      { code: 'fr_fr', name: 'French Store' },
      { code: 'de_de', name: 'de_de' },
      { code: 'pl_pl', name: 'pl_pl' },
      { code: 'es_es', name: 'es_es' },
    ])
  })
})

describe('normalizeStockSources', () => {
  it('returns an empty array for unsupported shapes', () => {
    expect(normalizeStockSources(null)).toEqual([])
    expect(normalizeStockSources(undefined)).toEqual([])
    expect(normalizeStockSources({})).toEqual([])
    expect(normalizeStockSources({ items: 'not-an-array' })).toEqual([])
  })

  it('reads items directly from an array payload', () => {
    const result = normalizeStockSources([
      { source_code: 'default', name: 'Default Source' },
      { source_code: '', name: 'Blank code' },
      { source_code: '   ' },
      null,
    ])

    expect(result).toEqual([{ source_code: 'default', name: 'Default Source' }])
  })

  it('reads items from a wrapped { items } payload', () => {
    const result = normalizeStockSources({
      items: [
        { source_code: 'eu_warehouse', name: 'EU Warehouse' },
        { source_code: 'us_warehouse' },
      ],
    })

    expect(result).toEqual([
      { source_code: 'eu_warehouse', name: 'EU Warehouse' },
      { source_code: 'us_warehouse', name: 'us_warehouse' },
    ])
  })

  it('trims code/name and falls back to the code when name is missing or blank', () => {
    const result = normalizeStockSources([
      { source_code: '  eu  ', name: '  Europe  ' },
      { source_code: 'us', name: '' },
    ])

    expect(result).toEqual([
      { source_code: 'eu', name: 'Europe' },
      { source_code: 'us', name: 'us' },
    ])
  })
})

describe('magentoHealthCheck.check', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('returns healthy with normalized store views when the request succeeds', async () => {
    const baseUrl = `https://${chance.domain()}`
    const credentials = { baseUrl, accessToken: chance.guid() }
    const storeViews = [
      { code: 'default', name: 'Default Store View' },
      { code: 'fr_fr', name: 'French Store View' },
    ]

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(storeViews),
    })

    const result = await magentoHealthCheck.check(credentials)

    expect(result.status).toBe('healthy')
    expect(result.message).toBe('Connected to Magento (2 store views)')
    expect(result.details).toEqual({ storeViews })
  })

  it('uses singular phrasing when exactly one store view is returned', async () => {
    const credentials = { baseUrl: `https://${chance.domain()}`, accessToken: chance.guid() }

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ code: 'default', name: 'Default Store View' }]),
    })

    const result = await magentoHealthCheck.check(credentials)

    expect(result.message).toBe('Connected to Magento (1 store view)')
  })

  it('returns unhealthy when the API responds with a non-ok status', async () => {
    const credentials = { baseUrl: `https://${chance.domain()}`, accessToken: chance.guid() }

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    })

    const result = await magentoHealthCheck.check(credentials)

    expect(result.status).toBe('unhealthy')
    expect(result.message).toContain('Magento connection failed')
    expect(result.message).toContain('401')
    expect(result.details.error).toContain('401')
  })

  it('returns unhealthy when required credentials are missing', async () => {
    const result = await magentoHealthCheck.check({})

    expect(result.status).toBe('unhealthy')
    expect(result.message).toContain('Magento store URL is required')
    expect(result.details.error).toBe('Magento store URL is required')
  })

  it('reports "Unknown Magento error" when a non-Error value is thrown', async () => {
    const credentials = { baseUrl: `https://${chance.domain()}`, accessToken: chance.guid() }

    global.fetch = jest.fn().mockRejectedValue(chance.sentence())

    const result = await magentoHealthCheck.check(credentials)

    expect(result.status).toBe('unhealthy')
    expect(result.details.error).toBe('Unknown Magento error')
  })
})
