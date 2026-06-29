import React from 'react'
import { FileText } from 'lucide-react'

const invoicesIcon = React.createElement(FileText, { width: 16, height: 16, 'aria-hidden': true })

export const metadata = {
  requireAuth: true,
  requireFeatures: ['financial_pl.view', 'sales.invoices.manage'],
  pageTitle: 'Invoice details',
  pageTitleKey: 'financial_pl.invoices.detail.title',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  navHidden: true,
  icon: invoicesIcon,
  breadcrumb: [
    { label: 'Invoices', labelKey: 'financial_pl.nav.invoices', href: '/backend/financial/invoices' },
  ],
} as const
