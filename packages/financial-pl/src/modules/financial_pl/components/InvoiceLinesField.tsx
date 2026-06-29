'use client'

import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * One invoice line. Matches core's invoice-line create fields (decimal money carried
 * as strings, `taxRate` as a percentage string). `totalNetAmount`/`taxAmount`/
 * `totalGrossAmount` are computed and displayed (and submitted) by the editor.
 */
export type InvoiceLineInput = {
  name: string
  quantity: string
  quantityUnit?: string
  unitPriceNet: string
  taxRate?: string
  totalNetAmount?: string
  taxAmount?: string
  totalGrossAmount?: string
  currencyCode: string
  lineNumber?: number
  kind?: 'product' | 'service' | 'shipping' | 'discount' | 'adjustment'
}

/** Round a number to 2 decimals and render as a fixed-point string, or '' for non-finite. */
function toMoney(value: number): string {
  if (!Number.isFinite(value)) return ''
  return (Math.round(value * 100) / 100).toFixed(2)
}

/**
 * Compute net / tax / gross totals for a line from quantity, unit price and tax rate.
 * Returns empty strings when inputs are not parseable, so a half-typed row never shows
 * `NaN`. Pure + testable.
 */
export function computeLineTotals(line: InvoiceLineInput): {
  totalNetAmount: string
  taxAmount: string
  totalGrossAmount: string
} {
  const quantity = Number(line.quantity)
  const unitPriceNet = Number(line.unitPriceNet)
  const taxRate = line.taxRate != null && line.taxRate !== '' ? Number(line.taxRate) : 0
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPriceNet)) {
    return { totalNetAmount: '', taxAmount: '', totalGrossAmount: '' }
  }
  const net = quantity * unitPriceNet
  const tax = Number.isFinite(taxRate) ? net * (taxRate / 100) : 0
  const gross = net + tax
  return {
    totalNetAmount: toMoney(net),
    taxAmount: toMoney(tax),
    totalGrossAmount: toMoney(gross),
  }
}

/** Build a line carrying its computed totals + the supplied currency / line number. */
export function withComputedTotals(line: InvoiceLineInput, currencyCode: string, lineNumber: number): InvoiceLineInput {
  const totals = computeLineTotals(line)
  return { ...line, ...totals, currencyCode, lineNumber }
}

export type InvoiceLinesFieldProps = {
  value: InvoiceLineInput[]
  onChange: (next: InvoiceLineInput[]) => void
  currencyCode: string
  disabled?: boolean
}

const labelClass = 'text-xs text-muted-foreground'

/**
 * Repeatable invoice-lines editor. Each row edits name, quantity, unit, unit price net
 * and tax rate; net / tax / gross are computed and shown (read-only). Add/remove rows.
 * Controlled: emits the full lines array (with computed totals, currency and 1-based
 * `lineNumber`) on every change, so the parent always holds a submit-ready value.
 */
export function InvoiceLinesField({ value, onChange, currencyCode, disabled }: InvoiceLinesFieldProps) {
  const t = useT()
  const busy = Boolean(disabled)

  const emit = React.useCallback(
    (lines: InvoiceLineInput[]) => {
      onChange(lines.map((line, index) => withComputedTotals(line, currencyCode, index + 1)))
    },
    [onChange, currencyCode],
  )

  const updateLine = (index: number, next: Partial<InvoiceLineInput>) => {
    emit(value.map((line, i) => (i === index ? { ...line, ...next } : line)))
  }

  const addLine = () => {
    emit([
      ...value,
      { name: '', quantity: '1', quantityUnit: '', unitPriceNet: '0', taxRate: '23', currencyCode, kind: 'product' },
    ])
  }

  const removeLine = (index: number) => {
    emit(value.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col gap-3">
      {value.map((line, index) => {
        const totals = computeLineTotals(line)
        return (
          <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex items-end gap-2">
              <div className="flex flex-[2] flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-name-${index}`}>
                  {t('financial_pl.lines.name', 'Name')}
                </label>
                <Input
                  id={`financial_pl-line-name-${index}`}
                  value={line.name}
                  disabled={busy}
                  onChange={(event) => updateLine(index, { name: event.target.value })}
                />
              </div>
              <IconButton
                type="button"
                variant="ghost"
                disabled={busy}
                aria-label={t('financial_pl.lines.remove', 'Remove line')}
                title={t('financial_pl.lines.remove', 'Remove line')}
                onClick={() => removeLine(index)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-qty-${index}`}>
                  {t('financial_pl.lines.quantity', 'Quantity')}
                </label>
                <Input
                  id={`financial_pl-line-qty-${index}`}
                  inputMode="decimal"
                  value={line.quantity}
                  disabled={busy}
                  onChange={(event) => updateLine(index, { quantity: event.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-unit-${index}`}>
                  {t('financial_pl.lines.quantityUnit', 'Unit')}
                </label>
                <Input
                  id={`financial_pl-line-unit-${index}`}
                  value={line.quantityUnit ?? ''}
                  disabled={busy}
                  onChange={(event) => updateLine(index, { quantityUnit: event.target.value })}
                  placeholder={t('financial_pl.lines.quantityUnitPlaceholder', 'pcs')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-price-${index}`}>
                  {t('financial_pl.lines.unitPriceNet', 'Unit price (net)')}
                </label>
                <Input
                  id={`financial_pl-line-price-${index}`}
                  inputMode="decimal"
                  value={line.unitPriceNet}
                  disabled={busy}
                  onChange={(event) => updateLine(index, { unitPriceNet: event.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-tax-${index}`}>
                  {t('financial_pl.lines.taxRate', 'VAT rate (%)')}
                </label>
                <Input
                  id={`financial_pl-line-tax-${index}`}
                  inputMode="decimal"
                  value={line.taxRate ?? ''}
                  disabled={busy}
                  onChange={(event) => updateLine(index, { taxRate: event.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <span>
                {t('financial_pl.lines.totalNet', 'Net')}: {totals.totalNetAmount || '—'} {currencyCode}
              </span>
              <span>
                {t('financial_pl.lines.taxAmount', 'VAT')}: {totals.taxAmount || '—'} {currencyCode}
              </span>
              <span>
                {t('financial_pl.lines.totalGross', 'Gross')}: {totals.totalGrossAmount || '—'} {currencyCode}
              </span>
            </div>
          </div>
        )
      })}
      <div className="flex">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={addLine}>
          <Plus className="mr-1 size-4" />
          {t('financial_pl.lines.add', 'Add line')}
        </Button>
      </div>
    </div>
  )
}

export default InvoiceLinesField
