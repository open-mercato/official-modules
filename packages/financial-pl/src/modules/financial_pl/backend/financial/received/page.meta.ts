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
  // Reached from the Sprzedaż/Zakupy toggle on the invoices list, so a second sidebar entry only
  // duplicated the route. The page keeps its title, icon and breadcrumb — it is hidden from the
  // navigation, not removed.
  navHidden: true,
  icon: receivedInvoicesIcon,
  breadcrumb: [{ label: 'Received invoices', labelKey: 'financial_pl.nav.received' }],
} as const

export default metadata
