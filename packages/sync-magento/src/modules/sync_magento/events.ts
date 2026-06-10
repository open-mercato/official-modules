import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'sync_magento.product.exported', label: 'Magento Product Exported', entity: 'product', category: 'crud' as const, clientBroadcast: true },
  { id: 'sync_magento.order.imported', label: 'Magento Order Imported', entity: 'order', category: 'crud' as const, clientBroadcast: true },
  { id: 'sync_magento.inventory.pushed', label: 'Magento Inventory Pushed', entity: 'inventory', category: 'lifecycle' as const, clientBroadcast: true },
  { id: 'sync_magento.attribute_set.provisioned', label: 'Magento Attribute Set Provisioned', entity: 'attribute_set', category: 'lifecycle' as const },
  { id: 'sync_magento.sync.started', label: 'Magento Sync Started', entity: 'sync', category: 'lifecycle' as const, clientBroadcast: true },
  { id: 'sync_magento.sync.completed', label: 'Magento Sync Completed', entity: 'sync', category: 'lifecycle' as const, clientBroadcast: true },
  { id: 'sync_magento.sync.failed', label: 'Magento Sync Failed', entity: 'sync', category: 'lifecycle' as const, clientBroadcast: true },
  { id: 'sync_magento.product.deleted', label: 'Magento Product Deleted', entity: 'product', category: 'lifecycle' as const, clientBroadcast: true },
  { id: 'sync_magento.product.deleted_externally', label: 'Magento Product Deleted Externally', entity: 'product', category: 'lifecycle' as const, clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'sync_magento', events })
export const emitSyncMagentoEvent = eventsConfig.emit
export type SyncMagentoEventId = typeof events[number]['id']
export default eventsConfig
