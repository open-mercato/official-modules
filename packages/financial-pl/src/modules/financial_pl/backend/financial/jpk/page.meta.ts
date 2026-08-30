export const metadata = {
  requireAuth: true,
  requireFeatures: ['financial_pl.view', 'financial_pl.manage'],
  pageTitle: 'JPK_V7',
  pageTitleKey: 'financial_pl.nav.jpk',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  pageOrder: 30,
  icon: 'file-spreadsheet',
  breadcrumb: [{ label: 'JPK_V7', labelKey: 'financial_pl.nav.jpk' }],
} as const
