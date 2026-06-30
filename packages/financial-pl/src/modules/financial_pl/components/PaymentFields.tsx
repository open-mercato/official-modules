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
            type="number"
            min={0}
            step={1}
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
            required
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
              onChange={(event) => patch({ bankAccount: event.target.value })}
              placeholder="PL00 0000 0000 0000 0000 0000 0000"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelClass} htmlFor="financial_pl-payment-bank-name">
              {t('financial_pl.invoices.form.payment.bankName', 'Bank name')}
            </label>
            <Input
              id="financial_pl-payment-bank-name"
              value={value.bankName ?? ''}
              disabled={busy}
              onChange={(event) => patch({ bankName: event.target.value })}
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
              onChange={(event) => patch({ swift: event.target.value.toUpperCase() })}
            />
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
              required
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
