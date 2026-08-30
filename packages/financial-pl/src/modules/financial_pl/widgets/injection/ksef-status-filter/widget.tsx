"use client"

/**
 * Invoice list filters — DataTable `:search-trailing` injection widget.
 *
 * Mounts to the right of the invoices-list search input
 * (spot `data-table:financial_pl.invoices:search-trailing`) and renders the invoice filters (KSeF
 * status, rodzaj faktury, status dokumentu) as visible inline <Select>s at the SAME height as the
 * search input (default trigger = `h-9`), instead of the FilterBar "Filters" popover. Keeping the
 * filters in an injection widget (rather than a custom DataTable `toolbar`) preserves the native
 * search bar AND the bulk-action bar, which both live in the FilterBar a custom toolbar would replace.
 *
 * Stateless: the host page owns the filter values and passes an `invoiceFilters` array
 * (`{ id, label, allLabel, value, options, onChange }`) through the DataTable `injectionContext`;
 * this widget only renders the controls. Feature-gated behind `financial_pl.view`.
 */

import * as React from 'react'
import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'

export type InvoiceFilterOption = { value: string; label: string }

export type InvoiceFilterConfig = {
  id: string
  label: string
  /** Label for the "no filter" sentinel option (value `all`). */
  allLabel: string
  value: string
  options: InvoiceFilterOption[]
  onChange: (value: string) => void
}

export type InvoiceFiltersContext = { invoiceFilters?: InvoiceFilterConfig[] }

export function InvoiceFiltersWidget({ context }: { context: InvoiceFiltersContext }) {
  const filters = context?.invoiceFilters
  if (!filters || filters.length === 0) return null

  return (
    // The DataTable injection spot lays its children out with `flex ... nowrap`, so filters kept at
    // their intrinsic width (see `shrink-0` below) would push the page into a horizontal scroll on a
    // phone. This wrapper lets them wrap onto more rows instead; `min-w-0` lets it shrink inside the
    // nowrap parent so the page itself never overflows (WCAG 1.4.10 Reflow).
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <Select key={filter.id} value={filter.value} onValueChange={filter.onChange}>
          {/*
            Default trigger size = h-9, matching the search input height.
            `shrink-0`: the DS trigger clamps its direct-child spans (`[&>span]:line-clamp-1`), so
            once the toolbar row runs out of room it squeezes the trigger and the selected value gets
            cut mid-word with no ellipsis. Keeping the trigger at its intrinsic width makes the row
            wrap instead of clipping the text the operator needs to read.
            Label uses `text-foreground`: at 12px, `muted-foreground` measures 4.18:1, under the
            WCAG 1.4.3 AA floor of 4.5:1 for text below 18px.
          */}
          <SelectTrigger
            className="w-auto min-w-0 shrink gap-2 sm:min-w-34 sm:shrink-0"
            aria-label={filter.label}
          >
            {/*
              The inline label is hidden below `sm`: on a phone the label + value together are wider
              than the viewport, and the trigger's `aria-label` already names the control for
              assistive tech, so nothing is lost. From `sm` up the label shows and `shrink-0` keeps
              the value from being clipped.
            */}
            <span className="hidden! shrink-0 whitespace-nowrap text-xs font-medium text-foreground sm:inline!">
              {filter.label}
            </span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{filter.allLabel}</SelectItem>
            {filter.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
    </div>
  )
}

const widget: InjectionWidgetModule<InvoiceFiltersContext> = {
  metadata: {
    id: 'financial_pl.injection.ksef-status-filter',
    title: 'Invoice list filters',
    description:
      'Inline invoice filters (KSeF status, invoice kind, document status) rendered next to the invoices-list search input at search-field height.',
    features: ['financial_pl.view'],
    priority: 100,
    enabled: true,
  },
  Widget: InvoiceFiltersWidget,
}

export default widget
