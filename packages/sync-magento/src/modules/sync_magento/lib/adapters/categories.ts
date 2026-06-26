import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CatalogProductCategory } from '@open-mercato/core/modules/catalog/data/entities'
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

async function createCategory(client: MagentoClient, parentId: string, category: CatalogProductCategory): Promise<string> {
  const created = await client.post<MagentoCategory>('/categories', {
    category: {
      parent_id: Number(parentId),
      name: category.name,
      is_active: category.isActive,
      include_in_menu: true,
    },
  })
  return String(created.id)
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
