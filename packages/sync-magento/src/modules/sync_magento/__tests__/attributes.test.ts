import Chance from 'chance'
import type { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import {
  toMagentoAttributeCode,
  ensureAttributeSet,
  ensureAttribute,
  resolveAttributeOptionId,
} from '../lib/adapters/attributes'
import { MagentoApiError } from '../lib/client'
import { emitSyncMagentoEvent } from '../events'
import {
  MAGENTO_ATTRIBUTE_ENTITY_TYPE,
  MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
  MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
  MAGENTO_DEFAULT_ATTRIBUTE_SET_ID,
  MAGENTO_PRODUCTS_INTEGRATION_ID,
  type AdapterContext,
} from '../lib/adapters/shared'

jest.mock('../events', () => ({ emitSyncMagentoEvent: jest.fn() }))

// Stub `./shared` so its real implementation (and the `../settings` ->
// `../data/entities` MikroORM decorator chain it pulls in) is never loaded.
jest.mock('../lib/adapters/shared', () => ({
  MAGENTO_PRODUCTS_INTEGRATION_ID: 'sync_magento_products',
  MAGENTO_ATTRIBUTE_ENTITY_TYPE: 'magento_products.attribute',
  MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE: 'magento_products.attribute_set',
  MAGENTO_ATTRIBUTE_SET_LOCAL_ID: '00000000-0000-0000-0000-000000000000',
  MAGENTO_DEFAULT_ATTRIBUTE_SET_ID: '4',
}))

const chance = new Chance()

function buildCtx(settingsOverrides: Record<string, unknown> = {}): AdapterContext {
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
      imageSyncEnabled: true,
      productExportConcurrency: 3,
      imageUploadConcurrency: 5,
      imageMaxDimension: 2000,
      msiModeDetected: null,
      ...settingsOverrides,
    } as AdapterContext['settings'],
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('toMagentoAttributeCode', () => {
  it('slugifies the key and prepends the configured prefix', () => {
    expect(toMagentoAttributeCode('Care Instructions', 'om')).toBe('om_care_instructions')
  })

  it('omits the prefix when empty', () => {
    expect(toMagentoAttributeCode('Care Instructions', '')).toBe('care_instructions')
  })

  it('prepends a_ when the result would not start with a letter', () => {
    expect(toMagentoAttributeCode('123field', '')).toBe('a_123field')
  })

  it('truncates to 60 characters and trims trailing underscores', () => {
    const result = toMagentoAttributeCode('a'.repeat(100), '')
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result.endsWith('_')).toBe(false)
  })
})

describe('ensureAttributeSet', () => {
  it('returns the default attribute set id when attributeSetPrefix is empty', async () => {
    const ctx = buildCtx({ attributeSetPrefix: '' })

    const result = await ensureAttributeSet(ctx)

    expect(result).toBe(MAGENTO_DEFAULT_ATTRIBUTE_SET_ID)
    expect(ctx.idMapping.lookupExternalId).not.toHaveBeenCalled()
    expect(ctx.client.get).not.toHaveBeenCalled()
  })

  it('returns the cached attribute set id without calling Magento', async () => {
    const ctx = buildCtx()
    const cachedId = chance.guid()
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue(cachedId)

    const result = await ensureAttributeSet(ctx)

    expect(result).toBe(cachedId)
    expect(ctx.idMapping.lookupExternalId).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID,
      MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
      MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
      ctx.scope,
    )
    expect(ctx.client.get).not.toHaveBeenCalled()
  })

  it('caches and returns an existing attribute set found by name', async () => {
    const ctx = buildCtx()
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue(null)
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [{ attribute_set_id: 42, attribute_set_name: 'om_default' }] })

    const result = await ensureAttributeSet(ctx)

    expect(result).toBe('42')
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID,
      MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
      MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
      '42',
      ctx.scope,
    )
    expect(emitSyncMagentoEvent).not.toHaveBeenCalled()
  })

  it('creates a new attribute set and emits a provisioning event when none exists', async () => {
    const ctx = buildCtx()
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue(null)
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ items: [] })
    ;(ctx.client.post as jest.Mock).mockResolvedValue({ attribute_set_id: 77, attribute_set_name: 'om_default' })

    const result = await ensureAttributeSet(ctx)

    expect(result).toBe('77')
    expect(ctx.client.post).toHaveBeenCalledWith('/products/attribute-sets', {
      attributeSet: { attribute_set_name: 'om_default' },
      skeletonId: Number(MAGENTO_DEFAULT_ATTRIBUTE_SET_ID),
    })
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID,
      MAGENTO_ATTRIBUTE_SET_ENTITY_TYPE,
      MAGENTO_ATTRIBUTE_SET_LOCAL_ID,
      '77',
      ctx.scope,
    )
    expect(emitSyncMagentoEvent).toHaveBeenCalledWith('sync_magento.attribute_set.provisioned', expect.objectContaining({
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      attributeSetId: '77',
      attributeSetName: 'om_default',
    }))
  })
})

function buildFieldDef(overrides: Partial<CustomFieldDef> = {}): CustomFieldDef {
  return {
    id: chance.guid(),
    entityId: 'catalog:catalog_product',
    key: 'care_instructions',
    kind: 'text',
    configJson: null,
    ...overrides,
  } as unknown as CustomFieldDef
}

describe('ensureAttribute', () => {
  it('returns an overridden attribute code without any lookups', async () => {
    const ctx = buildCtx({ attributeCodeOverrides: [{ omFieldName: 'care_instructions', magentoAttributeCode: 'care_instr' }] })
    const fieldDef = buildFieldDef()

    const result = await ensureAttribute(fieldDef, ctx)

    expect(result).toBe('care_instr')
    expect(ctx.idMapping.lookupExternalId).not.toHaveBeenCalled()
    expect(ctx.client.get).not.toHaveBeenCalled()
  })

  it('returns the cached attribute code without calling Magento', async () => {
    const ctx = buildCtx()
    const fieldDef = buildFieldDef()
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue('om_care_instructions')

    const result = await ensureAttribute(fieldDef, ctx)

    expect(result).toBe('om_care_instructions')
    expect(ctx.idMapping.lookupExternalId).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID,
      MAGENTO_ATTRIBUTE_ENTITY_TYPE,
      fieldDef.id,
      ctx.scope,
    )
    expect(ctx.client.get).not.toHaveBeenCalled()
  })

  it('caches the attribute code when the Magento attribute already exists', async () => {
    const ctx = buildCtx()
    const fieldDef = buildFieldDef()
    ;(ctx.idMapping.lookupExternalId as jest.Mock).mockResolvedValue(null)
    ;(ctx.client.get as jest.Mock).mockResolvedValue({ attribute_code: 'om_care_instructions' })

    const result = await ensureAttribute(fieldDef, ctx)

    expect(result).toBe('om_care_instructions')
    expect(ctx.client.get).toHaveBeenCalledWith('/products/attributes/om_care_instructions')
    expect(ctx.client.post).not.toHaveBeenCalled()
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID,
      MAGENTO_ATTRIBUTE_ENTITY_TYPE,
      fieldDef.id,
      'om_care_instructions',
      ctx.scope,
    )
  })

  it('creates and assigns a new attribute when it does not exist in Magento', async () => {
    const ctx = buildCtx()
    const fieldDef = buildFieldDef()
    ;(ctx.idMapping.lookupExternalId as jest.Mock)
      .mockResolvedValueOnce(null) // attribute cache lookup
      .mockResolvedValueOnce('10') // attribute set cache lookup (ensureAttributeSet)

    ;(ctx.client.get as jest.Mock).mockImplementation(async (path: string) => {
      if (path === '/products/attributes/om_care_instructions') {
        throw new MagentoApiError(404, 'Not found')
      }
      if (path.startsWith('/products/attribute-sets/')) {
        return [{ attribute_group_id: 7, attribute_group_name: 'General' }]
      }
      throw new Error(`Unexpected GET ${path}`)
    })
    ;(ctx.client.post as jest.Mock).mockResolvedValue(undefined)

    const result = await ensureAttribute(fieldDef, ctx)

    expect(result).toBe('om_care_instructions')
    expect(ctx.client.post).toHaveBeenCalledWith('/products/attributes', expect.objectContaining({
      attribute: expect.objectContaining({ attribute_code: 'om_care_instructions', frontend_input: 'text' }),
    }))
    expect(ctx.client.post).toHaveBeenCalledWith('/products/attribute-sets/10/attributes', {
      attributeSetId: 10,
      attributeGroupId: 7,
      attributeCode: 'om_care_instructions',
      sortOrder: 0,
    })
    expect(ctx.idMapping.storeExternalIdMapping).toHaveBeenCalledWith(
      MAGENTO_PRODUCTS_INTEGRATION_ID,
      MAGENTO_ATTRIBUTE_ENTITY_TYPE,
      fieldDef.id,
      'om_care_instructions',
      ctx.scope,
    )
  })
})

describe('resolveAttributeOptionId', () => {
  it('fetches attribute options and resolves the option_id by label', async () => {
    const ctx = buildCtx()
    ;(ctx.client.get as jest.Mock).mockResolvedValue({
      options: [
        { label: ' ', value: '' },
        { label: 'full_grain_leather', value: '142' },
        { label: 'recycled_mesh', value: '143' },
      ],
    })

    const result = await resolveAttributeOptionId('om_upper_material', 'full_grain_leather', ctx)

    expect(result).toBe('142')
    expect(ctx.client.get).toHaveBeenCalledWith('/products/attributes/om_upper_material')
  })

  it('returns null when no option matches the label', async () => {
    const ctx = buildCtx()
    ;(ctx.client.get as jest.Mock).mockResolvedValue({
      options: [{ label: 'recycled_mesh', value: '143' }],
    })

    const result = await resolveAttributeOptionId('om_upper_material', 'full_grain_leather', ctx)

    expect(result).toBeNull()
  })

  it('caches options per attribute code and only fetches once', async () => {
    const ctx = buildCtx()
    ;(ctx.client.get as jest.Mock).mockResolvedValue({
      options: [{ label: 'full_grain_leather', value: '142' }],
    })

    await resolveAttributeOptionId('om_upper_material', 'full_grain_leather', ctx)
    const result = await resolveAttributeOptionId('om_upper_material', 'full_grain_leather', ctx)

    expect(result).toBe('142')
    expect(ctx.client.get).toHaveBeenCalledTimes(1)
  })
})
