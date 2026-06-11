import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'sales.document.detail.quote:tabs': [
    {
      widgetId: 'pdf_generators.injection.quote_pdf_tab',
      priority: 10,
      kind: 'tab',
    },
  ],
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'pdf_generators.injection.order_pdf_tab',
      priority: 10,
      kind: 'tab',
    },
  ],
}

export default injectionTable
