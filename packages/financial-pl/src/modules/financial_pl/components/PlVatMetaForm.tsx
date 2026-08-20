'use client'

import * as React from 'react'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { SwitchField } from '@open-mercato/ui/primitives/switch-field'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@open-mercato/ui/primitives/accordion'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { isValidPolishNip } from '../lib/nip'
import { normalizeNipDigits } from '../lib/company-lookup'
import { normalizeDecimalInput } from '../lib/pl-format'
import { IsoDatePicker } from './IsoDatePicker'
import {
  GTU_CODES,
  JPK_PROCEDURE_MARKINGS,
  JPK_TYP_DOKUMENTU,
  type GtuCode,
  type JpkProcedureMarking,
  type JpkTypDokumentu,
} from '../lib/jpk-markings-codes'
import type {
  AdvanceInvoiceRef,
  AdvancePaymentSnapshot,
  InvoiceKindColumn,
  OrderLineSnapshot,
  OrderSnapshot,
} from '../data/entities'
import { isAdvanceInvoiceKind } from '../data/validators'

/** Procedure-markings flag map (one optional boolean per JPK procedure code). */
export type ProcedureMarkings = Partial<Record<JpkProcedureMarking, boolean>>
export type MarginScheme = 'travel' | 'used_goods' | 'art' | 'collectibles'
export type MarginVatRate = 0 | 5 | 8 | 23

/**
 * Controlled value shape for the PL-VAT metadata form. Mirrors the form-renderable
 * fields of `invoiceMetaPutSchema` (the page owns `salesInvoiceId` + persistence).
 */
export type InvoiceMeta = {
  contextNip?: string | null
  mppRequired?: boolean
  issuedOutsideKsef?: boolean
  vatExemptionBasis?: string | null
  invoiceKind?: InvoiceKindColumn
  selfBilling?: boolean
  reverseCharge?: boolean
  ossProcedure?: boolean
  consumptionCountryCode?: string | null
  exchangeRate?: string | null
  exchangeRateDate?: string | null
  advancePayments?: AdvancePaymentSnapshot[]
  advanceRefs?: AdvanceInvoiceRef[]
  orderSnapshot?: OrderSnapshot | null
  gtuCodes?: GtuCode[]
  procedureMarkings?: ProcedureMarkings
  typDokumentu?: JpkTypDokumentu | null
  marginScheme?: MarginScheme | null
  marginPurchaseCost?: string | null
  marginVatRate?: MarginVatRate | null
  badDebtReliefPeriod?: string | null
  badDebtTerminPlatnosci?: string | null
}

const INVOICE_KINDS: readonly InvoiceKindColumn[] = ['vat', 'zal', 'roz', 'upr', 'kor_zal', 'kor_roz']

// EU consumption countries available for an OSS distance sale (ISO alpha-2). PL is
// excluded — an OSS line is by definition taxed in another member state.
const OSS_CONSUMPTION_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'EL', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const

const NONE_VALUE = '__none__'
const MARGIN_VAT_RATES: readonly MarginVatRate[] = [23, 8, 5, 0]
const MARGIN_SCHEME_TO_PROCEDURE = {
  travel: 'MR_T',
  used_goods: 'MR_UZ',
  art: 'MR_UZ',
  collectibles: 'MR_UZ',
} as const satisfies Record<MarginScheme, JpkProcedureMarking>

const labelClass = 'text-sm font-medium text-foreground'
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export type PlVatMetaFormProps = {
  value: InvoiceMeta
  onChange: (next: InvoiceMeta) => void
  disabled?: boolean
  currencyCode?: string
  taxPointDate?: string
  /**
   * Hide the taxpayer-NIP field. Set on the invoice detail view, where the invoice document beside
   * this panel already states the seller's NIP — repeating it here just makes the reader check
   * whether the two values differ.
   */
  hideContextNip?: boolean
  /**
   * Hide the invoice-kind select. The kind decides what the rest of the invoice even means, so the
   * form promotes it to the top of the first tab and renders it there instead of here.
   */
  hideInvoiceKind?: boolean
}

type NbpLookupState = 'idle' | 'loading' | 'unavailable'

type NbpRateLookupResult =
  | { ok: true; currency: string; rate: string; tableDate: string }
  | { ok: false; reason: 'invalid_currency' | 'unavailable' | 'not_found' }

function computePlVatAccordionOpenSections(value: InvoiceMeta, includeFx: boolean): string[] {
  const open: string[] = []

  if (includeFx && (value.exchangeRate || value.exchangeRateDate)) open.push('fx')
  if (
    (value.advancePayments?.length ?? 0) > 0 ||
    (value.advanceRefs?.length ?? 0) > 0 ||
    value.orderSnapshot != null ||
    isAdvanceInvoiceKind(value.invoiceKind)
  ) {
    open.push('advance')
  }
  if (
    (value.gtuCodes?.length ?? 0) > 0 ||
    Object.values(value.procedureMarkings ?? {}).some(Boolean) ||
    value.marginScheme ||
    value.marginPurchaseCost ||
    value.marginVatRate != null ||
    value.typDokumentu
  ) {
    open.push('jpk')
  }
  if (value.badDebtReliefPeriod || value.badDebtTerminPlatnosci || value.vatExemptionBasis) {
    open.push('adjustments')
  }

  return open
}

export function applyMarginSchemeToMeta(value: InvoiceMeta, marginScheme: MarginScheme | null): InvoiceMeta {
  const procedureMarkings: ProcedureMarkings = { ...(value.procedureMarkings ?? {}) }
  procedureMarkings.MR_T = false
  procedureMarkings.MR_UZ = false
  if (marginScheme) procedureMarkings[MARGIN_SCHEME_TO_PROCEDURE[marginScheme]] = true

  return {
    ...value,
    marginScheme,
    marginPurchaseCost: marginScheme ? value.marginPurchaseCost ?? null : null,
    marginVatRate: marginScheme ? value.marginVatRate ?? 23 : null,
    procedureMarkings,
  }
}

/**
 * Controlled PL-VAT metadata editor rendering the FULL `invoiceMetaPutSchema` field
 * set. Pure controlled component: the parent owns persistence (M8 — no internal
 * no-op retry / save mutation). DS tokens + `@open-mercato/ui` primitives only.
 */
export function PlVatMetaForm({
  value,
  onChange,
  disabled,
  currencyCode,
  taxPointDate,
  hideContextNip,
  hideInvoiceKind,
}: PlVatMetaFormProps) {
  const t = useT()
  const busy = Boolean(disabled)
  const normalizedCurrencyCode = (currencyCode ?? '').trim().toUpperCase()
  const showFxSection = normalizedCurrencyCode !== 'PLN'
  const [initiallyOpenSections] = React.useState<string[]>(() =>
    computePlVatAccordionOpenSections(value, showFxSection),
  )
  const [openSections, setOpenSections] = React.useState<string[]>(initiallyOpenSections)
  const [gtuFilter, setGtuFilter] = React.useState('')
  const [procedureFilter, setProcedureFilter] = React.useState('')
  const [nbpLookupState, setNbpLookupState] = React.useState<NbpLookupState>('idle')
  const accordionDataSectionsRef = React.useRef<readonly string[]>(initiallyOpenSections)
  const skipNextAccordionSyncRef = React.useRef(false)
  const valueRef = React.useRef(value)
  React.useEffect(() => {
    valueRef.current = value
  }, [value])

  const patch = React.useCallback(
    (next: Partial<InvoiceMeta>) => {
      skipNextAccordionSyncRef.current = true
      onChange({ ...valueRef.current, ...next })
    },
    [onChange],
  )

  React.useEffect(() => {
    const sectionsWithData = computePlVatAccordionOpenSections(value, showFxSection)
    const previousSectionsWithData = accordionDataSectionsRef.current
    accordionDataSectionsRef.current = sectionsWithData

    setOpenSections((current) => {
      let nextOpen = showFxSection ? current : current.filter((section) => section !== 'fx')
      let changed = nextOpen.length !== current.length

      if (!skipNextAccordionSyncRef.current) {
        for (const section of sectionsWithData) {
          if (!previousSectionsWithData.includes(section) && !nextOpen.includes(section)) {
            if (nextOpen === current) nextOpen = [...current]
            nextOpen.push(section)
            changed = true
          }
        }
      }

      return changed ? nextOpen : current
    })

    if (skipNextAccordionSyncRef.current) skipNextAccordionSyncRef.current = false
  }, [showFxSection, value])

  const invoiceKind = value.invoiceKind ?? 'vat'
  const advanceEditorEnabled = isAdvanceInvoiceKind(invoiceKind)
  const gtuCodes = value.gtuCodes ?? []
  const procedureMarkings = value.procedureMarkings ?? {}
  // Kept in the canonical JPK order rather than object-key order, so a read-only list always reads
  // the same way regardless of the order the flags happened to be written in.
  const selectedProcedures = JPK_PROCEDURE_MARKINGS.filter((code) => Boolean(procedureMarkings[code]))
  const marginScheme = value.marginScheme ?? null
  const advancePayments = value.advancePayments ?? []
  const advanceRefs = value.advanceRefs ?? []
  const normalizedTaxPointDate = (taxPointDate ?? '').trim()
  const marginSchemeRequiresPln = normalizedCurrencyCode !== '' && normalizedCurrencyCode !== 'PLN'
  const hasNbpCurrency = /^[A-Z]{3}$/.test(normalizedCurrencyCode)
  const hasNbpDate = DATE_ONLY_RE.test(normalizedTaxPointDate)
  const nbpInputsReady = hasNbpCurrency && normalizedCurrencyCode !== 'PLN' && hasNbpDate
  const nbpLookupBusy = nbpLookupState === 'loading'
  const nbpDisabledReason = !hasNbpCurrency
    ? t('financial_pl.fields.nbpMissingCurrency', 'Set the invoice currency first')
    : normalizedCurrencyCode === 'PLN'
      ? t('financial_pl.fields.nbpPlnSkipped', 'PLN invoices do not need an NBP rate')
      : !hasNbpDate
        ? t('financial_pl.fields.nbpMissingDate', 'Set the invoice issue date first')
        : undefined
  const nbpButtonTitle = nbpInputsReady
    ? t('financial_pl.fields.fetchNbpRate', 'Fetch NBP rate')
    : nbpDisabledReason
  const nbpInputsRef = React.useRef({ currency: normalizedCurrencyCode, date: normalizedTaxPointDate })
  const nbpRequestIdRef = React.useRef(0)

  React.useEffect(() => {
    nbpInputsRef.current = { currency: normalizedCurrencyCode, date: normalizedTaxPointDate }
    nbpRequestIdRef.current += 1
    setNbpLookupState('idle')
  }, [normalizedCurrencyCode, normalizedTaxPointDate])

  const fetchNbpRate = React.useCallback(async () => {
    if (busy || nbpLookupBusy || !nbpInputsReady) return

    const requestedCurrency = normalizedCurrencyCode
    const requestedDate = normalizedTaxPointDate
    const requestId = nbpRequestIdRef.current + 1
    nbpRequestIdRef.current = requestId
    setNbpLookupState('loading')

    try {
      const res = await apiCall<NbpRateLookupResult>(
        `/api/financial_pl/ksef/nbp-rate?currency=${encodeURIComponent(requestedCurrency)}&date=${encodeURIComponent(requestedDate)}`,
      )
      const latest = nbpInputsRef.current
      if (
        nbpRequestIdRef.current !== requestId ||
        latest.currency !== requestedCurrency ||
        latest.date !== requestedDate
      ) {
        return
      }

      if (res.ok && res.result?.ok) {
        patch({ exchangeRate: res.result.rate, exchangeRateDate: res.result.tableDate })
        setNbpLookupState('idle')
        return
      }

      setNbpLookupState('unavailable')
    } catch {
      if (nbpRequestIdRef.current === requestId) setNbpLookupState('unavailable')
    }
  }, [busy, nbpInputsReady, nbpLookupBusy, normalizedCurrencyCode, normalizedTaxPointDate, patch])

  const toggleGtu = (code: GtuCode, next: boolean) => {
    const set = new Set(gtuCodes)
    if (next) set.add(code)
    else set.delete(code)
    patch({ gtuCodes: Array.from(set) })
  }

  const toggleProcedure = (code: JpkProcedureMarking, next: boolean) => {
    patch({ procedureMarkings: { ...procedureMarkings, [code]: next } })
  }

  const updateAdvancePayment = (index: number, next: Partial<AdvancePaymentSnapshot>) => {
    patch({
      advancePayments: advancePayments.map((row, i) => (i === index ? { ...row, ...next } : row)),
    })
  }
  const addAdvancePayment = () => {
    patch({ advancePayments: [...advancePayments, { receivedDate: '', amount: '' }] })
  }
  const removeAdvancePayment = (index: number) => {
    patch({ advancePayments: advancePayments.filter((_, i) => i !== index) })
  }

  const updateAdvanceRef = (index: number, next: Partial<AdvanceInvoiceRef>) => {
    patch({
      advanceRefs: advanceRefs.map((row, i) => (i === index ? { ...row, ...next } : row)),
    })
  }
  const addAdvanceRef = () => {
    patch({ advanceRefs: [...advanceRefs, {}] })
  }
  const removeAdvanceRef = (index: number) => {
    patch({ advanceRefs: advanceRefs.filter((_, i) => i !== index) })
  }

  // --- Order snapshot (ZAL / KOR_ZAL → FA(3) `Zamowienie`) -----------------------------------
  const orderSnapshot = value.orderSnapshot ?? null
  const orderLines: OrderLineSnapshot[] = orderSnapshot?.lines ?? []

  const patchOrderSnapshot = (next: Partial<OrderSnapshot>) => {
    const base: OrderSnapshot = orderSnapshot ?? { totalValue: '', lines: [] }
    patch({ orderSnapshot: { ...base, ...next } })
  }
  const enableOrderSnapshot = (next: boolean) => {
    patch({ orderSnapshot: next ? orderSnapshot ?? { totalValue: '', lines: [] } : null })
  }
  const updateOrderLine = (index: number, next: Partial<OrderLineSnapshot>) => {
    patchOrderSnapshot({ lines: orderLines.map((row, i) => (i === index ? { ...row, ...next } : row)) })
  }
  const addOrderLine = () => {
    patchOrderSnapshot({ lines: [...orderLines, { name: '' }] })
  }
  const removeOrderLine = (index: number) => {
    patchOrderSnapshot({ lines: orderLines.filter((_, i) => i !== index) })
  }

  // Inline taxpayer-NIP checksum feedback (parity with the buyer NIP field) — flag any non-empty value
  // that isn't a valid NIP at the field, not only via a form-level error on submit (code-jury, DeepSeek).
  const contextNipInvalid =
    (value.contextNip ?? '').trim().length > 0 && !isValidPolishNip(normalizeNipDigits(value.contextNip ?? ''))

  // Inline FX-rate validation — a non-empty exchange rate must be a positive number (parity with the
  // other numeric fields; a garbage rate would otherwise silently break the PLN-converted VAT).
  const exchangeRateRaw = (value.exchangeRate ?? '').trim()
  const exchangeRateNum = Number(exchangeRateRaw)
  const exchangeRateInvalid = exchangeRateRaw.length > 0 && !(Number.isFinite(exchangeRateNum) && exchangeRateNum > 0)

  return (
    // `@container`: this panel renders both full-width (edit form) and in a ~40% column
    // (invoice detail). Viewport `sm:` split fields into two columns even when the column was far
    // too narrow, colliding the NBP button with the date field. Container queries size to the
    // space actually available.
    // `@container` and `@3xl:` must not sit on the same element: a container sizes its DESCENDANTS,
    // so the grid classes here would have resolved against some ancestor container instead (there is
    // none), leaving the layout stuck at one column. The grid lives one level in.
    <div className="@container">
      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-2 @3xl:items-start">
      <div className="flex flex-col gap-2">
      {hideContextNip ? null : (
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-context-nip">
            {t('financial_pl.fields.contextNip', 'Taxpayer NIP')}
          </label>
          <Input
            id="financial_pl-context-nip"
            inputMode="numeric"
            value={value.contextNip ?? ''}
            disabled={busy}
            onChange={(event) => patch({ contextNip: event.target.value.length ? event.target.value : null })}
            placeholder="1234567890"
            aria-invalid={contextNipInvalid || undefined}
          />
          {contextNipInvalid ? (
            <span className="text-xs text-status-error-text">
              {t('financial_pl.validation.nipChecksumTaxpayer', 'The taxpayer NIP is invalid (checksum failed).')}
            </span>
          ) : null}
        </div>
      )}

      {hideInvoiceKind ? null : (
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-invoice-kind">
            {t('financial_pl.fields.invoiceKind', 'Invoice kind')}
          </label>
          <Select
            value={invoiceKind}
            onValueChange={(next) => patch({ invoiceKind: (next as InvoiceKindColumn) || 'vat' })}
            disabled={busy}
          >
            <SelectTrigger id="financial_pl-invoice-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVOICE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`financial_pl.invoiceKind.${kind}`, kind.toUpperCase())}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/*
        These five flags were a flat stack on the section's own `gap-2`, so the rows touched and
        read as one block of text with switches attached. A divided list gives each flag its own
        row with real vertical padding — the same treatment the rest of the form gives a field.
      */}
      <div className="flex flex-col gap-3">
        <SwitchField
          label={t('financial_pl.fields.mppRequired', 'Split payment (MPP) required')}
          checked={Boolean(value.mppRequired)}
          disabled={busy}
          onCheckedChange={(next) => patch({ mppRequired: Boolean(next) })}
        />

        <SwitchField
          label={t('financial_pl.fields.issuedOutsideKsef', 'Issued outside KSeF')}
          checked={Boolean(value.issuedOutsideKsef)}
          disabled={busy}
          onCheckedChange={(next) => patch({ issuedOutsideKsef: Boolean(next) })}
        />

        <SwitchField
          label={t('financial_pl.fields.selfBilling', 'Self-billing (samofakturowanie)')}
          checked={Boolean(value.selfBilling)}
          disabled={busy}
          onCheckedChange={(next) => patch({ selfBilling: Boolean(next) })}
        />

        <SwitchField
          label={t('financial_pl.fields.reverseCharge', 'Reverse charge')}
          checked={Boolean(value.reverseCharge)}
          disabled={busy}
          onCheckedChange={(next) => patch({ reverseCharge: Boolean(next) })}
        />

        <SwitchField
          label={t('financial_pl.fields.ossProcedure', 'OSS / WSTO_EE distance sale')}
          checked={Boolean(value.ossProcedure)}
          disabled={busy}
          onCheckedChange={(next) =>
            patch({ ossProcedure: Boolean(next), consumptionCountryCode: next ? value.consumptionCountryCode ?? null : null })
          }
        />
      </div>

      {value.ossProcedure ? (
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-consumption-country">
            {t('financial_pl.fields.consumptionCountry', 'Consumption country (OSS)')}
          </label>
          <ComboboxInput
            value={value.consumptionCountryCode ?? ''}
            onChange={(next) => patch({ consumptionCountryCode: next ? next : null })}
            suggestions={OSS_CONSUMPTION_COUNTRIES as readonly string[] as string[]}
            disabled={busy}
            placeholder={t('financial_pl.fields.consumptionCountryPlaceholder', 'Search country…')}
          />
        </div>
      ) : null}

      </div>

      <Accordion
        type="multiple"
        defaultValue={initiallyOpenSections}
        value={openSections}
        onValueChange={(next) => setOpenSections(next)}
        className="flex flex-col gap-3"
      >
        {showFxSection ? (
          <AccordionItem value="fx" variant="card">
            <AccordionTrigger triggerIcon="chevron">
              {t('financial_pl.invoices.plvat.section.fx', 'Foreign currency (FX)')}
            </AccordionTrigger>
            <AccordionContent>
              <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
                {/*
                  Own container: the row below must break against THIS cell's width, not the
                  form's. Both queries used to resolve against the same outer container, so once
                  the grid split into two columns at `@sm` the cell was only ~half that width
                  while the row still went horizontal at `@md` — which clipped the NBP button and
                  then hid it behind the date field between ~450px and ~900px (QA #51).
                */}
                <div className="@container flex flex-col gap-2">
                  <label className={labelClass} htmlFor="financial_pl-exchange-rate">
                    {t('financial_pl.fields.exchangeRate', 'Exchange rate (to PLN)')}
                  </label>
                  <div className="flex flex-col gap-1 @md:flex-row">
                    <Input
                      id="financial_pl-exchange-rate"
                      inputMode="decimal"
                      value={value.exchangeRate ?? ''}
                      disabled={busy}
                      aria-invalid={exchangeRateInvalid || undefined}
                      onChange={(event) => {
                        const next = normalizeDecimalInput(event.target.value)
                        patch({ exchangeRate: next.length ? next : null })
                        if (nbpLookupState !== 'idle') setNbpLookupState('idle')
                      }}
                      placeholder="4.3210"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 whitespace-nowrap"
                      disabled={busy || nbpLookupBusy || !nbpInputsReady}
                      title={nbpButtonTitle}
                      onClick={() => void fetchNbpRate()}
                    >
                      {nbpLookupBusy ? (
                        <Loader2 className="mr-1 size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1 size-4" />
                      )}
                      {t('financial_pl.fields.fetchNbpRate', 'Fetch NBP rate')}
                    </Button>
                  </div>
                  {nbpLookupState === 'unavailable' ? (
                    <span className="text-xs text-muted-foreground">
                      {t('financial_pl.fields.nbpUnavailable', 'NBP rate unavailable — enter manually')}
                    </span>
                  ) : null}
                  {exchangeRateInvalid ? (
                    <span className="text-xs text-status-error-text">
                      {t('financial_pl.validation.exchangeRate', 'Enter a positive exchange rate.')}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2">
                  <label className={labelClass} htmlFor="financial_pl-exchange-rate-date">
                    {t('financial_pl.fields.exchangeRateDate', 'Exchange rate date')}
                  </label>
                  <IsoDatePicker
                    id="financial_pl-exchange-rate-date"
                    value={value.exchangeRateDate}
                    disabled={busy}
                    onChange={(next) => patch({ exchangeRateDate: next.length ? next : null })}
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        ) : null}

        <AccordionItem value="advance" variant="card">
          <AccordionTrigger triggerIcon="chevron">
            {t('financial_pl.invoices.plvat.section.advance', 'Advance & settlement (ZAL/ROZ)')}
          </AccordionTrigger>
          <AccordionContent>
            {advanceEditorEnabled ? (
              <div className="flex flex-col gap-2">
              <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
                <legend className="px-1 text-sm font-medium text-foreground">
                  {t('financial_pl.fields.advancePaymentsGroup', 'Advance payments (ZAL)')}
                </legend>
                {advancePayments.map((row, index) => (
                  <div key={index} className="flex items-end gap-4">
                    <div className="flex flex-1 flex-col gap-4">
                      <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-date-${index}`}>
                        {t('financial_pl.fields.advanceReceivedDate', 'Received date')}
                      </label>
                      <IsoDatePicker
                        id={`financial_pl-advance-date-${index}`}
                        value={row.receivedDate}
                        disabled={busy}
                        onChange={(next) => updateAdvancePayment(index, { receivedDate: next })}
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-4">
                      <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-amount-${index}`}>
                        {t('financial_pl.fields.advanceAmount', 'Amount')}
                      </label>
                      <Input
                        id={`financial_pl-advance-amount-${index}`}
                        inputMode="decimal"
                        value={row.amount}
                        disabled={busy}
                        onChange={(event) => updateAdvancePayment(index, { amount: event.target.value })}
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-4">
                      <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-fx-${index}`}>
                        {t('financial_pl.fields.advanceFxRate', 'FX rate')}
                      </label>
                      <Input
                        id={`financial_pl-advance-fx-${index}`}
                        inputMode="decimal"
                        value={row.fxRate ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          updateAdvancePayment(index, { fxRate: event.target.value.length ? event.target.value : undefined })
                        }
                      />
                    </div>
                    <IconButton
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('financial_pl.actions.removeAdvancePayment', 'Remove advance payment')}
                      title={t('financial_pl.actions.removeAdvancePayment', 'Remove advance payment')}
                      onClick={() => removeAdvancePayment(index)}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                ))}
                <div className="flex">
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={addAdvancePayment}>
                    <Plus className="mr-1 size-4" />
                    {t('financial_pl.actions.addAdvancePayment', 'Add advance payment')}
                  </Button>
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
                <legend className="px-1 text-sm font-medium text-foreground">
                  {t('financial_pl.fields.advanceRefsGroup', 'Advance invoice references (ROZ)')}
                </legend>
                {advanceRefs.map((row, index) => (
                  <div key={index} className="flex items-end gap-4">
                    <div className="flex flex-1 flex-col gap-4">
                      <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-ksef-${index}`}>
                        {t('financial_pl.fields.advanceRefKsefNumber', 'KSeF number')}
                      </label>
                      <Input
                        id={`financial_pl-advance-ksef-${index}`}
                        value={row.ksefNumber ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          updateAdvanceRef(index, { ksefNumber: event.target.value.length ? event.target.value : undefined })
                        }
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-4">
                      <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-invoice-${index}`}>
                        {t('financial_pl.fields.advanceRefInvoiceNumber', 'Invoice number')}
                      </label>
                      <Input
                        id={`financial_pl-advance-invoice-${index}`}
                        value={row.invoiceNumber ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          updateAdvanceRef(index, { invoiceNumber: event.target.value.length ? event.target.value : undefined })
                        }
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-4">
                      <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-ref-amount-${index}`}>
                        {t('financial_pl.fields.advanceRefAmount', 'Amount')}
                      </label>
                      <Input
                        id={`financial_pl-advance-ref-amount-${index}`}
                        inputMode="decimal"
                        value={row.amount ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          updateAdvanceRef(index, { amount: event.target.value.length ? event.target.value : undefined })
                        }
                      />
                    </div>
                    <IconButton
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('financial_pl.actions.removeAdvanceRef', 'Remove advance reference')}
                      title={t('financial_pl.actions.removeAdvanceRef', 'Remove advance reference')}
                      onClick={() => removeAdvanceRef(index)}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                ))}
                <div className="flex">
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={addAdvanceRef}>
                    <Plus className="mr-1 size-4" />
                    {t('financial_pl.actions.addAdvanceRef', 'Add advance reference')}
                  </Button>
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
                <legend className="px-1 text-sm font-medium text-foreground">
                  {t('financial_pl.fields.orderSnapshotGroup', 'Order snapshot (ZAL / KOR_ZAL)')}
                </legend>
                <SwitchField
                  label={t('financial_pl.fields.orderSnapshotEnabled', 'Attach an order snapshot (FA(3) Zamówienie)')}
                  checked={orderSnapshot != null}
                  disabled={busy}
                  onCheckedChange={(next) => enableOrderSnapshot(Boolean(next))}
                />
                {orderSnapshot != null ? (
                  <>
                    <div className="flex flex-col gap-2">
                      <label className={labelClass} htmlFor="financial_pl-order-total">
                        {t('financial_pl.fields.orderTotalValue', 'Order total value')}
                      </label>
                      <Input
                        id="financial_pl-order-total"
                        inputMode="decimal"
                        value={orderSnapshot.totalValue}
                        disabled={busy}
                        onChange={(event) => patchOrderSnapshot({ totalValue: event.target.value })}
                        placeholder="1230.00"
                      />
                    </div>
                    {orderLines.map((row, index) => (
                      <div
                        key={index}
                        className="flex flex-col gap-2 rounded-md border border-border p-2 @md:flex-row @md:items-end"
                      >
                        <div className="flex flex-[2] flex-col gap-4">
                          <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-order-line-name-${index}`}>
                            {t('financial_pl.fields.orderLineName', 'Name')}
                          </label>
                          <Input
                            id={`financial_pl-order-line-name-${index}`}
                            value={row.name}
                            disabled={busy}
                            onChange={(event) => updateOrderLine(index, { name: event.target.value })}
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-4">
                          <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-order-line-qty-${index}`}>
                            {t('financial_pl.fields.orderLineQuantity', 'Quantity')}
                          </label>
                          <Input
                            id={`financial_pl-order-line-qty-${index}`}
                            inputMode="decimal"
                            value={row.quantity ?? ''}
                            disabled={busy}
                            onChange={(event) =>
                              updateOrderLine(index, { quantity: event.target.value.length ? event.target.value : undefined })
                            }
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-4">
                          <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-order-line-price-${index}`}>
                            {t('financial_pl.fields.orderLineUnitPrice', 'Unit price')}
                          </label>
                          <Input
                            id={`financial_pl-order-line-price-${index}`}
                            inputMode="decimal"
                            value={row.unitPrice ?? ''}
                            disabled={busy}
                            onChange={(event) =>
                              updateOrderLine(index, { unitPrice: event.target.value.length ? event.target.value : undefined })
                            }
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-4">
                          <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-order-line-net-${index}`}>
                            {t('financial_pl.fields.orderLineNetValue', 'Net value')}
                          </label>
                          <Input
                            id={`financial_pl-order-line-net-${index}`}
                            inputMode="decimal"
                            value={row.netValue ?? ''}
                            disabled={busy}
                            onChange={(event) =>
                              updateOrderLine(index, { netValue: event.target.value.length ? event.target.value : undefined })
                            }
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-4">
                          <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-order-line-vat-${index}`}>
                            {t('financial_pl.fields.orderLineVatRate', 'VAT rate')}
                          </label>
                          <Input
                            id={`financial_pl-order-line-vat-${index}`}
                            inputMode="decimal"
                            value={row.vatRate ?? ''}
                            disabled={busy}
                            onChange={(event) =>
                              updateOrderLine(index, { vatRate: event.target.value.length ? event.target.value : undefined })
                            }
                          />
                        </div>
                        <IconButton
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          aria-label={t('financial_pl.actions.removeOrderLine', 'Remove order line')}
                          title={t('financial_pl.actions.removeOrderLine', 'Remove order line')}
                          onClick={() => removeOrderLine(index)}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    ))}
                    <div className="flex">
                      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={addOrderLine}>
                        <Plus className="mr-1 size-4" />
                        {t('financial_pl.actions.addOrderLine', 'Add order line')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </fieldset>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t(
                  'financial_pl.invoices.form.advances.kindHint',
                  'Advance payments and order data are available only for ZAL/ROZ invoices and their corrections.',
                )}
              </p>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="jpk" variant="card">
          <AccordionTrigger triggerIcon="chevron">
            {t('financial_pl.invoices.plvat.section.jpk', 'JPK markings')}
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-2">
              <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
                <legend className="px-1 text-sm font-medium text-foreground">
                  {t('financial_pl.fields.marginScheme', 'Margin scheme')}
                </legend>
                <div className="flex flex-col gap-2">
                  <label className={labelClass} htmlFor="financial_pl-margin-scheme">
                    {t('financial_pl.fields.marginScheme', 'Margin scheme')}
                  </label>
                  <Select
                    value={marginScheme ?? NONE_VALUE}
                    disabled={busy || marginSchemeRequiresPln}
                    onValueChange={(next) =>
                      patch(applyMarginSchemeToMeta(value, next === NONE_VALUE ? null : (next as MarginScheme)))
                    }
                  >
                    <SelectTrigger id="financial_pl-margin-scheme" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>
                        {t('financial_pl.fields.marginScheme.none', 'None')}
                      </SelectItem>
                      <SelectItem value="travel">
                        {t('financial_pl.fields.marginScheme.travel', 'travel agencies')}
                      </SelectItem>
                      <SelectItem value="used_goods">
                        {t('financial_pl.fields.marginScheme.used_goods', 'second-hand goods')}
                      </SelectItem>
                      <SelectItem value="art">
                        {t('financial_pl.fields.marginScheme.art', 'works of art')}
                      </SelectItem>
                      <SelectItem value="collectibles">
                        {t('financial_pl.fields.marginScheme.collectibles', 'collectibles and antiques')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {marginSchemeRequiresPln ? (
                    <span className="text-xs text-muted-foreground">
                      {t('financial_pl.validation.marginSchemeRequiresPln', 'Margin-scheme invoices are available only in PLN.')}
                    </span>
                  ) : null}
                </div>
                {marginScheme ? (
                  <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <label className={labelClass} htmlFor="financial_pl-margin-purchase-cost">
                        {t('financial_pl.fields.marginPurchaseCost', 'Purchase cost (for JPK)')}
                      </label>
                      <Input
                        id="financial_pl-margin-purchase-cost"
                        inputMode="decimal"
                        value={value.marginPurchaseCost ?? ''}
                        disabled={busy}
                        onChange={(event) => {
                          const next = normalizeDecimalInput(event.target.value)
                          patch({ marginPurchaseCost: next.length ? next : null })
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className={labelClass} htmlFor="financial_pl-margin-vat-rate">
                        {t('financial_pl.fields.marginVatRate', 'VAT rate on margin')}
                      </label>
                      <Select
                        value={String(value.marginVatRate ?? 23)}
                        disabled={busy}
                        onValueChange={(next) => patch({ marginVatRate: Number(next) as MarginVatRate })}
                      >
                        <SelectTrigger id="financial_pl-margin-vat-rate" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MARGIN_VAT_RATES.map((rate) => (
                            <SelectItem key={rate} value={String(rate)}>
                              {rate}%
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : null}
              </fieldset>

              <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium text-foreground">
                  {t('financial_pl.fields.gtuGroup', 'GTU markings (JPK)')}
                </legend>
                {/*
                  Read-only: list only what was actually marked. Thirteen permanently-unchecked boxes
                  and a filter that cannot be used say nothing about THIS invoice — the reader only
                  needs the codes it carries.
                */}
                {busy ? (
                  gtuCodes.length > 0 ? (
                    <ul className="flex flex-col gap-1 text-sm text-foreground">
                      {gtuCodes.map((code) => (
                        <li key={code}>{t(`financial_pl.fields.gtu.${code}`, code)}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t('financial_pl.fields.noneSelected', 'None')}
                    </span>
                  )
                ) : (
                  <>
                    <Input
                      value={gtuFilter}
                      onChange={(event) => setGtuFilter(event.target.value)}
                      placeholder={t('financial_pl.fields.gtuFilter', 'Filter GTU codes…')}
                      aria-label={t('financial_pl.fields.gtuFilter', 'Filter GTU codes')}
                    />
                    <div className="grid grid-cols-2 gap-4 @sm:grid-cols-3">
                      {GTU_CODES.filter((code) => {
                        const q = gtuFilter.trim().toLowerCase()
                        if (!q || gtuCodes.includes(code)) return true
                        return code.toLowerCase().includes(q) || t(`financial_pl.fields.gtu.${code}`, code).toLowerCase().includes(q)
                      }).map((code) => (
                        <CheckboxField
                          key={code}
                          label={t(`financial_pl.fields.gtu.${code}`, code)}
                          checked={gtuCodes.includes(code)}
                          onCheckedChange={(next) => toggleGtu(code, Boolean(next))}
                        />
                      ))}
                    </div>
                  </>
                )}
              </fieldset>

              <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium text-foreground">
                  {t('financial_pl.fields.procedureGroup', 'JPK procedure markings')}
                </legend>
                {busy ? (
                  selectedProcedures.length > 0 ? (
                    <ul className="flex flex-col gap-1 text-sm text-foreground">
                      {selectedProcedures.map((code) => (
                        <li key={code}>{t(`financial_pl.fields.procedure.${code}`, code)}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t('financial_pl.fields.noneSelected', 'None')}
                    </span>
                  )
                ) : (
                  <>
                    <Input
                      value={procedureFilter}
                      onChange={(event) => setProcedureFilter(event.target.value)}
                      placeholder={t('financial_pl.fields.procedureFilter', 'Filter procedure markings…')}
                      aria-label={t('financial_pl.fields.procedureFilter', 'Filter procedure markings')}
                    />
                    <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
                      {JPK_PROCEDURE_MARKINGS.filter((code) => {
                        const q = procedureFilter.trim().toLowerCase()
                        if (!q || procedureMarkings[code]) return true
                        return code.toLowerCase().includes(q) || t(`financial_pl.fields.procedure.${code}`, code).toLowerCase().includes(q)
                      }).map((code) => (
                        <CheckboxField
                          key={code}
                          label={t(`financial_pl.fields.procedure.${code}`, code)}
                          checked={Boolean(procedureMarkings[code])}
                          onCheckedChange={(next) => toggleProcedure(code, Boolean(next))}
                        />
                      ))}
                    </div>
                  </>
                )}
              </fieldset>

              <div className="flex flex-col gap-2">
                <label className={labelClass} htmlFor="financial_pl-typ-dokumentu">
                  {t('financial_pl.fields.typDokumentu', 'Document type (JPK)')}
                </label>
                <Select
                  value={value.typDokumentu || NONE_VALUE}
                  onValueChange={(next) => patch({ typDokumentu: next === NONE_VALUE ? null : (next as JpkTypDokumentu) })}
                  disabled={busy}
                >
                  <SelectTrigger id="financial_pl-typ-dokumentu" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>—</SelectItem>
                    {JPK_TYP_DOKUMENTU.map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="adjustments" variant="card">
          <AccordionTrigger triggerIcon="chevron">
            {t('financial_pl.invoices.plvat.section.adjustments', 'Adjustments & exemption')}
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className={labelClass} htmlFor="financial_pl-bad-debt-period">
                    {t('financial_pl.fields.badDebtReliefPeriod', 'Bad-debt relief period (YYYY-MM)')}
                  </label>
                  <Input
                    id="financial_pl-bad-debt-period"
                    value={value.badDebtReliefPeriod ?? ''}
                    disabled={busy}
                    onChange={(event) => patch({ badDebtReliefPeriod: event.target.value.length ? event.target.value : null })}
                    placeholder="2026-02"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className={labelClass} htmlFor="financial_pl-bad-debt-due">
                    {t('financial_pl.fields.badDebtTerminPlatnosci', 'Bad-debt payment due date')}
                  </label>
                  <IsoDatePicker
                    id="financial_pl-bad-debt-due"
                    value={value.badDebtTerminPlatnosci}
                    disabled={busy}
                    onChange={(next) => patch({ badDebtTerminPlatnosci: next.length ? next : null })}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className={labelClass} htmlFor="financial_pl-vat-exemption">
                  {t('financial_pl.fields.vatExemptionBasis', 'VAT exemption legal basis')}
                </label>
                <Textarea
                  id="financial_pl-vat-exemption"
                  value={value.vatExemptionBasis ?? ''}
                  disabled={busy}
                  onChange={(event) => patch({ vatExemptionBasis: event.target.value.length ? event.target.value : null })}
                  rows={2}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      </div>
    </div>
  )
}

export default PlVatMetaForm
