import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['pdf_generators.view'],
    admin: ['pdf_generators.view'],
  },
}

export default setup
