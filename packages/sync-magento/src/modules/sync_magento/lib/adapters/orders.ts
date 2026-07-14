import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  ImportItem,
  StreamImportInput,
  ValidationResult,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import { CatalogProduct } from '@open-mercato/core/modules/catalog/data/entities'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import type { OrderCreateInput } from '@open-mercato/core/modules/sales/data/validators'
import type { PersonCreateInput } from '@open-mercato/core/modules/customers/data/validators'
import { MagentoApiError } from '../client'
import { magentoHealthCheck } from '../health'
import { emitSyncMagentoEvent } from '../../events'
import { fetchStoreViewsByCode, type MagentoStoreView } from '../store-views'
import {
  type AdapterContext,
  createAdapterContext,
  decodeProductCursor,
  encodeProductCursor,
  MAGENTO_ORDERS_INTEGRATION_ID,
} from './shared'

const SALES_ORDER_ENTITY_TYPE = 'sales.order'
const CUSTOMER_PERSON_ENTITY_TYPE = 'customers.person'

// Shape of GET /rest/V1/orders entries (Magento 2.4 REST API) — trimmed to the
// fields this adapter actually reads.
type MagentoOrderAddress = {
  firstname?: string
  lastname?: string
  email?: string
  telephone?: string
  street?: string[]
  city?: string
  region?: string
  postcode?: string
  country_id?: string
  company?: string
}

type MagentoOrderItem = {
  sku?: string
  name?: string
  price?: number
  qty_ordered?: number
}

type MagentoOrder = {
  entity_id: number
  increment_id: string
  order_currency_code: string
  store_id: number
  status: string
  created_at: string
  updated_at: string
  customer_id?: number | null
  customer_email?: string
  customer_firstname?: string
  customer_lastname?: string
  items?: MagentoOrderItem[]
  billing_address?: MagentoOrderAddress
  extension_attributes?: {
    shipping_assignments?: Array<{ shipping?: { address?: MagentoOrderAddress } }>
  }
}

type MagentoOrderSearchResponse = {
  items: MagentoOrder[]
  total_count?: number
}

export async function getMapping(): Promise<DataMapping> {
  return {
    entityType: SALES_ORDER_ENTITY_TYPE,
    matchStrategy: 'externalId',
    matchField: 'entity_id',
    fields: [
      { externalField: 'entity_id', localField: 'externalReference', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
      { externalField: 'increment_id', localField: 'orderNumber', mappingKind: 'core', required: true },
      { externalField: 'order_currency_code', localField: 'currencyCode', mappingKind: 'core', required: true },
      { externalField: 'grand_total', localField: 'grandTotalGrossAmount', mappingKind: 'core' },
      { externalField: 'customer_email', localField: 'customer', mappingKind: 'relation' },
      { externalField: 'items', localField: 'lines', mappingKind: 'relation' },
    ],
  }
}

export async function validateConnection(input: { credentials: Record<string, unknown> }): Promise<ValidationResult> {
  const result = await magentoHealthCheck.check(input.credentials)
  if (result.status === 'healthy') {
    return { ok: true, message: result.message, details: result.details }
  }
  return { ok: false, message: result.message }
}

function wrapImportError(error: unknown): string {
  if (error instanceof MagentoApiError) return error.message
  if (error instanceof Error) return error.message.split('\n')[0]
  return 'Unknown order import error'
}

function buildCommandContext(ctx: AdapterContext): CommandRuntimeContext {
  return {
    container: ctx.container,
    auth: null,
    organizationScope: {
      selectedId: ctx.scope.organizationId,
      filterIds: [ctx.scope.organizationId],
      allowedIds: [ctx.scope.organizationId],
      tenantId: ctx.scope.tenantId,
    },
    selectedOrganizationId: ctx.scope.organizationId,
    organizationIds: [ctx.scope.organizationId],
  }
}

// Magento's store_id → OM channelId, via the store view's code and the
// tenant's configured channelStoreMappings. Falls back to defaultOrderChannelId
// when the order's store isn't mapped to any channel (or has no mapping at all).
function resolveOrderChannelId(
  order: MagentoOrder,
  ctx: AdapterContext,
  storeViewsById: Map<number, MagentoStoreView>,
  channelIdByStoreViewCode: Map<string, string>,
): string | null {
  const storeView = storeViewsById.get(order.store_id)
  const mappedChannelId = storeView ? channelIdByStoreViewCode.get(storeView.code) : undefined
  return mappedChannelId ?? ctx.settings.defaultOrderChannelId ?? null
}

type ResolvedCustomer = {
  entityId: string | null
  snapshot: Record<string, unknown>
}

// Resolves (and, per `customerStrategy`, creates/links) the OM customer for a
// Magento order. `skip` never links a customer entity — only a snapshot is kept.
// `create_or_link` looks up an existing mapping/email match before creating.
// `create_only` always dispatches customers.people.create (no dedup), per spec.
async function resolveOrderCustomer(order: MagentoOrder, ctx: AdapterContext): Promise<ResolvedCustomer> {
  // `customerSnapshot` is `{ customer?: {...}, contact?: unknown }` (passthrough) —
  // nest under `customer` rather than a flat record, per the sales schema shape.
  const snapshot: Record<string, unknown> = {
    customer: {
      email: order.customer_email ?? null,
      firstName: order.customer_firstname ?? null,
      lastName: order.customer_lastname ?? null,
    },
  }

  if (ctx.settings.customerStrategy === 'skip') {
    return { entityId: null, snapshot }
  }

  if (ctx.settings.customerStrategy === 'create_or_link') {
    if (order.customer_id != null) {
      const mapped = await ctx.idMapping.lookupLocalId(
        MAGENTO_ORDERS_INTEGRATION_ID,
        CUSTOMER_PERSON_ENTITY_TYPE,
        String(order.customer_id),
        ctx.scope,
      )
      if (mapped) return { entityId: mapped, snapshot }
    }

    const normalizedEmail = order.customer_email?.trim().toLowerCase()
    if (normalizedEmail) {
      const existing = await findOneWithDecryption(
        ctx.em,
        CustomerEntity,
        { primaryEmail: normalizedEmail, organizationId: ctx.scope.organizationId, tenantId: ctx.scope.tenantId, deletedAt: null },
        undefined,
        ctx.scope,
      )
      if (existing) {
        if (order.customer_id != null) {
          await ctx.idMapping.storeExternalIdMapping(
            MAGENTO_ORDERS_INTEGRATION_ID,
            CUSTOMER_PERSON_ENTITY_TYPE,
            existing.id,
            String(order.customer_id),
            ctx.scope,
          )
        }
        return { entityId: existing.id, snapshot }
      }
    }
  }

  // create_only, or create_or_link with no existing mapping/email match.
  const billingName = order.billing_address
  const firstName = order.customer_firstname?.trim() || billingName?.firstname?.trim() || 'Magento'
  const lastName = order.customer_lastname?.trim() || billingName?.lastname?.trim() || 'Customer'

  const commandBus = ctx.container.resolve('commandBus') as CommandBus
  const personInput: PersonCreateInput = {
    organizationId: ctx.scope.organizationId,
    tenantId: ctx.scope.tenantId,
    firstName,
    lastName,
    primaryEmail: order.customer_email,
  }
  const { result } = await commandBus.execute<PersonCreateInput, { entityId: string; personId: string }>(
    'customers.people.create',
    { input: personInput, ctx: buildCommandContext(ctx) },
  )

  if (order.customer_id != null) {
    await ctx.idMapping.storeExternalIdMapping(
      MAGENTO_ORDERS_INTEGRATION_ID,
      CUSTOMER_PERSON_ENTITY_TYPE,
      result.entityId,
      String(order.customer_id),
      ctx.scope,
    )
  }
  return { entityId: result.entityId, snapshot }
}

// Best-effort SKU → local CatalogProduct id lookup for a line item. Left `null`
// when no match exists — `sales_order_lines.product_id` is nullable precisely
// for this case (imported line referencing a product OM doesn't know about).
async function resolveLineProductId(sku: string, ctx: AdapterContext): Promise<string | null> {
  const product = await findOneWithDecryption(
    ctx.em,
    CatalogProduct,
    { sku, organizationId: ctx.scope.organizationId, tenantId: ctx.scope.tenantId, deletedAt: null },
    undefined,
    ctx.scope,
  )
  return product?.id ?? null
}

async function buildOrderLines(order: MagentoOrder, ctx: AdapterContext): Promise<NonNullable<OrderCreateInput['lines']>> {
  const lines: NonNullable<OrderCreateInput['lines']> = []
  for (const item of order.items ?? []) {
    const sku = item.sku?.trim()
    if (!sku) continue
    const productId = await resolveLineProductId(sku, ctx)
    lines.push({
      kind: 'product',
      productId: productId ?? undefined,
      name: item.name,
      currencyCode: order.order_currency_code,
      quantity: item.qty_ordered ?? 0,
      unitPriceNet: item.price,
      catalogSnapshot: { sku, name: item.name ?? null, price: item.price ?? null },
    })
  }
  return lines
}

function toAddressSnapshot(address: MagentoOrderAddress | undefined): Record<string, unknown> | undefined {
  if (!address) return undefined
  return { ...address }
}

async function importOrder(
  order: MagentoOrder,
  ctx: AdapterContext,
  storeViewsById: Map<number, MagentoStoreView>,
  channelIdByStoreViewCode: Map<string, string>,
): Promise<ImportItem> {
  const externalId = String(order.entity_id)

  const existingLocalId = await ctx.idMapping.lookupLocalId(
    MAGENTO_ORDERS_INTEGRATION_ID,
    SALES_ORDER_ENTITY_TYPE,
    externalId,
    ctx.scope,
  )
  if (existingLocalId) {
    return { externalId, action: 'skip', data: { localId: existingLocalId, reason: 'already_imported' } }
  }

  const channelId = resolveOrderChannelId(order, ctx, storeViewsById, channelIdByStoreViewCode)
  if (!channelId) {
    return {
      externalId,
      action: 'failed',
      data: {
        errorMessage: `No channel mapping for Magento store_id ${order.store_id} and no defaultOrderChannelId configured`,
      },
    }
  }

  try {
    const customer = await resolveOrderCustomer(order, ctx)
    const lines = await buildOrderLines(order, ctx)
    const shippingAddress = order.extension_attributes?.shipping_assignments?.[0]?.shipping?.address

    const input: OrderCreateInput = {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      orderNumber: order.increment_id,
      externalReference: externalId,
      currencyCode: order.order_currency_code,
      channelId,
      customerEntityId: customer.entityId ?? undefined,
      customerSnapshot: customer.snapshot,
      billingAddressSnapshot: toAddressSnapshot(order.billing_address),
      shippingAddressSnapshot: toAddressSnapshot(shippingAddress),
      placedAt: new Date(order.created_at),
      lines,
    }

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<OrderCreateInput, { orderId: string }>('sales.orders.create', {
      input,
      ctx: buildCommandContext(ctx),
    })

    await ctx.idMapping.storeExternalIdMapping(
      MAGENTO_ORDERS_INTEGRATION_ID,
      SALES_ORDER_ENTITY_TYPE,
      result.orderId,
      externalId,
      ctx.scope,
    )

    emitSyncMagentoEvent('sync_magento.order.imported', {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      id: result.orderId,
      externalId,
    }).catch((error) => {
      console.error(`[sync_magento] failed to emit order.imported event for order ${externalId}: ${error instanceof Error ? error.message : String(error)}`)
    })

    return { externalId, action: 'create', data: { localId: result.orderId, orderNumber: order.increment_id } }
  } catch (error) {
    const errorMessage = wrapImportError(error)
    console.error(`[sync_magento] order import failed for Magento order ${externalId}: ${errorMessage}`)
    return { externalId, action: 'failed', data: { errorMessage } }
  }
}

function buildOrderSearchQuery(
  boundary: { updatedAt: string; id: string } | null,
  orderImportStatuses: string[] | null,
  batchSize: number,
): Record<string, string> {
  const query: Record<string, string> = {
    'searchCriteria[sortOrders][0][field]': 'updated_at',
    'searchCriteria[sortOrders][0][direction]': 'ASC',
    'searchCriteria[pageSize]': String(batchSize),
    'searchCriteria[currentPage]': '1',
  }

  let filterGroupIndex = 0
  if (boundary) {
    query[`searchCriteria[filterGroups][${filterGroupIndex}][filters][0][field]`] = 'updated_at'
    query[`searchCriteria[filterGroups][${filterGroupIndex}][filters][0][value]`] = boundary.updatedAt
    query[`searchCriteria[filterGroups][${filterGroupIndex}][filters][0][conditionType]`] = 'gt'
    filterGroupIndex += 1
  }
  if (orderImportStatuses && orderImportStatuses.length > 0) {
    query[`searchCriteria[filterGroups][${filterGroupIndex}][filters][0][field]`] = 'status'
    query[`searchCriteria[filterGroups][${filterGroupIndex}][filters][0][value]`] = orderImportStatuses.join(',')
    query[`searchCriteria[filterGroups][${filterGroupIndex}][filters][0][conditionType]`] = 'in'
  }

  return query
}

export async function* streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
  const ctx = await createAdapterContext({ credentials: input.credentials, scope: input.scope, runId: input.runId })

  const storeViewsByCode = await fetchStoreViewsByCode(ctx.client).catch((error) => {
    console.error(`[sync_magento] failed to resolve Magento store views: ${error instanceof Error ? error.message : String(error)}`)
    return new Map<string, MagentoStoreView>()
  })
  const storeViewsById = new Map<number, MagentoStoreView>(
    Array.from(storeViewsByCode.values()).map((view) => [view.id, view]),
  )
  const channelIdByStoreViewCode = new Map(
    ctx.settings.channelStoreMappings.map((mapping) => [mapping.storeViewCode, mapping.channelId]),
  )

  let boundary = decodeProductCursor(input.cursor)
  let cursor = input.cursor ?? ''
  let batchIndex = 0
  let hasMore = true

  while (hasMore) {
    const query = buildOrderSearchQuery(boundary, ctx.settings.orderImportStatuses, input.batchSize)

    let response: MagentoOrderSearchResponse
    try {
      response = await ctx.client.get<MagentoOrderSearchResponse>('/orders', { query })
    } catch (error) {
      console.error(`[sync_magento] failed to fetch Magento orders: ${wrapImportError(error)}`)
      yield { items: [], cursor, hasMore: false, batchIndex }
      return
    }

    const orders = response.items ?? []
    if (orders.length === 0) {
      yield { items: [], cursor, hasMore: false, batchIndex }
      return
    }

    const items: ImportItem[] = []
    for (const order of orders) {
      items.push(await importOrder(order, ctx, storeViewsById, channelIdByStoreViewCode))
    }

    const last = orders[orders.length - 1]
    boundary = { updatedAt: last.updated_at, id: String(last.entity_id) }
    cursor = encodeProductCursor(boundary)
    hasMore = orders.length === input.batchSize

    yield {
      items,
      cursor,
      hasMore,
      totalEstimate: response.total_count,
      batchIndex,
    }
    batchIndex += 1
  }
}

export const magentoOrdersAdapter: DataSyncAdapter = {
  providerKey: 'magento_orders',
  direction: 'import',
  supportedEntities: [SALES_ORDER_ENTITY_TYPE],
  runMode: 'generic',
  operationalTelemetry: true,
  getMapping,
  validateConnection,
  getInitialCursor: async () => null,
  streamImport,
}
