import { slugify } from '@open-mercato/shared/lib/slugify'
import type { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import type { CatalogProductOptionDefinition } from '@open-mercato/core/modules/catalog/data/types'
import { MagentoApiError, type MagentoClient } from '../client'
import { emitSyncMagentoEvent } from '../../events'
import {
  type AdapterContext,
  MAGENTO_ATTRIBUTE_ENTITY_TYPE,
  MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
  MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
  MAGENTO_DEFAULT_ATTRIBUTE_SET_ID,
  MAGENTO_PRODUCTS_INTEGRATION_ID,
} from './shared'

type MagentoAttributeSet = {
  attribute_set_id: number
  attribute_set_name: string
}

type MagentoAttributeSetList = {
  items?: MagentoAttributeSet[]
}

type MagentoAttributeGroup = {
  attribute_group_id: number
  attribute_group_name: string
}

type MagentoAttributeOption = {
  label: string
  value: string
}

type MagentoAttributeResponse = {
  attribute_id?: number
  options?: MagentoAttributeOption[]
}

// Converts an OM custom field key into a Magento-compatible attribute code:
// lowercase letters, digits, underscores, starting with a letter, max 60 chars.
export function toMagentoAttributeCode(key: string, prefix: string): string {
  const base = slugify(key, { replacement: '_', allowedChars: '_' }) || 'field'
  const withPrefix = prefix ? `${prefix}_${base}` : base
  const withLeadingLetter = /^[a-z]/.test(withPrefix) ? withPrefix : `a_${withPrefix}`
  const truncated = withLeadingLetter.slice(0, 60).replace(/_+$/, '')
  return truncated.length > 0 ? truncated : 'a'
}

function mapFrontendInput(kind: string): string {
  switch (kind) {
    case 'multiline':
      return 'textarea'
    case 'boolean':
      return 'boolean'
    case 'select':
      return 'select'
    case 'integer':
    case 'float':
    default:
      return 'text'
  }
}

function buildAttributeOptions(fieldDef: CustomFieldDef): MagentoAttributeOption[] | undefined {
  const configJson = fieldDef.configJson as { options?: unknown[] } | null | undefined
  const rawOptions = Array.isArray(configJson?.options) ? configJson!.options : null
  if (!rawOptions) return undefined
  return rawOptions.map((option) => {
    if (typeof option === 'string') return { label: option, value: '' }
    const candidate = option as { label?: unknown; value?: unknown }
    const label = typeof candidate.label === 'string' ? candidate.label : String(candidate.value ?? '')
    return { label, value: '' }
  })
}

async function findAttributeSetIdByName(client: MagentoClient, name: string): Promise<string | null> {
  const result = await client.get<MagentoAttributeSetList>('/products/attribute-sets/sets/list', {
    query: {
      'searchCriteria[filterGroups][0][filters][0][field]': 'attribute_set_name',
      'searchCriteria[filterGroups][0][filters][0][value]': name,
      'searchCriteria[filterGroups][0][filters][0][conditionType]': 'eq',
    },
  })
  const match = result.items?.find((item) => item.attribute_set_name === name)
  return match ? String(match.attribute_set_id) : null
}

async function createAttributeSet(client: MagentoClient, name: string): Promise<string> {
  const created = await client.post<MagentoAttributeSet>('/products/attribute-sets', {
    attributeSet: { attribute_set_name: name },
    skeletonId: Number(MAGENTO_DEFAULT_ATTRIBUTE_SET_ID),
  })
  return String(created.attribute_set_id)
}

/**
 * Resolves the Magento attribute set used for OM-derived custom-field attributes.
 * One set per tenant scope for MVP, cached via ExternalIdMappingService.
 *
 * If `attributeSetPrefix` is empty, provisioning is skipped entirely and Magento's
 * built-in "Default" set is used (per the entity comment's collision-risk tradeoff).
 */
export async function ensureAttributeSet(ctx: AdapterContext): Promise<string> {
  if (!ctx.settings.attributeSetPrefix) return MAGENTO_DEFAULT_ATTRIBUTE_SET_ID

  const cached = await ctx.idMapping.lookupExternalId(
    MAGENTO_PRODUCTS_INTEGRATION_ID,
    MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
    MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
    ctx.scope,
  )
  if (cached) return cached

  const attributeSetName = `${ctx.settings.attributeSetPrefix}_default`
  const existing = await findAttributeSetIdByName(ctx.client, attributeSetName)
  if (existing) {
    await ctx.idMapping.storeExternalIdMapping(
      MAGENTO_PRODUCTS_INTEGRATION_ID,
      MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
      MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
      existing,
      ctx.scope,
    )
    return existing
  }

  const created = await createAttributeSet(ctx.client, attributeSetName)
  await ctx.idMapping.storeExternalIdMapping(
    MAGENTO_PRODUCTS_INTEGRATION_ID,
    MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
    MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
    created,
    ctx.scope,
  )
  await emitSyncMagentoEvent('sync_magento.attribute_set.provisioned', {
    organizationId: ctx.scope.organizationId,
    tenantId: ctx.scope.tenantId,
    attributeSetId: created,
    attributeSetName,
  })
  return created
}

async function attributeExists(client: MagentoClient, code: string): Promise<boolean> {
  try {
    await client.get(`/products/attributes/${encodeURIComponent(code)}`)
    return true
  } catch (error) {
    if (error instanceof MagentoApiError && error.status === 404) return false
    throw error
  }
}

async function createAttribute(client: MagentoClient, code: string, fieldDef: CustomFieldDef): Promise<void> {
  try {
    await client.post('/products/attributes', {
      attribute: {
        attribute_code: code,
        frontend_input: mapFrontendInput(fieldDef.kind),
        default_frontend_label: fieldDef.key,
        is_required: false,
        is_user_defined: true,
        options: buildAttributeOptions(fieldDef),
      },
    })
  } catch (error) {
    // Concurrent export run may have created this attribute first; treat as success.
    if (error instanceof MagentoApiError && (error.status === 409 || error.status === 400)) return
    throw error
  }
}

async function resolveDefaultAttributeGroupId(client: MagentoClient, attributeSetId: string): Promise<number> {
  const groups = await client.get<MagentoAttributeGroup[]>(`/products/attribute-sets/${attributeSetId}/groups`, {
    query: {
      'searchCriteria[filterGroups][0][filters][0][field]': 'attribute_set_id',
      'searchCriteria[filterGroups][0][filters][0][value]': attributeSetId,
      'searchCriteria[filterGroups][0][filters][0][conditionType]': 'eq',
    },
  })
  const list = Array.isArray(groups) ? groups : []
  const preferred = list.find((group) => /general|product details/i.test(group.attribute_group_name))
  return (preferred ?? list[0])?.attribute_group_id ?? 0
}

async function assignAttributeToSet(client: MagentoClient, attributeSetId: string, code: string): Promise<void> {
  const attributeGroupId = await resolveDefaultAttributeGroupId(client, attributeSetId)
  try {
    await client.post(`/products/attribute-sets/${attributeSetId}/attributes`, {
      attributeSetId: Number(attributeSetId),
      attributeGroupId,
      attributeCode: code,
      sortOrder: 0,
    })
  } catch (error) {
    // Already assigned (e.g. concurrent run) is not an error for our purposes.
    if (error instanceof MagentoApiError && (error.status === 409 || error.status === 400)) return
    throw error
  }
}

async function fetchAndCacheAttribute(attributeCode: string, ctx: AdapterContext): Promise<{ attributeId: number; optionMap: Map<string, string> }> {
  const existingOptions = ctx.selectOptionCache.get(attributeCode)
  const existingId = ctx.magentoAttributeIdCache.get(attributeCode)
  if (existingOptions && existingId !== undefined) {
    return { attributeId: existingId, optionMap: existingOptions }
  }

  const attribute = await ctx.client.get<MagentoAttributeResponse>(
    `/products/attributes/${encodeURIComponent(attributeCode)}`,
  )
  const optionMap = new Map<string, string>()
  for (const option of attribute.options ?? []) {
    if (option.label) optionMap.set(option.label, option.value)
  }
  ctx.selectOptionCache.set(attributeCode, optionMap)
  const attributeId = attribute.attribute_id ?? 0
  ctx.magentoAttributeIdCache.set(attributeCode, attributeId)
  return { attributeId, optionMap }
}

/**
 * Resolves the Magento option_id for a `select`/`multiselect` attribute's option label.
 *
 * Magento stores `select` attribute values as an integer option id (backend_type
 * `int`), not the option label. `createAttribute` provisions options with the OM
 * option value as the Magento `label` (see `buildAttributeOptions`), so the
 * matching `option_id` can be looked up by label once the attribute exists.
 *
 * Results are cached per attribute code in `ctx.selectOptionCache` for the
 * duration of the run to avoid one GET per product per select attribute.
 */
export async function resolveAttributeOptionId(
  attributeCode: string,
  optionLabel: string,
  ctx: AdapterContext,
): Promise<string | null> {
  const { optionMap } = await fetchAndCacheAttribute(attributeCode, ctx)
  return optionMap.get(optionLabel) ?? null
}

/**
 * Returns the Magento integer `attribute_id` for a given attribute code.
 * Needed for `configurable_product_options` which reference the numeric id.
 */
export async function resolveAttributeId(attributeCode: string, ctx: AdapterContext): Promise<number> {
  const { attributeId } = await fetchAndCacheAttribute(attributeCode, ctx)
  return attributeId
}

/**
 * Resolves the Magento attribute_code for an OM option-schema dimension (e.g. "color",
 * "size"), provisioning a `select`/`global` attribute on first use.
 *
 * Configurable product dimensions must have `scope: 'global'` in Magento so they can
 * be assigned as configurable_product_options. This is different from custom-field
 * attributes, which use `frontend_input` derived from their OM field kind and do not
 * need a global scope declaration.
 *
 * Results are cached in-run via `ctx.configurableAttributeCache` (option code → attribute_code).
 */
export async function ensureConfigurableAttribute(optionDef: CatalogProductOptionDefinition, ctx: AdapterContext): Promise<string> {
  const cached = ctx.configurableAttributeCache.get(optionDef.code)
  if (cached) return cached

  const code = toMagentoAttributeCode(optionDef.code, ctx.settings.attributeSetPrefix)

  if (!(await attributeExists(ctx.client, code))) {
    const options = (optionDef.choices ?? []).map((choice) => ({
      label: choice.label ?? choice.code,
      value: '',
    }))
    try {
      await ctx.client.post('/products/attributes', {
        attribute: {
          attribute_code: code,
          frontend_input: 'select',
          scope: 'global',
          default_frontend_label: optionDef.label ?? optionDef.code,
          is_required: false,
          is_user_defined: true,
          options,
        },
      })
    } catch (error) {
      if (error instanceof MagentoApiError && (error.status === 409 || error.status === 400)) {
        // Concurrent run provisioned this attribute first; proceed.
      } else {
        throw error
      }
    }
    const attributeSetId = await ensureAttributeSet(ctx)
    await assignAttributeToSet(ctx.client, attributeSetId, code)
  }

  ctx.configurableAttributeCache.set(optionDef.code, code)
  return code
}

/**
 * Resolves the Magento attribute_code for an OM custom field, provisioning the
 * attribute (and assigning it to the tenant's attribute set) on first use.
 */
export async function ensureAttribute(fieldDef: CustomFieldDef, ctx: AdapterContext): Promise<string> {
  const override = ctx.settings.attributeCodeOverrides.find((entry) => entry.omFieldName === fieldDef.key)
  if (override) return override.magentoAttributeCode

  // `sync_external_id_mappings.internal_entity_id` is a uuid column, so the cache key
  // must be the custom field definition's own id rather than a composite "entityId:key" string.
  const cacheKey = fieldDef.id
  const cached = await ctx.idMapping.lookupExternalId(MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_ATTRIBUTE_ENTITY_TYPE, cacheKey, ctx.scope)
  if (cached) return cached

  const code = toMagentoAttributeCode(fieldDef.key, ctx.settings.attributeSetPrefix)

  if (!(await attributeExists(ctx.client, code))) {
    await createAttribute(ctx.client, code, fieldDef)
    const attributeSetId = await ensureAttributeSet(ctx)
    await assignAttributeToSet(ctx.client, attributeSetId, code)
  }

  await ctx.idMapping.storeExternalIdMapping(MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_ATTRIBUTE_ENTITY_TYPE, cacheKey, code, ctx.scope)
  return code
}
