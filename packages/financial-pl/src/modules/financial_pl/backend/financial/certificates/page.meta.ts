export const metadata = {
  requireAuth: true,
  requireFeatures: ['financial_pl.view', 'financial_pl.manage'],
  pageTitle: 'KSeF certificates',
  pageTitleKey: 'financial_pl.nav.certificates',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  pageOrder: 40,
  icon: 'shield-check',
  breadcrumb: [{ label: 'KSeF certificates', labelKey: 'financial_pl.nav.certificates' }],
} as const
