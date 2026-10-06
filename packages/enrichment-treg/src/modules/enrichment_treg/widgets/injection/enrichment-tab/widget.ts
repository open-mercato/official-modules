import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import EnrichmentTabWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, unknown> = {
  metadata: {
    id: 'enrichment_treg.injection.enrichment-tab',
    title: 'Enrichment',
    description: 'treg.to enrichment results and proposed field updates for the current person or company',
    features: ['enrichment_treg.view'],
    priority: 30,
    enabled: true,
  },
  Widget: EnrichmentTabWidget as InjectionWidgetModule<Record<string, unknown>, unknown>['Widget'],
}

export default widget
