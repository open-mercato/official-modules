import { appendFileSync } from 'node:fs'
import type { FilterQuery } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type {
  DataMapping,
  DataSyncAdapter,
  ExportBatch,
  ExportItemResult,
  StreamExportInput,
  ValidationResult,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import { CatalogProductPrice } from '@open-mercato/core/modules/catalog/data/entities'
import { MagentoApiError } from '../client'
import { magentoHealthCheck } from '../health'
import { emitSyncMagentoEvent } from '../../events'
import { fetchStoreViewsByCode, isGlobalPriceScope, type MagentoStoreView } from '../store-views'
import {
  type AdapterContext,
  createAdapterContext,
  decodeProductCursor,
  encodeProductCursor,
  type ProductExportCursor,
} from './shared'

const PRODUCT_PRICE_ENTITY_TYPE = 'catalog.product_price'

// A SKU whose Magento price(s) may need pushing this run: either a configurable
// product's variant (each variant is its own Magento simple product), or a
// standalone simple `CatalogProduct` that has no variants of its own.
// Configurable *parent* products are never priced directly in Magento (their
// displayed price is derived from child simples), so they're never a target.
type PricedTarget = { kind: 'variant' | 'product'; id: string; sku: string }

// Magento's bulk price endpoints are scoped by numeric store_id/website_id, but
// `MagentoSyncSettings.channelStoreMappings` only stores the human-readable store
// view code, so each OM channel mapping resolves to one push target here. When no
// channel mapping is configured at all, prices go to Magento's global scope
// (store_id 0 / website_id 0), matching Magento's out-of-the-box "Global" catalog
// price scope.
type ChannelTarget = { channelId: string | null; storeId: number; websiteId: number }

type BasePriceItem = { price: number; store_id: number; sku: string }
type SpecialPriceItem = { price: number; store_id: number; sku: string; price_from?: string; price_to?: string }
type TierPriceItem = { price: number; price_type: 'fixed'; website_id: number; sku: string; customer_group: string; quantity: number }
// Shape of the array Magento's bulk price endpoints return for entries that
// failed to save (successes are simply omitted from the response).
type MagentoPriceUpdateError = { message: string; parameters?: string[] }

const ALL_CUSTOMER_GROUPS = 'ALL GROUPS'

export async function getMapping(): Promise<DataMapping> {
  return {
    entityType: PRODUCT_PRICE_ENTITY_TYPE,
    matchStrategy: 'sku',
    matchField: 'sku',
    fields: [
      { externalField: 'sku', localField: 'sku', mappingKind: 'core', required: true, dedupeRole: 'primary' },
      { externalField: 'price', localField: 'price', mappingKind: 'core', required: true },
      { externalField: 'special_price', localField: 'specialPrice', mappingKind: 'relation' },
      { externalField: 'special_from_date', localField: 'specialFrom', mappingKind: 'relation' },
      { externalField: 'special_to_date', localField: 'specialTo', mappingKind: 'relation' },
      { externalField: 'tier_prices', localField: 'tierPrices', mappingKind: 'relation' },
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

function buildPriceWhere(scope: { organizationId: string; tenantId: string }, boundary: ProductExportCursor | null): FilterQuery<CatalogProductPrice> {
  const base: FilterQuery<CatalogProductPrice> = {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  }
  if (!boundary) return base
  const updatedAt = new Date(boundary.updatedAt)
  return {
    ...base,
    $or: [
      { updatedAt: { $gt: updatedAt } },
      { updatedAt, id: { $gt: boundary.id } },
    ],
  }
}

// A price row's target is its variant when set (configurable child or a simple
// product's own default variant); otherwise it's the product directly (simple
// products created without an explicit variant row). Rows left dangling on a
// deleted variant/product, or directly on a configurable parent (which has no
// own Magento price), aren't priceable.
function resolveTarget(row: CatalogProductPrice): PricedTarget | null {
  if (row.variant) {
    if (row.variant.deletedAt) return null
    const sku = row.variant.sku?.trim()
    return sku ? { kind: 'variant', id: row.variant.id, sku } : null
  }
  if (row.product) {
    if (row.product.deletedAt || row.product.productType === 'configurable') return null
    const sku = row.product.sku?.trim()
    return sku ? { kind: 'product', id: row.product.id, sku } : null
  }
  return null
}

async function fetchFullPriceRows(ctx: AdapterContext, target: PricedTarget): Promise<CatalogProductPrice[]> {
  return findWithDecryption(
    ctx.em,
    CatalogProductPrice,
    {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      ...(target.kind === 'variant' ? { variant: target.id } : { product: target.id }),
    },
    { populate: ['priceKind'] },
    ctx.scope,
  )
}

// Prefers rows scoped to `channelId`, falling back to the channel-agnostic
// (`channelId: null`) rows when nothing matches — same convention as the
// `magento_products` adapter's own price resolution.
function filterByChannel(rows: CatalogProductPrice[], channelId: string | null): CatalogProductPrice[] {
  if (channelId) {
    const scoped = rows.filter((row) => row.channelId === channelId)
    if (scoped.length > 0) return scoped
  }
  return rows.filter((row) => row.channelId == null)
}

function toNumber(row: CatalogProductPrice): number {
  const raw = row.unitPriceNet ?? row.unitPriceGross
  return raw ? Number(raw) : 0
}

// Magento's REST API expects `YYYY-MM-DD HH:mm:ss`, not ISO 8601.
function toMagentoDateTime(date: Date | null | undefined): string | undefined {
  if (!date) return undefined
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

// When Magento's Catalog Price Scope is Global, `price`/`special_price`/tier
// prices only accept store_id/website_id 0 ("Could not change non global Price
// when price scope is global" otherwise) — collapse every channel target to the
// global id pair in that case instead of each channel's real store/website id.
function resolveChannelTargets(
  channelStoreMappings: { channelId: string; storeViewCode: string }[],
  storeViewsByCode: Map<string, MagentoStoreView>,
  isGlobalScope: boolean,
  onMissingStoreView: (storeViewCode: string) => void,
): ChannelTarget[] {
  if (channelStoreMappings.length === 0) {
    return [{ channelId: null, storeId: 0, websiteId: 0 }]
  }
  const targets: ChannelTarget[] = []
  for (const mapping of channelStoreMappings) {
    const storeView = storeViewsByCode.get(mapping.storeViewCode)
    if (!storeView) {
      onMissingStoreView(mapping.storeViewCode)
      continue
    }
    targets.push({
      channelId: mapping.channelId,
      storeId: isGlobalScope ? 0 : storeView.id,
      websiteId: isGlobalScope ? 0 : storeView.website_id,
    })
  }
  return targets
}

// Builds this SKU's base/special/tier request entries across every configured
// channel target, marking it as "attempted" (so it gets a success/error result
// rather than being silently skipped) as soon as at least one entry is queued.
function buildPriceRequests(
  target: PricedTarget,
  rows: CatalogProductPrice[],
  channelTargets: ChannelTarget[],
  basePrices: BasePriceItem[],
  specialPrices: SpecialPriceItem[],
  tierPrices: TierPriceItem[],
  attemptedSkus: Set<string>,
): void {
  // Tier prices are website-scoped in Magento, not store-view-scoped — dedupe so
  // multiple store views on the same website don't queue the same tier twice.
  const seenTierKeys = new Set<string>()
  // Base price shares that same website/global scoping — under Global scope
  // every channel target resolves to store_id 0, so without a dedupe a
  // multi-channel setup would queue identical duplicate entries for one SKU.
  const seenBaseStoreIds = new Set<number>()

  for (const channelTarget of channelTargets) {
    const scoped = filterByChannel(rows, channelTarget.channelId)

    const regular = scoped.find((row) => !row.priceKind.isPromotion && row.minQuantity <= 1)
    if (regular && !seenBaseStoreIds.has(channelTarget.storeId)) {
      seenBaseStoreIds.add(channelTarget.storeId)
      basePrices.push({ price: toNumber(regular), store_id: channelTarget.storeId, sku: target.sku })
      attemptedSkus.add(target.sku)
    }

    const promo = scoped.find((row) => row.priceKind.isPromotion)
    if (promo) {
      specialPrices.push({
        price: toNumber(promo),
        store_id: channelTarget.storeId,
        sku: target.sku,
        price_from: toMagentoDateTime(promo.startsAt),
        price_to: toMagentoDateTime(promo.endsAt),
      })
      attemptedSkus.add(target.sku)
    }

    const tiers = scoped.filter((row) => !row.priceKind.isPromotion && row.minQuantity > 1)
    for (const tier of tiers) {
      const dedupeKey = `${channelTarget.websiteId}:${tier.minQuantity}`
      if (seenTierKeys.has(dedupeKey)) continue
      seenTierKeys.add(dedupeKey)
      tierPrices.push({
        price: toNumber(tier),
        price_type: 'fixed',
        website_id: channelTarget.websiteId,
        sku: target.sku,
        customer_group: ALL_CUSTOMER_GROUPS,
        quantity: tier.minQuantity,
      })
      attemptedSkus.add(target.sku)
    }
  }
}

function wrapPriceError(error: unknown): string {
  if (error instanceof MagentoApiError) return error.message
  if (error instanceof Error) return error.message.split('\n')[0]
  return 'Unknown price sync error'
}

// Calls one of Magento's bulk price endpoints and reconciles its response (an
// array of failures only — unmentioned SKUs are assumed to have saved) back onto
// `failedSkus`. A thrown error (network/auth/malformed request) fails every SKU
// submitted in this call, since none of them are known to have saved.
async function pushPrices<T extends { sku: string }>(
  ctx: AdapterContext,
  path: string,
  items: T[],
  failedSkus: Map<string, string>,
): Promise<void> {
  if (items.length === 0) return

  let errors: MagentoPriceUpdateError[]
  try {
    errors = (await ctx.client.post<MagentoPriceUpdateError[]>(path, { prices: items })) ?? []
  } catch (error) {
    const message = wrapPriceError(error)
    console.error(`[sync_magento] ${path} request failed: ${message}`)
    appendFileSync('/tmp/sync-magento-debug.log', `${new Date().toISOString()} REQUEST_FAILED ${path} ${JSON.stringify({ message, full: error instanceof Error ? (error.stack ?? error.message) : String(error), items })}\n`)
    for (const item of items) failedSkus.set(item.sku, message)
    return
  }
  appendFileSync('/tmp/sync-magento-debug.log', `${new Date().toISOString()} RESPONSE ${path} ${JSON.stringify({ items, errors })}\n`)

  for (const failure of errors) {
    // Magento's PriceUpdateResult doesn't carry a dedicated SKU field — the SKU is
    // typically one of the message's substitution `parameters`. Best-effort match
    // against the SKUs actually submitted in this call; anything unmatched is
    // logged but can't be attributed to a specific item (documented residual risk).
    const matched = items.find((item) => failure.parameters?.includes(item.sku) || failure.message.includes(item.sku))
    if (matched) {
      failedSkus.set(matched.sku, failure.message)
    } else {
      console.error(`[sync_magento] ${path} returned an unattributed price error: ${failure.message}`)
    }
  }
}

export async function* streamExport(input: StreamExportInput): AsyncIterable<ExportBatch> {
  const ctx = await createAdapterContext({ credentials: input.credentials, scope: input.scope, runId: input.runId })

  const storeViewsByCode = await fetchStoreViewsByCode(ctx.client).catch((error) => {
    console.error(`[sync_magento] failed to resolve Magento store views: ${error instanceof Error ? error.message : String(error)}`)
    return new Map<string, MagentoStoreView>()
  })
  const isGlobalScope = await isGlobalPriceScope(ctx.client).catch((error) => {
    console.error(`[sync_magento] failed to resolve Magento catalog price scope, assuming Global: ${error instanceof Error ? error.message : String(error)}`)
    return true
  })

  let boundary = decodeProductCursor(input.cursor)
  let cursor = input.cursor ?? ''
  let batchIndex = 0
  let hasMore = true

  while (hasMore) {
    const rows = await findWithDecryption(
      ctx.em,
      CatalogProductPrice,
      buildPriceWhere(ctx.scope, boundary),
      { orderBy: { updatedAt: 'asc', id: 'asc' }, limit: input.batchSize, populate: ['priceKind', 'variant', 'product'] },
      ctx.scope,
    )

    if (rows.length === 0) {
      yield { results: [], cursor, hasMore: false, batchIndex }
      return
    }

    // Resolve the distinct set of SKUs touched by this page's changed price rows,
    // then reload each one's *complete* current price picture (not just the rows
    // that changed) so the channel/fallback resolution below has the full set to
    // choose from — e.g. a channel-specific row changing shouldn't hide an
    // unrelated, unchanged global fallback row for a different channel.
    const targetsBySku = new Map<string, PricedTarget>()
    const skippedResults: ExportItemResult[] = []
    for (const row of rows) {
      const target = resolveTarget(row)
      if (!target) {
        skippedResults.push({ localId: row.id, status: 'skipped', error: 'Price row has no priceable SKU' })
        continue
      }
      targetsBySku.set(target.sku, target)
    }

    const missingStoreViewCodes = new Set<string>()
    const channelTargets = resolveChannelTargets(
      ctx.settings.channelStoreMappings,
      storeViewsByCode,
      isGlobalScope,
      (code) => missingStoreViewCodes.add(code),
    )
    for (const code of missingStoreViewCodes) {
      console.error(`[sync_magento] no Magento store view found for configured storeViewCode "${code}"; skipping that channel for price sync`)
    }

    const basePrices: BasePriceItem[] = []
    const specialPrices: SpecialPriceItem[] = []
    const tierPrices: TierPriceItem[] = []
    const attemptedSkus = new Set<string>()

    for (const target of targetsBySku.values()) {
      const fullRows = await fetchFullPriceRows(ctx, target)
      buildPriceRequests(target, fullRows, channelTargets, basePrices, specialPrices, tierPrices, attemptedSkus)
    }

    const failedSkus = new Map<string, string>()
    await pushPrices(ctx, '/products/base-prices', basePrices, failedSkus)
    await pushPrices(ctx, '/products/special-price', specialPrices, failedSkus)
    await pushPrices(ctx, '/products/tier-prices', tierPrices, failedSkus)

    const results: ExportItemResult[] = [...skippedResults]
    let successCount = 0
    for (const target of targetsBySku.values()) {
      if (!attemptedSkus.has(target.sku)) {
        results.push({ localId: target.id, externalId: target.sku, status: 'skipped', error: 'No price data to sync' })
        continue
      }
      const failureMessage = failedSkus.get(target.sku)
      if (failureMessage) {
        results.push({ localId: target.id, externalId: target.sku, status: 'error', error: failureMessage })
      } else {
        results.push({ localId: target.id, externalId: target.sku, status: 'success' })
        successCount += 1
      }
    }

    if (successCount > 0) {
      emitSyncMagentoEvent('sync_magento.price.pushed', {
        organizationId: ctx.scope.organizationId,
        tenantId: ctx.scope.tenantId,
        batchIndex,
        skuCount: successCount,
      }).catch((error) => {
        console.error(`[sync_magento] failed to emit price.pushed event: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    const last = rows[rows.length - 1]
    boundary = { updatedAt: last.updatedAt.toISOString(), id: last.id }
    cursor = encodeProductCursor(boundary)
    hasMore = rows.length === input.batchSize

    yield { results, cursor, hasMore, batchIndex }
    batchIndex += 1
  }
}

export const magentoPricesAdapter: DataSyncAdapter = {
  providerKey: 'magento_prices',
  direction: 'export',
  supportedEntities: [PRODUCT_PRICE_ENTITY_TYPE],
  runMode: 'generic',
  operationalTelemetry: true,
  getMapping,
  validateConnection,
  getInitialCursor: async () => null,
  streamExport,
}
