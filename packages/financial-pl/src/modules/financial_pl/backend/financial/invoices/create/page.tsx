'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { InvoiceForm, emptyInvoiceFormValue } from '../[id]/edit/InvoiceForm'

/**
 * Create-invoice page (SPEC-013). Renders the shared {@link InvoiceForm} in create mode.
 *
 * On submit the form POSTs the base invoice to core `/api/sales/invoices` (persisting lines), reads
 * the new id, PUTs the PL-VAT metadata to `/api/financial_pl/ksef/invoice-meta`, then navigates to
 * the new invoice's edit page — switching to edit/PUT mode so a failed meta step is retried in place
 * (never re-POSTing, which would duplicate-create).
 */
export default function CreateInvoicePage() {
  // Built once per mount so the starter line/header defaults are stable.
  const initialValue = React.useMemo(() => emptyInvoiceFormValue(), [])
  return (
    <Page>
      <PageBody>
        <InvoiceForm initialValue={initialValue} />
      </PageBody>
    </Page>
  )
}
