'use client'

import * as React from 'react'
import { Input } from '@open-mercato/ui/primitives/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { SwitchField } from '@open-mercato/ui/primitives/switch-field'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { isValidBankAccount, normalizeAccountNumber } from '../lib/bank-account'
import { lookupPolishBank } from '../lib/pl-bank-registry'
import { isValidSwift } from '../lib/pl-format'
import { IsoDatePicker } from './IsoDatePicker'

export const PAYMENT_METHODS = [
  'cash',
  'card',
  'voucher',
  'cheque',
  'credit',
  'transfer',
  'mobile',
  'other',
] as const

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export type PaymentValue = {
  method: PaymentMethod
  methodOther?: string
  termDays?: number
  bankAccount?: string
  bankName?: string
  swift?: string
  paid?: boolean
  paidDate?: string
}

export type PaymentFieldsProps = {
  value: PaymentValue
  onChange: (v: PaymentValue) => void
  disabled?: boolean
}

// Matches the field-label style used across the invoice form (PlVatMetaForm, CrudForm builtins).
// These were 12px muted while the section above them used 14px foreground, so the same form showed
// two different label treatments depending on which component rendered the field.
const labelClass = 'text-sm font-medium text-foreground'

function optionalNumber(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const next = Number(raw)
  return Number.isFinite(next) ? next : undefined
}

export function PaymentFields({ value, onChange, disabled }: PaymentFieldsProps) {
  const t = useT()
  const busy = Boolean(disabled)
  const manualBankFieldsRef = React.useRef<Set<'bankName' | 'swift'>>(new Set())
  const bankAccountRaw = (value.bankAccount ?? '').trim()
  const bankAccountInvalid = bankAccountRaw.length > 0 && !isValidBankAccount(bankAccountRaw)
  const swiftRaw = (value.swift ?? '').trim()
  const swiftInvalid = swiftRaw.length > 0 && !isValidSwift(swiftRaw)

  const patch = React.useCallback(
    (next: Partial<PaymentValue>) => onChange({ ...value, ...next }),
    [onChange, value],
  )

  const updateMethod = React.useCallback(
    (method: PaymentMethod) => {
      const next: PaymentValue = { ...value, method }
      if (method !== 'transfer') {
        delete next.bankAccount
        delete next.bankName
        delete next.swift
        manualBankFieldsRef.current.clear()
      }
      onChange(next)
    },
    [onChange, value],
  )

  return (
    <div className="@container flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 @xs:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-payment-method">
            {t('financial_pl.invoices.form.payment.method', 'Payment method')}
          </label>
          <Select
            value={value.method}
            disabled={busy}
            onValueChange={(next) => updateMethod(next as PaymentMethod)}
          >
            <SelectTrigger id="financial_pl-payment-method" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYMENT_METHODS.map((method) => (
                <SelectItem key={method} value={method}>
                  {t(`financial_pl.invoices.form.payment.methods.${method}`, method)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/*
          The payment term used to be a separate "days" input here while the Invoice details block
          above owns the due date with 7/14/30 quick-picks — two controls for one fact, and the date
          is the one that actually prints on the invoice. `termDays` stays in the model (it seeds the
          due-date derivation) but is no longer asked for twice.
        */}
        {value.method === 'transfer' ? (
    <div className="flex flex-col gap-2">
      <label className={labelClass} htmlFor="financial_pl-payment-swift">
        {t('financial_pl.invoices.form.payment.swift', 'SWIFT/BIC')}
      </label>
      <Input
        id="financial_pl-payment-swift"
        value={value.swift ?? ''}
        disabled={busy}
        aria-invalid={swiftInvalid || undefined}
        onChange={(event) => {
          manualBankFieldsRef.current.add('swift')
          patch({ swift: event.target.value.toUpperCase() })
        }}
      />
      {swiftInvalid ? (
        <span className="text-xs text-status-error-text">
          {t('financial_pl.validation.swift', 'Enter a valid SWIFT/BIC (8 or 11 characters).')}
        </span>
      ) : null}
    </div>
        ) : null}
      </div>

      {value.method === 'other' ? (
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-payment-method-other">
            {t('financial_pl.invoices.form.payment.methodOther', 'Other payment method')}
            <span aria-hidden="true"> *</span>
          </label>
          <Input
            id="financial_pl-payment-method-other"
            value={value.methodOther ?? ''}
            disabled={busy}
            // No native `required`: SPEC-018 keeps tab panels mounted, so this control can be
            // hidden (display:none) on an inactive tab — a blank native-required control under
            // display:none silently blocks form submission ("not focusable"). The invoice form
            // gates this in handleSubmit (other⇒methodOther) and routes to the Faktura tab;
            // `aria-required` keeps the a11y semantics without native validation.
            aria-required="true"
            onChange={(event) => patch({ methodOther: event.target.value })}
            placeholder={t(
              'financial_pl.invoices.form.payment.methodOtherPlaceholder',
              'Describe the payment method',
            )}
          />
        </div>
      ) : null}

      {value.method === 'transfer' ? (
        // The account number spans the row: an IBAN is 28+ characters and was being truncated into
        // a third of the width, while the bank name and SWIFT beside it are short.
        <div className="grid grid-cols-1 gap-4">
          <div className="flex flex-col gap-2">
            <label className={labelClass} htmlFor="financial_pl-payment-bank-account">
              {t('financial_pl.invoices.form.payment.bankAccount', 'Bank account')}
            </label>
            <Input
              id="financial_pl-payment-bank-account"
              value={value.bankAccount ?? ''}
              disabled={busy}
              aria-invalid={bankAccountInvalid || undefined}
              onChange={(event) => {
                const nextAccount = event.target.value
                const info = lookupPolishBank(normalizeAccountNumber(nextAccount))
                const patchObj: Partial<PaymentValue> = { bankAccount: nextAccount }
                // Auto-fill bank name / SWIFT from the account. Track the CURRENT account: refresh any
                // field the operator has NOT manually edited (so switching to a different recognized
                // bank updates it — code-jury Codex), and never clobber a manually-typed value. An
                // unrecognized/incomplete account leaves prior values untouched (no clear-flicker while
                // typing, and a manual/foreign entry is preserved).
                if (info) {
                  if (!manualBankFieldsRef.current.has('bankName')) patchObj.bankName = info.name
                  if (!manualBankFieldsRef.current.has('swift')) patchObj.swift = info.swift
                }
                patch(patchObj)
              }}
              placeholder="PL00 0000 0000 0000 0000 0000 0000"
            />
            {bankAccountInvalid ? (
              <span className="text-xs text-status-error-text">
                {t(
                  'financial_pl.validation.bankAccount',
                  'Enter a valid IBAN or 26-digit Polish account number (NRB).',
                )}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <label className={labelClass} htmlFor="financial_pl-payment-bank-name">
              {t('financial_pl.invoices.form.payment.bankName', 'Bank name')}
            </label>
            <Input
              id="financial_pl-payment-bank-name"
              value={value.bankName ?? ''}
              disabled={busy}
              onChange={(event) => {
                manualBankFieldsRef.current.add('bankName')
                patch({ bankName: event.target.value })
              }}
            />
          </div>
        </div>
      ) : null}

      {/*
        The paid switch sat in a two-column grid cell, so the toggle floated in the middle of a wide
        empty row. It now owns a normal full-width row and the date appears beneath it when relevant.
      */}
      <div className="flex flex-col gap-2">
        <SwitchField
          label={t('financial_pl.invoices.form.payment.paid', 'Paid')}
          checked={Boolean(value.paid)}
          disabled={busy}
          onCheckedChange={(next) => {
            const paid = Boolean(next)
            patch(paid ? { paid } : { paid: false, paidDate: undefined })
          }}
        />

        {value.paid ? (
          <div className="flex flex-col gap-2">
            <label className={labelClass} htmlFor="financial_pl-payment-paid-date">
              {t('financial_pl.invoices.form.payment.paidDate', 'Payment date')}
              <span aria-hidden="true"> *</span>
            </label>
            {/* DS picker, not `<input type="date">` — the native control draws the browser's own
                calendar inside a form built entirely from the design system. Required-ness is
                gated in handleSubmit (paid⇒paidDate), never natively: this panel can be hidden. */}
            <IsoDatePicker
              id="financial_pl-payment-paid-date"
              value={value.paidDate}
              disabled={busy}
              onChange={(next) => patch({ paidDate: next })}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default PaymentFields
