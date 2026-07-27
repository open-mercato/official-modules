'use client'

import * as React from 'react'
import { CreditCard, FileImage, Plus, Settings2, Trash2 } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { ErrorMessage } from '@open-mercato/ui/backend/detail/ErrorMessage'
import { LoadingMessage } from '@open-mercato/ui/backend/detail/LoadingMessage'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PAYMENT_METHODS } from '../../../components/PaymentFields'
import { FormSection } from '../../../components/FormSection'
import { isValidBankAccount, normalizeAccountNumber } from '../../../lib/bank-account'
import { lookupPolishBank } from '../../../lib/pl-bank-registry'
import { isValidSwift } from '../../../lib/pl-format'

/** Kept in sync with `invoiceSettingsPutSchema`; the server is still the authority. */
const MAX_LOGO_BYTES = 500_000
const ACCEPTED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
const TERM_DAY_PRESETS = [7, 14, 30] as const
const VAT_RATE_PRESETS = ['23', '8', '5', '0'] as const
const CURRENCY_PRESETS = ['PLN', 'EUR', 'USD', 'GBP'] as const

type InvoiceSettings = {
  logoDataUrl: string | null
  footerNote: string | null
  defaultPaymentMethod: string | null
  defaultTermDays: number | null
  defaultTaxRate: string | null
  defaultCurrencyCode: string | null
  defaultPriceMode: string | null
  bankAccounts: BankAccount[]
}

type BankAccount = {
  id: string
  label?: string | null
  accountNumber: string
  bankName?: string | null
  swift?: string | null
  isDefault?: boolean
}

const EMPTY: InvoiceSettings = {
  logoDataUrl: null,
  footerNote: null,
  defaultPaymentMethod: null,
  defaultTermDays: null,
  defaultTaxRate: null,
  defaultCurrencyCode: null,
  defaultPriceMode: null,
  bankAccounts: [],
}

/**
 * Per-organization invoice defaults (SPEC-013 follow-up): the logo and footer printed on the
 * document, plus the values a new invoice starts with.
 *
 * Deliberately NOT here: the seller's identity (name, NIP, address), which lives on the `ksef_pl`
 * integration credential and is what the KSeF filing actually uses — an editable second copy would
 * let the printed document and the filed document disagree. Numbering is also out: core owns the
 * sequence, and a format editable from two places would produce gaps.
 */
export default function InvoiceSettingsPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [settings, setSettings] = React.useState<InvoiceSettings>(EMPTY)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [logoError, setLogoError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void (async () => {
      const res = await apiCall<{ settings?: InvoiceSettings; error?: string }>(
        '/api/financial_pl/invoice-settings',
      )
      if (cancelled) return
      if (!res.ok) {
        setLoadError(res.result?.error ?? t('financial_pl.settings.loadFailed', 'Could not load invoice settings.'))
      } else {
        setSettings({ ...EMPTY, ...(res.result?.settings ?? {}) })
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [scopeVersion, t])

  const patch = React.useCallback(
    (next: Partial<InvoiceSettings>) => setSettings((prev) => ({ ...prev, ...next })),
    [],
  )

  const patchAccount = React.useCallback(
    (index: number, next: Partial<BankAccount>) =>
      setSettings((prev) => ({
        ...prev,
        bankAccounts: prev.bankAccounts.map((account, i) => (i === index ? { ...account, ...next } : account)),
      })),
    [],
  )

  const addAccount = React.useCallback(
    () =>
      setSettings((prev) => ({
        ...prev,
        bankAccounts: [
          ...prev.bankAccounts,
          {
            // `crypto.randomUUID` is available in every browser this admin runs in; the id only has
            // to be stable across a render, the server never derives meaning from it.
            id: crypto.randomUUID(),
            label: '',
            accountNumber: '',
            bankName: '',
            swift: '',
            // The first account added is the default — otherwise a single-account seller would have
            // to remember to mark it, and a new invoice would prefill nothing.
            isDefault: prev.bankAccounts.length === 0,
          },
        ],
      })),
    [],
  )

  const removeAccount = React.useCallback(
    (index: number) =>
      setSettings((prev) => {
        const next = prev.bankAccounts.filter((_, i) => i !== index)
        // Removing the default promotes the first survivor, so the list never ends up defaultless.
        if (next.length > 0 && !next.some((account) => account.isDefault)) next[0] = { ...next[0], isDefault: true }
        return { ...prev, bankAccounts: next }
      }),
    [],
  )

  const setDefaultAccount = React.useCallback(
    (index: number) =>
      setSettings((prev) => ({
        ...prev,
        bankAccounts: prev.bankAccounts.map((account, i) => ({ ...account, isDefault: i === index })),
      })),
    [],
  )

  const onPickLogo = React.useCallback(
    (file: File | undefined) => {
      setLogoError(null)
      if (!file) return
      if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
        setLogoError(t('financial_pl.settings.logoType', 'Use a PNG, JPEG, SVG or WebP image.'))
        return
      }
      // Checked before reading: base64 inflates by ~33%, so a file over the cap can only fail
      // server-side, and failing here says why without a round trip.
      if (file.size > MAX_LOGO_BYTES) {
        setLogoError(t('financial_pl.settings.logoSize', 'The logo must be under 500 kB.'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : null
        if (result) patch({ logoDataUrl: result })
      }
      reader.onerror = () =>
        setLogoError(t('financial_pl.settings.logoRead', 'Could not read that file.'))
      reader.readAsDataURL(file)
    },
    [patch, t],
  )

  const onSave = React.useCallback(async () => {
    setSaving(true)
    const trimmed = (v: string | null) => {
      const next = (v ?? '').trim()
      return next ? next : null
    }
    const res = await apiCall<{ ok?: boolean; error?: string }>('/api/financial_pl/invoice-settings', {
      method: 'PUT',
      body: JSON.stringify({
        logoDataUrl: settings.logoDataUrl,
        footerNote: trimmed(settings.footerNote),
        defaultPaymentMethod: trimmed(settings.defaultPaymentMethod),
        defaultTermDays: settings.defaultTermDays,
        defaultTaxRate: trimmed(settings.defaultTaxRate),
        defaultCurrencyCode: trimmed(settings.defaultCurrencyCode),
        defaultPriceMode: settings.defaultPriceMode,
        // Blank rows are the operator adding a row and changing their mind; dropping them here
        // keeps an empty account number from ever reaching the invoice.
        bankAccounts: settings.bankAccounts
          .filter((account) => account.accountNumber.trim().length > 0)
          .map((account) => ({
            id: account.id,
            label: trimmed(account.label ?? null),
            accountNumber: account.accountNumber.trim(),
            bankName: trimmed(account.bankName ?? null),
            swift: trimmed(account.swift ?? null),
            isDefault: Boolean(account.isDefault),
          })),
      }),
    })
    setSaving(false)
    if (!res.ok) {
      flash(res.result?.error ?? t('financial_pl.settings.saveFailed', 'Could not save invoice settings.'), 'error')
      return
    }
    flash(t('financial_pl.settings.saved', 'Invoice settings saved.'), 'success')
  }, [settings, t])

  if (loading) return <LoadingMessage label={t('financial_pl.settings.loading', 'Loading invoice settings…')} />
  if (loadError) return <ErrorMessage label={loadError} />

  const labelClass = 'text-sm font-medium text-foreground'

  return (
    <Page>
      <PageBody>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-xl font-semibold text-foreground">
              {t('financial_pl.settings.title', 'Invoice settings')}
            </h1>
            <Button type="button" disabled={saving} onClick={() => void onSave()}>
              {saving
                ? t('financial_pl.settings.saving', 'Saving…')
                : t('financial_pl.settings.save', 'Save settings')}
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <FormSection
              icon={<FileImage className="size-4" />}
              title={t('financial_pl.settings.branding', 'Branding')}
              description={t(
                'financial_pl.settings.brandingHint',
                'Printed on the invoice document. Does not affect the KSeF filing.',
              )}
            >
              <div className="flex flex-col gap-2">
                <span className={labelClass}>{t('financial_pl.settings.logo', 'Logo')}</span>
                {settings.logoDataUrl ? (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL has no
                        remote origin to optimise, and next/image would only add a loader. */}
                    <img
                      src={settings.logoDataUrl}
                      alt={t('financial_pl.settings.logoAlt', 'Invoice logo')}
                      className="max-h-16 max-w-40 rounded border border-border bg-background object-contain p-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        patch({ logoDataUrl: null })
                        if (fileInputRef.current) fileInputRef.current.value = ''
                      }}
                    >
                      <Trash2 className="mr-1 size-4" />
                      {t('financial_pl.settings.logoRemove', 'Remove')}
                    </Button>
                  </div>
                ) : null}
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_LOGO_TYPES.join(',')}
                  onChange={(event) => onPickLogo(event.target.files?.[0])}
                />
                {logoError ? <span className="text-xs text-status-error-text">{logoError}</span> : null}
              </div>

              <div className="flex flex-col gap-2">
                <label className={labelClass} htmlFor="financial_pl-settings-footer">
                  {t('financial_pl.settings.footerNote', 'Footer note')}
                </label>
                <Textarea
                  id="financial_pl-settings-footer"
                  value={settings.footerNote ?? ''}
                  onChange={(event) => patch({ footerNote: event.target.value })}
                  placeholder={t(
                    'financial_pl.settings.footerNotePlaceholder',
                    'e.g. thank-you line, register entry, complaints address',
                  )}
                />
              </div>
            </FormSection>

            <FormSection
              icon={<Settings2 className="size-4" />}
              title={t('financial_pl.settings.defaults', 'New invoice defaults')}
              description={t(
                'financial_pl.settings.defaultsHint',
                'What a new invoice starts with. Every value stays editable per invoice.',
              )}
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <label className={labelClass} htmlFor="financial_pl-settings-currency">
                    {t('financial_pl.invoices.form.fields.currencyCode', 'Currency')}
                  </label>
                  <Select
                    value={settings.defaultCurrencyCode ?? 'PLN'}
                    onValueChange={(next) => patch({ defaultCurrencyCode: next })}
                  >
                    <SelectTrigger id="financial_pl-settings-currency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCY_PRESETS.map((code) => (
                        <SelectItem key={code} value={code}>
                          {code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <label className={labelClass} htmlFor="financial_pl-settings-vat">
                    {t('financial_pl.lines.taxRate', 'VAT rate (%)')}
                  </label>
                  <Select
                    value={settings.defaultTaxRate ?? '23'}
                    onValueChange={(next) => patch({ defaultTaxRate: next })}
                  >
                    <SelectTrigger id="financial_pl-settings-vat" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VAT_RATE_PRESETS.map((rate) => (
                        <SelectItem key={rate} value={rate}>
                          {rate}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className={labelClass}>
                  {t('financial_pl.lines.priceMode', 'Prices are entered as')}
                </span>
                <SegmentedControl
                  value={settings.defaultPriceMode ?? 'net'}
                  onValueChange={(next) => patch({ defaultPriceMode: next })}
                  className="rounded-md"
                >
                  <SegmentedControlItem value="net" className="rounded">
                    {t('financial_pl.lines.priceModeNet', 'Net')}
                  </SegmentedControlItem>
                  <SegmentedControlItem value="gross" className="rounded">
                    {t('financial_pl.lines.priceModeGross', 'Gross')}
                  </SegmentedControlItem>
                </SegmentedControl>
              </div>

              <div className="flex flex-col gap-2">
                <span className={labelClass}>
                  {t('financial_pl.settings.termDays', 'Payment term')}
                </span>
                <div className="flex flex-wrap items-center gap-1">
                  {TERM_DAY_PRESETS.map((days) => {
                    const active = settings.defaultTermDays === days
                    return (
                      <Button
                        key={days}
                        type="button"
                        size="sm"
                        variant={active ? 'secondary' : 'outline'}
                        aria-pressed={active}
                        onClick={() => patch({ defaultTermDays: active ? null : days })}
                      >
                        {t('financial_pl.invoices.form.fields.dueInDays', '{count} days', { count: days })}
                      </Button>
                    )
                  })}
                </div>
              </div>
            </FormSection>

            <FormSection
              icon={<CreditCard className="size-4" />}
              title={t('financial_pl.invoices.form.sections.payment', 'Payment / settlement')}
              description={t(
                'financial_pl.settings.paymentHint',
                'Prefilled on a new invoice so the account number is not retyped each time.',
              )}
            >
              <div className="flex flex-col gap-2">
                <label className={labelClass} htmlFor="financial_pl-settings-method">
                  {t('financial_pl.invoices.form.payment.method', 'Payment method')}
                </label>
                <Select
                  value={settings.defaultPaymentMethod ?? 'transfer'}
                  onValueChange={(next) => patch({ defaultPaymentMethod: next })}
                >
                  <SelectTrigger id="financial_pl-settings-method" className="w-full">
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
                A list, not one account: a seller settling in PLN and EUR prints a different number
                depending on the invoice, so the choice belongs to the invoice. Exactly one entry is
                the default, which is what a new invoice starts with.
              */}
              <div className="flex flex-col gap-3">
                <span className={labelClass}>
                  {t('financial_pl.settings.bankAccounts', 'Bank accounts')}
                </span>

                {settings.bankAccounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('financial_pl.settings.bankAccountsEmpty', 'No accounts configured yet.')}
                  </p>
                ) : null}

                {settings.bankAccounts.map((account, index) => (
                  <div key={account.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Input
                        value={account.label ?? ''}
                        onChange={(event) => patchAccount(index, { label: event.target.value })}
                        placeholder={t('financial_pl.settings.bankAccountLabel', 'Name, e.g. "PLN — main"')}
                        className="max-w-56"
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant={account.isDefault ? 'secondary' : 'outline'}
                          aria-pressed={Boolean(account.isDefault)}
                          onClick={() => setDefaultAccount(index)}
                        >
                          {account.isDefault
                            ? t('financial_pl.settings.bankAccountDefault', 'Default')
                            : t('financial_pl.settings.bankAccountMakeDefault', 'Make default')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t('financial_pl.settings.bankAccountRemove', 'Remove account')}
                          title={t('financial_pl.settings.bankAccountRemove', 'Remove account')}
                          onClick={() => removeAccount(index)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                    <Input
                      value={account.accountNumber}
                      aria-invalid={
                        account.accountNumber.trim().length > 0 && !isValidBankAccount(account.accountNumber.trim())
                          ? true
                          : undefined
                      }
                      onChange={(event) => {
                        const nextAccount = event.target.value
                        const info = lookupPolishBank(normalizeAccountNumber(nextAccount))
                        // Fill the bank name and SWIFT from the account's clearing code, but never
                        // clobber what was typed by hand — an unrecognised or foreign account keeps
                        // whatever the operator entered.
                        patchAccount(index, {
                          accountNumber: nextAccount,
                          ...(info && !account.bankName?.trim() ? { bankName: info.name } : {}),
                          ...(info && !account.swift?.trim() ? { swift: info.swift } : {}),
                        })
                      }}
                      placeholder="PL00 0000 0000 0000 0000 0000 0000"
                      aria-label={t('financial_pl.invoices.form.payment.bankAccount', 'Bank account')}
                    />
                    {account.accountNumber.trim().length > 0 && !isValidBankAccount(account.accountNumber.trim()) ? (
                      <span className="text-xs text-status-error-text">
                        {t(
                          'financial_pl.validation.bankAccount',
                          'Enter a valid IBAN or 26-digit Polish account number (NRB).',
                        )}
                      </span>
                    ) : null}
                    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
                      <Input
                        value={account.bankName ?? ''}
                        onChange={(event) => patchAccount(index, { bankName: event.target.value })}
                        placeholder={t('financial_pl.invoices.form.payment.bankName', 'Bank name')}
                        aria-label={t('financial_pl.invoices.form.payment.bankName', 'Bank name')}
                      />
                      <Input
                        value={account.swift ?? ''}
                        aria-invalid={
                          (account.swift ?? '').trim().length > 0 && !isValidSwift((account.swift ?? '').trim())
                            ? true
                            : undefined
                        }
                        onChange={(event) => patchAccount(index, { swift: event.target.value.toUpperCase() })}
                        placeholder={t('financial_pl.invoices.form.payment.swift', 'SWIFT/BIC')}
                        aria-label={t('financial_pl.invoices.form.payment.swift', 'SWIFT/BIC')}
                      />
                    </div>
                  </div>
                ))}

                <div className="flex justify-end">
                  <Button type="button" size="sm" onClick={addAccount}>
                    <Plus className="mr-1 size-4" />
                    {t('financial_pl.settings.bankAccountAdd', 'Add account')}
                  </Button>
                </div>
              </div>
            </FormSection>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
