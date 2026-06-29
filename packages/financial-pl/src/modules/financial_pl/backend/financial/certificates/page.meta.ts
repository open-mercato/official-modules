import React from 'react'
import { ShieldCheck } from 'lucide-react'

const certificatesIcon = React.createElement(ShieldCheck, { width: 16, height: 16, 'aria-hidden': true })

export const metadata = {
  requireAuth: true,
  requireFeatures: ['financial_pl.view', 'financial_pl.manage'],
  pageTitle: 'KSeF certificates',
  pageTitleKey: 'financial_pl.nav.certificates',
  pageGroup: 'Financials (PL)',
  pageGroupKey: 'financial_pl.nav.group',
  pageOrder: 40,
  icon: certificatesIcon,
  breadcrumb: [{ label: 'KSeF certificates', labelKey: 'financial_pl.nav.certificates' }],
} as const
