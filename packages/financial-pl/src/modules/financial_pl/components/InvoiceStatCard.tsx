'use client'

import * as React from 'react'
import { type LucideIcon } from 'lucide-react'
import { cn } from '@open-mercato/shared/lib/utils'

// OM brand accent gradient for the stat-card bottom bar — mirrors the DS FancyButton primary gradient
// (uses the same `--brand-lime` / `--brand-violet` CSS vars, with the DS hex fallbacks).
export const BRAND_ACCENT_GRADIENT =
  'linear-gradient(90deg, var(--brand-lime, #B4F372) 0%, #EEFB63 50%, var(--brand-violet, #BC9AFF) 100%)'

/**
 * Summary stat card — label top-left, icon in a bordered tile top-right, large value below, and a
 * thin brand-gradient accent bar along the bottom edge. The `danger` tone (e.g. the "Problemy KSeF"
 * card when there are rejections) tints the card + swaps the accent bar to the DS error color.
 *
 * Shared by both invoice-list tabs (Sales + Purchases) so the KPI row is identical on each — keeping
 * the table at the same vertical position when switching scopes.
 */
export function InvoiceStatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: LucideIcon
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'danger'
}) {
  const danger = tone === 'danger'
  return (
    <div
      className={cn(
        'relative flex flex-col overflow-hidden rounded-lg border p-4 pb-5',
        danger ? 'border-status-error-border bg-status-error-bg' : 'border-border bg-card',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={cn('truncate text-sm', danger ? 'text-status-error-text' : 'text-muted-foreground')}>
          {label}
        </p>
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md border bg-background',
            danger ? 'border-status-error-border' : 'border-border',
          )}
        >
          <Icon
            className={cn('size-4', danger ? 'text-status-error-icon' : 'text-brand-violet')}
            aria-hidden="true"
          />
        </span>
      </div>
      <p
        className={cn(
          'mt-2 truncate text-2xl font-semibold tracking-tight tabular-nums',
          danger ? 'text-status-error-text' : 'text-foreground',
        )}
      >
        {value}
      </p>
      {/*
        The sub line is ALWAYS rendered, blank when unset. Cards that had a sub grew 18px taller than
        those that did not, so the Sales and Purchases KPI rows were different heights and the page
        jumped when switching tabs.
      */}
      <p
        className={cn(
          'mt-0.5 min-h-4 truncate text-xs',
          danger ? 'text-status-error-text/80' : 'text-muted-foreground',
        )}
      >
        {sub ?? '\u00A0'}
      </p>
      <span
        aria-hidden="true"
        className={cn('absolute inset-x-0 bottom-0 h-1', danger && 'bg-status-error-icon')}
        style={danger ? undefined : { backgroundImage: BRAND_ACCENT_GRADIENT }}
      />
    </div>
  )
}

export default InvoiceStatCard
