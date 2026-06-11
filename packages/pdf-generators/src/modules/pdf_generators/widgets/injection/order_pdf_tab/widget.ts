import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import OrderPdfTabWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'pdf_generators.injection.order_pdf_tab',
    title: 'PDF',
    features: ['pdf_generators.view'],
    priority: 10,
  },
  Widget: OrderPdfTabWidget,
}

export default widget
