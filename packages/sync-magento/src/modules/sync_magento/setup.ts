import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createCredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import { createIntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import { createIntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { applyMagentoEnvPreset } from './lib/preset'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['sync_magento.view', 'sync_magento.configure'],
    admin: ['sync_magento.view', 'sync_magento.configure'],
    employee: ['sync_magento.view'],
  },

  async onTenantCreated({ em, organizationId, tenantId }) {
    try {
      await applyMagentoEnvPreset({
        em,
        credentialsService: createCredentialsService(em),
        integrationStateService: createIntegrationStateService(em),
        integrationLogService: createIntegrationLogService(em),
        scope: { tenantId, organizationId },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Magento preset error'
      console.warn(`[sync_magento] Failed to apply env preset during tenant setup: ${message}`)
    }
  },
}

export default setup
