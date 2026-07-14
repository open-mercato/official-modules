import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'
import { syncMagentoDetailWidgetSpotId } from '../integration'

export const injectionTable: ModuleInjectionTable = {
  [syncMagentoDetailWidgetSpotId]: [
    {
      widgetId: 'sync_magento.injection.settings',
      kind: 'tab',
      groupLabel: 'sync_magento.tabs.settings',
      priority: 10,
    },
  ],
}

export default injectionTable
