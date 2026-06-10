import { z } from 'zod'

export const channelStockMappingSchema = z.object({
  channelId: z.string().uuid(),
  stockSource: z.string().min(1).max(255),
})

export const channelStoreMappingSchema = z.object({
  channelId: z.string().uuid(),
  storeViewCode: z.string().min(1).max(255),
  currencyCode: z.string().length(3),
})

export const attributeCodeOverrideSchema = z.object({
  omFieldName: z.string().min(1),
  magentoAttributeCode: z.string().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/),
})

export const syncSettingsSchema = z.object({
  channelStockMappings: z.array(channelStockMappingSchema).nullable().optional(),
  channelStoreMappings: z.array(channelStoreMappingSchema).nullable().optional(),
  orderImportStatuses: z.array(z.string()).nullable().optional(),
  defaultOrderChannelId: z.string().uuid().nullable().optional(),
  customerStrategy: z.enum(['create_or_link', 'create_only', 'skip']).optional(),
  // Empty string allowed = no prefix (risk of native attribute collision, documented in UI)
  attributeSetPrefix: z.string().max(32).optional(),
  attributeCodeOverrides: z.array(attributeCodeOverrideSchema).nullable().optional(),
  imageSyncEnabled: z.boolean().optional(),
  productExportConcurrency: z.number().int().min(1).max(10).optional(),
  imageUploadConcurrency: z.number().int().min(1).max(10).optional(),
  imageMaxDimension: z.number().int().min(0).max(10000).optional(),
})

export type SyncSettingsInput = z.infer<typeof syncSettingsSchema>
