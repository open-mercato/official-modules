'use client'

import * as React from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { isValidBankAccount, normalizeAccountNumber } from '../lib/bank-account'
import { lookupPolishBank } from '../lib/pl-bank-registry'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { SwitchField } from '@open-mercato/ui/primitives/switch-field'
import { useT } from '@open-mercato/shared/lib/i18n/context'
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

/** A settlement account configured in invoice settings, offered as a pick here. */
export type PaymentAccountOption = {
  id: string
  label?: string | null
  accountNumber: string
  bankName?: string | null
  swift?: string | null
  isDefault?: boolean
}

export type PaymentFieldsProps = {
  value: PaymentValue
  onChange: (v: PaymentValue) => void
  disabled?: boolean
  /** Accounts from invoice settings. */
  accounts?: PaymentAccountOption[]
  /**
   * Persist a new account to invoice settings and select it. Omitted ⇒ no add affordance, so the
   * only way in is the settings screen. Resolves false when the save failed.
   */
  onCreateAccount?: (account: Omit<PaymentAccountOption, 'id'>) => Promise<boolean>
}

// Matches the field-label style used across the invoice form (PlVatMetaForm, CrudForm builtins).
// These were 12px muted while the section above them used 14px foreground, so the same form showed
// two different label treatments depending on which component rendered the field.
const labelClass = 'text-sm font-medium text-foreground'
const LEGACY_ACCOUNT_ID = '__stored__'

function optionalNumber(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const next = Number(raw)
  return Number.isFinite(next) ? next : undefined
}

export function PaymentFields({ value, onChange, disabled, accounts, onCreateAccount }: PaymentFieldsProps) {
  const t = useT()
  const busy = Boolean(disabled)

  const patch = React.useCallback(
    (next: Partial<PaymentValue>) => onChange({ ...value, ...next }),
    [onChange, value],
  )

  const [addOpen, setAddOpen] = React.useState(false)
  const [savingAccount, setSavingAccount] = React.useState(false)
  const [draftAccount, setDraftAccount] = React.useState<Omit<PaymentAccountOption, 'id'>>({
    label: '',
    accountNumber: '',
    bankName: '',
    swift: '',
  })
  const draftAccountInvalid =
    draftAccount.accountNumber.trim().length > 0 && !isValidBankAccount(draftAccount.accountNumber.trim())

  const storedAccount = (value.bankAccount ?? '').trim()
  const options = React.useMemo<PaymentAccountOption[]>(() => {
    const configured = accounts ?? []
    if (!storedAccount) return configured
    if (configured.some((account) => account.accountNumber.trim() === storedAccount)) return configured
    // An account removed from settings after the invoice was written still has to be selectable,
    // otherwise opening that invoice would silently clear its account number.
    return [
      ...configured,
      {
        id: LEGACY_ACCOUNT_ID,
        label: `${storedAccount}${value.bankName ? ` (${value.bankName})` : ''}`,
        accountNumber: storedAccount,
        bankName: value.bankName ?? null,
        swift: value.swift ?? null,
      },
    ]
  }, [accounts, storedAccount, value.bankName, value.swift])
  const selectedAccount = options.find((account) => account.accountNumber.trim() === storedAccount) ?? null
  const selectedAccountId = selectedAccount?.id ?? null

  const updateMethod = React.useCallback(
    (method: PaymentMethod) => {
      const next: PaymentValue = { ...value, method }
      if (method !== 'transfer') {
        delete next.bankAccount
        delete next.bankName
        delete next.swift
      }
      if (method !== 'other') {
        delete next.methodOther
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
      </div>

      {value.method === 'other' ? (
        // "Other" needs a free-text description (FA(3) PlatnoscInna → OpisPlatnosci). Without this
        // input the method was un-completable: selecting it left `methodOther` empty and blocked
        // submit forever (QA #38). Required-ness is gated field-specifically in handleSubmit.
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-payment-method-other">
            {t('financial_pl.invoices.form.payment.methodOther', 'Other payment method')}
            <span aria-hidden="true"> *</span>
          </label>
          <Input
            id="financial_pl-payment-method-other"
            value={value.methodOther ?? ''}
            disabled={busy}
            placeholder={t('financial_pl.invoices.form.payment.methodOtherPlaceholder', 'Describe the payment method')}
            onChange={(event) => patch({ methodOther: event.target.value })}
          />
        </div>
      ) : null}

      {value.method === 'transfer' ? (
        // Pick-only on the invoice: the account number is defined once in invoice settings and
        // chosen here. Free entry let a typo reach the printed document, and every one-off account
        // typed in silently disappeared instead of becoming reusable.
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-payment-account-pick">
            {t('financial_pl.invoices.form.payment.accountPick', 'Account')}
          </label>
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                'financial_pl.invoices.form.payment.noAccounts',
                'No bank accounts configured yet — add one in invoice settings.',
              )}{' '}
              <a className="underline" href="/backend/financial/invoice-settings">
                {t('financial_pl.nav.invoiceSettings', 'Invoice settings')}
              </a>
            </p>
          ) : (
            <Select
              value={selectedAccountId ?? ''}
              disabled={busy}
              onValueChange={(next) => {
                const picked = options.find((account) => account.id === next)
                if (!picked) return
                patch({
                  bankAccount: picked.accountNumber,
                  bankName: picked.bankName ?? '',
                  swift: picked.swift ?? '',
                })
              }}
            >
              <SelectTrigger id="financial_pl-payment-account-pick" className="w-full">
                <SelectValue
                  placeholder={t('financial_pl.invoices.form.payment.accountPlaceholder', 'Choose an account')}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.label?.trim() || account.accountNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {onCreateAccount ? (
            <>
              <div className="flex justify-start">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setDraftAccount({ label: '', accountNumber: '', bankName: '', swift: '' })
                    setAddOpen(true)
                  }}
                >
                  <Plus className="mr-1 size-4" />
                  {t('financial_pl.invoices.form.payment.accountAdd', 'Add account')}
                </Button>
              </div>
              <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {t('financial_pl.invoices.form.payment.accountAddTitle', 'Add a bank account')}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="flex flex-col gap-3 px-6 py-2">
                    <div className="flex flex-col gap-2">
                      <label className={labelClass} htmlFor="financial_pl-new-account-label">
                        {t('financial_pl.settings.bankAccountLabel', 'Name')}
                      </label>
                      <Input
                        id="financial_pl-new-account-label"
                        value={draftAccount.label ?? ''}
                        onChange={(event) => setDraftAccount((prev) => ({ ...prev, label: event.target.value }))}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className={labelClass} htmlFor="financial_pl-new-account-number">
                        {t('financial_pl.invoices.form.payment.bankAccount', 'Bank account')}
                        <span aria-hidden="true" className="text-status-error-text"> *</span>
                      </label>
                      <Input
                        id="financial_pl-new-account-number"
                        value={draftAccount.accountNumber}
                        aria-invalid={draftAccountInvalid || undefined}
                        placeholder="PL00 0000 0000 0000 0000 0000 0000"
                        onChange={(event) => {
                          const nextAccount = event.target.value
                          const info = lookupPolishBank(normalizeAccountNumber(nextAccount))
                          setDraftAccount((prev) => ({
                            ...prev,
                            accountNumber: nextAccount,
                            ...(info && !prev.bankName?.trim() ? { bankName: info.name } : {}),
                            ...(info && !prev.swift?.trim() ? { swift: info.swift } : {}),
                          }))
                        }}
                      />
                      {draftAccountInvalid ? (
                        <span className="text-xs text-status-error-text">
                          {t(
                            'financial_pl.validation.bankAccount',
                            'Enter a valid IBAN or 26-digit Polish account number (NRB).',
                          )}
                        </span>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
                      <div className="flex flex-col gap-2">
                        <label className={labelClass} htmlFor="financial_pl-new-account-bank">
                          {t('financial_pl.invoices.form.payment.bankName', 'Bank name')}
                        </label>
                        <Input
                          id="financial_pl-new-account-bank"
                          value={draftAccount.bankName ?? ''}
                          onChange={(event) => setDraftAccount((prev) => ({ ...prev, bankName: event.target.value }))}
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className={labelClass} htmlFor="financial_pl-new-account-swift">
                          {t('financial_pl.invoices.form.payment.swift', 'SWIFT/BIC')}
                        </label>
                        <Input
                          id="financial_pl-new-account-swift"
                          value={draftAccount.swift ?? ''}
                          onChange={(event) =>
                            setDraftAccount((prev) => ({ ...prev, swift: event.target.value.toUpperCase() }))
                          }
                        />
                      </div>
                    </div>
                  </div>
                  <DialogFooter layout="equal">
                    <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={savingAccount}>
                      {t('financial_pl.invoices.form.payment.accountAddCancel', 'Cancel')}
                    </Button>
                    <Button
                      type="button"
                      disabled={savingAccount || draftAccountInvalid || !draftAccount.accountNumber.trim()}
                      onClick={async () => {
                        setSavingAccount(true)
                        const ok = await onCreateAccount({
                          label: draftAccount.label?.trim() || null,
                          accountNumber: draftAccount.accountNumber.trim(),
                          bankName: draftAccount.bankName?.trim() || null,
                          swift: draftAccount.swift?.trim() || null,
                        })
                        setSavingAccount(false)
                        if (ok) setAddOpen(false)
                      }}
                    >
                      {savingAccount
                        ? t('financial_pl.invoices.form.payment.accountAddSaving', 'Saving…')
                        : t('financial_pl.invoices.form.payment.accountAddSave', 'Add account')}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          ) : null}
          {selectedAccount ? (
            <span className="text-xs text-muted-foreground">
              {[selectedAccount.accountNumber, selectedAccount.bankName, selectedAccount.swift]
                .filter((part) => (part ?? '').toString().trim().length > 0)
                .join(', ')}
            </span>
          ) : null}
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
