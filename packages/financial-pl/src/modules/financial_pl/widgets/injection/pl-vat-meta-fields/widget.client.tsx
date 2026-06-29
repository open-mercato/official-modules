'use client'

import * as React from 'react'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { SwitchField } from '@open-mercato/ui/primitives/switch-field'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { CustomFieldProps } from '@open-mercato/shared/modules/widgets/injection'
import {
  GTU_CODES,
  JPK_PROCEDURE_MARKINGS,
  JPK_TYP_DOKUMENTU,
  type GtuCode,
  type JpkProcedureMarking,
  type JpkTypDokumentu,
} from '../../../lib/jpk-markings-codes'

type InvoiceKind = 'vat' | 'zal' | 'roz' | 'upr' | 'kor_zal' | 'kor_roz'

type MetaItem = {
  salesInvoiceId?: string
  contextNip?: string | null
  mppRequired?: boolean
  vatExemptionBasis?: string | null
  invoiceKind?: InvoiceKind
  selfBilling?: boolean
  reverseCharge?: boolean
  ossProcedure?: boolean
  consumptionCountryCode?: string | null
  gtuCodes?: string[]
  procedureMarkings?: Partial<Record<JpkProcedureMarking, boolean>>
  typDokumentu?: JpkTypDokumentu | null
  updatedAt?: string | null
}

const INVOICE_META_PATH = '/api/financial_pl/ksef/invoice-meta'

const INVOICE_KINDS: readonly InvoiceKind[] = ['vat', 'zal', 'roz', 'upr', 'kor_zal', 'kor_roz']

// EU consumption countries available for an OSS distance sale (ISO alpha-2). PL is
// excluded — an OSS line is by definition taxed in another member state.
const OSS_CONSUMPTION_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'EL', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const

const NONE_VALUE = '__none__'

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
  const [invoiceKind, setInvoiceKind] = React.useState<InvoiceKind>('vat')
  const [selfBilling, setSelfBilling] = React.useState(false)
  const [reverseCharge, setReverseCharge] = React.useState(false)
  const [ossProcedure, setOssProcedure] = React.useState(false)
  const [consumptionCountryCode, setConsumptionCountryCode] = React.useState<string>('')
  const [gtuCodes, setGtuCodes] = React.useState<GtuCode[]>([])
  const [procedureMarkings, setProcedureMarkings] = React.useState<Record<JpkProcedureMarking, boolean>>(
    () => Object.fromEntries(JPK_PROCEDURE_MARKINGS.map((c) => [c, false])) as Record<JpkProcedureMarking, boolean>,
  )
  const [typDokumentu, setTypDokumentu] = React.useState<JpkTypDokumentu | ''>('')
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
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
        setInvoiceKind(item?.invoiceKind ?? 'vat')
        setSelfBilling(Boolean(item?.selfBilling))
        setReverseCharge(Boolean(item?.reverseCharge))
        setOssProcedure(Boolean(item?.ossProcedure))
        setConsumptionCountryCode(item?.consumptionCountryCode ?? '')
        setGtuCodes((item?.gtuCodes ?? []).filter((c): c is GtuCode => (GTU_CODES as readonly string[]).includes(c)))
        setProcedureMarkings(
          Object.fromEntries(
            JPK_PROCEDURE_MARKINGS.map((c) => [c, Boolean(item?.procedureMarkings?.[c])]),
          ) as Record<JpkProcedureMarking, boolean>,
        )
        setTypDokumentu(item?.typDokumentu ?? '')
        setUpdatedAt(item?.updatedAt ?? null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [salesInvoiceId])

  const toggleGtu = React.useCallback((code: GtuCode, next: boolean) => {
    setGtuCodes((prev) => (next ? Array.from(new Set([...prev, code])) : prev.filter((c) => c !== code)))
  }, [])

  const toggleProcedure = React.useCallback((code: JpkProcedureMarking, next: boolean) => {
    setProcedureMarkings((prev) => ({ ...prev, [code]: next }))
  }, [])

  const handleSave = React.useCallback(async () => {
    if (!salesInvoiceId) return
    const payload = {
      salesInvoiceId,
      contextNip: contextNip.trim().length > 0 ? contextNip.trim() : null,
      mppRequired,
      vatExemptionBasis: vatExemptionBasis.trim().length > 0 ? vatExemptionBasis.trim() : null,
      invoiceKind,
      selfBilling,
      reverseCharge,
      ossProcedure,
      consumptionCountryCode: ossProcedure && consumptionCountryCode ? consumptionCountryCode : null,
      gtuCodes,
      procedureMarkings,
      typDokumentu: typDokumentu || null,
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
        context: { retryLastMutation },
        mutationPayload: payload,
      })
      flash(t('financial_pl.fields.plVatMetaSaved', 'Polish VAT metadata saved.'), 'success')
    } catch (err) {
      flash(err instanceof Error ? err.message : t('financial_pl.errors.meta_save_failed', 'Failed to save the Polish VAT metadata.'), 'error')
    } finally {
      setSaving(false)
    }
  }, [
    salesInvoiceId,
    contextNip,
    mppRequired,
    vatExemptionBasis,
    invoiceKind,
    selfBilling,
    reverseCharge,
    ossProcedure,
    consumptionCountryCode,
    gtuCodes,
    procedureMarkings,
    typDokumentu,
    updatedAt,
    runMutation,
    retryLastMutation,
    t,
  ])

  if (!salesInvoiceId) return null
  if (loading) return <LoadingMessage label={t('financial_pl.fields.plVatMeta', 'Polish VAT metadata')} />

  const busy = disabled || saving

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
          disabled={busy}
          onChange={(event) => setContextNip(event.target.value)}
          placeholder="1234567890"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-invoice-kind">
          {t('financial_pl.fields.invoiceKind', 'Invoice kind')}
        </label>
        <Select
          value={invoiceKind}
          onValueChange={(value) => setInvoiceKind((value as InvoiceKind) || 'vat')}
          disabled={busy}
        >
          <SelectTrigger id="financial_pl-invoice-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INVOICE_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kind.toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SwitchField
        label={t('financial_pl.fields.mppRequired', 'Split payment (MPP) required')}
        checked={mppRequired}
        disabled={busy}
        onCheckedChange={(next) => setMppRequired(Boolean(next))}
      />

      <SwitchField
        label={t('financial_pl.fields.selfBilling', 'Self-billing (samofakturowanie)')}
        checked={selfBilling}
        disabled={busy}
        onCheckedChange={(next) => setSelfBilling(Boolean(next))}
      />

      <SwitchField
        label={t('financial_pl.fields.reverseCharge', 'Reverse charge')}
        checked={reverseCharge}
        disabled={busy}
        onCheckedChange={(next) => setReverseCharge(Boolean(next))}
      />

      <SwitchField
        label={t('financial_pl.fields.ossProcedure', 'OSS / WSTO_EE distance sale')}
        checked={ossProcedure}
        disabled={busy}
        onCheckedChange={(next) => setOssProcedure(Boolean(next))}
      />

      {ossProcedure ? (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-consumption-country">
            {t('financial_pl.fields.consumptionCountry', 'Consumption country (OSS)')}
          </label>
          <Select
            value={consumptionCountryCode || NONE_VALUE}
            onValueChange={(value) => setConsumptionCountryCode(value === NONE_VALUE ? '' : value)}
            disabled={busy}
          >
            <SelectTrigger id="financial_pl-consumption-country" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>—</SelectItem>
              {OSS_CONSUMPTION_COUNTRIES.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-typ-dokumentu">
          {t('financial_pl.fields.typDokumentu', 'Document type (JPK)')}
        </label>
        <Select
          value={typDokumentu || NONE_VALUE}
          onValueChange={(value) => setTypDokumentu(value === NONE_VALUE ? '' : (value as JpkTypDokumentu))}
          disabled={busy}
        >
          <SelectTrigger id="financial_pl-typ-dokumentu" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>—</SelectItem>
            {JPK_TYP_DOKUMENTU.map((code) => (
              <SelectItem key={code} value={code}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t('financial_pl.fields.gtuGroup', 'GTU markings (JPK)')}
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {GTU_CODES.map((code) => (
            <CheckboxField
              key={code}
              label={t(`financial_pl.fields.gtu.${code}`, code)}
              checked={gtuCodes.includes(code)}
              disabled={busy}
              onCheckedChange={(next) => toggleGtu(code, Boolean(next))}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t('financial_pl.fields.procedureGroup', 'JPK procedure markings')}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {JPK_PROCEDURE_MARKINGS.map((code) => (
            <CheckboxField
              key={code}
              label={t(`financial_pl.fields.procedure.${code}`, code)}
              checked={procedureMarkings[code]}
              disabled={busy}
              onCheckedChange={(next) => toggleProcedure(code, Boolean(next))}
            />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-vat-exemption">
          {t('financial_pl.fields.vatExemptionBasis', 'VAT exemption legal basis')}
        </label>
        <Textarea
          id="financial_pl-vat-exemption"
          value={vatExemptionBasis}
          disabled={busy}
          onChange={(event) => setVatExemptionBasis(event.target.value)}
          rows={2}
        />
      </div>

      <div className="flex">
        <Button type="button" onClick={handleSave} disabled={busy}>
          {t('financial_pl.fields.plVatMetaSave', 'Save Polish VAT metadata')}
        </Button>
      </div>
    </div>
  )
}
