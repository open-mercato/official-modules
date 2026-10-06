import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { createCredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import { createIntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { applyTregEnvPreset } from './lib/preset'

const logger = createLogger('enrichment_treg').child({ component: 'setup' })

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['enrichment_treg.view', 'enrichment_treg.run', 'enrichment_treg.configure'],
    admin: ['enrichment_treg.view', 'enrichment_treg.run', 'enrichment_treg.configure'],
    employee: ['enrichment_treg.view', 'enrichment_treg.run'],
  },

  async onTenantCreated({ em, organizationId, tenantId }) {
    try {
      await applyTregEnvPreset({
        credentialsService: createCredentialsService(em),
        integrationStateService: createIntegrationStateService(em),
        scope: { tenantId, organizationId },
      })
    } catch (err) {
      logger.warn('Failed to apply treg env preset during tenant setup', { err })
    }
  },
}

export default setup
