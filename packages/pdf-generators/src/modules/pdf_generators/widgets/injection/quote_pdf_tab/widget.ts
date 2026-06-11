import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import QuoteGeneratePdfWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'pdf_generators.injection.quote_pdf_tab',
    title: 'PDF',
    features: ['pdf_generators.view'],
    priority: 10,
  },
  Widget: QuoteGeneratePdfWidget,
}

export default widget
