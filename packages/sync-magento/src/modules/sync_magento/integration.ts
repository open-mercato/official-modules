import { buildIntegrationDetailWidgetSpotId, type IntegrationBundle, type IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'

export const syncMagentoDetailWidgetSpotId = buildIntegrationDetailWidgetSpotId('sync_magento')

export const bundle: IntegrationBundle = {
  id: 'sync_magento',
  title: 'Magento 2.4',
  description: 'Sync products, inventory, and orders with Magento 2.4',
  package: '@open-mercato/sync-magento',
  version: '1.0.0',
  author: 'Open Mercato Team',
  credentials: {
    fields: [
      { key: 'baseUrl', label: 'Magento Store URL', type: 'url', required: true },
      {
        key: 'accessToken',
        label: 'Integration Access Token',
        type: 'secret',
        required: true,
        helpText: 'Generate a permanent Integration Access Token in Magento Admin -> System -> Integrations -> Add Integration. Set resource access to "All" or specific resources, then save and activate to copy the token.',
      },
    ],
  },
  healthCheck: { service: 'magentoHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [
  {
    id: 'sync_magento_products',
    title: 'Magento Products',
    category: 'data_sync',
    hub: 'data_sync',
    providerKey: 'magento_products',
    bundleId: 'sync_magento',
    description: 'Export products, images, categories, and attributes to Magento',
    detailPage: { widgetSpotId: syncMagentoDetailWidgetSpotId },
  },
  {
    id: 'sync_magento_prices',
    title: 'Magento Prices',
    category: 'data_sync',
    hub: 'data_sync',
    providerKey: 'magento_prices',
    bundleId: 'sync_magento',
    description: 'Bulk push base prices and special prices to Magento (fast path, independent of product sync)',
    detailPage: { widgetSpotId: syncMagentoDetailWidgetSpotId },
  },
  {
    id: 'sync_magento_inventory',
    title: 'Magento Inventory',
    category: 'data_sync',
    hub: 'data_sync',
    providerKey: 'magento_inventory',
    bundleId: 'sync_magento',
    description: 'Push stock levels per OM channel to Magento stock sources',
    detailPage: { widgetSpotId: syncMagentoDetailWidgetSpotId },
  },
  {
    id: 'sync_magento_orders',
    title: 'Magento Orders',
    category: 'data_sync',
    hub: 'data_sync',
    providerKey: 'magento_orders',
    bundleId: 'sync_magento',
    description: 'Import Magento orders with customer data and addresses',
    detailPage: { widgetSpotId: syncMagentoDetailWidgetSpotId },
  },
]
