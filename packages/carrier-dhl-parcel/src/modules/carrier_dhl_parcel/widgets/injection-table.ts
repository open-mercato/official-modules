import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'
import { carrierDhlParcelDetailWidgetSpotId } from '../integration'

export const injectionTable: ModuleInjectionTable = {
  [carrierDhlParcelDetailWidgetSpotId]: [
    {
      widgetId: 'carrier_dhl_parcel.injection.config',
      kind: 'tab',
      groupLabel: 'carrier_dhl_parcel.tabs.settings',
      priority: 100,
    },
  ],
  'detail:sales.order:shipping': [
    {
      widgetId: 'carrier_dhl_parcel.injection.tracking',
      priority: 50,
    },
  ],
}

export default injectionTable
