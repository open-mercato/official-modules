import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createExternalIdMappingService, type ExternalIdMappingService } from '@open-mercato/core/modules/data_sync/lib/id-mapping'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { createMagentoClient, type MagentoClient } from '../client'
import { loadMagentoSettings, type MagentoSettings } from '../settings'

// Integration id used to scope ExternalIdMappingService lookups for the products adapter.
export const MAGENTO_PRODUCTS_INTEGRATION_ID = 'sync_magento_products'

// entityType conventions, per SPEC-005 Data Models table.
export const CATALOG_PRODUCT_ENTITY_TYPE = 'catalog.product'
export const MAGENTO_ATTRIBUTE_ENTITY_TYPE = 'magento_products.attribute'
export const MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE = 'magento_products.attribute_set'
export const MAGENTO_CATEGORY_ENTITY_TYPE = 'magento_products.category'

// Single row used for the per-tenant attribute set cache (one set per tenant for MVP).
// `sync_external_id_mappings.internal_entity_id` is a uuid column, so this placeholder
// must be a valid UUID even though the cached row isn't tied to a specific OM entity;
// uniqueness comes from (entityType, organizationId, tenantId).
export const MAGENTO_ATTRIBUTE_SET_LOCAL_ID = '00000000-0000-0000-0000-000000000000'

// Magento's built-in "Default Category" id, used as the root for category provisioning.
export const MAGENTO_ROOT_CATEGORY_ID = '2'

// Magento's built-in "Default" attribute set id, used as a fallback/skeleton.
export const MAGENTO_DEFAULT_ATTRIBUTE_SET_ID = '4'

export type AdapterContext = {
  em: EntityManager
  client: MagentoClient
  idMapping: ExternalIdMappingService
  scope: TenantScope
  settings: MagentoSettings
  // Per-run cache of Magento `select` attribute options (attribute_code -> option label -> option_id),
  // since `select`/`multiselect` attributes store an integer option id, not the option label.
  selectOptionCache: Map<string, Map<string, string>>
  // Per-run cache of option-schema-derived configurable attribute codes (option code -> Magento attribute_code).
  configurableAttributeCache: Map<string, string>
  // Per-run cache of Magento attribute_id integers by attribute_code, used when building
  // configurable_product_options (which require the numeric id, not the code string).
  magentoAttributeIdCache: Map<string, number>
}

export async function createAdapterContext(input: {
  credentials: Record<string, unknown>
  scope: TenantScope
}): Promise<AdapterContext> {
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const settings = await loadMagentoSettings(em, input.scope)
  return {
    em,
    client: createMagentoClient(input.credentials),
    idMapping: createExternalIdMappingService(em),
    scope: input.scope,
    settings,
    selectOptionCache: new Map(),
    configurableAttributeCache: new Map(),
    magentoAttributeIdCache: new Map(),
  }
}

export type ProductExportCursor = {
  updatedAt: string
  id: string
}

export function encodeProductCursor(cursor: ProductExportCursor): string {
  return JSON.stringify(cursor)
}

export function decodeProductCursor(cursor: string | undefined | null): ProductExportCursor | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(cursor) as Partial<ProductExportCursor>
    if (typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string') {
      return { updatedAt: parsed.updatedAt, id: parsed.id }
    }
    return null
  } catch {
    return null
  }
}
