import Chance from 'chance'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  CatalogProduct,
  CatalogProductCategoryAssignment,
  CatalogProductPrice,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import { CustomFieldDef, CustomFieldValue } from '@open-mercato/core/modules/entities/data/entities'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { StorageDriverFactory } from '@open-mercato/core/modules/attachments/lib/drivers'
import { magentoHealthCheck } from '../lib/health'
import { emitSyncMagentoEvent } from '../events'
import {
  ensureAttribute,
  ensureAttributeSet,
  ensureConfigurableAttribute,
  resolveAttributeId,
  resolveAttributeOptionId,
} from '../lib/adapters/attributes'
import { ensureCategory } from '../lib/adapters/categories'
import {
  getMapping,
  magentoProductsAdapter,
  streamExport,
  validateConnection,
} from '../lib/adapters/products'
import { createAdapterContext, type AdapterContext } from '../lib/adapters/shared'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(),
  findOneWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/catalog/data/entities', () => ({
  CatalogProduct: class CatalogProduct {},
  CatalogProductCategoryAssignment: class CatalogProductCategoryAssignment {},
  CatalogProductPrice: class CatalogProductPrice {},
  CatalogProductVariant: class CatalogProductVariant {},
}))

jest.mock('@open-mercato/core/modules/entities/data/entities', () => ({
  CustomFieldDef: class CustomFieldDef {},
  CustomFieldValue: class CustomFieldValue {},
}))

jest.mock('@open-mercato/core/modules/attachments/data/entities', () => ({
  Attachment: class Attachment {},
}))

jest.mock('@open-mercato/core/modules/attachments/lib/drivers', () => ({
  StorageDriverFactory: jest.fn(),
}))

jest.mock('../lib/health', () => ({
  magentoHealthCheck: { check: jest.fn() },
}))

jest.mock('../events', () => ({ emitSyncMagentoEvent: jest.fn().mockResolvedValue(undefined) }))

jest.mock('../lib/adapters/attributes', () => ({
  ensureAttributeSet: jest.fn(),
  ensureAttribute: jest.fn(),
  ensureConfigurableAttribute: jest.fn(),
  resolveAttributeId: jest.fn(),
  resolveAttributeOptionId: jest.fn(),
}))

jest.mock('../lib/adapters/categories', () => ({
  ensureCategory: jest.fn(),
}))

// Stub `./shared` so its real implementation (and the `../settings` ->
// `../data/entities` / DI container chain it pulls in) is never loaded.
jest.mock('../lib/adapters/shared', () => ({
  CATALOG_PRODUCT_ENTITY_TYPE: 'catalog.product',
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
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(),
    } as unknown as AdapterContext['client'],
    idMapping: {
      lookupLocalId: jest.fn(),
      lookupExternalId: jest.fn(),
      storeExternalIdMapping: jest.fn(),
    } as unknown as AdapterContext['idMapping'],
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

function buildProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: chance.guid(),
    sku: chance.word().toUpperCase(),
    title: chance.sentence({ words: 3 }),
    description: chance.sentence(),
    isActive: true,
    weightValue: '1.5',
    defaultMediaUrl: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getMapping', () => {
  it('returns a SKU-matched mapping for catalog.product', async () => {
    const mapping = await getMapping()

    expect(mapping.entityType).toBe('catalog.product')
    expect(mapping.matchStrategy).toBe('sku')
    expect(mapping.matchField).toBe('sku')

    const skuField = mapping.fields.find((field) => field.externalField === 'sku')
    expect(skuField).toEqual(expect.objectContaining({
      localField: 'sku',
      mappingKind: 'core',
      required: true,
      dedupeRole: 'primary',
    }))
  })
})

describe('validateConnection', () => {
  it('returns ok when the health check is healthy', async () => {
    ;(magentoHealthCheck.check as jest.Mock).mockResolvedValue({
      status: 'healthy',
      message: 'Connected to Magento (1 store view)',
      details: { storeViews: [] },
    })

    const result = await validateConnection({ credentials: {} })

    expect(result).toEqual({ ok: true, message: 'Connected to Magento (1 store view)', details: { storeViews: [] } })
  })

  it('returns not ok when the health check is unhealthy', async () => {
    ;(magentoHealthCheck.check as jest.Mock).mockResolvedValue({
      status: 'unhealthy',
      message: 'Magento connection failed: timeout',
      details: { error: 'timeout' },
    })

    const result = await validateConnection({ credentials: {} })

    expect(result).toEqual({ ok: false, message: 'Magento connection failed: timeout' })
  })
})

async function collectBatches(input: Parameters<typeof streamExport>[0]) {
  const batches = []
  for await (const batch of streamExport(input)) {
    batches.push(batch)
  }
  return batches
}

describe('streamExport', () => {
  it('exports a product successfully', async () => {
    const ctx = buildCtx()
    const product = buildProduct()

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')

    ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CustomFieldDef) return []
      if (entity === CatalogProduct) return [product]
      if (entity === CatalogProductCategoryAssignment) return []
      if (entity === CustomFieldValue) return []
      throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
    })

    ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CatalogProductVariant) return null
      if (entity === CatalogProductPrice) return { unitPriceNet: '19.99', unitPriceGross: '24.99' }
      throw new Error(`Unexpected findOneWithDecryption entity: ${String(entity)}`)
    })

    const batches = await collectBatches({
      entityType: 'catalog.product',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual({
      results: [{ localId: product.id, externalId: product.sku, status: 'success' }],
      cursor: JSON.stringify({ updatedAt: product.updatedAt.toISOString(), id: product.id }),
      hasMore: false,
      batchIndex: 0,
    })

    expect(ctx.client.put).toHaveBeenCalledWith(`/products/${product.sku}`, {
      product: {
        sku: product.sku,
        name: product.title,
        price: 19.99,
        status: 1,
        visibility: 4,
        type_id: 'simple',
        weight: 1.5,
        attribute_set_id: 10,
        custom_attributes: [
          expect.objectContaining({ attribute_code: 'url_key' }),
          { attribute_code: 'description', value: product.description },
        ],
        extension_attributes: { category_links: [] },
      },
    }, { query: { saveOptions: true } })

    expect(emitSyncMagentoEvent).toHaveBeenCalledWith('sync_magento.product.exported', {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      id: product.id,
      sku: product.sku,
    })
  })

  it('skips products without a SKU', async () => {
    const ctx = buildCtx()
    const product = buildProduct({ sku: '   ' })

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')

    ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CustomFieldDef) return []
      if (entity === CatalogProduct) return [product]
      throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
    })

    const batches = await collectBatches({
      entityType: 'catalog.product',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].results).toEqual([{ localId: product.id, status: 'skipped', error: 'Missing SKU' }])
    expect(ctx.client.put).not.toHaveBeenCalled()
    expect(emitSyncMagentoEvent).not.toHaveBeenCalled()
  })

  it('isolates per-item failures within a batch', async () => {
    const ctx = buildCtx()
    const productA = buildProduct()
    const productB = buildProduct()

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')

    ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CustomFieldDef) return []
      if (entity === CatalogProduct) return [productA, productB]
      if (entity === CatalogProductCategoryAssignment) return []
      if (entity === CustomFieldValue) return []
      throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
    })

    ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CatalogProductVariant) return null
      if (entity === CatalogProductPrice) return { unitPriceNet: '19.99', unitPriceGross: '24.99' }
      throw new Error(`Unexpected findOneWithDecryption entity: ${String(entity)}`)
    })

    ;(ctx.client.put as jest.Mock).mockImplementation(async (path: string) => {
      if (path === `/products/${productA.sku}`) throw new Error('Magento rejected the request')
      return undefined
    })

    const batches = await collectBatches({
      entityType: 'catalog.product',
      batchSize: 5,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].results).toEqual([
      { localId: productA.id, externalId: productA.sku, status: 'error', error: 'Magento rejected the request' },
      { localId: productB.id, externalId: productB.sku, status: 'success' },
    ])
    expect(emitSyncMagentoEvent).toHaveBeenCalledTimes(1)
  })

  it('resolves category links and custom attributes for the export payload', async () => {
    const ctx = buildCtx()
    const product = buildProduct()
    const category = { id: chance.guid(), name: 'Accessories' }
    const categoryAssignment = { position: 0, category }
    const fieldDef = { key: 'care_instructions', kind: 'text', entityId: 'catalog:catalog_product' }
    const fieldValue = { fieldKey: 'care_instructions', valueText: 'Hand wash only' }

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')
    ;(ensureCategory as jest.Mock).mockResolvedValue('33')
    ;(ensureAttribute as jest.Mock).mockResolvedValue('om_care_instructions')

    ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CustomFieldDef) return [fieldDef]
      if (entity === CatalogProduct) return [product]
      if (entity === CatalogProductCategoryAssignment) return [categoryAssignment]
      if (entity === CustomFieldValue) return [fieldValue]
      throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
    })

    ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CatalogProductVariant) return null
      if (entity === CatalogProductPrice) return { unitPriceNet: '19.99', unitPriceGross: '24.99' }
      throw new Error(`Unexpected findOneWithDecryption entity: ${String(entity)}`)
    })

    const batches = await collectBatches({
      entityType: 'catalog.product',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
    expect(ensureCategory).toHaveBeenCalledWith(category, ctx)
    expect(ensureAttribute).toHaveBeenCalledWith(fieldDef, ctx)

    const [, payload] = (ctx.client.put as jest.Mock).mock.calls[0]
    expect(payload.product.extension_attributes.category_links).toEqual([{ position: 0, category_id: 33 }])
    expect(payload.product.custom_attributes).toEqual([
      expect.objectContaining({ attribute_code: 'url_key' }),
      { attribute_code: 'description', value: product.description },
      { attribute_code: 'om_care_instructions', value: 'Hand wash only' },
    ])
  })

  it('sends the Magento option_id for select custom fields', async () => {
    const ctx = buildCtx()
    const product = buildProduct()
    const fieldDef = { key: 'upper_material', kind: 'select', entityId: 'catalog:catalog_product' }
    const fieldValue = { fieldKey: 'upper_material', valueText: 'full_grain_leather' }

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')
    ;(ensureAttribute as jest.Mock).mockResolvedValue('om_upper_material')
    ;(resolveAttributeOptionId as jest.Mock).mockResolvedValue('142')

    ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CustomFieldDef) return [fieldDef]
      if (entity === CatalogProduct) return [product]
      if (entity === CatalogProductCategoryAssignment) return []
      if (entity === CustomFieldValue) return [fieldValue]
      throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
    })

    ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CatalogProductVariant) return null
      if (entity === CatalogProductPrice) return { unitPriceNet: '19.99', unitPriceGross: '24.99' }
      throw new Error(`Unexpected findOneWithDecryption entity: ${String(entity)}`)
    })

    const batches = await collectBatches({
      entityType: 'catalog.product',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
    expect(resolveAttributeOptionId).toHaveBeenCalledWith('om_upper_material', 'full_grain_leather', ctx)

    const [, payload] = (ctx.client.put as jest.Mock).mock.calls[0]
    expect(payload.product.custom_attributes).toEqual([
      expect.objectContaining({ attribute_code: 'url_key' }),
      { attribute_code: 'description', value: product.description },
      { attribute_code: 'om_upper_material', value: '142' },
    ])
  })

  it('skips a select custom attribute when no Magento option matches', async () => {
    const ctx = buildCtx()
    const product = buildProduct()
    const fieldDef = { key: 'upper_material', kind: 'select', entityId: 'catalog:catalog_product' }
    const fieldValue = { fieldKey: 'upper_material', valueText: 'full_grain_leather' }

    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')
    ;(ensureAttribute as jest.Mock).mockResolvedValue('om_upper_material')
    ;(resolveAttributeOptionId as jest.Mock).mockResolvedValue(null)

    ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CustomFieldDef) return [fieldDef]
      if (entity === CatalogProduct) return [product]
      if (entity === CatalogProductCategoryAssignment) return []
      if (entity === CustomFieldValue) return [fieldValue]
      throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
    })

    ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
      if (entity === CatalogProductVariant) return null
      if (entity === CatalogProductPrice) return { unitPriceNet: '19.99', unitPriceGross: '24.99' }
      throw new Error(`Unexpected findOneWithDecryption entity: ${String(entity)}`)
    })

    const batches = await collectBatches({
      entityType: 'catalog.product',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])

    const [, payload] = (ctx.client.put as jest.Mock).mock.calls[0]
    expect(payload.product.custom_attributes).toEqual([
      expect.objectContaining({ attribute_code: 'url_key' }),
      { attribute_code: 'description', value: product.description },
    ])
  })

  describe('image upload', () => {
    const originalFetch = global.fetch
    const originalAppUrl = process.env.APP_URL
    const originalPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL

    afterEach(() => {
      global.fetch = originalFetch
      if (originalAppUrl === undefined) delete process.env.APP_URL
      else process.env.APP_URL = originalAppUrl
      if (originalPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
      else process.env.NEXT_PUBLIC_APP_URL = originalPublicAppUrl
    })

    function mockFetchImage() {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new ArrayBuffer(8),
      }) as unknown as typeof fetch
    }

    function mockExportDependencies(ctx: AdapterContext, product: ReturnType<typeof buildProduct>) {
      ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
      ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')

      ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
        if (entity === CustomFieldDef) return []
        if (entity === CatalogProduct) return [product]
        if (entity === CatalogProductCategoryAssignment) return []
        if (entity === CustomFieldValue) return []
        throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
      })

      ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
        if (entity === CatalogProductVariant) return null
        if (entity === CatalogProductPrice) return { unitPriceNet: '19.99', unitPriceGross: '24.99' }
        throw new Error(`Unexpected findOneWithDecryption entity: ${String(entity)}`)
      })
    }

    it('resolves a relative defaultMediaUrl against APP_URL before fetching', async () => {
      process.env.APP_URL = 'http://localhost:3000'
      mockFetchImage()

      const ctx = buildCtx({ imageSyncEnabled: true, imageMaxDimension: 0 })
      const product = buildProduct({ defaultMediaUrl: '/media/catalog/product/img-3075.jpg' })
      mockExportDependencies(ctx, product)

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:3000/media/catalog/product/img-3075.jpg')
      expect(ctx.client.post).toHaveBeenCalledWith(`/products/${product.sku}/media`, expect.objectContaining({
        entry: expect.objectContaining({ content: expect.objectContaining({ name: 'img-3075.jpg' }) }),
      }))
    })

    it('reads an OM attachment image directly from storage instead of fetching it over HTTP', async () => {
      const attachmentId = chance.guid()
      const mockRead = jest.fn().mockResolvedValue({ buffer: Buffer.from('image-bytes') })
      const mockResolveForPartition = jest.fn().mockResolvedValue({ read: mockRead })
      ;(StorageDriverFactory as unknown as jest.Mock).mockImplementation(() => ({
        resolveForPartition: mockResolveForPartition,
      }))
      global.fetch = jest.fn() as unknown as typeof fetch

      const ctx = buildCtx({ imageSyncEnabled: true, imageMaxDimension: 0 })
      ctx.em.findOne = jest.fn().mockResolvedValue({
        id: attachmentId,
        partitionCode: 'catalog-images',
        storagePath: `${attachmentId}/img-3075.jpg`,
        mimeType: 'image/png',
        fileName: 'img-3075.jpg',
        tenantId: ctx.scope.tenantId,
        organizationId: ctx.scope.organizationId,
      }) as unknown as AdapterContext['em']['findOne']

      const product = buildProduct({ defaultMediaUrl: `/api/attachments/image/${attachmentId}/img-3075.jpg` })
      mockExportDependencies(ctx, product)

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(ctx.em.findOne).toHaveBeenCalledWith(Attachment, {
        id: attachmentId,
        tenantId: ctx.scope.tenantId,
        organizationId: ctx.scope.organizationId,
      })
      expect(mockResolveForPartition).toHaveBeenCalledWith('catalog-images', {
        tenantId: ctx.scope.tenantId,
        organizationId: ctx.scope.organizationId,
      })
      expect(mockRead).toHaveBeenCalledWith('catalog-images', `${attachmentId}/img-3075.jpg`)
      expect(ctx.client.post).toHaveBeenCalledWith(`/products/${product.sku}/media`, expect.objectContaining({
        entry: expect.objectContaining({ content: expect.objectContaining({ name: 'img-3075.jpg', type: 'image/png' }) }),
      }))
    })

    it('logs and continues when an OM attachment image is missing', async () => {
      const attachmentId = chance.guid()
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      global.fetch = jest.fn() as unknown as typeof fetch

      const ctx = buildCtx({ imageSyncEnabled: true, imageMaxDimension: 0 })
      ctx.em.findOne = jest.fn().mockResolvedValue(null) as unknown as AdapterContext['em']['findOne']

      const product = buildProduct({ defaultMediaUrl: `/api/attachments/image/${attachmentId}/img.jpg` })
      mockExportDependencies(ctx, product)

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(ctx.client.post).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`image upload failed for SKU ${product.sku}`))

      consoleError.mockRestore()
    })

    it('fetches an absolute defaultMediaUrl as-is', async () => {
      delete process.env.APP_URL
      delete process.env.NEXT_PUBLIC_APP_URL
      mockFetchImage()

      const ctx = buildCtx({ imageSyncEnabled: true, imageMaxDimension: 0 })
      const product = buildProduct({ defaultMediaUrl: 'https://cdn.example.com/img.jpg' })
      mockExportDependencies(ctx, product)

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
      expect(global.fetch).toHaveBeenCalledWith('https://cdn.example.com/img.jpg')
      expect(ctx.client.post).toHaveBeenCalledWith(`/products/${product.sku}/media`, expect.objectContaining({
        entry: expect.objectContaining({ content: expect.objectContaining({ name: 'img.jpg' }) }),
      }))
    })

    it('logs and continues when APP_URL is not configured for a relative defaultMediaUrl', async () => {
      delete process.env.APP_URL
      delete process.env.NEXT_PUBLIC_APP_URL
      global.fetch = jest.fn() as unknown as typeof fetch
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      const ctx = buildCtx({ imageSyncEnabled: true, imageMaxDimension: 0 })
      const product = buildProduct({ defaultMediaUrl: '/media/catalog/product/img.jpg' })
      mockExportDependencies(ctx, product)

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches[0].results).toEqual([{ localId: product.id, externalId: product.sku, status: 'success' }])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(ctx.client.post).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`image upload failed for SKU ${product.sku}`))

      consoleError.mockRestore()
    })
  })
})

  describe('configurable products', () => {
    function buildConfigurableProduct(overrides: Record<string, unknown> = {}) {
      return {
        id: chance.guid(),
        sku: chance.word().toUpperCase(),
        title: chance.sentence({ words: 3 }),
        description: chance.sentence(),
        isActive: true,
        weightValue: '0.5',
        defaultMediaUrl: null,
        productType: 'configurable',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        optionSchemaTemplate: {
          schema: {
            options: [
              { code: 'color', label: 'Color', inputType: 'select', choices: [{ code: 'red', label: 'Red' }, { code: 'blue', label: 'Blue' }] },
              { code: 'size', label: 'Size', inputType: 'select', choices: [{ code: 's', label: 'S' }, { code: 'l', label: 'L' }] },
            ],
          },
        },
        ...overrides,
      }
    }

    function buildVariant(parentId: string, overrides: Record<string, unknown> = {}) {
      return {
        id: chance.guid(),
        product: { id: parentId },
        sku: chance.word().toUpperCase(),
        name: null,
        isActive: true,
        weightValue: null,
        optionValues: { color: 'Red', size: 'S' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
        ...overrides,
      }
    }

    it('exports a configurable product with two variants', async () => {
      const ctx = buildCtx()
      const parent = buildConfigurableProduct()
      const variantA = buildVariant(parent.id, { optionValues: { color: 'Red', size: 'S' } })
      const variantB = buildVariant(parent.id, { optionValues: { color: 'Blue', size: 'L' } })

      ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
      ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')
      ;(ensureConfigurableAttribute as jest.Mock)
        .mockResolvedValueOnce('om_color')  // color
        .mockResolvedValueOnce('om_size')   // size
        .mockResolvedValue('om_color')       // repeated calls for variant option patching

      ;(resolveAttributeId as jest.Mock)
        .mockResolvedValueOnce(93)   // om_color attribute_id
        .mockResolvedValueOnce(157)  // om_size attribute_id

      ;(resolveAttributeOptionId as jest.Mock).mockImplementation(async (_code: string, label: string) => {
        const map: Record<string, string> = { Red: '23', Blue: '24', S: '56', L: '57' }
        return map[label] ?? null
      })

      // First two PUT calls are variant simple products (return their Magento ids)
      const variantAMagentoId = chance.integer({ min: 100, max: 999 })
      const variantBMagentoId = chance.integer({ min: 1000, max: 9999 })
      ;(ctx.client.put as jest.Mock)
        .mockResolvedValueOnce({ id: variantAMagentoId })   // variantA simple
        .mockResolvedValueOnce({ id: variantBMagentoId })   // variantB simple
        .mockResolvedValueOnce(undefined)                    // variantA option attribute patch
        .mockResolvedValueOnce(undefined)                    // variantB option attribute patch
        .mockResolvedValueOnce(undefined)                    // parent configurable PUT

      ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
        if (entity === CustomFieldDef) return []
        if (entity === CatalogProduct) return [parent]
        if (entity === CatalogProductCategoryAssignment) return []
        if (entity === CustomFieldValue) return []
        if (entity === CatalogProductVariant) return [variantA, variantB]
        throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
      })

      ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null) // no prices

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches).toHaveLength(1)
      expect(batches[0].results).toEqual([{ localId: parent.id, externalId: parent.sku, status: 'success' }])

      // The last PUT is the configurable parent
      const calls = (ctx.client.put as jest.Mock).mock.calls
      const parentCall = calls[calls.length - 1]
      const [parentPath, parentPayload] = parentCall
      expect(parentPath).toBe(`/products/${parent.sku}`)
      expect(parentPayload.product.type_id).toBe('configurable')
      expect(parentPayload.product.extension_attributes.configurable_product_links).toEqual([variantAMagentoId, variantBMagentoId])
      expect(parentPayload.product.extension_attributes.configurable_product_options).toHaveLength(2)

      const colorOption = parentPayload.product.extension_attributes.configurable_product_options[0]
      expect(colorOption.attribute_id).toBe(93)
      expect(colorOption.label).toBe('Color')
      expect(colorOption.values).toEqual(expect.arrayContaining([{ value_index: 23 }, { value_index: 24 }]))

      const sizeOption = parentPayload.product.extension_attributes.configurable_product_options[1]
      expect(sizeOption.attribute_id).toBe(157)
      expect(sizeOption.label).toBe('Size')
      expect(sizeOption.values).toEqual(expect.arrayContaining([{ value_index: 56 }, { value_index: 57 }]))

      expect(emitSyncMagentoEvent).toHaveBeenCalledWith('sync_magento.product.exported', expect.objectContaining({ sku: parent.sku }))
    })

    it('skips variants without a SKU and exports the configurable parent regardless', async () => {
      const ctx = buildCtx()
      const parent = buildConfigurableProduct()
      const variantWithSku = buildVariant(parent.id)
      const variantNoSku = buildVariant(parent.id, { sku: '' })

      ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
      ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')
      ;(ensureConfigurableAttribute as jest.Mock).mockResolvedValue('om_color')
      ;(resolveAttributeId as jest.Mock).mockResolvedValue(93)
      ;(resolveAttributeOptionId as jest.Mock).mockResolvedValue('23')

      ;(ctx.client.put as jest.Mock)
        .mockResolvedValueOnce({ id: 500 })  // variantWithSku
        .mockResolvedValueOnce(undefined)     // variant option patch
        .mockResolvedValueOnce(undefined)     // parent configurable

      ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
        if (entity === CustomFieldDef) return []
        if (entity === CatalogProduct) return [parent]
        if (entity === CatalogProductCategoryAssignment) return []
        if (entity === CustomFieldValue) return []
        if (entity === CatalogProductVariant) return [variantWithSku, variantNoSku]
        throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
      })

      ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches[0].results).toEqual([{ localId: parent.id, externalId: parent.sku, status: 'success' }])
      // Only the variant with a SKU should trigger a PUT for a child simple
      const putPaths = (ctx.client.put as jest.Mock).mock.calls.map(([path]: [string]) => path)
      expect(putPaths.filter((p) => p !== `/products/${parent.sku}`)).toHaveLength(2) // child + option patch
    })

    it('isolates a Magento error during configurable export without failing other items', async () => {
      const ctx = buildCtx()
      const goodSimple = buildProduct()
      const badConfigurable = buildConfigurableProduct()
      badConfigurable.sku = 'CONF-BAD'

      ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
      ;(ensureAttributeSet as jest.Mock).mockResolvedValue('10')
      ;(ensureConfigurableAttribute as jest.Mock).mockResolvedValue('om_color')
      ;(resolveAttributeId as jest.Mock).mockResolvedValue(93)
      ;(resolveAttributeOptionId as jest.Mock).mockResolvedValue('23')

      ;(ctx.client.put as jest.Mock).mockImplementation(async (path: string) => {
        if (path.includes('CONF-BAD')) throw new Error('Magento rejected configurable')
        return { id: 42 }
      })

      ;(findWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
        if (entity === CustomFieldDef) return []
        if (entity === CatalogProduct) return [badConfigurable, goodSimple]
        if (entity === CatalogProductCategoryAssignment) return []
        if (entity === CustomFieldValue) return []
        if (entity === CatalogProductVariant) return []
        throw new Error(`Unexpected findWithDecryption entity: ${String(entity)}`)
      })

      ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, entity) => {
        if (entity === CatalogProductVariant) return null
        if (entity === CatalogProductPrice) return { unitPriceNet: '9.99', unitPriceGross: null }
        throw new Error(`Unexpected findOneWithDecryption entity: ${String(entity)}`)
      })

      const batches = await collectBatches({
        entityType: 'catalog.product',
        batchSize: 10,
        credentials: {},
        mapping: await getMapping(),
        scope: ctx.scope,
      })

      expect(batches[0].results).toEqual([
        { localId: badConfigurable.id, externalId: 'CONF-BAD', status: 'error', error: 'Magento rejected configurable' },
        { localId: goodSimple.id, externalId: goodSimple.sku, status: 'success' },
      ])
    })
  })

describe('magentoProductsAdapter', () => {
  it('exposes the expected provider shape', async () => {
    expect(magentoProductsAdapter.providerKey).toBe('magento_products')
    expect(magentoProductsAdapter.direction).toBe('export')
    expect(magentoProductsAdapter.supportedEntities).toEqual(['catalog.product'])
    expect(magentoProductsAdapter.runMode).toBe('generic')
    expect(magentoProductsAdapter.operationalTelemetry).toBe(true)
    expect(typeof magentoProductsAdapter.streamExport).toBe('function')
    await expect(magentoProductsAdapter.getInitialCursor!({ entityType: 'catalog.product', scope: { organizationId: 'a', tenantId: 'b' } })).resolves.toBeNull()
  })
})
