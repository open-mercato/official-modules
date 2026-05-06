import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { registerShippingAdapter } from '@open-mercato/core/modules/shipping_carriers/lib/adapter-registry'
import { dhlParcelHealthCheck } from './lib/health'
import { dhlParcelAdapterV1 } from './lib/adapters/v1'

export function register(container: AppContainer) {
  registerShippingAdapter(dhlParcelAdapterV1)

  container.register({
    dhlParcelHealthCheck: asValue(dhlParcelHealthCheck),
  })
}
