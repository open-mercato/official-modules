import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createCredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import { createIntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import { createIntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { applyDhlParcelEnvPreset } from './lib/preset'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['carrier_dhl_parcel.view', 'carrier_dhl_parcel.configure'],
    admin: ['carrier_dhl_parcel.view', 'carrier_dhl_parcel.configure'],
  },

  async onTenantCreated({ em, organizationId, tenantId }) {
    try {
      await applyDhlParcelEnvPreset({
        credentialsService: createCredentialsService(em),
        integrationStateService: createIntegrationStateService(em),
        integrationLogService: createIntegrationLogService(em),
        scope: { tenantId, organizationId },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown DHL Parcel preset error'
      console.warn(`[carrier_dhl_parcel] Failed to apply env preset during tenant setup: ${message}`)
    }
  },
}

export default setup
