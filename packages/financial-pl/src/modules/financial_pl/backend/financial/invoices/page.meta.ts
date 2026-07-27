export const metadata = {
  requireAuth: true,
  requireFeatures: ['financial_pl.view', 'sales.invoices.manage'],
  pageTitle: 'Invoices',
  pageTitleKey: 'financial_pl.nav.invoices',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  pageOrder: 10,
  icon: 'receipt-text',
  breadcrumb: [{ label: 'Invoices', labelKey: 'financial_pl.nav.invoices' }],
} as const
