'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Sent/received invoice direction toggle. Rendered at the top of both the sales-invoices list
 * (`scope="sent"`) and the received-invoices list (`scope="received"`); selecting the other segment
 * navigates to that list. The two surfaces keep their own routes, APIs and columns — this is a
 * visible switch between them, not a merged table.
 */
export type InvoiceScope = 'sent' | 'received'

const SCOPE_ROUTES: Record<InvoiceScope, string> = {
  sent: '/backend/financial/invoices',
  received: '/backend/financial/received',
}

export function InvoiceScopeTabs({ scope }: { scope: InvoiceScope }) {
  const t = useT()
  const router = useRouter()

  return (
    <SegmentedControl
      value={scope}
      onValueChange={(next) => {
        const target = next as InvoiceScope
        if (target !== scope && SCOPE_ROUTES[target]) router.push(SCOPE_ROUTES[target])
      }}
      aria-label={t('financial_pl.invoices.tabs.aria', 'Invoice direction')}
      // DS SegmentedControl defaults to a full pill (`rounded-full`); square it to the DS control
      // radius (`rounded-md` ~6px, items nest at `rounded`) per the OM no-full-pill convention.
      className="rounded-md"
    >
      <SegmentedControlItem value="sent" className="rounded">
        {t('financial_pl.invoices.tabs.sent', 'Sent')}
      </SegmentedControlItem>
      <SegmentedControlItem value="received" className="rounded">
        {t('financial_pl.invoices.tabs.received', 'Received')}
      </SegmentedControlItem>
    </SegmentedControl>
  )
}

export default InvoiceScopeTabs
