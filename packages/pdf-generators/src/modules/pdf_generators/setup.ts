import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['pdf_generators.view', 'pdf_generators.generate'],
    admin: ['pdf_generators.view', 'pdf_generators.generate'],
  },
}

export default setup
