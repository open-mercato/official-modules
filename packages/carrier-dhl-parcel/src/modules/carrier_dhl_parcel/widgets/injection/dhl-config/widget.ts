import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DhlConfigWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'carrier_dhl_parcel.injection.config',
    title: 'DHL Parcel Settings',
    features: ['carrier_dhl_parcel.configure'],
    priority: 100,
  },
  Widget: DhlConfigWidget,
}

export default widget
