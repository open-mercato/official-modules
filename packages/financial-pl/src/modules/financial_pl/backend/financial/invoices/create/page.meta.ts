import React from 'react'
import { FilePlus } from 'lucide-react'

const createIcon = React.createElement(FilePlus, { width: 16, height: 16, 'aria-hidden': true })

export const metadata = {
  requireAuth: true,
  // Composed gate (SPEC-013): authoring an invoice writes core SalesInvoice (gated by
  // sales.invoices.manage) plus the PL-VAT layer (financial_pl.view), so both are required.
  requireFeatures: ['financial_pl.view', 'sales.invoices.manage'],
  pageTitle: 'Create invoice',
  pageTitleKey: 'financial_pl.invoices.create.title',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  navHidden: true,
  icon: createIcon,
  breadcrumb: [
    { label: 'Invoices', labelKey: 'financial_pl.nav.invoices', href: '/backend/financial/invoices' },
    { label: 'Create invoice', labelKey: 'financial_pl.invoices.create.title' },
  ],
} as const
