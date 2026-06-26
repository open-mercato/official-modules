import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import {
  MagentoSyncSettings,
  type AttributeCodeOverride,
  type ChannelStockMapping,
  type ChannelStoreMapping,
  type MagentoCustomerStrategy,
} from '../data/entities'

export type MagentoSettings = {
  channelStockMappings: ChannelStockMapping[]
  channelStoreMappings: ChannelStoreMapping[]
  orderImportStatuses: string[] | null
  defaultOrderChannelId: string | null
  customerStrategy: MagentoCustomerStrategy
  attributeSetPrefix: string
  attributeCodeOverrides: AttributeCodeOverride[]
  imageSyncEnabled: boolean
  productExportConcurrency: number
  imageUploadConcurrency: number
  imageMaxDimension: number
  msiModeDetected: boolean | null
}

export async function loadMagentoSettings(em: EntityManager, scope: TenantScope): Promise<MagentoSettings> {
  const record = await findOneWithDecryption(
    em,
    MagentoSyncSettings,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )

  return {
    channelStockMappings: record?.channelStockMappings ?? [],
    channelStoreMappings: record?.channelStoreMappings ?? [],
    orderImportStatuses: record?.orderImportStatuses ?? null,
    defaultOrderChannelId: record?.defaultOrderChannelId ?? null,
    customerStrategy: record?.customerStrategy ?? 'create_or_link',
    attributeSetPrefix: record?.attributeSetPrefix ?? 'om',
    attributeCodeOverrides: record?.attributeCodeOverrides ?? [],
    imageSyncEnabled: record?.imageSyncEnabled ?? true,
    productExportConcurrency: record?.productExportConcurrency ?? 3,
    imageUploadConcurrency: record?.imageUploadConcurrency ?? 5,
    imageMaxDimension: record?.imageMaxDimension ?? 2000,
    msiModeDetected: record?.msiModeDetected ?? null,
  }
}
