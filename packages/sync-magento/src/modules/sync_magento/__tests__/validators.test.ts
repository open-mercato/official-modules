import Chance from 'chance'
import {
  channelStockMappingSchema,
  channelStoreMappingSchema,
  attributeCodeOverrideSchema,
  syncSettingsSchema,
} from '../data/validators'

const chance = new Chance()

describe('channelStockMappingSchema', () => {
  it('accepts a valid mapping', () => {
    const input = { channelId: chance.guid(), stockSource: chance.word() }
    expect(channelStockMappingSchema.safeParse(input).success).toBe(true)
  })

  it('rejects a non-uuid channelId', () => {
    expect(channelStockMappingSchema.safeParse({ channelId: 'not-a-uuid', stockSource: 'default' }).success).toBe(false)
  })

  it('rejects an empty stockSource', () => {
    expect(channelStockMappingSchema.safeParse({ channelId: chance.guid(), stockSource: '' }).success).toBe(false)
  })
})

describe('channelStoreMappingSchema', () => {
  it('accepts a valid mapping', () => {
    const input = { channelId: chance.guid(), storeViewCode: chance.word(), currencyCode: 'EUR' }
    expect(channelStoreMappingSchema.safeParse(input).success).toBe(true)
  })

  it('rejects a currency code that is not exactly 3 characters', () => {
    const base = { channelId: chance.guid(), storeViewCode: 'default' }
    expect(channelStoreMappingSchema.safeParse({ ...base, currencyCode: 'EU' }).success).toBe(false)
    expect(channelStoreMappingSchema.safeParse({ ...base, currencyCode: 'EURO' }).success).toBe(false)
  })

  it('rejects an empty storeViewCode', () => {
    expect(channelStoreMappingSchema.safeParse({ channelId: chance.guid(), storeViewCode: '', currencyCode: 'EUR' }).success).toBe(false)
  })
})

describe('attributeCodeOverrideSchema', () => {
  it('accepts a valid override', () => {
    const input = { omFieldName: chance.word(), magentoAttributeCode: 'om_season' }
    expect(attributeCodeOverrideSchema.safeParse(input).success).toBe(true)
  })

  it('rejects an empty omFieldName', () => {
    expect(attributeCodeOverrideSchema.safeParse({ omFieldName: '', magentoAttributeCode: 'om_season' }).success).toBe(false)
  })

  it('rejects attribute codes that do not start with a lowercase letter', () => {
    expect(attributeCodeOverrideSchema.safeParse({ omFieldName: 'season', magentoAttributeCode: '1season' }).success).toBe(false)
    expect(attributeCodeOverrideSchema.safeParse({ omFieldName: 'season', magentoAttributeCode: '_season' }).success).toBe(false)
  })

  it('rejects attribute codes containing uppercase letters or invalid characters', () => {
    expect(attributeCodeOverrideSchema.safeParse({ omFieldName: 'season', magentoAttributeCode: 'OmSeason' }).success).toBe(false)
    expect(attributeCodeOverrideSchema.safeParse({ omFieldName: 'season', magentoAttributeCode: 'om-season' }).success).toBe(false)
  })

  it('rejects attribute codes longer than 60 characters', () => {
    const tooLong = `om_${'a'.repeat(58)}`
    expect(tooLong.length).toBeGreaterThan(60)
    expect(attributeCodeOverrideSchema.safeParse({ omFieldName: 'season', magentoAttributeCode: tooLong }).success).toBe(false)
  })

  it('accepts lowercase letters, digits, and underscores starting with a letter', () => {
    expect(attributeCodeOverrideSchema.safeParse({ omFieldName: 'season', magentoAttributeCode: 'om_season_2' }).success).toBe(true)
  })
})

describe('syncSettingsSchema', () => {
  it('accepts an empty payload (every field optional)', () => {
    expect(syncSettingsSchema.safeParse({}).success).toBe(true)
  })

  it('accepts null for nullable array/relation fields', () => {
    const result = syncSettingsSchema.safeParse({
      channelStockMappings: null,
      channelStoreMappings: null,
      orderImportStatuses: null,
      defaultOrderChannelId: null,
      attributeCodeOverrides: null,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a fully populated valid payload', () => {
    const payload = {
      channelStockMappings: [{ channelId: chance.guid(), stockSource: 'default' }],
      channelStoreMappings: [{ channelId: chance.guid(), storeViewCode: 'default', currencyCode: 'EUR' }],
      orderImportStatuses: ['processing', 'complete'],
      defaultOrderChannelId: chance.guid(),
      customerStrategy: 'create_or_link' as const,
      attributeSetPrefix: 'om',
      attributeCodeOverrides: [{ omFieldName: 'season', magentoAttributeCode: 'om_season' }],
      imageSyncEnabled: true,
      productExportConcurrency: 3,
      imageUploadConcurrency: 5,
      imageMaxDimension: 2000,
    }
    expect(syncSettingsSchema.safeParse(payload).success).toBe(true)
  })

  it('rejects an unknown customerStrategy value', () => {
    expect(syncSettingsSchema.safeParse({ customerStrategy: 'auto_merge' }).success).toBe(false)
  })

  it('rejects an attributeSetPrefix longer than 32 characters', () => {
    expect(syncSettingsSchema.safeParse({ attributeSetPrefix: 'a'.repeat(33) }).success).toBe(false)
  })

  it('allows an empty attributeSetPrefix (documented opt-out of the prefix)', () => {
    expect(syncSettingsSchema.safeParse({ attributeSetPrefix: '' }).success).toBe(true)
  })

  it('rejects concurrency and dimension values outside their bounds', () => {
    expect(syncSettingsSchema.safeParse({ productExportConcurrency: 0 }).success).toBe(false)
    expect(syncSettingsSchema.safeParse({ productExportConcurrency: 11 }).success).toBe(false)
    expect(syncSettingsSchema.safeParse({ imageUploadConcurrency: 0 }).success).toBe(false)
    expect(syncSettingsSchema.safeParse({ imageUploadConcurrency: 11 }).success).toBe(false)
    expect(syncSettingsSchema.safeParse({ imageMaxDimension: -1 }).success).toBe(false)
    expect(syncSettingsSchema.safeParse({ imageMaxDimension: 10001 }).success).toBe(false)
  })

  it('rejects non-integer concurrency values', () => {
    expect(syncSettingsSchema.safeParse({ productExportConcurrency: 1.5 }).success).toBe(false)
  })

  it('rejects a non-uuid defaultOrderChannelId', () => {
    expect(syncSettingsSchema.safeParse({ defaultOrderChannelId: 'not-a-uuid' }).success).toBe(false)
  })
})
