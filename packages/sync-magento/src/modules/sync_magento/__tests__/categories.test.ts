import Chance from 'chance'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { CatalogProductCategory } from '@open-mercato/core/modules/catalog/data/entities'
import { ensureCategory } from '../lib/adapters/categories'
import {
  MAGENTO_CATEGORY_ENTITY_TYPE,
  MAGENTO_PRODUCTS_INTEGRATION_ID,
  MAGENTO_ROOT_CATEGORY_ID,
  type AdapterContext,
} from '../lib/adapters/shared'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/catalog/data/entities', () => ({
  CatalogProductCategory: class CatalogProductCategory {},
}))

// Stub `./shared` so its real implementation (and the `../settings` ->
// `../data/entities` MikroORM decorator chain it pulls in) is never loaded.
jest.mock('../lib/adapters/shared', () => ({
  MAGENTO_PRODUCTS_INTEGRATION_ID: 'sync_magento_products',
  MAGENTO_CATEGORY_ENTITY_TYPE: 'magento_products.category',
  MAGENTO_ROOT_CATEGORY_ID: '2',
}))

const chance = new Chance()

function buildCtx(): AdapterContext {
  return {
    em: {} as AdapterContext['em'],
    client: {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    } as unknown as AdapterContext['client'],
    idMapping: {
      lookupLocalId: jest.fn(),
      lookupExternalId: jest.fn(),
      storeExternalIdMapping: jest.fn(),
    } as unknown as AdapterContext['idMapping'],
    scope: { organizationId: chance.guid(), tenantId: chance.guid() },
    settings: {} as AdapterContext['settings'],
  }
}

function buildCategory(overrides: Partial<CatalogProductCategory> = {}): CatalogProductCategory {
  return {
    id: chance.guid(),
    name: chance.word(),
    parentId: null,
    isActive: true,
    ...overrides,
  } as unknown as CatalogProductCategory
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('ensureCategory', () => {
  it('returns the cached Magento category id without calling Magento', async () => {
    const ctx = buildCtx()
    const category = buildCategory()
    const cachedId = chance.guid()
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue(cachedId)

    const result = await ensureCategory(category, ctx)

    expect(result).toBe(cachedId)
    expect(ctx.client.get).not.toHaveBeenCalled()
    expect(ctx.idMapping.lookupExternalId).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_CATEGORY_ENTITY_TYPE, category.id, ctx.scope,
    )
  })

  it('finds an existing child category under the root category by name', async () => {
    const ctx = buildCtx()
    const category = buildCategory({ name: 'Accessories', parentId: null })
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue(null)
    ;(ctx.client.get as jest.Mock).mockResolvedValue({
      id: Number(MAGENTO_ROOT_CATEGORY_ID),
      name: 'Default Category',
      children_data: [{ id: 15, name: 'Accessories' }],
    })

    const result = await ensureCategory(category, ctx)

    expect(result).toBe('15')
    expect(ctx.client.get).toHaveBeenCalledWith(`/categories/${MAGENTO_ROOT_CATEGORY_ID}`)
    expect(ctx.client.post).not.toHaveBeenCalled()
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_CATEGORY_ENTITY_TYPE, category.id, '15', ctx.scope,
    )
  })

  it('creates a new category under the root category when no matching child exists', async () => {
    const ctx = buildCtx()
    const category = buildCategory({ name: 'New Category', parentId: null })
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue(null)
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ id: Number(MAGENTO_ROOT_CATEGORY_ID), name: 'Default Category', children_data: [] })
    ;(ctx.client.post as jest.Mock).mockResolvedValue({ id: 99, name: 'New Category' })

    const result = await ensureCategory(category, ctx)

    expect(result).toBe('99')
    expect(ctx.client.post).toHaveBeenCalledWith('/categories', {
      category: {
        parent_id: Number(MAGENTO_ROOT_CATEGORY_ID),
        name: 'New Category',
        is_active: true,
        include_in_menu: true,
        custom_attributes: [{ attribute_code: 'url_key', value: 'new-category' }],
      },
    })
  })

  it('recursively provisions ancestor categories before the requested category', async () => {
    const ctx = buildCtx()
    const parent = buildCategory({ name: 'Parent', parentId: null })
    const child = buildCategory({ name: 'Child', parentId: parent.id })

    ;(ctx.idMapping.lookupExternalId as jest.Mock)
      .mockResolvedValueOnce(null) // child cache lookup
      .mockResolvedValueOnce(null) // parent cache lookup

    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(parent)

    ;(ctx.client.get as jest.Mock).mockImplementation(async (path: string) => {
      if (path === `/categories/${MAGENTO_ROOT_CATEGORY_ID}`) {
        return { id: Number(MAGENTO_ROOT_CATEGORY_ID), name: 'Default Category', children_data: [] }
      }
      if (path === '/categories/55') {
        return { id: 55, name: 'Parent', children_data: [] }
      }
      throw new Error(`Unexpected GET ${path}`)
    })
    ;(ctx.client.post as jest.Mock)
      .mockResolvedValueOnce({ id: 55, name: 'Parent' })
      .mockResolvedValueOnce({ id: 56, name: 'Child' })

    const result = await ensureCategory(child, ctx)

    expect(result).toBe('56')
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_CATEGORY_ENTITY_TYPE, parent.id, '55', ctx.scope,
    )
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID, MAGENTO_CATEGORY_ENTITY_TYPE, child.id, '56', ctx.scope,
    )
  })
})
