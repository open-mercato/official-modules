'use client'

import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { SwitchField } from '@open-mercato/ui/primitives/switch-field'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
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

/** Procedure-markings flag map (one optional boolean per JPK procedure code). */
export type ProcedureMarkings = Partial<Record<JpkProcedureMarking, boolean>>

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

const labelClass = 'text-sm font-medium text-foreground'

export type PlVatMetaFormProps = {
  value: InvoiceMeta
  onChange: (next: InvoiceMeta) => void
  disabled?: boolean
}

/**
 * Controlled PL-VAT metadata editor rendering the FULL `invoiceMetaPutSchema` field
 * set. Pure controlled component: the parent owns persistence (M8 — no internal
 * no-op retry / save mutation). DS tokens + `@open-mercato/ui` primitives only.
 */
export function PlVatMetaForm({ value, onChange, disabled }: PlVatMetaFormProps) {
  const t = useT()
  const busy = Boolean(disabled)

  const patch = React.useCallback(
    (next: Partial<InvoiceMeta>) => {
      onChange({ ...value, ...next })
    },
    [onChange, value],
  )

  const invoiceKind = value.invoiceKind ?? 'vat'
  const gtuCodes = value.gtuCodes ?? []
  const procedureMarkings = value.procedureMarkings ?? {}
  const advancePayments = value.advancePayments ?? []
  const advanceRefs = value.advanceRefs ?? []

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
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
        />
      </div>

      <div className="flex flex-col gap-1.5">
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

      {value.ossProcedure ? (
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-consumption-country">
            {t('financial_pl.fields.consumptionCountry', 'Consumption country (OSS)')}
          </label>
          <Select
            value={value.consumptionCountryCode || NONE_VALUE}
            onValueChange={(next) => patch({ consumptionCountryCode: next === NONE_VALUE ? null : next })}
            disabled={busy}
          >
            <SelectTrigger id="financial_pl-consumption-country" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>—</SelectItem>
              {OSS_CONSUMPTION_COUNTRIES.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-exchange-rate">
            {t('financial_pl.fields.exchangeRate', 'Exchange rate (to PLN)')}
          </label>
          <Input
            id="financial_pl-exchange-rate"
            inputMode="decimal"
            value={value.exchangeRate ?? ''}
            disabled={busy}
            onChange={(event) => patch({ exchangeRate: event.target.value.length ? event.target.value : null })}
            placeholder="4.3210"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-exchange-rate-date">
            {t('financial_pl.fields.exchangeRateDate', 'Exchange rate date')}
          </label>
          <Input
            id="financial_pl-exchange-rate-date"
            type="date"
            value={value.exchangeRateDate ?? ''}
            disabled={busy}
            onChange={(event) => patch({ exchangeRateDate: event.target.value.length ? event.target.value : null })}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t('financial_pl.fields.advancePaymentsGroup', 'Advance payments (ZAL)')}
        </legend>
        {advancePayments.map((row, index) => (
          <div key={index} className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-date-${index}`}>
                {t('financial_pl.fields.advanceReceivedDate', 'Received date')}
              </label>
              <Input
                id={`financial_pl-advance-date-${index}`}
                type="date"
                value={row.receivedDate}
                disabled={busy}
                onChange={(event) => updateAdvancePayment(index, { receivedDate: event.target.value })}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
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
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-fx-${index}`}>
                {t('financial_pl.fields.advanceFxRate', 'FX rate')}
              </label>
              <Input
                id={`financial_pl-advance-fx-${index}`}
                inputMode="decimal"
                value={row.fxRate ?? ''}
                disabled={busy}
                onChange={(event) => updateAdvancePayment(index, { fxRate: event.target.value.length ? event.target.value : undefined })}
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

      <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t('financial_pl.fields.advanceRefsGroup', 'Advance invoice references (ROZ)')}
        </legend>
        {advanceRefs.map((row, index) => (
          <div key={index} className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-ksef-${index}`}>
                {t('financial_pl.fields.advanceRefKsefNumber', 'KSeF number')}
              </label>
              <Input
                id={`financial_pl-advance-ksef-${index}`}
                value={row.ksefNumber ?? ''}
                disabled={busy}
                onChange={(event) => updateAdvanceRef(index, { ksefNumber: event.target.value.length ? event.target.value : undefined })}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-invoice-${index}`}>
                {t('financial_pl.fields.advanceRefInvoiceNumber', 'Invoice number')}
              </label>
              <Input
                id={`financial_pl-advance-invoice-${index}`}
                value={row.invoiceNumber ?? ''}
                disabled={busy}
                onChange={(event) => updateAdvanceRef(index, { invoiceNumber: event.target.value.length ? event.target.value : undefined })}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor={`financial_pl-advance-ref-amount-${index}`}>
                {t('financial_pl.fields.advanceRefAmount', 'Amount')}
              </label>
              <Input
                id={`financial_pl-advance-ref-amount-${index}`}
                inputMode="decimal"
                value={row.amount ?? ''}
                disabled={busy}
                onChange={(event) => updateAdvanceRef(index, { amount: event.target.value.length ? event.target.value : undefined })}
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

      <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
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
            <div className="flex flex-col gap-1.5">
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
                className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-end"
              >
                <div className="flex flex-[2] flex-col gap-1.5">
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
                <div className="flex flex-1 flex-col gap-1.5">
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
                <div className="flex flex-1 flex-col gap-1.5">
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
                <div className="flex flex-1 flex-col gap-1.5">
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
                <div className="flex flex-1 flex-col gap-1.5">
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

      <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t('financial_pl.fields.gtuGroup', 'GTU markings (JPK)')}
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {GTU_CODES.map((code) => (
            <CheckboxField
              key={code}
              label={t(`financial_pl.fields.gtu.${code}`, code)}
              checked={gtuCodes.includes(code)}
              disabled={busy}
              onCheckedChange={(next) => toggleGtu(code, Boolean(next))}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t('financial_pl.fields.procedureGroup', 'JPK procedure markings')}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {JPK_PROCEDURE_MARKINGS.map((code) => (
            <CheckboxField
              key={code}
              label={t(`financial_pl.fields.procedure.${code}`, code)}
              checked={Boolean(procedureMarkings[code])}
              disabled={busy}
              onCheckedChange={(next) => toggleProcedure(code, Boolean(next))}
            />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
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
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-bad-debt-due">
            {t('financial_pl.fields.badDebtTerminPlatnosci', 'Bad-debt payment due date')}
          </label>
          <Input
            id="financial_pl-bad-debt-due"
            type="date"
            value={value.badDebtTerminPlatnosci ?? ''}
            disabled={busy}
            onChange={(event) => patch({ badDebtTerminPlatnosci: event.target.value.length ? event.target.value : null })}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
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
  )
}

export default PlVatMetaForm
