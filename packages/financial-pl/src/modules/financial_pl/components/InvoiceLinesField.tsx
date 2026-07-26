'use client'

import * as React from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Button } from '@open-mercato/ui/primitives/button'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
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
import { Popover, PopoverContent, PopoverTrigger } from '@open-mercato/ui/primitives/popover'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
import { normalizeDecimalInput } from '../lib/pl-format'
import { GTU_CODES, type GtuCode } from '../lib/jpk-markings-codes'

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


/** GTU codes recorded on a line (stored in its metadata). */
export function lineGtuCodes(line: InvoiceLineInput): GtuCode[] {
  const raw = (line.metadata as Record<string, unknown> | null | undefined)?.gtuCodes
  if (!Array.isArray(raw)) return []
  return raw.filter((code): code is GtuCode => (GTU_CODES as readonly string[]).includes(String(code)))
}

/** Union of every line's GTU codes — what actually gets filed on the invoice. */
export function collectLineGtuCodes(lines: InvoiceLineInput[]): GtuCode[] {
  const seen = new Set<GtuCode>()
  for (const line of lines) for (const code of lineGtuCodes(line)) seen.add(code)
  return GTU_CODES.filter((code) => seen.has(code))
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
  /** Submit-time errors keyed as `line.<index>.<field>`, so the offending cell is marked. */
  errors?: Record<string, string>
  value: InvoiceLineInput[]
  onChange: (next: InvoiceLineInput[]) => void
  currencyCode: string
  disabled?: boolean
  priceMode?: PriceMode
  onPriceModeChange?: (next: PriceMode) => void
  /**
   * Values this row started from, matched by index. When supplied, a line whose gross has moved
   * shows the previous figure beside the new one — on a correction the reader needs the change,
   * not just the result. Omitted on a plain invoice, where there is nothing to compare against.
   */
  originalLines?: InvoiceLineInput[]
  marginScheme?: MarginScheme | null
}

// Matches the field-label style used across the invoice form (PlVatMetaForm, CrudForm builtins).
// These were 12px muted while the section above them used 14px foreground, so the same form showed
// two different label treatments depending on which component rendered the field.
const labelClass = 'text-sm font-medium text-foreground'
/** Per-line labels are redundant once the shared column header is visible, but must stay for
 *  screen readers and for the stacked (narrow) layout where there is no header row. */
const lineLabelClass = 'text-sm font-medium text-foreground @xl:sr-only'

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
  originalLines,
  marginScheme,
  errors,
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

  const toggleLineGtu = (index: number, code: GtuCode, checked: boolean) => {
    const line = value[index]
    if (!line) return
    const current = new Set(lineGtuCodes(line))
    if (checked) current.add(code)
    else current.delete(code)
    const next = GTU_CODES.filter((c) => current.has(c))
    const metadata = { ...(line.metadata ?? {}) }
    if (next.length > 0) metadata.gtuCodes = next
    else delete metadata.gtuCodes
    updateLine(index, { metadata: Object.keys(metadata).length > 0 ? metadata : null })
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
    // `@container` establishes the query context every `@xl:` class below depends on. Without it
    // the whole table layout was dead code: the row stacked at every width, including full screen.
    <div className="@container flex flex-col gap-3">
      {/* Label beside the control, not pushed to opposite ends of the row — at full width the
          two drifted so far apart they stopped reading as one field. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className={labelClass}>{t('financial_pl.lines.priceMode', 'Prices')}</span>
        {/*
          DS SegmentedControl — this is mutually-exclusive view state, which is exactly what the
          primitive is for; the previous hand-rolled pair of Buttons in a bordered box reimplemented
          it and drifted from the DS. Squared per the house no-full-pill rule.
        */}
        <SegmentedControl
          value={effectivePriceMode}
          onValueChange={(next) => setPriceMode(next as PriceMode)}
          disabled={busy || marginMode}
          aria-label={t('financial_pl.lines.priceMode', 'Prices')}
          className="rounded-md"
        >
          <SegmentedControlItem value="net" className="rounded">
            {t('financial_pl.lines.priceModeNet', 'net')}
          </SegmentedControlItem>
          <SegmentedControlItem value="gross" className="rounded">
            {t('financial_pl.lines.priceModeGross', 'gross')}
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
      {/* One bordered container with a header band and row separators — the fields were readable
          individually but did not read as a TABLE, which is what a line editor is. */}
      <div className="overflow-hidden rounded-md border border-border/60">
      {/* Shared column header — replaces the label repeated on every line, which is what made the
          editor so tall. Hidden when the row stacks, where each field keeps its own label. */}
      {value.length > 0 ? (
        <div className="hidden grid-cols-2 gap-x-3 gap-y-2 @xl:grid-cols-[auto_minmax(0,2.5fr)_repeat(5,minmax(0,1fr))_auto] @xl:items-start border-b border-border/60 bg-muted/50 px-3 py-2 @xl:grid">
          <span className="w-6" />
          <span className="text-xs font-medium text-muted-foreground">
            {t('financial_pl.lines.name', 'Name')}
            <span aria-hidden="true" className="text-status-error-text"> *</span>
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            {t('financial_pl.lines.quantity', 'Quantity')}
            <span aria-hidden="true" className="text-status-error-text"> *</span>
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            {t('financial_pl.lines.quantityUnit', 'Unit')}
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            {/* Follows the net/gross switch. The per-line label already did, but it is `sr-only`
                in the table layout, so this shared header was the only visible one — hardcoded to
                "net", which made the switch look like it did nothing. */}
            {effectivePriceMode === 'gross'
              ? t('financial_pl.lines.unitPriceGross', 'Unit price (gross)')
              : t('financial_pl.lines.unitPriceNet', 'Unit price (net)')}
            <span aria-hidden="true" className="text-status-error-text"> *</span>
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            {t('financial_pl.lines.discountPercent', 'Discount %')}
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            {t('financial_pl.lines.taxRate', 'VAT rate (%)')}
          </span>
          <span className="w-9" />
        </div>
      ) : null}
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
        const lineError = (field: string) => errors?.[`line.${index}.${field}`]
        const selectedGtu = lineGtuCodes(line)
        return (
          <div key={index} className="flex flex-col gap-2 border-b border-border/60 p-3 last:border-b-0">
            {/* Numbered so the rows can be referred to — and so a correction's line order matches
                the numbering on the document it corrects. The number and the delete control share
                one band: they are both "this line" affordances, and giving each its own row cost
                two lines of height per position while leaving the delete button floating. */}
            <div className="-mx-3 -mt-3 flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 @xl:hidden">
              <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className="inline-flex size-5 items-center justify-center rounded bg-background text-[11px] font-semibold tabular-nums text-foreground">
                  {index + 1}
                </span>
                {t('financial_pl.lines.lineNumberShort', 'Item')}
              </span>
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={t('financial_pl.lines.remove', 'Remove line')}
                title={t('financial_pl.lines.remove', 'Remove line')}
                onClick={() => removeLine(index)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 @xl:grid-cols-[auto_minmax(0,2.5fr)_repeat(5,minmax(0,1fr))_auto] @xl:items-start">
              <span className="hidden w-6 shrink-0 text-xs tabular-nums text-muted-foreground @xl:block @xl:pt-2.5">
                {index + 1}.
              </span>
              <div className="col-span-2 flex flex-col gap-2 @xl:col-span-1">
                <label className={lineLabelClass} htmlFor={`financial_pl-line-product-${index}`}>
                  {t('financial_pl.lines.name', 'Name')}
                  <span aria-hidden="true" className="text-status-error-text"> *</span>
                </label>
                {lineError('name') ? (
                  <span className="order-last text-xs text-status-error-text">{lineError('name')}</span>
                ) : null}
                {/*
                  The DS ComboboxInput renders a bare <input> with no dropdown indicator, so nothing
                  told the user this field opens a product list. The chevron is an overlay (the
                  component takes no icon prop) and `[&_input]:pr-9` reserves room so a long product
                  name never runs underneath it.
                */}
                <div
                  data-invalid={lineError('name') ? 'true' : undefined}
                  className={`relative [&_input]:pr-9${
                    // ComboboxInput takes no `aria-invalid`, so the invalid border is applied to the
                    // input it renders — same look the DS Input gives its own invalid state.
                    lineError('name') ? ' [&_input]:border-destructive' : ''
                  }`}
                >
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
                  <ChevronDown
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 top-[1.125rem] size-4 -translate-y-1/2 text-muted-foreground"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <label className={lineLabelClass} htmlFor={`financial_pl-line-qty-${index}`}>
                  {t('financial_pl.lines.quantity', 'Quantity')}
                  <span aria-hidden="true" className="text-status-error-text"> *</span>
                </label>
                <Input
                  id={`financial_pl-line-qty-${index}`}
                  inputMode="decimal"
                  value={line.quantity}
                  disabled={busy}
                  aria-invalid={lineError('quantity') ? true : undefined}
                  onChange={(event) => updateLine(index, { quantity: normalizeDecimalInput(event.target.value) })}
                />
                {lineError('quantity') ? (
                  <span className="text-xs text-status-error-text">{lineError('quantity')}</span>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <label className={lineLabelClass} htmlFor={`financial_pl-line-unit-${index}`}>
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
                  {/* Capped: the DS default is the full available viewport height, which inside a
                      tall modal let this 14-item list cover the entire dialog. */}
                  <SelectContent className="max-h-60">
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
              <div className="flex flex-col gap-2">
                <label className={lineLabelClass} htmlFor={`financial_pl-line-price-${index}`}>
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
                    aria-invalid={lineError('unitPrice') ? true : undefined}
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
                {lineError('unitPrice') ? (
                  <span className="text-xs text-status-error-text">{lineError('unitPrice')}</span>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <label className={lineLabelClass} htmlFor={`financial_pl-line-discount-${index}`}>
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
              <div className="flex flex-col gap-2">
                <label className={lineLabelClass} htmlFor={`financial_pl-line-tax-${index}`}>
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
              {/* Last column of the wide row — deleting is a row-level action, so it sits at the
                  end of the row it deletes. When the row stacks it moves into the header band. */}
              <div className="hidden @xl:flex @xl:justify-center @xl:pt-1">
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t('financial_pl.lines.remove', 'Remove line')}
                  title={t('financial_pl.lines.remove', 'Remove line')}
                  onClick={() => removeLine(index)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            {/*
              Line totals as a distinct strip rather than four grey captions: these are the numbers
              the operator checks before filing, so they get their own surface, right-aligned figures
              and a bold gross — the same weighting the printed document uses.
            */}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                {t('financial_pl.lines.gtu', 'GTU')}
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="sm" disabled={busy}>
                    {selectedGtu.length > 0
                      ? selectedGtu.join(', ')
                      : t('financial_pl.lines.gtuNone', 'None')}
                    <ChevronDown className="ml-1 size-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="max-h-72 w-80 overflow-y-auto p-2">
                  <div className="flex flex-col gap-1">
                    {GTU_CODES.map((code) => (
                      <CheckboxField
                        key={code}
                        label={t(`financial_pl.fields.gtu.${code}`, code)}
                        checked={selectedGtu.includes(code)}
                        onCheckedChange={(next) => toggleLineGtu(index, code, Boolean(next))}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/50 p-3 sm:grid-cols-4">
              <span className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {t('financial_pl.lines.totalNet', 'Net')}
                </span>
                <span className="text-sm tabular-nums text-foreground">
                  {totals.totalNetAmount || '—'} {currencyCode}
                </span>
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {t('financial_pl.lines.discountAmount', 'Discount')}
                </span>
                <span className="text-sm tabular-nums text-foreground">
                  {totals.discountAmount || '—'} {currencyCode}
                </span>
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {t('financial_pl.lines.taxAmount', 'VAT')}
                </span>
                <span className="text-sm tabular-nums text-foreground">
                  {marginMode ? t('financial_pl.lines.marginVatLabel', 'margin') : (totals.taxAmount || '—')}{' '}
                  {marginMode ? '' : currencyCode}
                </span>
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {t('financial_pl.lines.totalGross', 'Gross')}
                </span>
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {totals.totalGrossAmount || '—'} {currencyCode}
                </span>
                {(() => {
                  const previous = originalLines?.[index]?.totalGrossAmount
                  if (!previous || !totals.totalGrossAmount) return null
                  if (Number(previous) === Number(totals.totalGrossAmount)) return null
                  return (
                    <span className="text-xs tabular-nums text-muted-foreground line-through">
                      {/* toMoney: the stored value carries the DB's 4 decimals ("615.0000"), which
                          would sit next to the 2-decimal figure above it. */}
                      {toMoney(Number(previous))} {currencyCode}
                    </span>
                  )
                })()}
              </span>
            </div>
          </div>
        )
      })}
      </div>
      {discountTotal > 0 ? (
        <div className="flex justify-end text-sm text-muted-foreground">
          <span>
            {t('financial_pl.lines.discountTotal', 'Total discount')}: {toMoney(discountTotal)} {currencyCode}
          </span>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={busy} onClick={addLine}>
          <Plus className="mr-1 size-4" />
          {t('financial_pl.lines.add', 'Add line')}
        </Button>
      </div>
    </div>
  )
}

export default InvoiceLinesField
