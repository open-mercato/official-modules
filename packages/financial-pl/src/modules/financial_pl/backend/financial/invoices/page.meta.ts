import React from 'react'
import { FileText } from 'lucide-react'

const invoicesIcon = React.createElement(FileText, { width: 16, height: 16, 'aria-hidden': true })

export const metadata = {
  requireAuth: true,
  requireFeatures: ['financial_pl.view', 'sales.invoices.manage'],
  pageTitle: 'Invoices',
  pageTitleKey: 'financial_pl.nav.invoices',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  pageOrder: 10,
  icon: invoicesIcon,
  breadcrumb: [{ label: 'Invoices', labelKey: 'financial_pl.nav.invoices' }],
} as const
