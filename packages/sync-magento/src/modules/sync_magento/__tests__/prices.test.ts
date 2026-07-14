import Chance from 'chance'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CatalogProductPrice } from '@open-mercato/core/modules/catalog/data/entities'
import { magentoHealthCheck } from '../lib/health'
import { emitSyncMagentoEvent } from '../events'
import { fetchStoreViewsByCode, isGlobalPriceScope } from '../lib/store-views'
import {
  getMapping,
  magentoPricesAdapter,
  streamExport,
  validateConnection,
} from '../lib/adapters/prices'
import { createAdapterContext, type AdapterContext } from '../lib/adapters/shared'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/catalog/data/entities', () => ({
  CatalogProductPrice: class CatalogProductPrice {},
}))

jest.mock('../lib/health', () => ({
  magentoHealthCheck: { check: jest.fn() },
}))

jest.mock('../events', () => ({ emitSyncMagentoEvent: jest.fn().mockResolvedValue(undefined) }))

jest.mock('../lib/store-views', () => ({
  fetchStoreViewsByCode: jest.fn().mockResolvedValue(new Map()),
  isGlobalPriceScope: jest.fn().mockResolvedValue(true),
}))

jest.mock('../lib/adapters/shared', () => ({
  createAdapterContext: jest.fn(),
  encodeProductCursor: (cursor: { updatedAt: string; id: string }) => JSON.stringify(cursor),
  decodeProductCursor: (cursor?: string | null) => {
    if (!cursor) return null
    try {
      const parsed = JSON.parse(cursor) as Partial<{ updatedAt: string; id: string }>
      if (typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string') {
        return { updatedAt: parsed.updatedAt, id: parsed.id }
      }
      return null
    } catch {
      return null
    }
  },
}))

const chance = new Chance()

function buildCtx(settingsOverrides: Record<string, unknown> = {}): AdapterContext {
  return {
    em: {} as AdapterContext['em'],
    client: {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    } as unknown as AdapterContext['client'],
    idMapping: {} as unknown as AdapterContext['idMapping'],
    integrationLogService: { write: jest.fn().mockResolvedValue(undefined) } as unknown as AdapterContext['integrationLogService'],
    scope: { organizationId: chance.guid(), tenantId: chance.guid() },
    selectOptionCache: new Map(),
    configurableAttributeCache: new Map(),
    magentoAttributeIdCache: new Map(),
    settings: {
      channelStockMappings: [],
      channelStoreMappings: [],
      orderImportStatuses: null,
      defaultOrderChannelId: null,
      customerStrategy: 'create_or_link',
      attributeSetPrefix: 'om',
      attributeCodeOverrides: [],
      imageSyncEnabled: false,
      productExportConcurrency: 3,
      imageUploadConcurrency: 5,
      imageMaxDimension: 2000,
      msiModeDetected: null,
      ...settingsOverrides,
    } as AdapterContext['settings'],
  }
}

function buildProductRef(overrides: Record<string, unknown> = {}) {
  return {
    id: chance.guid(),
    sku: chance.word().toUpperCase(),
    productType: 'simple',
    deletedAt: null,
    ...overrides,
  }
}

function buildVariantRef(overrides: Record<string, unknown> = {}) {
  return {
    id: chance.guid(),
    sku: chance.word().toUpperCase(),
    deletedAt: null,
    ...overrides,
  }
}

function buildPriceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: chance.guid(),
    variant: null,
    product: null,
    priceKind: { id: chance.guid(), isPromotion: false },
    channelId: null,
    minQuantity: 1,
    maxQuantity: null,
    unitPriceNet: '19.99',
    unitPriceGross: '24.99',
    startsAt: null,
    endsAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

// Wires `findWithDecryption` so the first call (the cursor page query, identified
// by an options object carrying `limit`) returns `page`, and every subsequent
// call (the per-target "reload full picture" query) returns whichever of
// `allRows` belong to the variant/product id in that call's `where`.
function mockPriceRows(page: ReturnType<typeof buildPriceRow>[], allRows: ReturnType<typeof buildPriceRow>[] = page) {
  ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, _entity, where, options) => {
    if (options?.limit) return page
    if (where?.variant) return allRows.filter((row) => row.variant?.id === where.variant)
    if (where?.product) return allRows.filter((row) => row.product?.id === where.product)
    return []
  })
}

async function collectBatches(input: Parameters<typeof streamExport>[0]) {
  const batches = []
  for await (const batch of streamExport(input)) {
    batches.push(batch)
  }
  return batches
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(new Map())
  ;(isGlobalPriceScope as jest.Mock).mockResolvedValue(true)
})

describe('getMapping', () => {
  it('returns a SKU-matched mapping for catalog.product_price', async () => {
    const mapping = await getMapping()

    expect(mapping.entityType).toBe('catalog.product_price')
    expect(mapping.matchStrategy).toBe('sku')
    expect(mapping.matchField).toBe('sku')
    expect(mapping.fields.map((f) => f.externalField)).toEqual(
      expect.arrayContaining(['sku', 'price', 'special_price', 'special_from_date', 'special_to_date', 'tier_prices']),
    )
  })
})

describe('validateConnection', () => {
  it('returns ok when the health check is healthy', async () => {
    ;(magentoHealthCheck.check as jest.Mock).mockResolvedValue({ status: 'healthy', message: 'Connected' })
    const result = await validateConnection({ credentials: {} })
    expect(result).toEqual({ ok: true, message: 'Connected', details: undefined })
  })

  it('returns not ok when the health check is unhealthy', async () => {
    ;(magentoHealthCheck.check as jest.Mock).mockResolvedValue({ status: 'unhealthy', message: 'timeout' })
    const result = await validateConnection({ credentials: {} })
    expect(result).toEqual({ ok: false, message: 'timeout' })
  })
})

describe('streamExport', () => {
  it('pushes a base price for a simple product with no channel mappings configured', async () => {
    const ctx = buildCtx()
    const product = buildProductRef()
    const row = buildPriceRow({ product, id: chance.guid() })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    mockPriceRows([row])

    const batches = await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(ctx.client.post).toHaveBeenCalledWith('/products/base-prices', {
      prices: [{ price: 19.99, store_id: 0, sku: product.sku }],
    })
    expect(ctx.client.post).toHaveBeenCalledTimes(1) // no special/tier rows -> those endpoints aren't called
    expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
    expect(emitSyncMagentoEvent).toHaveBeenCalledWith(
      'sync_magento.price.pushed',
      expect.objectContaining({ batchIndex: 0, skuCount: 1 }),
    )
  })

  it('pushes base, special, and tier prices for a configurable variant', async () => {
    const ctx = buildCtx()
    const variant = buildVariantRef()
    const regular = buildPriceRow({ variant, id: chance.guid() })
    const special = buildPriceRow({
      variant,
      id: chance.guid(),
      priceKind: { id: chance.guid(), isPromotion: true },
      unitPriceNet: '14.99',
      unitPriceGross: null,
      startsAt: new Date('2026-02-01T00:00:00.000Z'),
      endsAt: new Date('2026-02-15T00:00:00.000Z'),
    })
    const tier = buildPriceRow({ variant, id: chance.guid(), minQuantity: 10, unitPriceNet: '15.99', unitPriceGross: null })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    mockPriceRows([regular], [regular, special, tier])

    await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(ctx.client.post).toHaveBeenCalledWith('/products/base-prices', { prices: [{ price: 19.99, store_id: 0, sku: variant.sku }] })
    expect(ctx.client.post).toHaveBeenCalledWith('/products/special-price', {
      prices: [{ price: 14.99, store_id: 0, sku: variant.sku, price_from: '2026-02-01 00:00:00', price_to: '2026-02-15 00:00:00' }],
    })
    expect(ctx.client.post).toHaveBeenCalledWith('/products/tier-prices', {
      prices: [{ price: 15.99, price_type: 'fixed', website_id: 0, sku: variant.sku, customer_group: 'ALL GROUPS', quantity: 10 }],
    })
  })

  it('prefers a channel-specific price row over the global fallback when a channel mapping resolves', async () => {
    const channelId = chance.guid()
    const ctx = buildCtx({ channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }] })
    const product = buildProductRef()
    const globalRow = buildPriceRow({ product, id: chance.guid(), channelId: null, unitPriceNet: '19.99' })
    const channelRow = buildPriceRow({ product, id: chance.guid(), channelId, unitPriceNet: '29.99' })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(new Map([['default', { id: 2, code: 'default', website_id: 1, store_group_id: 1 }]]))
    mockPriceRows([globalRow], [globalRow, channelRow])

    await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(ctx.client.post).toHaveBeenCalledWith('/products/base-prices', {
      prices: [{ price: 29.99, store_id: 0, sku: product.sku }],
    })
  })

  it('submits the channel-resolved store_id when Magento catalog price scope is not Global', async () => {
    const channelId = chance.guid()
    const ctx = buildCtx({ channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }] })
    const product = buildProductRef()
    const channelRow = buildPriceRow({ product, id: chance.guid(), channelId, unitPriceNet: '29.99' })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(new Map([['default', { id: 2, code: 'default', website_id: 1, store_group_id: 1 }]]))
    ;(isGlobalPriceScope as jest.Mock).mockResolvedValue(false)
    mockPriceRows([channelRow], [channelRow])

    await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(ctx.client.post).toHaveBeenCalledWith('/products/base-prices', {
      prices: [{ price: 29.99, store_id: 2, sku: product.sku }],
    })
  })

  it('skips every target when a configured store view cannot be resolved', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = buildCtx({ channelStoreMappings: [{ channelId: chance.guid(), storeViewCode: 'missing', currencyCode: 'USD' }] })
    const product = buildProductRef()
    const row = buildPriceRow({ product, id: chance.guid() })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(new Map())
    mockPriceRows([row])

    const batches = await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(ctx.client.post).not.toHaveBeenCalled()
    expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'skipped', error: 'No price data to sync' }])
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('no Magento store view found for configured storeViewCode "missing"'))

    consoleError.mockRestore()
  })

  it('skips a price row with no priceable target (e.g. attached directly to a configurable parent)', async () => {
    const ctx = buildCtx()
    const configurableParent = buildProductRef({ productType: 'configurable' })
    const row = buildPriceRow({ product: configurableParent, id: chance.guid() })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    mockPriceRows([row])

    const batches = await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(ctx.client.post).not.toHaveBeenCalled()
    expect(batches[0].results).toEqual([{ localId: row.id, status: 'skipped', error: 'Price row has no priceable SKU' }])
  })

  it('attributes a bulk endpoint failure back to the matching SKU via the message parameters', async () => {
    const ctx = buildCtx()
    const goodProduct = buildProductRef()
    const badProduct = buildProductRef()
    const goodRow = buildPriceRow({ product: goodProduct, id: chance.guid() })
    const badRow = buildPriceRow({ product: badProduct, id: chance.guid() })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    mockPriceRows([goodRow, badRow])
    ;(ctx.client.post as jest.Mock).mockImplementation(async (path: string) => {
      if (path === '/products/base-prices') {
        return [{ message: 'Invalid price for SKU', parameters: [badProduct.sku] }]
      }
      return []
    })

    const batches = await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].results).toEqual(
      expect.arrayContaining([
        { localId: goodProduct.id, externalId: goodProduct.sku, status: 'success' },
        { localId: badProduct.id, externalId: badProduct.sku, status: 'error', error: 'Invalid price for SKU' },
      ]),
    )
  })

  it('marks every submitted SKU failed when the bulk request itself throws', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = buildCtx()
    const product = buildProductRef()
    const row = buildPriceRow({ product, id: chance.guid() })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    mockPriceRows([row])
    ;(ctx.client.post as jest.Mock).mockRejectedValue(new Error('Magento is down'))

    const batches = await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'error', error: 'Magento is down' }])

    consoleError.mockRestore()
  })

  it('marks a target skipped when it has no regular, special, or tier price row', async () => {
    const ctx = buildCtx()
    const product = buildProductRef()
    // Only a promotional row that itself resolves to nothing because filterByChannel
    // still returns it — instead exercise the true "no rows at all" case by making the
    // full reload return an empty array despite the page query having a row for it.
    const row = buildPriceRow({ product, id: chance.guid() })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, _entity, where, options) => {
      if (options?.limit) return [row]
      return []
    })

    const batches = await collectBatches({
      entityType: 'catalog.product_price',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(ctx.client.post).not.toHaveBeenCalled()
    expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'skipped', error: 'No price data to sync' }])
  })
})

describe('magentoPricesAdapter', () => {
  it('exposes the expected provider shape', async () => {
    expect(magentoPricesAdapter.providerKey).toBe('magento_prices')
    expect(magentoPricesAdapter.direction).toBe('export')
    expect(magentoPricesAdapter.supportedEntities).toEqual(['catalog.product_price'])
    expect(magentoPricesAdapter.runMode).toBe('generic')
    expect(magentoPricesAdapter.operationalTelemetry).toBe(true)
    expect(await magentoPricesAdapter.getInitialCursor?.({ entityType: 'catalog.product_price', scope: { organizationId: 'x', tenantId: 'y' } })).toBeNull()
  })
})
