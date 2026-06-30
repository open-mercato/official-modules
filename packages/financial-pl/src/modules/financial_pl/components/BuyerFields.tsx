'use client'

import * as React from 'react'
import { Search, Loader2 } from 'lucide-react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Button } from '@open-mercato/ui/primitives/button'
import { Tag } from '@open-mercato/ui/primitives/tag'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { isValidPolishNip } from '../lib/nip'
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

const labelClass = 'text-xs text-muted-foreground'
type LookupState = 'idle' | 'searching' | 'unavailable' | 'not_found'

export type BuyerFieldsProps = {
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
export function BuyerFields({ value, onChange, disabled }: BuyerFieldsProps) {
  const t = useT()
  const busy = Boolean(disabled)
  const [lookupState, setLookupState] = React.useState<LookupState>('idle')
  const [vatStatus, setVatStatus] = React.useState<string | null>(null)

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

  const nipDigits = normalizeNipDigits(value.nip ?? '')
  // Flag any non-empty NIP field whose value isn't a valid NIP — including letters that normalise to ''
  // — so the inline state matches the save-time validation (code-jury r2, Codex).
  const nipInvalid = (value.nip ?? '').trim().length > 0 && !isValidPolishNip(nipDigits)

  const loadCustomerSuggestions = React.useCallback(async (query?: string) => {
    const q = (query ?? '').trim()
    if (q.length < 2) return []
    try {
      const res = await apiCall<{ items?: Array<{ displayName?: string | null; legalName?: string | null }> }>(
        `/api/customers/companies?search=${encodeURIComponent(q)}&pageSize=10`,
      )
      if (!res.ok || !res.result?.items) return []
      const seen = new Set<string>()
      const out: string[] = []
      for (const c of res.result.items) {
        const name = (c.displayName || c.legalName || '').trim()
        if (name && !seen.has(name)) {
          seen.add(name)
          out.push(name)
        }
      }
      return out
    } catch {
      return []
    }
  }, [])

  // Fill only BLANK fields — never silently overwrite what the operator already typed. Merges
  // against `valueRef.current` (the latest value), so edits made during the in-flight lookup survive.
  const applyCompany = React.useCallback(
    (company: Extract<CompanyLookupResult, { ok: true }>['company']) => {
      const latest = valueRef.current
      const parsed = parseWykazAddress(company.address)
      const keepOr = (current: string | undefined, incoming: string) =>
        current && current.trim() ? current : incoming
      onChange({
        ...latest,
        companyName: keepOr(latest.companyName, company.name ?? ''),
        addressLine1: keepOr(latest.addressLine1, parsed.addressLine1),
        postalCode: keepOr(latest.postalCode, parsed.postalCode),
        city: keepOr(latest.city, parsed.city),
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
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-col gap-1.5">
        <label className={labelClass} htmlFor="financial_pl-buyer-name">
          {t('financial_pl.buyer.companyName', 'Buyer name')}
        </label>
        <ComboboxInput
          value={value.companyName ?? ''}
          onChange={(next) => patch({ companyName: next })}
          loadSuggestions={loadCustomerSuggestions}
          allowCustomValues
          disabled={busy}
          placeholder={t('financial_pl.buyer.companyNamePlaceholder', 'Search customers or type a name')}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={labelClass} htmlFor="financial_pl-buyer-nip">
          {t('financial_pl.buyer.nip', 'Buyer NIP')}
        </label>
        <div className="flex items-start gap-2">
          <div className="flex flex-1 flex-col gap-1">
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
            {nipInvalid ? (
              <span className="text-xs text-status-error-text">
                {t('financial_pl.validation.nipChecksum', 'Invalid NIP (checksum failed).')}
              </span>
            ) : null}
          </div>
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
        </div>
        <div className="flex items-center gap-2">
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

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-buyer-line1">
            {t('financial_pl.buyer.addressLine1', 'Address line 1')}
          </label>
          <Input
            id="financial_pl-buyer-line1"
            value={value.addressLine1 ?? ''}
            disabled={busy}
            onChange={(event) => patch({ addressLine1: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-buyer-line2">
            {t('financial_pl.buyer.addressLine2', 'Address line 2 (optional)')}
          </label>
          <Input
            id="financial_pl-buyer-line2"
            value={value.addressLine2 ?? ''}
            disabled={busy}
            onChange={(event) => patch({ addressLine2: event.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-buyer-postal">
            {t('financial_pl.buyer.postalCode', 'Postal code')}
          </label>
          <Input
            id="financial_pl-buyer-postal"
            value={value.postalCode ?? ''}
            disabled={busy}
            onChange={(event) => patch({ postalCode: event.target.value })}
            placeholder="00-000"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-buyer-city">
            {t('financial_pl.buyer.city', 'City')}
          </label>
          <Input
            id="financial_pl-buyer-city"
            value={value.city ?? ''}
            disabled={busy}
            onChange={(event) => patch({ city: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="financial_pl-buyer-country">
            {t('financial_pl.buyer.country', 'Country')}
          </label>
          <Input
            id="financial_pl-buyer-country"
            value={value.countryCode ?? ''}
            disabled={busy}
            maxLength={2}
            onChange={(event) => patch({ countryCode: event.target.value.toUpperCase() })}
            placeholder="PL"
          />
        </div>
      </div>
    </div>
  )
}

export default BuyerFields
