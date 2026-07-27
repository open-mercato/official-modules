'use client'

import * as React from 'react'
import { Search, Loader2 } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Button } from '@open-mercato/ui/primitives/button'
import { Tag } from '@open-mercato/ui/primitives/tag'
import { ComboboxInput, type ComboboxOption } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { isValidPolishNip } from '../lib/nip'
import { isValidPolishPostalCode } from '../lib/pl-format'
import { normalizeNipDigits, parseWykazAddress, type CompanyLookupResult } from '../lib/company-lookup'
import type { BuyerValue } from '../lib/buyer-snapshot'

export type { BuyerValue } from '../lib/buyer-snapshot'
export { buyerToSnapshot, snapshotToBuyer, buyerFromMetadata } from '../lib/buyer-snapshot'

type VatTagVariant = 'success' | 'warning' | 'error' | 'neutral'
function vatStatusVariant(status: string | null): VatTagVariant {
  if (!status) return 'neutral'
  const s = status.toLowerCase()
  if (s.startsWith('czynny')) return 'success'
  if (s.startsWith('zwolnion')) return 'warning'
  if (s.startsWith('niezarejestrow')) return 'error'
  return 'neutral'
}

// Matches the field-label style used across the invoice form (PlVatMetaForm, CrudForm builtins).
// These were 12px muted while the section above them used 14px foreground, so the same form showed
// two different label treatments depending on which component rendered the field.
const labelClass = 'text-sm font-medium text-foreground'

/** PL first (the common case), then the EU member states, then a few frequent non-EU partners. */
const BUYER_COUNTRIES = [
  'PL',
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'GB', 'CH', 'NO', 'US', 'UA',
] as const
type LookupState = 'idle' | 'searching' | 'unavailable' | 'not_found'
type CustomerSuggestion = { id: string; label: string }
type CustomerCompanyListItem = {
  id?: string | null
  displayName?: string | null
  display_name?: string | null
  legalName?: string | null
  legal_name?: string | null
  city?: string | null
  industry?: string | null
}
type CustomerCompanyAddress = {
  addressLine1?: string | null
  addressLine2?: string | null
  buildingNumber?: string | null
  flatNumber?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  isPrimary?: boolean | null
}
type CustomerCompanyDetail = {
  addresses?: CustomerCompanyAddress[] | null
}

export type BuyerFieldsProps = {
  /** Submit-time errors keyed as `buyer.<field>`, so the offending input is marked, not just listed. */
  errors?: Record<string, string>
  value: BuyerValue
  onChange: (next: BuyerValue) => void
  disabled?: boolean
}

/**
 * Commercial-grade buyer editor (SPEC-014): a searchable customer picker (company name, backed by
 * core `/api/customers/companies`, with free entry), a NIP field with a "Look up" action that
 * autofills name + address + VAT status from the MF "Wykaz podatników VAT" register, inline NIP
 * checksum validation, and address fields. Controlled; persisted by the parent to
 * `metadata.buyerSnapshot`. DS tokens + `@open-mercato/ui` primitives only.
 */
export function BuyerFields({ value, onChange, disabled, errors }: BuyerFieldsProps) {
  const errorFor = (key: string) => errors?.[`buyer.${key}`]
  const t = useT()
  const busy = Boolean(disabled)
  const [lookupState, setLookupState] = React.useState<LookupState>('idle')
  const [vatStatus, setVatStatus] = React.useState<string | null>(null)
  const customerSuggestionsRef = React.useRef(new Map<string, CustomerSuggestion>())
  const selectedCustomerIdRef = React.useRef<string | null>(null)
  const customerSelectionDirtiesRef = React.useRef<Set<keyof BuyerValue>>(new Set())

  // Keep a ref to the latest value so the ASYNC lookup merges against the operator's current edits
  // (not the snapshot captured when the request started) — otherwise an in-flight lookup reverts a
  // field the user typed while it was loading (code-jury, Codex).
  const valueRef = React.useRef(value)
  React.useEffect(() => {
    valueRef.current = value
  }, [value])

  const patch = React.useCallback(
    (next: Partial<BuyerValue>) => onChange({ ...valueRef.current, ...next }),
    [onChange],
  )

  // A non-Polish buyer is identified by an EU VAT ID, not a Polish NIP — the field, its validation
  // and the GUS lookup (which only knows Polish taxpayers) all switch with the country.
  const isPolishBuyer = ((value.countryCode ?? 'PL').trim().toUpperCase() || 'PL') === 'PL'
  const nipDigits = normalizeNipDigits(value.nip ?? '')
  // Flag any non-empty NIP field whose value isn't a valid NIP — including letters that normalise to ''
  // — so the inline state matches the save-time validation (code-jury r2, Codex).
  const nipInvalid = ((value.nip ?? '').trim().length > 0 && !isValidPolishNip(nipDigits)) || Boolean(errors?.['buyer.nip'])
  const postalRaw = (value.postalCode ?? '').trim()
  const countryIsPl = ((value.countryCode ?? 'PL').trim().toUpperCase() || 'PL') === 'PL'
  const postalInvalid = postalRaw.length > 0 && countryIsPl && !isValidPolishPostalCode(postalRaw)

  const trimText = React.useCallback((next?: string | null) => (next ?? '').trim(), [])

  const composeCustomerAddressLine1 = React.useCallback(
    (address?: CustomerCompanyAddress) => {
      if (!address) return ''
      const line1 = trimText(address.addressLine1)
      const building = trimText(address.buildingNumber)
      const flat = trimText(address.flatNumber)
      const number = building && flat ? `${building}/${flat}` : building || flat
      if (!number) return line1
      if (!line1) return number
      return line1.includes(number) ? line1 : `${line1} ${number}`
    },
    [trimText],
  )

  const markCustomerSelectionDirty = React.useCallback((field: keyof BuyerValue) => {
    if (selectedCustomerIdRef.current) customerSelectionDirtiesRef.current.add(field)
  }, [])

  const loadSelectedCustomerAddress = React.useCallback(
    async (selected: CustomerSuggestion) => {
      try {
        const res = await apiCall<CustomerCompanyDetail>(
          `/api/customers/companies/${encodeURIComponent(selected.id)}?include=addresses`,
        )
        if (selectedCustomerIdRef.current !== selected.id || !res.ok || !res.result) return
        const address = res.result.addresses?.find((a) => a.isPrimary) ?? res.result.addresses?.[0]
        const dirty = customerSelectionDirtiesRef.current
        const latest = valueRef.current
        onChange({
          ...latest,
          companyName: selected.label,
          addressLine1: dirty.has('addressLine1') ? latest.addressLine1 : composeCustomerAddressLine1(address),
          addressLine2: dirty.has('addressLine2') ? latest.addressLine2 : trimText(address?.addressLine2),
          postalCode: dirty.has('postalCode') ? latest.postalCode : trimText(address?.postalCode),
          city: dirty.has('city') ? latest.city : trimText(address?.city),
          countryCode: dirty.has('countryCode')
            ? latest.countryCode
            : trimText(address?.country).toUpperCase() || 'PL',
        })
      } catch {
        // Customers is an optional module dependency for this picker; manual buyer entry remains available.
      }
    },
    [composeCustomerAddressLine1, onChange, trimText],
  )

  const loadCustomerSuggestions = React.useCallback(async (query?: string): Promise<ComboboxOption[]> => {
    const q = (query ?? '').trim()
    customerSuggestionsRef.current = new Map()
    try {
      const url =
        q.length >= 2
          ? `/api/customers/companies?search=${encodeURIComponent(q)}&pageSize=10`
          : `/api/customers/companies?pageSize=10`
      const res = await apiCall<{ items?: CustomerCompanyListItem[] }>(
        url,
      )
      if (!res.ok || !res.result?.items) return []
      const nextMap = new Map<string, CustomerSuggestion>()
      const out: ComboboxOption[] = []
      for (const c of res.result.items) {
        const id = trimText(c.id)
        const label = trimText(c.displayName || c.display_name || c.legalName || c.legal_name)
        if (id && label && !nextMap.has(id)) {
          const description = [trimText(c.city), trimText(c.industry)].filter(Boolean).join(' / ')
          nextMap.set(id, { id, label })
          out.push({ value: id, label, ...(description ? { description } : {}) })
        }
      }
      customerSuggestionsRef.current = nextMap
      return out
    } catch {
      customerSuggestionsRef.current = new Map()
      return []
    }
  }, [trimText])

  // Preserve a typed name, but prefer register address values on explicit lookup. Merge against
  // `valueRef.current` (the latest value), so edits made during the in-flight lookup survive.
  const applyCompany = React.useCallback(
    (company: Extract<CompanyLookupResult, { ok: true }>['company']) => {
      const latest = valueRef.current
      const parsed = parseWykazAddress(company.address)
      const keepOr = (current: string | undefined, incoming: string) =>
        current && current.trim() ? current : incoming
      const preferIncoming = (incoming: string, current: string | undefined) =>
        incoming && incoming.trim() ? incoming : (current ?? '')
      onChange({
        ...latest,
        companyName: keepOr(latest.companyName, company.name ?? ''),
        addressLine1: preferIncoming(parsed.addressLine1, latest.addressLine1),
        postalCode: preferIncoming(parsed.postalCode, latest.postalCode),
        city: preferIncoming(parsed.city, latest.city),
        countryCode: latest.countryCode && latest.countryCode.trim() ? latest.countryCode : 'PL',
      })
      setVatStatus(company.statusVat)
    },
    [onChange],
  )

  const runLookup = React.useCallback(async () => {
    if (busy) return
    const requestedNip = nipDigits
    if (!isValidPolishNip(requestedNip)) return
    setLookupState('searching')
    setVatStatus(null)
    try {
      const res = await apiCall<CompanyLookupResult>(
        `/api/financial_pl/ksef/company-lookup?nip=${encodeURIComponent(requestedNip)}`,
      )
      // Discard a stale response if the operator changed the NIP while it was in flight — otherwise the
      // PREVIOUS NIP's name/address/VAT status would fill against a now-different NIP, persisting a
      // buyerSnapshot whose company details don't match its NIP (code-jury, Codex).
      if (normalizeNipDigits(valueRef.current.nip ?? '') !== requestedNip) {
        setLookupState('idle')
        return
      }
      if (res.ok && res.result?.ok) {
        applyCompany(res.result.company)
        setLookupState('idle')
        return
      }
      const reason = res.result && !res.result.ok ? res.result.reason : 'unavailable'
      setLookupState(reason === 'not_found' ? 'not_found' : 'unavailable')
    } catch {
      setLookupState('unavailable')
    }
  }, [applyCompany, busy, nipDigits])

  return (
    <div className="@container flex flex-col gap-4">
      {/*
        NIP first: the operator types it, presses Look up, and the name and address are filled
        from the registry. Asking for the name first inverted the flow — it invited typing by
        hand what the lookup was about to overwrite.
      */}
      <div className="flex flex-col gap-2">
        <label
          className={labelClass}
          htmlFor={isPolishBuyer ? 'financial_pl-buyer-nip' : 'financial_pl-buyer-eu-vat-id'}
        >
          {isPolishBuyer
            ? t('financial_pl.buyer.nip', 'Buyer NIP')
            : t('financial_pl.buyer.euVatId', 'Buyer EU VAT ID')}
        </label>
        <div className="flex items-start gap-4">
          <div className="flex flex-1 flex-col gap-1">
            {isPolishBuyer ? (
              <Input
                id="financial_pl-buyer-nip"
                inputMode="numeric"
                value={value.nip ?? ''}
                disabled={busy}
                onChange={(event) => {
                  patch({ nip: event.target.value })
                  if (lookupState !== 'idle') setLookupState('idle')
                }}
                placeholder="1234567890"
                aria-invalid={nipInvalid || undefined}
              />
            ) : (
              <Input
                id="financial_pl-buyer-eu-vat-id"
                value={value.euVatId ?? ''}
                disabled={busy}
                onChange={(event) => patch({ euVatId: event.target.value.toUpperCase() })}
                placeholder="DE123456789"
              />
            )}
            {isPolishBuyer && nipInvalid ? (
              <span className="text-xs text-status-error-text">
                {t('financial_pl.validation.nipChecksum', 'Invalid NIP (checksum failed).')}
              </span>
            ) : null}
          </div>
          {/* The registry lookup is Polish-only, so it is not offered for a foreign buyer. */}
          {isPolishBuyer ? (
            <Button
              type="button"
              variant="outline"
              size="default"
              disabled={busy || lookupState === 'searching' || !isValidPolishNip(nipDigits)}
              onClick={() => void runLookup()}
            >
              {lookupState === 'searching' ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Search className="mr-1 size-4" />
              )}
              {t('financial_pl.buyer.lookup', 'Look up')}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          {vatStatus ? (
            <Tag variant={vatStatusVariant(vatStatus)} dot>
              {t('financial_pl.buyer.vatStatus', 'VAT status')}: {vatStatus}
            </Tag>
          ) : null}
          {lookupState === 'unavailable' ? (
            <span className="text-xs text-muted-foreground">
              {t('financial_pl.buyer.lookupUnavailable', 'Lookup unavailable — enter the buyer manually.')}
            </span>
          ) : null}
          {lookupState === 'not_found' ? (
            <span className="text-xs text-muted-foreground">
              {t('financial_pl.buyer.lookupNotFound', 'No active taxpayer found for this NIP.')}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className={labelClass} htmlFor="financial_pl-buyer-name">
          {t('financial_pl.buyer.companyName', 'Buyer name')}
        </label>
        <div
          data-invalid={errorFor('companyName') ? 'true' : undefined}
          className={errorFor('companyName') ? '[&_input]:border-destructive' : undefined}
        >
        <ComboboxInput
          value={value.companyName ?? ''}
          onChange={(next) => {
            const selected = customerSuggestionsRef.current.get(next)
            if (selected) {
              selectedCustomerIdRef.current = selected.id
              customerSelectionDirtiesRef.current.clear()
              patch({
                companyName: selected.label,
                addressLine1: '',
                addressLine2: '',
                postalCode: '',
                city: '',
                countryCode: 'PL',
              })
              void loadSelectedCustomerAddress(selected)
              return
            }
            selectedCustomerIdRef.current = null
            customerSelectionDirtiesRef.current.clear()
            patch({ companyName: next })
          }}
          loadSuggestions={loadCustomerSuggestions}
          allowCustomValues
          disabled={busy}
          placeholder={t('financial_pl.buyer.companyNamePlaceholder', 'Search customers or type a name')}
        />
        </div>
        {errorFor('companyName') ? (
          <span className="text-xs text-status-error-text">{errorFor('companyName')}</span>
        ) : null}
      </div>

      {/* Country sits with the buyer's identity rather than at the end of the address: it decides
          whether the tax id above is a Polish NIP or an EU VAT ID, so it is answered early. */}
      <div className="flex flex-col gap-2">
        <label className={labelClass} htmlFor="financial_pl-buyer-country">
          {t('financial_pl.buyer.country', 'Country')}
        </label>
        <Select
          value={(value.countryCode ?? 'PL').toUpperCase()}
          disabled={busy}
          onValueChange={(next) => {
            markCustomerSelectionDirty('countryCode')
            patch({ countryCode: next })
          }}
        >
          <SelectTrigger id="financial_pl-buyer-country" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {BUYER_COUNTRIES.map((code) => (
              <SelectItem key={code} value={code}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 @md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-buyer-line1">
            {t('financial_pl.buyer.addressLine1', 'Address line 1')}
            <span aria-hidden="true" className="text-status-error-text"> *</span>
          </label>
          <Input
            id="financial_pl-buyer-line1"
            value={value.addressLine1 ?? ''}
            disabled={busy}
            aria-invalid={errorFor('addressLine1') ? true : undefined}
            onChange={(event) => {
              markCustomerSelectionDirty('addressLine1')
              patch({ addressLine1: event.target.value })
            }}
          />
          {errorFor('addressLine1') ? (
            <span className="text-xs text-status-error-text">{errorFor('addressLine1')}</span>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-buyer-line2">
            {t('financial_pl.buyer.addressLine2', 'Address line 2 (optional)')}
          </label>
          <Input
            id="financial_pl-buyer-line2"
            value={value.addressLine2 ?? ''}
            disabled={busy}
            onChange={(event) => {
              markCustomerSelectionDirty('addressLine2')
              patch({ addressLine2: event.target.value })
            }}
          />
        </div>
      </div>

      {/* Postal code and city are one fact read together — `@xs` rather than `@md` so they pair
          inside the ~340px buyer column, not only at full page width. Split unevenly: a Polish
          postal code is a fixed six characters, while a town name is not, so equal halves wasted
          room on the code and truncated the town. */}
      <div className="grid grid-cols-1 gap-4 @xs:grid-cols-[minmax(0,0.55fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-buyer-postal">
            {t('financial_pl.buyer.postalCode', 'Postal code')}
          </label>
          <Input
            id="financial_pl-buyer-postal"
            value={value.postalCode ?? ''}
            disabled={busy}
            onChange={(event) => {
              markCustomerSelectionDirty('postalCode')
              patch({ postalCode: event.target.value })
            }}
            placeholder="00-000"
            aria-invalid={postalInvalid || undefined}
          />
          {postalInvalid ? (
            <span className="text-xs text-status-error-text">
              {t('financial_pl.validation.postalCode', 'Enter a valid Polish postal code (NN-NNN).')}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="financial_pl-buyer-city">
            {t('financial_pl.buyer.city', 'City')}
          </label>
          <Input
            id="financial_pl-buyer-city"
            value={value.city ?? ''}
            disabled={busy}
            onChange={(event) => {
              markCustomerSelectionDirty('city')
              patch({ city: event.target.value })
            }}
          />
        </div>
      </div>
    </div>
  )
}

export default BuyerFields
