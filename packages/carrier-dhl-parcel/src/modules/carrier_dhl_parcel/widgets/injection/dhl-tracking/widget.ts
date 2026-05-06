import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DhlTrackingWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'carrier_dhl_parcel.injection.tracking',
    title: 'DHL Parcel Tracking',
    features: ['carrier_dhl_parcel.view'],
    priority: 50,
  },
  Widget: DhlTrackingWidget,
}

export default widget
