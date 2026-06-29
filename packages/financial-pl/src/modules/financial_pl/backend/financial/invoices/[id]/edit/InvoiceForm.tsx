'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { z } from 'zod'
import { CrudForm, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  InvoiceLinesField,
  withComputedTotals,
  type InvoiceLineInput,
} from '../../../../../components/InvoiceLinesField'
import { PlVatMetaForm, type InvoiceMeta } from '../../../../../components/PlVatMetaForm'

/** Header fields edited directly through the core sales invoice contract. */
type InvoiceHeaderValues = {
  invoiceNumber: string
  issueDate: string
  dueDate: string
  currencyCode: string
  orderId: string
}

/** Full controlled value of the invoice editor (header + lines + PL-VAT meta). */
export type InvoiceFormValue = {
  header: InvoiceHeaderValues
  lines: InvoiceLineInput[]
  meta: InvoiceMeta
  /** Present in edit mode — the meta row's updatedAt for optimistic locking, if known. */
  metaUpdatedAt?: string | null
}

export type InvoiceFormProps = {
  /** `undefined` in create mode; the invoice id in edit mode. */
  invoiceId?: string
  initialValue: InvoiceFormValue
  /** When true the form renders read-only (KSeF-locked invoice). */
  readOnly?: boolean
  /** Lock reason banner — rendered above the form when read-only. */
  lockNotice?: React.ReactNode
}

const DEFAULT_CURRENCY = 'PLN'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Build a fresh, empty header for create mode with sensible defaults. */
export function emptyHeader(): InvoiceHeaderValues {
  const today = new Date().toISOString().slice(0, 10)
  return { invoiceNumber: '', issueDate: today, dueDate: today, currencyCode: DEFAULT_CURRENCY, orderId: '' }
}

/** Build a default create-mode value with one starter line and empty meta. */
export function emptyInvoiceFormValue(): InvoiceFormValue {
  return {
    header: emptyHeader(),
    lines: [withComputedTotals(
      { name: '', quantity: '1', quantityUnit: '', unitPriceNet: '0', taxRate: '23', currencyCode: DEFAULT_CURRENCY, kind: 'product' },
      DEFAULT_CURRENCY,
      1,
    )],
    meta: {},
  }
}

/** Strip empty-string optionals so the core invoice schema receives only provided fields. */
function buildInvoiceHeaderPayload(header: InvoiceHeaderValues): Record<string, unknown> {
  const payload: Record<string, unknown> = { currencyCode: header.currencyCode.trim().toUpperCase() || DEFAULT_CURRENCY }
  const invoiceNumber = header.invoiceNumber.trim()
  if (invoiceNumber) payload.invoiceNumber = invoiceNumber
  const issueDate = header.issueDate.trim()
  if (issueDate) payload.issueDate = issueDate
  const dueDate = header.dueDate.trim()
  if (dueDate) payload.dueDate = dueDate
  const orderId = header.orderId.trim()
  if (orderId) payload.orderId = orderId
  return payload
}

/** Map editor lines to the core invoice-line wire shape (drop empty optionals). */
function buildLinesPayload(lines: InvoiceLineInput[], currencyCode: string): Array<Record<string, unknown>> {
  return lines.map((line, index) => {
    const computed = withComputedTotals(line, currencyCode, index + 1)
    const row: Record<string, unknown> = {
      name: computed.name,
      quantity: computed.quantity,
      unitPriceNet: computed.unitPriceNet,
      currencyCode,
      lineNumber: index + 1,
      kind: computed.kind ?? 'product',
    }
    if (computed.quantityUnit && computed.quantityUnit.trim()) row.quantityUnit = computed.quantityUnit.trim()
    if (computed.taxRate != null && computed.taxRate !== '') row.taxRate = computed.taxRate
    if (computed.taxAmount) row.taxAmount = computed.taxAmount
    if (computed.totalNetAmount) row.totalNetAmount = computed.totalNetAmount
    if (computed.totalGrossAmount) row.totalGrossAmount = computed.totalGrossAmount
    return row
  })
}

/** Map the controlled PL-VAT meta value to the invoice-meta PUT body (keyed by salesInvoiceId). */
function buildMetaPayload(salesInvoiceId: string, meta: InvoiceMeta): Record<string, unknown> {
  const body: Record<string, unknown> = { salesInvoiceId, ...meta }
  // Drop client-only empties that the schema would reject (e.g. partial NIP cleared to '').
  if (body.contextNip === '') body.contextNip = null
  if (body.consumptionCountryCode === '') body.consumptionCountryCode = null
  if (body.exchangeRate === '') body.exchangeRate = null
  if (body.exchangeRateDate === '') body.exchangeRateDate = null
  return body
}

type CreateResponse = { invoiceId?: string; id?: string }

/**
 * Shared invoice create/edit form (SPEC-013). Renders the core invoice header, the repeatable
 * line editor and the full PL-VAT meta editor in one CrudForm.
 *
 * Data flow:
 * - CREATE: POST /api/sales/invoices (header + lines) → read the new id → PUT invoice-meta →
 *   navigate to the new invoice's edit page (switch to edit mode; never re-POST so a failed meta
 *   step is retried in place, avoiding duplicate-create).
 * - EDIT: PUT /api/sales/invoices (id + header + FULL lines[]; core uses replace semantics) → PUT
 *   invoice-meta.
 *
 * All writes go through `useGuardedMutation().runMutation(...)` with a real `retryLastMutation`
 * injected into the mutation context so conflict-resolution widgets can re-drive the save.
 */
export function InvoiceForm({ invoiceId, initialValue, readOnly, lockNotice }: InvoiceFormProps) {
  const t = useT()
  const router = useRouter()
  const isEdit = Boolean(invoiceId)

  const [value, setValue] = React.useState<InvoiceFormValue>(initialValue)
  React.useEffect(() => {
    setValue(initialValue)
  }, [initialValue])

  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    invoiceId: string | null
    operation: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: 'financial_pl-invoice-form',
    blockedMessage: t('financial_pl.invoices.form.saveBlocked', 'Save was blocked. Resolve the conflict and try again.'),
  })

  const buildMutationContext = React.useCallback(
    (operation: string, id: string | null) => ({
      formId: 'financial_pl-invoice-form',
      invoiceId: id,
      operation,
      retryLastMutation,
    }),
    [retryLastMutation],
  )

  const setLines = React.useCallback((lines: InvoiceLineInput[]) => {
    setValue((prev) => ({ ...prev, lines }))
  }, [])
  const setMeta = React.useCallback((meta: InvoiceMeta) => {
    setValue((prev) => ({ ...prev, meta }))
  }, [])

  // --- Submit handler shared by create + edit -----------------------------------------------
  // Header values come straight from the CrudForm builtin fields (passed in by `onSubmit`) so the
  // payload reflects the latest edits without depending on async state propagation.
  const handleSubmit = React.useCallback(async (header: InvoiceHeaderValues) => {
    if (readOnly) return
    const effectiveCurrency = header.currencyCode.trim().toUpperCase() || DEFAULT_CURRENCY
    const linesPayload = buildLinesPayload(value.lines, effectiveCurrency)
    if (linesPayload.length < 1) {
      throw createCrudFormError(t('financial_pl.invoices.form.linesRequired', 'Add at least one invoice line.'))
    }
    if (value.lines.some((line) => !line.name.trim())) {
      throw createCrudFormError(t('financial_pl.invoices.form.lineNameRequired', 'Every invoice line needs a name.'))
    }
    const headerPayload = buildInvoiceHeaderPayload(header)

    if (isEdit && invoiceId) {
      // EDIT — replace semantics: always send the FULL lines[] (core deletes + recreates).
      const invoiceCall = await runMutation({
        operation: () =>
          apiCall<CreateResponse>('/api/sales/invoices', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: invoiceId, ...headerPayload, lines: linesPayload }),
          }),
        context: buildMutationContext('updateInvoice', invoiceId),
        mutationPayload: { id: invoiceId, ...headerPayload },
      })
      if (!invoiceCall.ok) {
        throw createCrudFormError(t('financial_pl.invoices.form.errors.saveInvoice', 'Failed to save the invoice.'))
      }
      const metaCall = await runMutation({
        operation: () =>
          apiCall(`/api/financial_pl/ksef/invoice-meta`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildMetaPayload(invoiceId, value.meta)),
          }),
        context: buildMutationContext('updateMeta', invoiceId),
        mutationPayload: { salesInvoiceId: invoiceId },
      })
      if (!metaCall.ok) {
        throw createCrudFormError(t('financial_pl.errors.meta_save_failed', 'Failed to save the Polish VAT metadata.'))
      }
      flash(t('financial_pl.invoices.form.savedEdit', 'Invoice saved.'), 'success')
      return
    }

    // CREATE — step 1: POST the base invoice (core persists lines + auto-numbers).
    const createCall = await runMutation({
      operation: () =>
        apiCall<CreateResponse>('/api/sales/invoices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...headerPayload, lines: linesPayload }),
        }),
      context: buildMutationContext('createInvoice', null),
      mutationPayload: { ...headerPayload },
    })
    if (!createCall.ok) {
      throw createCrudFormError(t('financial_pl.invoices.form.errors.createInvoice', 'Failed to create the invoice.'))
    }
    const newId = createCall.result?.invoiceId ?? createCall.result?.id ?? null
    if (!newId || !UUID_RE.test(newId)) {
      throw createCrudFormError(t('financial_pl.invoices.form.errors.createInvoice', 'Failed to create the invoice.'))
    }

    // CREATE — step 2: PUT the PL-VAT meta keyed by the new id. A failure here is non-fatal: the
    // invoice already exists, so we still switch to edit mode (never re-POST) so it can be retried.
    let metaOk = true
    try {
      const metaCall = await runMutation({
        operation: () =>
          apiCall(`/api/financial_pl/ksef/invoice-meta`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildMetaPayload(newId, value.meta)),
          }),
        context: buildMutationContext('createMeta', newId),
        mutationPayload: { salesInvoiceId: newId },
      })
      metaOk = metaCall.ok
    } catch {
      metaOk = false
    }
    if (metaOk) {
      flash(t('financial_pl.invoices.form.savedCreate', 'Invoice created.'), 'success')
    } else {
      flash(
        t('financial_pl.invoices.form.metaDeferred', 'Invoice created, but the Polish VAT metadata could not be saved. Complete it on the edit screen.'),
        'warning',
      )
    }
    // Switch to edit mode on the new invoice — never re-POST.
    router.push(`/backend/financial/invoices/${encodeURIComponent(newId)}/edit`)
  }, [buildMutationContext, invoiceId, isEdit, readOnly, router, runMutation, t, value.lines, value.meta])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    {
      id: 'header',
      title: t('financial_pl.invoices.form.sections.header', 'Invoice details'),
      column: 1,
      fields: ['invoiceNumber', 'issueDate', 'dueDate', 'currencyCode', 'orderId'],
    },
    {
      id: 'lines',
      title: t('financial_pl.invoices.form.sections.lines', 'Lines'),
      column: 1,
      // Derive the currency from the LIVE CrudForm header value (`values.currencyCode`) so editing
      // the currency field re-stamps the lines immediately — `value.header.currencyCode` is only the
      // initial/last-submitted value and would be stale while the user types.
      component: (ctx) => {
        const liveCurrency =
          (typeof ctx.values.currencyCode === 'string' ? ctx.values.currencyCode.trim().toUpperCase() : '') ||
          DEFAULT_CURRENCY
        return (
          <InvoiceLinesField
            value={value.lines}
            onChange={setLines}
            currencyCode={liveCurrency}
            disabled={readOnly}
          />
        )
      },
    },
    {
      id: 'plvat',
      title: t('financial_pl.invoices.form.sections.plVat', 'Polish VAT'),
      column: 1,
      component: () => (
        <PlVatMetaForm value={value.meta} onChange={setMeta} disabled={readOnly} />
      ),
    },
  ], [readOnly, setLines, setMeta, t, value.lines, value.meta])

  return (
    <div className="flex flex-col gap-4">
      {lockNotice}
      <CrudForm
        title={isEdit
          ? t('financial_pl.invoices.edit.title', 'Edit invoice')
          : t('financial_pl.invoices.create.title', 'Create invoice')}
        backHref="/backend/financial/invoices"
        cancelHref="/backend/financial/invoices"
        submitLabel={isEdit
          ? t('financial_pl.invoices.form.save', 'Save invoice')
          : t('financial_pl.invoices.form.create', 'Create invoice')}
        readOnly={readOnly}
        fields={[
          {
            id: 'invoiceNumber',
            label: t('financial_pl.invoices.form.fields.invoiceNumber', 'Invoice number'),
            type: 'text',
            placeholder: t('financial_pl.invoices.form.fields.invoiceNumberPlaceholder', 'Auto-assigned if left blank'),
          },
          {
            id: 'issueDate',
            label: t('financial_pl.invoices.form.fields.issueDate', 'Issue date'),
            type: 'date',
          },
          {
            id: 'dueDate',
            label: t('financial_pl.invoices.form.fields.dueDate', 'Due date'),
            type: 'date',
          },
          {
            id: 'currencyCode',
            label: t('financial_pl.invoices.form.fields.currencyCode', 'Currency'),
            type: 'text',
            required: true,
          },
          {
            id: 'orderId',
            label: t('financial_pl.invoices.form.fields.orderId', 'Order ID (optional)'),
            type: 'text',
          },
        ]}
        groups={groups}
        initialValues={{
          invoiceNumber: value.header.invoiceNumber,
          issueDate: value.header.issueDate,
          dueDate: value.header.dueDate,
          currencyCode: value.header.currencyCode,
          orderId: value.header.orderId,
        }}
        schema={z.object({
          invoiceNumber: z.string().optional(),
          issueDate: z.string().optional(),
          dueDate: z.string().optional(),
          currencyCode: z.string().trim().min(1),
          orderId: z.string().optional(),
        })}
        onSubmit={async (values) => {
          // CrudForm owns the header builtin fields; the lines + meta come from our controlled
          // state. Pass the just-submitted header straight into the two-step write.
          await handleSubmit({
            invoiceNumber: String(values.invoiceNumber ?? ''),
            issueDate: String(values.issueDate ?? ''),
            dueDate: String(values.dueDate ?? ''),
            currencyCode: String(values.currencyCode ?? DEFAULT_CURRENCY),
            orderId: String(values.orderId ?? ''),
          })
        }}
      />
    </div>
  )
}

/** Convenience: a localized "Issue a correction" link to the detail page (used by the lock banner). */
export function IssueCorrectionLink({ invoiceId, label }: { invoiceId: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={`/backend/financial/invoices/${encodeURIComponent(invoiceId)}`}>{label}</Link>
    </Button>
  )
}

export default InvoiceForm
