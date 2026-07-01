import type { FilterQuery } from '@mikro-orm/postgresql'
import sharp from 'sharp'
import { findWithDecryption, findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type {
  DataMapping,
  DataSyncAdapter,
  ExportBatch,
  ExportItemResult,
  StreamExportInput,
  ValidationResult,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import {
  CatalogOptionSchemaTemplate,
  CatalogProduct,
  CatalogProductCategoryAssignment,
  CatalogProductPrice,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import { CustomFieldDef, CustomFieldValue } from '@open-mercato/core/modules/entities/data/entities'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { StorageDriverFactory } from '@open-mercato/core/modules/attachments/lib/drivers'
import { MagentoApiError } from '../client'
import { magentoHealthCheck } from '../health'
import { emitSyncMagentoEvent } from '../../events'
import {
  ensureAttribute,
  ensureAttributeSet,
  ensureConfigurableAttribute,
  resolveAttributeId,
  resolveAttributeOptionId,
} from './attributes'
import { ensureCategory } from './categories'
import {
  type AdapterContext,
  CATALOG_PRODUCT_ENTITY_TYPE,
  createAdapterContext,
  decodeProductCursor,
  encodeProductCursor,
  type ProductExportCursor,
} from './shared'

const CATALOG_PRODUCT_CUSTOM_FIELD_ENTITY_ID = 'catalog:catalog_product'

type MagentoCategoryLink = { position: number; category_id: number }
type MagentoCustomAttribute = { attribute_code: string; value: string }

export async function getMapping(): Promise<DataMapping> {
  return {
    entityType: CATALOG_PRODUCT_ENTITY_TYPE,
    matchStrategy: 'sku',
    matchField: 'sku',
    fields: [
      { externalField: 'sku', localField: 'sku', mappingKind: 'core', required: true, dedupeRole: 'primary' },
      { externalField: 'name', localField: 'title', mappingKind: 'core', required: true },
      { externalField: 'description', localField: 'description', mappingKind: 'core' },
      { externalField: 'status', localField: 'isActive', mappingKind: 'core', transform: 'isActive ? 1 : 2' },
      { externalField: 'weight', localField: 'weightValue', mappingKind: 'core' },
      { externalField: 'price', localField: 'price', mappingKind: 'relation', transform: 'defaultVariant.regularPrice' },
      { externalField: 'category_links', localField: 'categoryAssignments', mappingKind: 'relation' },
      { externalField: 'media_gallery_entries', localField: 'defaultMediaUrl', mappingKind: 'relation' },
      { externalField: 'custom_attributes', localField: '*', mappingKind: 'custom_field' },
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

function buildProductWhere(scope: { organizationId: string; tenantId: string }, boundary: ProductExportCursor | null): FilterQuery<CatalogProduct> {
  const base: FilterQuery<CatalogProduct> = {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    productType: { $in: ['simple', 'configurable'] },
    deletedAt: null,
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

async function loadCustomFieldDefs(ctx: AdapterContext): Promise<CustomFieldDef[]> {
  return findWithDecryption(
    ctx.em,
    CustomFieldDef,
    {
      entityId: CATALOG_PRODUCT_CUSTOM_FIELD_ENTITY_ID,
      isActive: true,
      deletedAt: null,
      $and: [
        { $or: [{ tenantId: null }, { tenantId: ctx.scope.tenantId }] },
        { $or: [{ organizationId: null }, { organizationId: ctx.scope.organizationId }] },
      ],
    },
    undefined,
    ctx.scope,
  )
}

async function resolveProductPrice(product: CatalogProduct, ctx: AdapterContext): Promise<number> {
  const defaultVariant = await findOneWithDecryption(
    ctx.em,
    CatalogProductVariant,
    {
      product: product.id,
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      isDefault: true,
      deletedAt: null,
    },
    undefined,
    ctx.scope,
  )

  const baseWhere: FilterQuery<CatalogProductPrice> = {
    organizationId: ctx.scope.organizationId,
    tenantId: ctx.scope.tenantId,
    priceKind: { isPromotion: false },
    ...(defaultVariant ? { variant: defaultVariant.id } : { product: product.id }),
  }

  const preferredChannelId = ctx.settings.channelStoreMappings[0]?.channelId ?? null

  let price = preferredChannelId
    ? await findOneWithDecryption(ctx.em, CatalogProductPrice, { ...baseWhere, channelId: preferredChannelId }, undefined, ctx.scope)
    : null

  if (!price) {
    price = await findOneWithDecryption(ctx.em, CatalogProductPrice, { ...baseWhere, channelId: null }, undefined, ctx.scope)
  }

  if (!price) return 0
  const raw = price.unitPriceNet ?? price.unitPriceGross
  return raw ? Number(raw) : 0
}

async function resolveCategoryLinks(product: CatalogProduct, ctx: AdapterContext): Promise<MagentoCategoryLink[]> {
  const assignments = await findWithDecryption(
    ctx.em,
    CatalogProductCategoryAssignment,
    { product: product.id, organizationId: ctx.scope.organizationId, tenantId: ctx.scope.tenantId },
    { populate: ['category'] },
    ctx.scope,
  )

  const links: MagentoCategoryLink[] = []
  for (const assignment of assignments) {
    const categoryId = await ensureCategory(assignment.category, ctx)
    links.push({ position: assignment.position, category_id: Number(categoryId) })
  }
  return links
}

function coerceCustomFieldValue(def: CustomFieldDef, value: CustomFieldValue): string | null {
  switch (def.kind) {
    case 'multiline':
      return value.valueMultiline ?? null
    case 'integer':
      return value.valueInt != null ? String(value.valueInt) : null
    case 'float':
      return value.valueFloat != null ? String(value.valueFloat) : null
    case 'boolean':
      return value.valueBool != null ? (value.valueBool ? '1' : '0') : null
    case 'select':
    case 'text':
    default:
      return value.valueText ?? null
  }
}

async function resolveCustomAttributes(
  product: CatalogProduct,
  ctx: AdapterContext,
  defs: CustomFieldDef[],
): Promise<MagentoCustomAttribute[]> {
  if (defs.length === 0) return []

  const values = await findWithDecryption(
    ctx.em,
    CustomFieldValue,
    { entityId: CATALOG_PRODUCT_CUSTOM_FIELD_ENTITY_ID, recordId: product.id, tenantId: ctx.scope.tenantId, deletedAt: null },
    undefined,
    ctx.scope,
  )

  const attributes: MagentoCustomAttribute[] = []
  for (const value of values) {
    const def = defs.find((candidate) => candidate.key === value.fieldKey)
    if (!def) continue
    const coerced = coerceCustomFieldValue(def, value)
    if (coerced === null) continue
    const code = await ensureAttribute(def, ctx)

    if (def.kind === 'select') {
      // Magento `select` attributes store an integer option_id, not the option label.
      const optionId = await resolveAttributeOptionId(code, coerced, ctx)
      if (optionId === null) {
        console.warn(`[sync_magento] no Magento option on attribute ${code} matches "${coerced}" (product ${product.id}); skipping attribute`)
        continue
      }
      attributes.push({ attribute_code: code, value: optionId })
      continue
    }

    attributes.push({ attribute_code: code, value: coerced })
  }
  return attributes
}

// `product.defaultMediaUrl` is typically a relative OM attachment path (e.g.
// `/api/attachments/image/...`), which Node's `fetch` cannot resolve on its own.
// Resolve it against the OM app's own base URL (not the Magento store's).
function resolveAbsoluteMediaUrl(url: string): string {
  if (/^https?:\/\//.test(url)) return url
  const base = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (!base) throw new Error(`Cannot resolve relative media URL "${url}": APP_URL is not configured`)
  return new URL(url, base).toString()
}

function isUrlKeyConflict(error: MagentoApiError): boolean {
  const lower = error.body.toLowerCase()
  return lower.includes('url key') || lower.includes('url_key')
}

function toUrlKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product'
}

function wrapExportError(error: unknown): string {
  if (error instanceof MagentoApiError) return error.message
  if (error instanceof Error) return error.message.split('\n')[0]
  return 'Unknown export error'
}

// Retries a product PUT up to 5 times on url_key uniqueness conflicts, appending
// a counter suffix (-1, -2, …) to the url_key on each retry.
async function withUrlKeyRetry<T>(baseUrlKey: string, attempt: (urlKey: string) => Promise<T>): Promise<T> {
  for (let i = 0; i <= 5; i++) {
    try {
      return await attempt(i === 0 ? baseUrlKey : `${baseUrlKey}-${i}`)
    } catch (error) {
      if (error instanceof MagentoApiError && isUrlKeyConflict(error) && i < 5) continue
      throw error
    }
  }
  throw new Error('unreachable')
}

// Matches OM's own attachment image route, e.g. `/api/attachments/image/<uuid>/img.jpg`.
const ATTACHMENT_IMAGE_URL_PATTERN = /^\/api\/attachments\/image\/([0-9a-f-]{36})(?:\/|$)/i

type ProductMedia = { buffer: Buffer; contentType: string; fileName: string }

// Most catalog product images live in a tenant-scoped, non-public attachment
// partition, so an unauthenticated `fetch` from this background worker would get a
// 401 from the attachments API even after `resolveAbsoluteMediaUrl`. Read the file
// straight from storage instead, the same way the attachments image route does.
async function readAttachmentMedia(attachmentId: string, ctx: AdapterContext): Promise<ProductMedia> {
  const attachment = await ctx.em.findOne(Attachment, {
    id: attachmentId,
    tenantId: ctx.scope.tenantId,
    organizationId: ctx.scope.organizationId,
  })
  if (!attachment) throw new Error(`Attachment ${attachmentId} not found`)

  const storageDriverFactory = new StorageDriverFactory(ctx.em)
  const driver = await storageDriverFactory.resolveForPartition(attachment.partitionCode, {
    tenantId: ctx.scope.tenantId,
    organizationId: ctx.scope.organizationId,
  })
  const { buffer } = await driver.read(attachment.partitionCode, attachment.storagePath)

  return {
    buffer,
    contentType: attachment.mimeType || 'image/jpeg',
    fileName: attachment.fileName || attachmentId,
  }
}

async function fetchRemoteMedia(url: string, sku: string): Promise<ProductMedia> {
  const absoluteUrl = resolveAbsoluteMediaUrl(url)
  const response = await fetch(absoluteUrl)
  if (!response.ok) throw new Error(`Failed to fetch product image (${response.status})`)

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'image/jpeg',
    fileName: absoluteUrl.split('/').pop()?.split('?')[0] || `${sku}.jpg`,
  }
}

// Fetches `product.defaultMediaUrl`, optionally resizes it to `imageMaxDimension`,
// and uploads it as the product's media gallery entry. Failures here do not fail
// the product export item (the product itself was already saved successfully).
async function uploadProductImage(product: CatalogProduct, ctx: AdapterContext, sku: string): Promise<void> {
  const url = product.defaultMediaUrl
  if (!url) return

  const attachmentMatch = url.match(ATTACHMENT_IMAGE_URL_PATTERN)
  const media = attachmentMatch ? await readAttachmentMedia(attachmentMatch[1], ctx) : await fetchRemoteMedia(url, sku)

  let buffer = media.buffer
  const maxDimension = ctx.settings.imageMaxDimension
  if (maxDimension > 0) {
    buffer = await sharp(buffer)
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
      .toBuffer()
  }

  const contentType = media.contentType
  const fileName = media.fileName

  await ctx.client.post(`/products/${encodeURIComponent(sku)}/media`, {
    entry: {
      media_type: 'image',
      label: product.title,
      position: 0,
      disabled: false,
      types: ['image', 'small_image', 'thumbnail'],
      content: {
        base64_encoded_data: buffer.toString('base64'),
        type: contentType,
        name: fileName,
      },
    },
  })
}

// Resolves price for a specific variant by its id (not using the isDefault shortcut).
async function resolveVariantPrice(variantId: string, product: CatalogProduct, ctx: AdapterContext): Promise<number> {
  const baseWhere: FilterQuery<CatalogProductPrice> = {
    organizationId: ctx.scope.organizationId,
    tenantId: ctx.scope.tenantId,
    priceKind: { isPromotion: false },
    variant: variantId,
  }

  const preferredChannelId = ctx.settings.channelStoreMappings[0]?.channelId ?? null
  let price = preferredChannelId
    ? await findOneWithDecryption(ctx.em, CatalogProductPrice, { ...baseWhere, channelId: preferredChannelId }, undefined, ctx.scope)
    : null

  if (!price) {
    price = await findOneWithDecryption(ctx.em, CatalogProductPrice, { ...baseWhere, channelId: null }, undefined, ctx.scope)
  }

  if (!price) return 0
  const raw = price.unitPriceNet ?? price.unitPriceGross
  return raw ? Number(raw) : 0
}

type MagentoProductStub = { id: number }
type VariantExportResult = { sku: string; magentoId: number }

// Exports a single configurable product variant as a Magento `simple` product.
// `visibility: 1` hides it from catalog/search listings — it's only reachable
// through its configurable parent.
async function exportVariantAsSimple(
  variant: CatalogProductVariant,
  parentProduct: CatalogProduct,
  ctx: AdapterContext,
  attributeSetId: string,
  categoryLinks: MagentoCategoryLink[],
  parentCustomAttributes: MagentoCustomAttribute[],
): Promise<VariantExportResult | null> {
  const sku = variant.sku?.trim()
  if (!sku) return null

  const variantPrice = await resolveVariantPrice(variant.id, parentProduct, ctx)

  const inheritedAttributes: MagentoCustomAttribute[] = []
  if (parentProduct.description) {
    inheritedAttributes.push({ attribute_code: 'description', value: parentProduct.description })
  }
  // Carry over parent custom attributes (e.g. material, care instructions) to variants
  // so each simple child inherits the catalog content attributes.
  inheritedAttributes.push(...parentCustomAttributes.filter((a) => a.attribute_code !== 'description'))

  const response = await withUrlKeyRetry(toUrlKey(sku), (urlKey) =>
    ctx.client.put<MagentoProductStub>(`/products/${encodeURIComponent(sku)}`, {
      product: {
        sku,
        name: variant.name ?? parentProduct.title,
        price: variantPrice,
        status: variant.isActive && parentProduct.isActive ? 1 : 2,
        visibility: 1, // Not visible individually — only accessible via the configurable parent.
        type_id: 'simple',
        weight: variant.weightValue ? Number(variant.weightValue) : (parentProduct.weightValue ? Number(parentProduct.weightValue) : 0),
        attribute_set_id: Number(attributeSetId),
        custom_attributes: [{ attribute_code: 'url_key', value: urlKey }, ...inheritedAttributes],
        extension_attributes: { category_links: categoryLinks },
      },
    }, { query: { saveOptions: true } }),
  )

  return { sku, magentoId: response.id }
}

async function exportConfigurableProduct(
  product: CatalogProduct,
  ctx: AdapterContext,
  attributeSetId: string,
  customFieldDefs: CustomFieldDef[],
): Promise<ExportItemResult> {
  const sku = product.sku?.trim()
  if (!sku) {
    return { localId: product.id, status: 'skipped', error: 'Missing SKU' }
  }

  try {
    const [categoryLinks, parentCustomAttributes, variants] = await Promise.all([
      resolveCategoryLinks(product, ctx),
      resolveCustomAttributes(product, ctx, customFieldDefs),
      findWithDecryption(
        ctx.em,
        CatalogProductVariant,
        { product: product.id, organizationId: ctx.scope.organizationId, tenantId: ctx.scope.tenantId, deletedAt: null },
        { orderBy: { createdAt: 'asc' } },
        ctx.scope,
      ),
    ])

    // Pre-compute configurable dimension attribute codes so they can be excluded from
    // parentCustomAttributes on variant simple products. Configurable dimension values are
    // always set per-variant in the option-value patch below; if parentCustomAttributes
    // also contains these codes (name collision between a custom field and a dimension),
    // the first variant PUT would plant a wrong value_index that the second PUT may never
    // overwrite (e.g. when optionValues is null for that dimension), causing Magento's
    // Matrix.php to crash with "Undefined array key <value_index>".
    const schema = product.optionSchemaTemplate?.schema
    const configurableAttrCodes = new Set<string>()
    if (schema?.options?.length) {
      for (const optionDef of schema.options) {
        configurableAttrCodes.add(await ensureConfigurableAttribute(optionDef, ctx))
      }
    }
    const variantBaseAttrs = configurableAttrCodes.size > 0
      ? parentCustomAttributes.filter((a) => !configurableAttrCodes.has(a.attribute_code))
      : parentCustomAttributes

    // Export each variant as a simple child product and collect their Magento ids.
    const variantResults: VariantExportResult[] = []
    for (const variant of variants) {
      const result = await exportVariantAsSimple(variant, product, ctx, attributeSetId, categoryLinks, variantBaseAttrs)
      if (result) variantResults.push(result)
    }

    // Build configurable_product_options from the option schema.
    const configurable_product_options: unknown[] = []

    if (schema?.options?.length) {
      for (let position = 0; position < schema.options.length; position++) {
        const optionDef = schema.options[position]
        const attributeCode = await ensureConfigurableAttribute(optionDef, ctx)
        const attributeId = await resolveAttributeId(attributeCode, ctx)

        // Collect the unique set of option values used by the variants for this dimension.
        const seenValueIndexes = new Set<string>()
        const values: { value_index: number }[] = []
        for (const variant of variants) {
          const rawValue = variant.optionValues?.[optionDef.code]
          if (!rawValue) continue
          const optionId = await resolveAttributeOptionId(attributeCode, rawValue, ctx)
          if (optionId && !seenValueIndexes.has(optionId)) {
            seenValueIndexes.add(optionId)
            values.push({ value_index: Number(optionId) })
          }
        }

        if (values.length === 0) continue

        configurable_product_options.push({
          attribute_id: attributeId,
          label: optionDef.label ?? optionDef.code,
          position,
          is_use_default: false,
          values,
        })
      }
    }

    // For configurable attributes (option values) on each variant, add the per-variant
    // option value to the variant's custom_attributes so Magento links the swatch correctly.
    if (schema?.options?.length) {
      for (const variant of variants) {
        const sku = variant.sku?.trim()
        if (!sku) continue
        const variantOptionAttributes: MagentoCustomAttribute[] = []
        for (const optionDef of schema.options) {
          const rawValue = variant.optionValues?.[optionDef.code]
          if (!rawValue) continue
          const attributeCode = await ensureConfigurableAttribute(optionDef, ctx)
          const optionId = await resolveAttributeOptionId(attributeCode, rawValue, ctx)
          if (optionId) variantOptionAttributes.push({ attribute_code: attributeCode, value: optionId })
        }
        if (variantOptionAttributes.length > 0) {
          // Patch the already-created variant simple product with its option attribute values.
          await ctx.client.put(`/products/${encodeURIComponent(sku)}`, {
            product: { sku, custom_attributes: variantOptionAttributes },
          })
        }
      }
    }

    const configurableCustomAttributes: MagentoCustomAttribute[] = [
      ...(product.description ? [{ attribute_code: 'description', value: product.description }] : []),
      ...parentCustomAttributes.filter((a) => a.attribute_code !== 'description'),
    ]

    await withUrlKeyRetry(toUrlKey(sku), (urlKey) =>
      ctx.client.put(`/products/${encodeURIComponent(sku)}`, {
        product: {
          sku,
          name: product.title,
          price: 0, // Magento derives the displayed price range from the child simples.
          status: product.isActive ? 1 : 2,
          visibility: 4,
          type_id: 'configurable',
          weight: product.weightValue ? Number(product.weightValue) : 0,
          attribute_set_id: Number(attributeSetId),
          custom_attributes: [{ attribute_code: 'url_key', value: urlKey }, ...configurableCustomAttributes],
          extension_attributes: {
            category_links: categoryLinks,
            configurable_product_options,
            configurable_product_links: variantResults.map((v) => v.magentoId),
          },
        },
      }, { query: { saveOptions: true } }),
    )

    if (ctx.settings.imageSyncEnabled && product.defaultMediaUrl) {
      await uploadProductImage(product, ctx, sku).catch((error) => {
        console.error(`[sync_magento] image upload failed for SKU ${sku}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    emitSyncMagentoEvent('sync_magento.product.exported', {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      id: product.id,
      sku,
    }).catch((error) => {
      console.error(`[sync_magento] failed to emit product.exported event for SKU ${sku}: ${error instanceof Error ? error.message : String(error)}`)
    })

    return { localId: product.id, externalId: sku, status: 'success' }
  } catch (error) {
    const message = wrapExportError(error)
    console.error(`[sync_magento] configurable export failed for SKU ${sku} (id=${product.id}): ${message}`)
    return { localId: product.id, externalId: sku, status: 'error', error: message }
  }
}

async function exportProduct(
  product: CatalogProduct,
  ctx: AdapterContext,
  attributeSetId: string,
  customFieldDefs: CustomFieldDef[],
): Promise<ExportItemResult> {
  if (product.productType === 'configurable') {
    return exportConfigurableProduct(product, ctx, attributeSetId, customFieldDefs)
  }

  const sku = product.sku?.trim()
  if (!sku) {
    return { localId: product.id, status: 'skipped', error: 'Missing SKU' }
  }

  try {
    const [price, categoryLinks, customAttributes] = await Promise.all([
      resolveProductPrice(product, ctx),
      resolveCategoryLinks(product, ctx),
      resolveCustomAttributes(product, ctx, customFieldDefs),
    ])

    if (product.description) {
      customAttributes.unshift({ attribute_code: 'description', value: product.description })
    }

    await withUrlKeyRetry(toUrlKey(sku), (urlKey) =>
      ctx.client.put(`/products/${encodeURIComponent(sku)}`, {
        product: {
          sku,
          name: product.title,
          price,
          status: product.isActive ? 1 : 2,
          visibility: 4,
          type_id: 'simple',
          weight: product.weightValue ? Number(product.weightValue) : 0,
          attribute_set_id: Number(attributeSetId),
          custom_attributes: [{ attribute_code: 'url_key', value: urlKey }, ...customAttributes],
          extension_attributes: { category_links: categoryLinks },
        },
      }, { query: { saveOptions: true } }),
    )

    if (ctx.settings.imageSyncEnabled && product.defaultMediaUrl) {
      await uploadProductImage(product, ctx, sku).catch((error) => {
        console.error(`[sync_magento] image upload failed for SKU ${sku}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    // Fire-and-forget per spec: a slow/failing subscriber must not block the per-item export loop.
    emitSyncMagentoEvent('sync_magento.product.exported', {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      id: product.id,
      sku,
    }).catch((error) => {
      console.error(`[sync_magento] failed to emit product.exported event for SKU ${sku}: ${error instanceof Error ? error.message : String(error)}`)
    })

    return { localId: product.id, externalId: sku, status: 'success' }
  } catch (error) {
    const message = wrapExportError(error)
    console.error(`[sync_magento] export failed for SKU ${sku} (id=${product.id}): ${message}`)
    return { localId: product.id, externalId: sku, status: 'error', error: message }
  }
}

export async function* streamExport(input: StreamExportInput): AsyncIterable<ExportBatch> {
  const ctx = await createAdapterContext({ credentials: input.credentials, scope: input.scope })
  const attributeSetId = await ensureAttributeSet(ctx)
  const customFieldDefs = await loadCustomFieldDefs(ctx)

  let boundary = decodeProductCursor(input.cursor)
  let cursor = input.cursor ?? ''
  let batchIndex = 0
  let hasMore = true

  while (hasMore) {
    const products = await findWithDecryption(
      ctx.em,
      CatalogProduct,
      buildProductWhere(ctx.scope, boundary),
      { orderBy: { updatedAt: 'asc', id: 'asc' }, limit: input.batchSize, populate: ['optionSchemaTemplate'] },
      ctx.scope,
    )

    if (products.length === 0) {
      yield { results: [], cursor, hasMore: false, batchIndex }
      return
    }

    const results: ExportItemResult[] = []
    for (const product of products) {
      results.push(await exportProduct(product, ctx, attributeSetId, customFieldDefs))
    }

    const last = products[products.length - 1]
    boundary = { updatedAt: last.updatedAt.toISOString(), id: last.id }
    cursor = encodeProductCursor(boundary)
    hasMore = products.length === input.batchSize

    yield { results, cursor, hasMore, batchIndex }
    batchIndex += 1
  }
}

export const magentoProductsAdapter: DataSyncAdapter = {
  providerKey: 'magento_products',
  direction: 'export',
  supportedEntities: [CATALOG_PRODUCT_ENTITY_TYPE],
  runMode: 'generic',
  operationalTelemetry: true,
  getMapping,
  validateConnection,
  getInitialCursor: async () => null,
  streamExport,
}
