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

const labelClass = 'text-xs text-muted-foreground'

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
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
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

        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-payment-term-days">
            {t('financial_pl.invoices.form.payment.termDays', 'Payment term (days)')}
          </label>
          <Input
            id="financial_pl-payment-term-days"
            // Plain text (not type="number") so NO native constraint validation applies at all:
            // SPEC-018 keeps tab panels mounted, so this control is hidden (display:none) on an
            // inactive tab, and a native-invalid hidden control ("not focusable") silently blocks
            // form submission before handleSubmit can run. type="number" still carries an IMPLICIT
            // step=1, so a fractional value (e.g. 14.5) is a stepMismatch → the class was not fully
            // closed by dropping the explicit min/step (code-jury: Codex + Kimi, 2 voters). type="text"
            // removes stepMismatch/badInput entirely; the term is validated in JS by handleSubmit
            // (termDaysRange: whole number 0..3650, routes to the Faktura tab). inputMode="numeric"
            // keeps the numeric on-screen keyboard.
            inputMode="numeric"
            value={value.termDays == null ? '' : String(value.termDays)}
            disabled={busy}
            onChange={(event) => patch({ termDays: optionalNumber(event.target.value) })}
          />
        </div>
      </div>

      {value.method === 'other' ? (
        <div className="flex flex-col gap-1.5">
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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
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
          <div className="flex flex-col gap-1.5">
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
          <div className="flex flex-col gap-1.5">
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
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
          <div className="flex flex-col gap-1.5">
            <label className={labelClass} htmlFor="financial_pl-payment-paid-date">
              {t('financial_pl.invoices.form.payment.paidDate', 'Payment date')}
              <span aria-hidden="true"> *</span>
            </label>
            <Input
              id="financial_pl-payment-paid-date"
              type="date"
              value={value.paidDate ?? ''}
              disabled={busy}
              // No native `required` — see the methodOther note above: gated in handleSubmit
              // (paid⇒paidDate) + Faktura-tab routing; native required under a hidden panel
              // would silently block submission.
              aria-required="true"
              onChange={(event) => patch({ paidDate: event.target.value })}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default PaymentFields
