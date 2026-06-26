import * as React from 'react'
import type { InjectionFieldWidget } from '@open-mercato/shared/modules/widgets/injection'

const PlVatMetaPanel = React.lazy(() => import('./widget.client'))

/**
 * Polish VAT metadata fields — injects a self-contained panel (context NIP, MPP
 * required, VAT exemption basis) into the sales-invoice CrudForm
 * (`crud-form:sales.sales_invoice:fields`).
 *
 * The panel is a single `custom` field that loads and persists the
 * `SalesInvoicePlMeta` row directly against the financial_pl invoice-meta API
 * keyed by the invoice id (`context.record.id`). Persisting through its own API
 * keeps the field decoupled from the host form's submit cycle and avoids relying
 * on enriched values being seeded into the sales form's initial values.
 */
const widget: InjectionFieldWidget = {
  metadata: {
    id: 'financial_pl.injection.pl-vat-meta-fields',
    title: 'Polish VAT metadata',
    description: 'Context NIP, MPP (split payment), and VAT exemption basis for a sales invoice.',
    features: ['financial_pl.view'],
    priority: 100,
    enabled: true,
  },
  fields: [
    {
      id: 'financial_pl.plVatMeta',
      label: 'financial_pl.fields.plVatMeta',
      labelKey: 'financial_pl.fields.plVatMeta',
      type: 'custom',
      group: 'details',
      customComponent: PlVatMetaPanel,
    },
  ],
}

export default widget
