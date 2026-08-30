import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { ksefHealthCheck } from './lib/health-check'

export function register(container: AppContainer) {
  container.register({
    ksefHealthCheck: asValue(ksefHealthCheck),
  })
}
