import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CatalogProductCategory } from '@open-mercato/core/modules/catalog/data/entities'
import { MagentoApiError } from '../client'
import type { MagentoClient } from '../client'
import {
  type AdapterContext,
  MAGENTO_CATEGORY_ENTITY_TYPE,
  MAGENTO_PRODUCTS_INTEGRATION_ID,
  MAGENTO_ROOT_CATEGORY_ID,
} from './shared'

type MagentoCategory = {
  id: number
  name: string
  children_data?: MagentoCategory[]
}

async function findChildCategoryIdByName(client: MagentoClient, parentId: string, name: string): Promise<string | null> {
  const parent = await client.get<MagentoCategory>(`/categories/${encodeURIComponent(parentId)}`)
  const match = parent.children_data?.find((child) => child.name === name)
  return match ? String(match.id) : null
}

function toCategoryUrlKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'category'
}

function isCategoryUrlKeyConflict(error: MagentoApiError): boolean {
  const lower = error.body.toLowerCase()
  return lower.includes('url key') || lower.includes('url_key')
}

async function createCategory(client: MagentoClient, parentId: string, category: CatalogProductCategory): Promise<string> {
  const baseUrlKey = toCategoryUrlKey(category.name)
  for (let i = 0; i <= 5; i++) {
    const urlKey = i === 0 ? baseUrlKey : `${baseUrlKey}-${i}`
    try {
      const created = await client.post<MagentoCategory>('/categories', {
        category: {
          parent_id: Number(parentId),
          name: category.name,
          is_active: category.isActive,
          include_in_menu: true,
          custom_attributes: [{ attribute_code: 'url_key', value: urlKey }],
        },
      })
      return String(created.id)
    } catch (error) {
      if (error instanceof MagentoApiError && isCategoryUrlKeyConflict(error) && i < 5) continue
      throw error
    }
  }
  throw new Error('unreachable')
}

async function findCategoryById(
  ctx: AdapterContext,
  categoryId: string,
): Promise<CatalogProductCategory | null> {
  return findOneWithDecryption(
    ctx.em,
    CatalogProductCategory,
    { id: categoryId, organizationId: ctx.scope.organizationId, tenantId: ctx.scope.tenantId, deletedAt: null },
    undefined,
    ctx.scope,
  )
}

/**
 * Resolves the Magento category_id for an OM CatalogProductCategory, recursively
 * provisioning ancestor categories under Magento's root category as needed.
 */
export async function ensureCategory(category: CatalogProductCategory, ctx: AdapterContext): Promise<string> {
  const cached = await ctx.idMapping.lookupExternalId(MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_CATEGORY_ENTITY_TYPE, category.id, ctx.scope)
  if (cached) return cached

  let parentMagentoId: string = MAGENTO_ROOT_CATEGORY_ID
  if (category.parentId) {
    const parent = await findCategoryById(ctx, category.parentId)
    if (parent) parentMagentoId = await ensureCategory(parent, ctx)
  }

  let categoryId = await findChildCategoryIdByName(ctx.client, parentMagentoId, category.name)
  if (!categoryId) {
    categoryId = await createCategory(ctx.client, parentMagentoId, category)
  }

  await ctx.idMapping.storeExternalIdMapping(MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_CATEGORY_ENTITY_TYPE, category.id, categoryId, ctx.scope)
  return categoryId
}
