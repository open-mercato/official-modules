import React from 'react'
import { Inbox } from 'lucide-react'

const receivedInvoicesIcon = React.createElement(Inbox, { width: 16, height: 16, 'aria-hidden': true })

export const metadata = {
  requireAuth: true,
  requireFeatures: ['financial_pl.view'],
  pageTitle: 'Received invoices',
  pageTitleKey: 'financial_pl.nav.received',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  pageOrder: 30,
  icon: receivedInvoicesIcon,
  breadcrumb: [{ label: 'Received invoices', labelKey: 'financial_pl.nav.received' }],
} as const

export default metadata
