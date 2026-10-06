import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'detail:customers.person:tabs': [
    {
      widgetId: 'enrichment_treg.injection.enrichment-tab',
      kind: 'tab',
      groupLabel: 'enrichment_treg.tab.title',
      priority: 30,
    },
  ],
  'detail:customers.company:tabs': [
    {
      widgetId: 'enrichment_treg.injection.enrichment-tab',
      kind: 'tab',
      groupLabel: 'enrichment_treg.tab.title',
      priority: 30,
    },
  ],
}

export default injectionTable
