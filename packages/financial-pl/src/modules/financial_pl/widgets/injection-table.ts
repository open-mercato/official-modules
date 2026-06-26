import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * financial_pl → sales-invoice host wiring. The sales-invoices UI host exposes
 * the DataTable id `sales.invoices` and the CrudForm entity id
 * `sales.sales_invoice`; financial_pl mounts its KSeF column, send action, and
 * PL VAT meta fields at those spots without the sales module knowing about KSeF.
 */
export const injectionTable: ModuleInjectionTable = {
  'data-table:sales.invoices:columns': [
    {
      widgetId: 'financial_pl.injection.ksef-status-column',
      priority: 100,
    },
  ],
  'data-table:sales.invoices:row-actions': [
    {
      widgetId: 'financial_pl.injection.ksef-send-action',
      priority: 100,
    },
  ],
  'crud-form:sales.sales_invoice:fields': [
    {
      widgetId: 'financial_pl.injection.pl-vat-meta-fields',
      priority: 100,
    },
  ],
}

export default injectionTable
