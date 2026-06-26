import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { registerDataSyncAdapter } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'
import { magentoHealthCheck } from './lib/health'
import { magentoProductsAdapter } from './lib/adapters/products'
import { magentoPricesAdapter } from './lib/adapters/prices'
import { magentoInventoryAdapter } from './lib/adapters/inventory'
import { magentoOrdersAdapter } from './lib/adapters/orders'

export function register(container: AppContainer) {
  container.register({
    magentoHealthCheck: asValue(magentoHealthCheck),
  })

  registerDataSyncAdapter(magentoProductsAdapter)
  registerDataSyncAdapter(magentoPricesAdapter)
  registerDataSyncAdapter(magentoInventoryAdapter)
  registerDataSyncAdapter(magentoOrdersAdapter)
}
