import type { InjectionRowActionWidget } from '@open-mercato/shared/modules/widgets/injection'

type InvoiceRow = {
  id?: string
}

/**
 * Download invoice PDF row action — opens the financial_pl invoice-pdf endpoint for
 * an issued sales invoice, which streams the KSeF visualization (wizualizacja
 * faktury ustrukturyzowanej) as application/pdf with a download Content-Disposition.
 * Injected into `data-table:sales.invoices:row-actions` next to the KSeF send action.
 *
 * Read-only: it only navigates to a GET download route (the browser handles the file
 * via the attachment Content-Disposition), so no confirmation arming is needed.
 * Gated on the `financial_pl.view` feature.
 */
const widget: InjectionRowActionWidget = {
  metadata: {
    id: 'financial_pl.injection.ksef-invoice-pdf',
    title: 'Download invoice PDF',
    description: 'Downloads the KSeF invoice PDF visualization for a sales invoice.',
    features: ['financial_pl.view'],
    priority: 90,
    enabled: true,
  },
  rowActions: [
    {
      id: 'financial_pl.ksef-invoice-pdf',
      label: 'financial_pl.actions.downloadInvoicePdf',
      icon: 'download',
      onSelect(row) {
        const invoice = (row ?? {}) as InvoiceRow
        if (!invoice.id) return
        const href = `/api/financial_pl/ksef/invoice-pdf?salesInvoiceId=${encodeURIComponent(invoice.id)}`
        if (typeof window !== 'undefined') {
          window.open(href, '_blank', 'noopener,noreferrer')
        }
      },
    },
  ],
}

export default widget
