export const metadata = {
  requireAuth: true,
  // Composed gate (SPEC-013): editing an invoice writes core SalesInvoice (sales.invoices.manage)
  // plus the PL-VAT layer (financial_pl.view).
  requireFeatures: ['financial_pl.view', 'sales.invoices.manage'],
  pageTitle: 'Edit invoice',
  pageTitleKey: 'financial_pl.invoices.edit.title',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'Invoices', labelKey: 'financial_pl.nav.invoices', href: '/backend/financial/invoices' },
    { label: 'Edit invoice', labelKey: 'financial_pl.invoices.edit.title' },
  ],
} as const
