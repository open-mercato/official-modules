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
import { ComboboxInput, type ComboboxOption } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { normalizeDecimalInput } from '../lib/pl-format'

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
  unitPriceGross?: string
  taxRate?: string
  discountPercent?: string
  discountAmount?: string
  metadata?: Record<string, unknown> | null
  productId?: string
  sku?: string
  totalNetAmount?: string
  taxAmount?: string
  totalGrossAmount?: string
  currencyCode: string
  lineNumber?: number
  kind?: 'product' | 'service' | 'shipping' | 'discount' | 'adjustment'
}

export type PriceMode = 'net' | 'gross'
export type MarginScheme = 'travel' | 'used_goods' | 'art' | 'collectibles'

type CatalogProductPricing = {
  unit_price_net?: string | number | null
  unit_price_gross?: string | number | null
  currency_code?: string | null
  tax_rate?: string | number | null
}

type CatalogProduct = {
  id: string
  title: string
  sku?: string | null
  default_unit?: string | null
  default_sales_unit?: string | null
  tax_rate?: string | number | null
  primary_currency_code?: string | null
  pricing?: CatalogProductPricing | null
}

type CatalogProductsResponse = {
  items?: CatalogProduct[]
}

/** Round a number to 2 decimals and render as a fixed-point string, or '' for non-finite. */
function toMoney(value: number): string {
  if (!Number.isFinite(value)) return ''
  return (Math.round(value * 100) / 100).toFixed(2)
}

function toRoundedNumber(value: number): number {
  const money = toMoney(value)
  return money ? Number(money) : Number.NaN
}

function isMarginMode(marginScheme?: MarginScheme | null): boolean {
  return Boolean(marginScheme)
}

export function isValidDiscountPercent(value: string | undefined): boolean {
  const text = (value ?? '').trim()
  if (!text) return true
  if (!/^\d{1,3}(?:\.\d{0,2})?$/.test(text)) return false
  const numeric = Number(text)
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100
}

function parseDiscountPercent(value: string | undefined): number | null {
  const text = (value ?? '').trim()
  if (!text) return 0
  if (!isValidDiscountPercent(text)) return null
  return Number(text)
}

function isDiscountPercentInputAllowed(value: string): boolean {
  if (value === '') return true
  if (!/^\d{0,3}(?:\.\d{0,2})?$/.test(value)) return false
  if (value.endsWith('.')) return true
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100
}

function normalizeTaxRate(line: InvoiceLineInput, marginScheme?: MarginScheme | null): number {
  if (isMarginMode(marginScheme)) return 0
  const taxRate = line.taxRate != null && line.taxRate !== '' ? Number(line.taxRate) : 0
  return Number.isFinite(taxRate) ? taxRate : 0
}

function deriveGrossFromNet(unitPriceNet: string, taxRate: number, marginScheme?: MarginScheme | null): string {
  const unitNet = Number(unitPriceNet)
  if (!Number.isFinite(unitNet)) return ''
  if (isMarginMode(marginScheme)) return toMoney(unitNet)
  return toMoney(unitNet * (1 + taxRate / 100))
}

function deriveNetFromGross(unitPriceGross: string, taxRate: number, marginScheme?: MarginScheme | null): string {
  const unitGross = Number(unitPriceGross)
  if (!Number.isFinite(unitGross)) return ''
  if (isMarginMode(marginScheme)) return toMoney(unitGross)
  return toMoney(unitGross * 100 / (100 + taxRate))
}

export function normalizeLineForPriceMode(
  line: InvoiceLineInput,
  priceMode: PriceMode,
  marginScheme?: MarginScheme | null,
): InvoiceLineInput {
  const taxRate = normalizeTaxRate(line, marginScheme)
  if (priceMode === 'gross' || isMarginMode(marginScheme)) {
    const sourceGross = line.unitPriceGross && line.unitPriceGross.trim()
      ? line.unitPriceGross
      : deriveGrossFromNet(line.unitPriceNet, taxRate, marginScheme)
    return {
      ...line,
      unitPriceGross: sourceGross,
      unitPriceNet: deriveNetFromGross(sourceGross, taxRate, marginScheme),
    }
  }
  const sourceNet = line.unitPriceNet && line.unitPriceNet.trim()
    ? line.unitPriceNet
    : deriveNetFromGross(line.unitPriceGross ?? '', taxRate, marginScheme)
  return {
    ...line,
    unitPriceNet: sourceNet,
    unitPriceGross: deriveGrossFromNet(sourceNet, taxRate, marginScheme),
  }
}

export function convertLinesPriceMode(
  lines: InvoiceLineInput[],
  nextPriceMode: PriceMode,
  marginScheme?: MarginScheme | null,
): InvoiceLineInput[] {
  return lines.map((line) => {
    const taxRate = normalizeTaxRate(line, marginScheme)
    if (nextPriceMode === 'gross' || isMarginMode(marginScheme)) {
      const sourceGross = deriveGrossFromNet(line.unitPriceNet, taxRate, marginScheme)
      return {
        ...line,
        unitPriceGross: sourceGross,
        unitPriceNet: deriveNetFromGross(sourceGross, taxRate, marginScheme),
      }
    }
    const sourceNet = deriveNetFromGross(line.unitPriceGross ?? '', taxRate, marginScheme)
    return {
      ...line,
      unitPriceNet: sourceNet,
      unitPriceGross: deriveGrossFromNet(sourceNet, taxRate, marginScheme),
    }
  })
}

/**
 * Compute net / tax / gross totals for a line from quantity, unit price and tax rate.
 * Returns empty strings when inputs are not parseable, so a half-typed row never shows
 * `NaN`. Pure + testable.
 */
export function computeLineTotals(
  line: InvoiceLineInput,
  priceMode: PriceMode = 'net',
  marginScheme?: MarginScheme | null,
): {
  discountAmount: string
  totalNetAmount: string
  taxAmount: string
  totalGrossAmount: string
  unitPriceNet: string
  unitPriceGross: string
} {
  const quantity = Number(line.quantity)
  const marginMode = isMarginMode(marginScheme)
  const effectivePriceMode: PriceMode = marginMode ? 'gross' : priceMode
  const taxRate = normalizeTaxRate(line, marginScheme)
  const normalized = normalizeLineForPriceMode(line, effectivePriceMode, marginScheme)
  const unitPriceNet = Number(normalized.unitPriceNet)
  const unitPriceGross = Number(normalized.unitPriceGross)
  const discountPercent = parseDiscountPercent(line.discountPercent)
  if (
    !Number.isFinite(quantity) ||
    !Number.isFinite(unitPriceNet) ||
    (effectivePriceMode === 'gross' && !Number.isFinite(unitPriceGross)) ||
    discountPercent === null
  ) {
    return {
      discountAmount: '',
      totalNetAmount: '',
      taxAmount: '',
      totalGrossAmount: '',
      unitPriceNet: normalized.unitPriceNet,
      unitPriceGross: normalized.unitPriceGross ?? '',
    }
  }
  if (marginMode) {
    const baseGross = toRoundedNumber(quantity * unitPriceGross)
    const discountAmount = toRoundedNumber(quantity * unitPriceGross * discountPercent / 100)
    const gross = toRoundedNumber(baseGross - discountAmount)
    return {
      discountAmount: toMoney(discountAmount),
      totalNetAmount: toMoney(gross),
      taxAmount: '',
      totalGrossAmount: toMoney(gross),
      unitPriceNet: normalized.unitPriceNet,
      unitPriceGross: normalized.unitPriceGross ?? '',
    }
  }
  if (effectivePriceMode === 'gross') {
    const baseGross = toRoundedNumber(quantity * unitPriceGross)
    const discountAmount = toRoundedNumber(quantity * unitPriceGross * discountPercent / 100)
    const gross = toRoundedNumber(baseGross - discountAmount)
    const tax = toRoundedNumber(gross * taxRate / (100 + taxRate))
    const net = toRoundedNumber(gross - tax)
    return {
      discountAmount: toMoney(discountAmount),
      totalNetAmount: toMoney(net),
      taxAmount: toMoney(tax),
      totalGrossAmount: toMoney(gross),
      unitPriceNet: normalized.unitPriceNet,
      unitPriceGross: normalized.unitPriceGross ?? '',
    }
  }
  const baseNet = toRoundedNumber(quantity * unitPriceNet)
  const discountAmount = toRoundedNumber(quantity * unitPriceNet * discountPercent / 100)
  const net = toRoundedNumber(baseNet - discountAmount)
  const tax = toRoundedNumber(net * taxRate / 100)
  const gross = toRoundedNumber(net + tax)
  return {
    discountAmount: toMoney(discountAmount),
    totalNetAmount: toMoney(net),
    taxAmount: toMoney(tax),
    totalGrossAmount: toMoney(gross),
    unitPriceNet: normalized.unitPriceNet,
    unitPriceGross: normalized.unitPriceGross ?? '',
  }
}

/** Build a line carrying its computed totals + the supplied currency / line number. */
export function withComputedTotals(
  line: InvoiceLineInput,
  currencyCode: string,
  lineNumber: number,
  priceMode: PriceMode = 'net',
  marginScheme?: MarginScheme | null,
): InvoiceLineInput {
  const totals = computeLineTotals(line, priceMode, marginScheme)
  return {
    ...line,
    unitPriceNet: totals.unitPriceNet || line.unitPriceNet,
    unitPriceGross: totals.unitPriceGross || line.unitPriceGross,
    discountAmount: totals.discountAmount,
    totalNetAmount: totals.totalNetAmount,
    taxAmount: totals.taxAmount,
    totalGrossAmount: totals.totalGrossAmount,
    currencyCode,
    lineNumber,
  }
}

export type InvoiceLinesFieldProps = {
  value: InvoiceLineInput[]
  onChange: (next: InvoiceLineInput[]) => void
  currencyCode: string
  disabled?: boolean
  priceMode?: PriceMode
  onPriceModeChange?: (next: PriceMode) => void
  marginScheme?: MarginScheme | null
}

const labelClass = 'text-xs text-muted-foreground'

/**
 * Repeatable invoice-lines editor. Each row edits name, quantity, unit, unit price net
 * and tax rate; net / tax / gross are computed and shown (read-only). Add/remove rows.
 * Controlled: emits the full lines array (with computed totals, currency and 1-based
 * `lineNumber`) on every change, so the parent always holds a submit-ready value.
 */
export function InvoiceLinesField({
  value,
  onChange,
  currencyCode,
  disabled,
  priceMode = 'net',
  onPriceModeChange,
  marginScheme,
}: InvoiceLinesFieldProps) {
  const t = useT()
  const busy = Boolean(disabled)
  const marginMode = isMarginMode(marginScheme)
  const effectivePriceMode: PriceMode = marginMode ? 'gross' : priceMode
  const productByIdRef = React.useRef<Map<string, CatalogProduct>>(new Map())

  const emit = React.useCallback(
    (lines: InvoiceLineInput[]) => {
      onChange(lines.map((line, index) => withComputedTotals(line, currencyCode, index + 1, effectivePriceMode, marginScheme)))
    },
    [onChange, currencyCode, effectivePriceMode, marginScheme],
  )

  const updateLine = (index: number, next: Partial<InvoiceLineInput>) => {
    emit(value.map((line, i) => (i === index ? { ...line, ...next } : line)))
  }

  const loadProductSuggestions = React.useCallback(async (query?: string): Promise<ComboboxOption[]> => {
    const q = (query ?? '').trim()
    try {
      const url = q.length >= 2
        ? `/api/catalog/products?search=${encodeURIComponent(q)}&pageSize=10`
        : `/api/catalog/products?pageSize=10`
      const res = await apiCall<CatalogProductsResponse>(url)
      const items = res.ok && Array.isArray(res.result?.items) ? res.result.items : []
      if (items.length === 0) return []
      const options: ComboboxOption[] = []
      for (const product of items) {
        const id = product.id.trim()
        const title = product.title.trim()
        if (!id || !title) continue
        const normalizedProduct = { ...product, id, title }
        productByIdRef.current.set(id, normalizedProduct)
        options.push({
          value: id,
          label: title,
          description: product.sku?.trim() || undefined,
        })
      }
      return options
    } catch {
      return []
    }
  }, [])

  const updateLineProduct = (index: number, nextValue: string) => {
    const product = productByIdRef.current.get(nextValue)
    const carriedMetadata = value[index]?.metadata ? { ...value[index].metadata } : {}
    if (!product) {
      delete carriedMetadata.productId
      updateLine(index, {
        name: nextValue,
        productId: undefined,
        sku: undefined,
        metadata: Object.keys(carriedMetadata).length > 0 ? carriedMetadata : null,
      })
      return
    }

    const pricing = product.pricing ?? null
    const unit = product.default_unit?.trim() || product.default_sales_unit?.trim()
    const taxRate = pricing?.tax_rate ?? product.tax_rate
    carriedMetadata.productId = product.id
    const next: Partial<InvoiceLineInput> = {
      name: product.title,
      productId: product.id,
      sku: product.sku ?? undefined,
      metadata: carriedMetadata,
    }

    if (unit) next.quantityUnit = unit
    if (taxRate != null && String(taxRate).trim() !== '') next.taxRate = String(taxRate)
    if (
      pricing != null
      && pricing.currency_code === currencyCode
      && pricing.unit_price_net != null
      && String(pricing.unit_price_net).trim() !== ''
    ) {
      next.unitPriceNet = String(pricing.unit_price_net)
    }
    if (
      pricing != null
      && pricing.currency_code === currencyCode
      && pricing.unit_price_gross != null
      && String(pricing.unit_price_gross).trim() !== ''
    ) {
      next.unitPriceGross = String(pricing.unit_price_gross)
    }
    const nextTaxRate = normalizeTaxRate({ ...value[index], ...next }, marginScheme)
    if (next.unitPriceNet != null && next.unitPriceGross == null) {
      next.unitPriceGross = deriveGrossFromNet(next.unitPriceNet, nextTaxRate, marginScheme)
    }
    if (next.unitPriceGross != null && next.unitPriceNet == null) {
      next.unitPriceNet = deriveNetFromGross(next.unitPriceGross, nextTaxRate, marginScheme)
    }

    updateLine(index, next)
  }

  const addLine = () => {
    emit([
      ...value,
      { name: '', quantity: '1', quantityUnit: DEFAULT_UNIT, unitPriceNet: '0', unitPriceGross: '0', taxRate: '23', currencyCode, kind: 'product' },
    ])
  }

  const removeLine = (index: number) => {
    emit(value.filter((_, i) => i !== index))
  }

  const discountTotal = value.reduce((sum, line) => {
    const amount = Number(computeLineTotals(line, effectivePriceMode, marginScheme).discountAmount)
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)

  const setPriceMode = (next: PriceMode) => {
    if (busy || marginMode || next === effectivePriceMode) return
    onPriceModeChange?.(next)
    onChange(
      convertLinesPriceMode(value, next)
        .map((line, index) => withComputedTotals(line, currencyCode, index + 1, next)),
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className={labelClass}>{t('financial_pl.lines.priceMode', 'Prices')}</span>
        <div
          className="inline-flex w-fit rounded-md border border-border bg-background p-0.5"
          role="group"
          aria-label={t('financial_pl.lines.priceMode', 'Prices')}
        >
          {(['net', 'gross'] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="2xs"
              variant={effectivePriceMode === mode ? 'secondary' : 'ghost'}
              disabled={busy || marginMode}
              aria-pressed={effectivePriceMode === mode}
              onClick={() => setPriceMode(mode)}
            >
              {mode === 'net'
                ? t('financial_pl.lines.priceModeNet', 'net')
                : t('financial_pl.lines.priceModeGross', 'gross')}
            </Button>
          ))}
        </div>
      </div>
      {value.map((line, index) => {
        const totals = computeLineTotals(line, effectivePriceMode, marginScheme)
        const normalizedLine = normalizeLineForPriceMode(line, effectivePriceMode, marginScheme)
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
                <label className={labelClass} htmlFor={`financial_pl-line-product-${index}`}>
                  {t('financial_pl.invoices.line.product', 'Product (from catalog)')}
                </label>
                <ComboboxInput
                  value={line.name}
                  onChange={(next) => updateLineProduct(index, next)}
                  loadSuggestions={loadProductSuggestions}
                  seedOptions={
                    line.name ? [{ value: line.name, label: line.name, description: line.sku ?? null }] : []
                  }
                  allowCustomValues
                  disabled={busy}
                  placeholder={t('financial_pl.invoices.line.productPlaceholder', 'Search products or type a name')}
                />
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-qty-${index}`}>
                  {t('financial_pl.lines.quantity', 'Quantity')}
                </label>
                <Input
                  id={`financial_pl-line-qty-${index}`}
                  inputMode="decimal"
                  value={line.quantity}
                  disabled={busy}
                  onChange={(event) => updateLine(index, { quantity: normalizeDecimalInput(event.target.value) })}
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
                  {effectivePriceMode === 'gross'
                    ? t('financial_pl.lines.unitPriceGross', 'Unit price (gross)')
                    : t('financial_pl.lines.unitPriceNet', 'Unit price (net)')}
                </label>
                {busy ? (
                  <span className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-sm">
                    {effectivePriceMode === 'gross' ? (normalizedLine.unitPriceGross || '—') : (normalizedLine.unitPriceNet || '—')}
                  </span>
                ) : (
                  <Input
                    id={`financial_pl-line-price-${index}`}
                    inputMode="decimal"
                    value={effectivePriceMode === 'gross' ? (line.unitPriceGross ?? '') : line.unitPriceNet}
                    disabled={busy}
                    onChange={(event) => {
                      const nextValue = normalizeDecimalInput(event.target.value)
                      const taxRate = normalizeTaxRate(line, marginScheme)
                      if (effectivePriceMode === 'gross') {
                        updateLine(index, {
                          unitPriceGross: nextValue,
                          unitPriceNet: deriveNetFromGross(nextValue, taxRate, marginScheme),
                        })
                      } else {
                        updateLine(index, {
                          unitPriceNet: nextValue,
                          unitPriceGross: deriveGrossFromNet(nextValue, taxRate, marginScheme),
                        })
                      }
                    }}
                  />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-discount-${index}`}>
                  {t('financial_pl.lines.discountPercent', 'Discount %')}
                </label>
                {busy ? (
                  <span className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-sm">
                    {line.discountPercent?.trim() ? `${line.discountPercent}%` : '—'}
                  </span>
                ) : (
                  <Input
                    id={`financial_pl-line-discount-${index}`}
                    inputMode="decimal"
                    value={line.discountPercent ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const next = normalizeDecimalInput(event.target.value)
                      if (isDiscountPercentInputAllowed(next)) updateLine(index, { discountPercent: next })
                    }}
                  />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`financial_pl-line-tax-${index}`}>
                  {t('financial_pl.lines.taxRate', 'VAT rate (%)')}
                </label>
                {marginMode ? (
                  <span className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-sm">
                    {t('financial_pl.lines.marginVatLabel', 'margin')}
                  </span>
                ) : null}
                {!marginMode ? (
                  <>
                    <Select
                      value={isOtherVat ? OTHER_OPTION : (matchedVat ?? '')}
                      disabled={busy}
                      onValueChange={(next) => {
                        const nextTaxRate = next === OTHER_OPTION ? '' : next
                        const numericTaxRate = Number(nextTaxRate || 0)
                        const patch: Partial<InvoiceLineInput> = { taxRate: nextTaxRate }
                        if (effectivePriceMode === 'gross') {
                          patch.unitPriceNet = deriveNetFromGross(line.unitPriceGross ?? '', numericTaxRate)
                        } else {
                          patch.unitPriceGross = deriveGrossFromNet(line.unitPriceNet, numericTaxRate)
                        }
                        updateLine(index, patch)
                      }}
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
                        onChange={(event) => {
                          const nextTaxRate = normalizeDecimalInput(event.target.value)
                          const numericTaxRate = Number(nextTaxRate || 0)
                          const patch: Partial<InvoiceLineInput> = { taxRate: nextTaxRate }
                          if (effectivePriceMode === 'gross') {
                            patch.unitPriceNet = deriveNetFromGross(line.unitPriceGross ?? '', numericTaxRate)
                          } else {
                            patch.unitPriceGross = deriveGrossFromNet(line.unitPriceNet, numericTaxRate)
                          }
                          updateLine(index, patch)
                        }}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              <span>
                {t('financial_pl.lines.totalNet', 'Net')}: {totals.totalNetAmount || '—'} {currencyCode}
              </span>
              <span>
                {t('financial_pl.lines.unitPriceNet', 'Unit price (net)')}: {normalizedLine.unitPriceNet || '—'} {currencyCode}
              </span>
              <span>
                {t('financial_pl.lines.taxAmount', 'VAT')}: {marginMode ? t('financial_pl.lines.marginVatLabel', 'margin') : (totals.taxAmount || '—')} {marginMode ? '' : currencyCode}
              </span>
              <span>
                {t('financial_pl.lines.totalGross', 'Gross')}: {totals.totalGrossAmount || '—'} {currencyCode}
              </span>
            </div>
          </div>
        )
      })}
      {discountTotal > 0 ? (
        <div className="flex justify-end text-sm text-muted-foreground">
          <span>
            {t('financial_pl.lines.discountTotal', 'Total discount')}: {toMoney(discountTotal)} {currencyCode}
          </span>
        </div>
      ) : null}
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
