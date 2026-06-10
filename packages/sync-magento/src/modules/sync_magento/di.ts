import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { magentoHealthCheck } from './lib/health'

export function register(container: AppContainer) {
  container.register({
    magentoHealthCheck: asValue(magentoHealthCheck),
  })
}
