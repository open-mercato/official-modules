export const metadata = {
  requireAuth: true,
  // Viewing the defaults is harmless, but they decide what every future invoice looks like — so the
  // page is gated on the same `manage` feature that guards the PUT it performs.
  requireFeatures: ['financial_pl.view', 'financial_pl.manage'],
  pageTitle: 'Invoice settings',
  pageTitleKey: 'financial_pl.nav.invoiceSettings',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  pageOrder: 35,
  icon: 'sliders',
  breadcrumb: [{ label: 'Invoice settings', labelKey: 'financial_pl.nav.invoiceSettings' }],
} as const

export default metadata
