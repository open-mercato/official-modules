'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { PaymentAccountOption } from './PaymentFields'
import type { InvoiceNumberingSeries } from '../data/entities'

export type InvoiceSettingsDto = {
  logoDataUrl?: string | null
  footerNote?: string | null
  defaultPaymentMethod?: string | null
  defaultTermDays?: number | null
  defaultTaxRate?: string | null
  defaultCurrencyCode?: string | null
  defaultPriceMode?: string | null
  bankAccounts?: PaymentAccountOption[]
  numberingSeries?: InvoiceNumberingSeries[]
}

/**
 * Per-organization invoice settings.
 *
 * Shared by the invoice form (account list + create-mode defaults) and by every screen that renders
 * the document, which needs the logo and footer note — those are stored here and printed there, so
 * a second copy of this fetch would be a second chance for the two to disagree.
 */
export function useInvoiceSettings(): { settings: InvoiceSettingsDto | null; refresh: () => void } {
  const [settings, setSettings] = React.useState<InvoiceSettingsDto | null>(null)
  // Bumped to re-run the fetch after the invoice form adds an account inline, so the picker shows
  // it without a page reload.
  const [nonce, setNonce] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await apiCall<{ settings?: InvoiceSettingsDto }>('/api/financial_pl/invoice-settings')
      if (cancelled || !res.ok) return
      setSettings(res.result?.settings ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [nonce])
  const refresh = React.useCallback(() => setNonce((prev) => prev + 1), [])
  return { settings, refresh }
}

export default useInvoiceSettings
