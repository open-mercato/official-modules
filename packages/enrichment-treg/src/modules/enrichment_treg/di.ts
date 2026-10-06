import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { tregHealthCheck } from './lib/health'

export function register(container: AppContainer) {
  container.register({
    tregHealthCheck: asValue(tregHealthCheck),
  })
}
