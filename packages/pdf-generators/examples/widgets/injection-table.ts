import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

// Declares which injection slots receive this module's widgets.
// The key is the slot ID defined by the host module.
// Common slot IDs for PDF tabs:
//   'sales.document.detail.order:tabs'    — order detail page
//   'sales.document.detail.quote:tabs'    — quote detail page
//   'sales.document.detail.shipment:tabs' — shipment detail page
export const injectionTable: ModuleInjectionTable = {
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'example.injection.order_pdf_tab',
      kind: 'tab',
      priority: 10,
    },
  ],
}

export default injectionTable
