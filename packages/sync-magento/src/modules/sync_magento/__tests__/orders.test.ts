import Chance from 'chance'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { magentoHealthCheck } from '../lib/health'
import { emitSyncMagentoEvent } from '../events'
import { fetchStoreViewsByCode } from '../lib/store-views'
import {
  getMapping,
  magentoOrdersAdapter,
  streamImport,
  validateConnection,
} from '../lib/adapters/orders'
import { createAdapterContext, type AdapterContext } from '../lib/adapters/shared'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/catalog/data/entities', () => ({
  CatalogProduct: class CatalogProduct {},
}))

jest.mock('@open-mercato/core/modules/customers/data/entities', () => ({
  CustomerEntity: class CustomerEntity {},
}))

jest.mock('../lib/health', () => ({
  magentoHealthCheck: { check: jest.fn() },
}))

jest.mock('../events', () => ({ emitSyncMagentoEvent: jest.fn().mockResolvedValue(undefined) }))

jest.mock('../lib/store-views', () => ({
  fetchStoreViewsByCode: jest.fn().mockResolvedValue(new Map()),
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
  MAGENTO_ORDERS_INTEGRATION_ID: 'sync_magento_orders',
}))

const chance = new Chance()

function buildCtx(settingsOverrides: Record<string, unknown> = {}) {
  const commandBus = { execute: jest.fn() }
  const ctx = {
    em: {} as AdapterContext['em'],
    client: {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    } as unknown as AdapterContext['client'],
    idMapping: {
      lookupLocalId: jest.fn().mockResolvedValue(null),
      lookupExternalId: jest.fn().mockResolvedValue(null),
      storeExternalIdMapping: jest.fn().mockResolvedValue(undefined),
      deleteExternalIdMapping: jest.fn(),
      deleteExternalIdMappings: jest.fn(),
    } as unknown as AdapterContext['idMapping'],
    integrationLogService: { write: jest.fn().mockResolvedValue(undefined) } as unknown as AdapterContext['integrationLogService'],
    container: { resolve: jest.fn((key: string) => (key === 'commandBus' ? commandBus : undefined)) } as unknown as AdapterContext['container'],
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
  } as AdapterContext
  return { ctx, commandBus }
}

function buildMagentoOrder(overrides: Record<string, unknown> = {}) {
  return {
    entity_id: chance.integer({ min: 1, max: 100000 }),
    increment_id: `100000${chance.integer({ min: 1, max: 9 })}`,
    order_currency_code: 'USD',
    store_id: 1,
    status: 'processing',
    created_at: '2026-01-01 10:00:00',
    updated_at: '2026-01-01T10:00:00.000Z',
    customer_id: null,
    customer_email: chance.email(),
    customer_firstname: chance.first(),
    customer_lastname: chance.last(),
    items: [{ sku: chance.word().toUpperCase(), name: chance.word(), price: 19.99, qty_ordered: 2 }],
    billing_address: { firstname: 'Bill', lastname: 'Ing', email: 'bill@example.com' },
    ...overrides,
  }
}

async function collectBatches(input: Parameters<typeof streamImport>[0]) {
  const batches = []
  for await (const batch of streamImport(input)) {
    batches.push(batch)
  }
  return batches
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(new Map())
})

describe('getMapping', () => {
  it('returns an externalId-matched mapping for sales.order', async () => {
    const mapping = await getMapping()
    expect(mapping.entityType).toBe('sales.order')
    expect(mapping.matchStrategy).toBe('externalId')
    expect(mapping.matchField).toBe('entity_id')
    expect(mapping.fields.map((f) => f.externalField)).toEqual(
      expect.arrayContaining(['entity_id', 'increment_id', 'order_currency_code', 'customer_email', 'items']),
    )
  })
})

describe('validateConnection', () => {
  it('reports healthy when the health check succeeds', async () => {
    ;(magentoHealthCheck.check as jest.Mock).mockResolvedValue({ status: 'healthy', message: 'ok' })
    const result = await validateConnection({ credentials: {} })
    expect(result.ok).toBe(true)
  })

  it('reports unhealthy when the health check fails', async () => {
    ;(magentoHealthCheck.check as jest.Mock).mockResolvedValue({ status: 'unhealthy', message: 'bad token' })
    const result = await validateConnection({ credentials: {} })
    expect(result).toEqual({ ok: false, message: 'bad token' })
  })
})

describe('streamImport', () => {
  it('skips an order whose Magento entity_id is already mapped', async () => {
    const { ctx, commandBus } = buildCtx({ defaultOrderChannelId: chance.guid() })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ctx.idMapping.lookupLocalId as jest.Mock).mockResolvedValue(chance.guid())
    const order = buildMagentoOrder()
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })

    const batches = await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].items).toEqual([
      { externalId: String(order.entity_id), action: 'skip', data: { localId: expect.any(String), reason: 'already_imported' } },
    ])
    expect(commandBus.execute).not.toHaveBeenCalled()
  })

  it('fails an order when no channel can be resolved', async () => {
    const { ctx, commandBus } = buildCtx()
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    const order = buildMagentoOrder({ store_id: 99 })
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })

    const batches = await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].items[0].action).toBe('failed')
    expect(batches[0].items[0].data.errorMessage).toContain('store_id 99')
    expect(commandBus.execute).not.toHaveBeenCalled()
  })

  it('resolves the channel via channelStoreMappings and creates the order (customerStrategy: skip)', async () => {
    const channelId = chance.guid()
    const { ctx, commandBus } = buildCtx({
      channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }],
      customerStrategy: 'skip',
    })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(
      new Map([['default', { id: 1, code: 'default', website_id: 1, store_group_id: 1 }]]),
    )
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)
    const order = buildMagentoOrder({ store_id: 1 })
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })
    commandBus.execute.mockResolvedValue({ result: { orderId: chance.guid() } })

    const batches = await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(commandBus.execute).toHaveBeenCalledTimes(1)
    const [commandId, options] = commandBus.execute.mock.calls[0]
    expect(commandId).toBe('sales.orders.create')
    expect(options.input).toMatchObject({
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      orderNumber: order.increment_id,
      externalReference: String(order.entity_id),
      currencyCode: 'USD',
      channelId,
      customerEntityId: undefined,
    })
    expect(batches[0].items[0].action).toBe('create')
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      'sync_magento_orders',
      'sales.order',
      expect.any(String),
      String(order.entity_id),
      ctx.scope,
    )
    expect(emitSyncMagentoEvent).toHaveBeenCalledWith('sync_magento.order.imported', expect.objectContaining({ externalId: String(order.entity_id) }))
  })

  it('links an existing customer by email under create_or_link without creating a new one', async () => {
    const channelId = chance.guid()
    const { ctx, commandBus } = buildCtx({
      channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }],
      customerStrategy: 'create_or_link',
    })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(
      new Map([['default', { id: 1, code: 'default', website_id: 1, store_group_id: 1 }]]),
    )
    const existingCustomerId = chance.guid()
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue({ id: existingCustomerId })
    const order = buildMagentoOrder({ store_id: 1 })
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })
    commandBus.execute.mockResolvedValue({ result: { orderId: chance.guid() } })

    await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    // Only the order-create command should fire — no customers.people.create.
    expect(commandBus.execute).toHaveBeenCalledTimes(1)
    expect(commandBus.execute.mock.calls[0][0]).toBe('sales.orders.create')
    expect(commandBus.execute.mock.calls[0][1].input.customerEntityId).toBe(existingCustomerId)
  })

  it('creates a new customer under create_or_link when no email match exists', async () => {
    const channelId = chance.guid()
    const { ctx, commandBus } = buildCtx({
      channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }],
      customerStrategy: 'create_or_link',
    })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(
      new Map([['default', { id: 1, code: 'default', website_id: 1, store_group_id: 1 }]]),
    )
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)
    const order = buildMagentoOrder({ store_id: 1 })
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })
    const newCustomerId = chance.guid()
    commandBus.execute.mockImplementation(async (commandId: string) => {
      if (commandId === 'customers.people.create') return { result: { entityId: newCustomerId, personId: chance.guid() } }
      return { result: { orderId: chance.guid() } }
    })

    await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(commandBus.execute).toHaveBeenCalledTimes(2)
    expect(commandBus.execute.mock.calls[0][0]).toBe('customers.people.create')
    expect(commandBus.execute.mock.calls[1][0]).toBe('sales.orders.create')
    expect(commandBus.execute.mock.calls[1][1].input.customerEntityId).toBe(newCustomerId)
  })

  it('always creates a new customer under create_only, even with an email match available', async () => {
    const channelId = chance.guid()
    const { ctx, commandBus } = buildCtx({
      channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }],
      customerStrategy: 'create_only',
    })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(
      new Map([['default', { id: 1, code: 'default', website_id: 1, store_group_id: 1 }]]),
    )
    const order = buildMagentoOrder({ store_id: 1 })
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })
    commandBus.execute.mockImplementation(async (commandId: string) => {
      if (commandId === 'customers.people.create') return { result: { entityId: chance.guid(), personId: chance.guid() } }
      return { result: { orderId: chance.guid() } }
    })

    await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    // create_only must never dedupe by email (the only findOneWithDecryption
    // call should be the line item's CatalogProduct SKU lookup, not CustomerEntity).
    expect(findOneWithDecryption).not.toHaveBeenCalledWith(
      expect.anything(),
      CustomerEntity,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
    expect(commandBus.execute.mock.calls[0][0]).toBe('customers.people.create')
  })

  it('resolves a line item SKU to the local product id when a match exists, and leaves it unset otherwise', async () => {
    const channelId = chance.guid()
    const { ctx, commandBus } = buildCtx({
      channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }],
      customerStrategy: 'skip',
    })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(
      new Map([['default', { id: 1, code: 'default', website_id: 1, store_group_id: 1 }]]),
    )
    const matchedSku = 'MATCHED-SKU'
    const unmatchedSku = 'UNMATCHED-SKU'
    const localProductId = chance.guid()
    ;(findOneWithDecryption as jest.Mock).mockImplementation(async (_em, _entity, where: Record<string, unknown>) =>
      where.sku === matchedSku ? { id: localProductId } : null,
    )
    const order = buildMagentoOrder({
      store_id: 1,
      items: [
        { sku: matchedSku, name: 'Matched', price: 10, qty_ordered: 1 },
        { sku: unmatchedSku, name: 'Unmatched', price: 20, qty_ordered: 1 },
      ],
    })
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })
    commandBus.execute.mockResolvedValue({ result: { orderId: chance.guid() } })

    await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    const input = commandBus.execute.mock.calls[0][1].input
    expect(input.lines).toEqual([
      expect.objectContaining({ productId: localProductId, quantity: 1 }),
      expect.objectContaining({ productId: undefined, quantity: 1 }),
    ])
  })

  it('marks the item as failed when sales.orders.create throws, without storing a mapping', async () => {
    const channelId = chance.guid()
    const { ctx, commandBus } = buildCtx({
      channelStoreMappings: [{ channelId, storeViewCode: 'default', currencyCode: 'USD' }],
      customerStrategy: 'skip',
    })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(fetchStoreViewsByCode as jest.Mock).mockResolvedValue(
      new Map([['default', { id: 1, code: 'default', website_id: 1, store_group_id: 1 }]]),
    )
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)
    const order = buildMagentoOrder({ store_id: 1 })
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [order], total_count: 1 })
    commandBus.execute.mockRejectedValue(new Error('validation failed: currencyCode is required'))

    const batches = await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].items[0]).toEqual({
      externalId: String(order.entity_id),
      action: 'failed',
      data: { errorMessage: 'validation failed: currencyCode is required' },
    })
    expect(ctx.idMapping.storeExternalIdMapping).not.toHaveBeenCalledWith(
      'sync_magento_orders',
      'sales.order',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('sets hasMore based on whether a full page was returned, and encodes the next cursor', async () => {
    const { ctx } = buildCtx({ defaultOrderChannelId: chance.guid(), customerStrategy: 'skip' })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)
    const order = buildMagentoOrder({ entity_id: 42, updated_at: '2026-02-01T00:00:00.000Z' })
    // batchSize is 1 and this order "fills" the page (hasMore=true) — the second
    // fetch must come back short (or empty) so the generator terminates.
    ;(ctx.client.get as jest.Mock)
      .mockResolvedValueOnce({ items: [order], total_count: 1 })
      .mockResolvedValueOnce({ items: [], total_count: 1 })
    const commandBusStub = { execute: jest.fn().mockResolvedValue({ result: { orderId: chance.guid() } }) }
    ;(ctx.container.resolve as jest.Mock).mockReturnValue(commandBusStub)

    const batches = await collectBatches({
      entityType: 'sales.order',
      batchSize: 1,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches[0].hasMore).toBe(true)
    expect(JSON.parse(batches[0].cursor)).toEqual({ updatedAt: '2026-02-01T00:00:00.000Z', id: '42' })
  })

  it('includes an "in" status filter group in the Magento search when orderImportStatuses is configured', async () => {
    const { ctx } = buildCtx({ defaultOrderChannelId: chance.guid(), orderImportStatuses: ['processing', 'complete'] })
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [], total_count: 0 })

    await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    const [path, options] = (ctx.client.get as jest.Mock).mock.calls[0]
    expect(path).toBe('/orders')
    expect(options.query['searchCriteria[filterGroups][0][filters][0][field]']).toBe('status')
    expect(options.query['searchCriteria[filterGroups][0][filters][0][value]']).toBe('processing,complete')
    expect(options.query['searchCriteria[filterGroups][0][filters][0][conditionType]']).toBe('in')
  })

  it('stops with an empty, non-more batch when the Magento request fails', async () => {
    const { ctx } = buildCtx()
    ;(createAdapterContext as jest.Mock).mockResolvedValue(ctx)
    ;(ctx.client.get as jest.Mock).mockRejectedValue(new Error('Magento is down'))

    const batches = await collectBatches({
      entityType: 'sales.order',
      batchSize: 10,
      credentials: {},
      mapping: await getMapping(),
      scope: ctx.scope,
    })

    expect(batches).toEqual([{ items: [], cursor: '', hasMore: false, batchIndex: 0 }])
  })
})

describe('magentoOrdersAdapter', () => {
  it('is a generic, telemetry-enabled import adapter for sales.order', () => {
    expect(magentoOrdersAdapter.providerKey).toBe('magento_orders')
    expect(magentoOrdersAdapter.direction).toBe('import')
    expect(magentoOrdersAdapter.supportedEntities).toEqual(['sales.order'])
    expect(magentoOrdersAdapter.runMode).toBe('generic')
    expect(magentoOrdersAdapter.operationalTelemetry).toBe(true)
    expect(typeof magentoOrdersAdapter.streamImport).toBe('function')
  })
})
