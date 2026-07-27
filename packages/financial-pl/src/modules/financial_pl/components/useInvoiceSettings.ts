'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { PaymentAccountOption } from './PaymentFields'

export type InvoiceSettingsDto = {
  logoDataUrl?: string | null
  footerNote?: string | null
  defaultPaymentMethod?: string | null
  defaultTermDays?: number | null
  defaultTaxRate?: string | null
  defaultCurrencyCode?: string | null
  defaultPriceMode?: string | null
  bankAccounts?: PaymentAccountOption[]
}

/**
 * Per-organization invoice settings.
 *
 * Shared by the invoice form (account list + create-mode defaults) and by every screen that renders
 * the document, which needs the logo and footer note — those are stored here and printed there, so
 * a second copy of this fetch would be a second chance for the two to disagree.
 */
export function useInvoiceSettings(): InvoiceSettingsDto | null {
  const [settings, setSettings] = React.useState<InvoiceSettingsDto | null>(null)
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
  }, [])
  return settings
}

export default useInvoiceSettings
