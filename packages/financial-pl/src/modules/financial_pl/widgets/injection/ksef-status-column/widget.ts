import * as React from 'react'
import type { InjectionColumnWidget } from '@open-mercato/shared/modules/widgets/injection'
import KsefStatusCell from './widget.client'

/**
 * KSeF status column — renders the Polish KSeF submission status as a DS
 * semantic status `Badge` inline in the sales-invoices DataTable
 * (`data-table:sales.invoices:columns`). The value comes from the
 * `_financial_pl.ksefStatus` field added by `financial_pl.ksef-invoice-status`
 * response enricher.
 */
const widget: InjectionColumnWidget = {
  metadata: {
    id: 'financial_pl.injection.ksef-status-column',
    title: 'KSeF status',
    description: 'Shows the KSeF submission status for a sales invoice (sourced from the financial_pl enricher).',
    features: ['financial_pl.view'],
    priority: 100,
    enabled: true,
  },
  columns: [
    {
      id: 'financial_pl.ksef-status',
      header: 'financial_pl.columns.ksefStatus',
      accessorKey: '_financial_pl',
      size: 180,
      cell: ({ getValue }) => {
        const value = getValue() as
          | { ksefStatus?: string | null; ksefNumber?: string | null; submissionId?: string | null; upoAvailable?: boolean }
          | null
          | undefined
        return React.createElement(KsefStatusCell, {
          status: value?.ksefStatus ?? null,
          ksefNumber: value?.ksefNumber ?? null,
          submissionId: value?.submissionId ?? null,
          upoAvailable: Boolean(value?.upoAvailable),
        })
      },
    },
  ],
}

export default widget
