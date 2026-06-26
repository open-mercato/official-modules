'use client'

import * as React from 'react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { SwitchField } from '@open-mercato/ui/primitives/switch-field'
import { Button } from '@open-mercato/ui/primitives/button'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { CustomFieldProps } from '@open-mercato/shared/modules/widgets/injection'

type MetaItem = {
  salesInvoiceId?: string
  contextNip?: string | null
  mppRequired?: boolean
  vatExemptionBasis?: string | null
  updatedAt?: string | null
}

const INVOICE_META_PATH = '/api/financial_pl/ksef/invoice-meta'

/**
 * Self-contained PL VAT metadata panel injected into the sales-invoice CrudForm.
 * Loads the existing `SalesInvoicePlMeta` row by invoice id and persists edits
 * through the financial_pl invoice-meta API (wrapped in `useGuardedMutation`),
 * independent of the host form's submit cycle.
 */
export default function PlVatMetaPanel({ context, disabled }: CustomFieldProps) {
  const t = useT()
  const record = (context as { record?: Record<string, unknown> } | undefined)?.record
  const salesInvoiceId = typeof record?.id === 'string' ? record.id : null

  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [contextNip, setContextNip] = React.useState('')
  const [mppRequired, setMppRequired] = React.useState(false)
  const [vatExemptionBasis, setVatExemptionBasis] = React.useState('')
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null)

  const { runMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'financial_pl.pl-vat-meta',
  })

  React.useEffect(() => {
    if (!salesInvoiceId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    apiCall<{ item: MetaItem | null }>(`${INVOICE_META_PATH}?salesInvoiceId=${encodeURIComponent(salesInvoiceId)}`)
      .then((res) => {
        if (cancelled) return
        const item = res.result?.item ?? null
        setContextNip(item?.contextNip ?? '')
        setMppRequired(Boolean(item?.mppRequired))
        setVatExemptionBasis(item?.vatExemptionBasis ?? '')
        setUpdatedAt(item?.updatedAt ?? null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [salesInvoiceId])

  const handleSave = React.useCallback(async () => {
    if (!salesInvoiceId) return
    const payload = {
      salesInvoiceId,
      contextNip: contextNip.trim().length > 0 ? contextNip.trim() : null,
      mppRequired,
      vatExemptionBasis: vatExemptionBasis.trim().length > 0 ? vatExemptionBasis.trim() : null,
    }
    setSaving(true)
    try {
      await runMutation({
        operation: async () => {
          const call = await apiCall(INVOICE_META_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...buildOptimisticLockHeader(updatedAt) },
            body: JSON.stringify(payload),
          })
          if (!call.ok) {
            const message =
              call.result && typeof call.result === 'object' && 'error' in call.result
                ? String((call.result as { error?: unknown }).error ?? '')
                : ''
            throw new Error(message || t('financial_pl.errors.meta_save_failed', 'Failed to save the Polish VAT metadata.'))
          }
          return call
        },
        context: { retryLastMutation: async () => false },
        mutationPayload: payload,
      })
      flash(t('financial_pl.fields.plVatMetaSaved', 'Polish VAT metadata saved.'), 'success')
    } catch (err) {
      flash(err instanceof Error ? err.message : t('financial_pl.errors.meta_save_failed', 'Failed to save the Polish VAT metadata.'), 'error')
    } finally {
      setSaving(false)
    }
  }, [salesInvoiceId, contextNip, mppRequired, vatExemptionBasis, updatedAt, runMutation, t])

  if (!salesInvoiceId) return null
  if (loading) return <LoadingMessage label={t('financial_pl.fields.plVatMeta', 'Polish VAT metadata')} />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-context-nip">
          {t('financial_pl.fields.contextNip', 'Taxpayer NIP')}
        </label>
        <Input
          id="financial_pl-context-nip"
          inputMode="numeric"
          value={contextNip}
          disabled={disabled || saving}
          onChange={(event) => setContextNip(event.target.value)}
          placeholder="1234567890"
        />
      </div>

      <SwitchField
        label={t('financial_pl.fields.mppRequired', 'Split payment (MPP) required')}
        checked={mppRequired}
        disabled={disabled || saving}
        onCheckedChange={(next) => setMppRequired(Boolean(next))}
      />

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-vat-exemption">
          {t('financial_pl.fields.vatExemptionBasis', 'VAT exemption legal basis')}
        </label>
        <Textarea
          id="financial_pl-vat-exemption"
          value={vatExemptionBasis}
          disabled={disabled || saving}
          onChange={(event) => setVatExemptionBasis(event.target.value)}
          rows={2}
        />
      </div>

      <div className="flex">
        <Button type="button" onClick={handleSave} disabled={disabled || saving}>
          {t('financial_pl.fields.plVatMetaSave', 'Save Polish VAT metadata')}
        </Button>
      </div>
    </div>
  )
}
