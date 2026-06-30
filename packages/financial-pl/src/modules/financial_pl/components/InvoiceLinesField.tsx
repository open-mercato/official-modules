'use client'

import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { useT } from '@open-mercato/shared/lib/i18n/context'

// Standard Polish VAT rates offered as quick-picks; any other numeric rate goes through "Other".
// `zw`/`np`/`oo` (exempt / not-taxed / reverse-charge) are intentionally NOT line options: core's
// `tax_rate` is numeric, and persisting them as 0 would mis-file an exempt line as ordinary 0% VAT
// (0% ≠ zw). Express exemption / reverse-charge through the Polish-VAT section instead.
const STANDARD_VAT_RATES = ['23', '8', '5', '0'] as const
// Common Polish units of measure; "Other…" reveals a free input for any custom UoM.
const COMMON_UNITS = ['szt.', 'kg', 'g', 'l', 'ml', 'm', 'm²', 'm³', 'godz.', 'km', 'opak.', 'usł.', 'kpl.', 't'] as const
const OTHER_OPTION = '__other__'
const DEFAULT_UNIT = 'szt.'

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
      { name: '', quantity: '1', quantityUnit: DEFAULT_UNIT, unitPriceNet: '0', taxRate: '23', currencyCode, kind: 'product' },
    ])
  }

  const removeLine = (index: number) => {
    emit(value.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col gap-3">
      {value.map((line, index) => {
        const totals = computeLineTotals(line)
        const unitValue = line.quantityUnit ?? ''
        const isOtherUnit = !(COMMON_UNITS as readonly string[]).includes(unitValue)
        const taxValue = line.taxRate ?? ''
        // Match a standard rate NUMERICALLY so an edit-prefilled scaled value (e.g. core stores
        // `23.0000`) still shows the clean "23%" pick rather than dropping into "Other…" (code-jury, Kimi).
        const taxNum = taxValue.trim() === '' ? null : Number(taxValue)
        const matchedVat =
          taxNum != null && Number.isFinite(taxNum)
            ? (STANDARD_VAT_RATES as readonly string[]).find((r) => Number(r) === taxNum)
            : undefined
        // "Other" whenever the value doesn't match a standard rate — including a just-picked "Other…"
        // (taxRate '') so the custom numeric input renders (code-jury r2, Codex). A scaled prefill like
        // '23.0000' matches numerically → shows the clean "23%" pick (code-jury r1, Kimi).
        const isOtherVat = !matchedVat
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
                <Select
                  value={isOtherUnit ? OTHER_OPTION : unitValue}
                  disabled={busy}
                  onValueChange={(next) =>
                    updateLine(index, { quantityUnit: next === OTHER_OPTION ? '' : next })
                  }
                >
                  <SelectTrigger id={`financial_pl-line-unit-${index}`} className="w-full">
                    <SelectValue placeholder={t('financial_pl.lines.quantityUnitPlaceholder', 'szt.')} />
                  </SelectTrigger>
                  <SelectContent>
                    {COMMON_UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {unit}
                      </SelectItem>
                    ))}
                    <SelectItem value={OTHER_OPTION}>{t('financial_pl.lines.unitOther', 'Other…')}</SelectItem>
                  </SelectContent>
                </Select>
                {isOtherUnit ? (
                  <Input
                    aria-label={t('financial_pl.lines.quantityUnitCustom', 'Custom unit')}
                    value={unitValue}
                    disabled={busy}
                    onChange={(event) => updateLine(index, { quantityUnit: event.target.value })}
                    placeholder={t('financial_pl.lines.quantityUnitCustomPlaceholder', 'e.g. rbg')}
                  />
                ) : null}
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
                <Select
                  value={isOtherVat ? OTHER_OPTION : (matchedVat ?? '')}
                  disabled={busy}
                  onValueChange={(next) =>
                    updateLine(index, { taxRate: next === OTHER_OPTION ? '' : next })
                  }
                >
                  <SelectTrigger id={`financial_pl-line-tax-${index}`} className="w-full">
                    <SelectValue placeholder={t('financial_pl.lines.taxRatePlaceholder', 'Select…')} />
                  </SelectTrigger>
                  <SelectContent>
                    {STANDARD_VAT_RATES.map((rate) => (
                      <SelectItem key={rate} value={rate}>
                        {rate}%
                      </SelectItem>
                    ))}
                    <SelectItem value={OTHER_OPTION}>{t('financial_pl.lines.taxRateOther', 'Other…')}</SelectItem>
                  </SelectContent>
                </Select>
                {isOtherVat ? (
                  <Input
                    aria-label={t('financial_pl.lines.taxRateCustom', 'Custom VAT rate (%)')}
                    inputMode="decimal"
                    value={taxValue}
                    disabled={busy}
                    onChange={(event) => updateLine(index, { taxRate: event.target.value })}
                  />
                ) : null}
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
