import { OptionalProps } from '@mikro-orm/core'
import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

export type ChannelStockMapping = {
  channelId: string
  stockSource: string
}

export type ChannelStoreMapping = {
  channelId: string
  storeViewCode: string
  currencyCode: string
}

export type AttributeCodeOverride = {
  omFieldName: string
  magentoAttributeCode: string
}

export type MagentoCustomerStrategy = 'create_or_link' | 'create_only' | 'skip'

@Entity({ tableName: 'sync_magento_settings' })
@Unique({ name: 'sync_magento_settings_scope_unique', properties: ['tenantId', 'organizationId'] })
export class MagentoSyncSettings {
  [OptionalProps]?: 'customerStrategy' | 'attributeSetPrefix' | 'imageSyncEnabled'
    | 'productExportConcurrency' | 'imageUploadConcurrency' | 'imageMaxDimension'
    | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  // [{channelId: string, stockSource: string}]
  @Property({ name: 'channel_stock_mappings', type: 'json', nullable: true })
  channelStockMappings?: ChannelStockMapping[] | null

  // [{channelId: string, storeViewCode: string, currencyCode: string}]
  @Property({ name: 'channel_store_mappings', type: 'json', nullable: true })
  channelStoreMappings?: ChannelStoreMapping[] | null

  // Magento order statuses to import; null = all
  @Property({ name: 'order_import_statuses', type: 'json', nullable: true })
  orderImportStatuses?: string[] | null

  @Property({ name: 'default_order_channel_id', type: 'uuid', nullable: true })
  defaultOrderChannelId?: string | null

  @Property({ name: 'customer_strategy', type: 'text', default: 'create_or_link' })
  customerStrategy: MagentoCustomerStrategy = 'create_or_link'

  // Prefix for auto-created Magento attributes. Default: 'om'. Set to '' to disable prefix.
  // WARNING: empty prefix risks collision with native Magento attributes (color, size, weight, etc.)
  @Property({ name: 'attribute_set_prefix', type: 'text', default: 'om' })
  attributeSetPrefix: string = 'om'

  // Optional per-field attribute code override; bypasses auto-provisioning when set
  @Property({ name: 'attribute_code_overrides', type: 'json', nullable: true })
  attributeCodeOverrides?: AttributeCodeOverride[] | null

  // When false: images are skipped in product sync entirely
  @Property({ name: 'image_sync_enabled', type: 'boolean', default: true })
  imageSyncEnabled: boolean = true

  // Max concurrent product batches for async bulk product export (1-10, default 3)
  @Property({ name: 'product_export_concurrency', type: 'int', default: 3 })
  productExportConcurrency: number = 3

  // Max image upload concurrency across products (1-10, default 5)
  @Property({ name: 'image_upload_concurrency', type: 'int', default: 5 })
  imageUploadConcurrency: number = 5

  // Max image dimension (px) before resize; 0 = no resize. Default: 2000
  @Property({ name: 'image_max_dimension', type: 'int', default: 2000 })
  imageMaxDimension: number = 2000

  // Cache result of MSI probe across processes (null = not yet probed)
  @Property({ name: 'msi_mode_detected', type: 'boolean', nullable: true })
  msiModeDetected?: boolean | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
