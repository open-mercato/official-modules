'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { z } from 'zod'
import { CrudForm, type CrudFormGroup, type CrudFormGroupComponentProps } from '@open-mercato/ui/backend/CrudForm'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Tabs, TabsList, TabsTrigger } from '@open-mercato/ui/primitives/tabs'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
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
import { BuyerFields, buyerToSnapshot, type BuyerValue } from '../../../../../components/BuyerFields'
import {
  PaymentFields,
  PAYMENT_METHODS,
  type PaymentMethod,
  type PaymentValue,
} from '../../../../../components/PaymentFields'
import { isValidPolishNip } from '../../../../../lib/nip'
import { normalizeNipDigits } from '../../../../../lib/company-lookup'

/** Header fields edited directly through the core sales invoice contract. */
type InvoiceHeaderValues = {
  invoiceNumber: string
  issueDate: string
  dueDate: string
  saleDate?: string
  currencyCode: string
  orderId: string
}

/** Full controlled value of the invoice editor (header + buyer + lines + PL-VAT meta). */
export type InvoiceFormValue = {
  header: InvoiceHeaderValues
  /** Buyer (Nabywca) — persisted to core SalesInvoice `metadata.buyerSnapshot`. */
  buyer: BuyerValue
  lines: InvoiceLineInput[]
  /** Payment & settlement — persisted to core SalesInvoice `metadata.payment`. */
  payment?: PaymentValue
  meta: InvoiceMeta
  /** Invoice note (Uwagi) — persisted in core SalesInvoice `metadata.notes`. */
  notes?: string
  /** The core invoice `metadata` loaded in edit mode — carried so `buyerSnapshot` merges without
   * clobbering other keys. `null`/absent in create mode. */
  metadata?: Record<string, unknown> | null
  /** Present in edit mode — the meta row's updatedAt for optimistic locking, if known. */
  metaUpdatedAt?: string | null
}

type ControlledInvoiceFormValue = Omit<InvoiceFormValue, 'header' | 'payment'> & {
  header: InvoiceHeaderValues & { saleDate: string }
  payment: PaymentValue
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
const DEFAULT_TERM_DAYS = 14
const ADVANCE_INVOICE_KINDS = new Set(['zal', 'roz', 'kor_zal', 'kor_roz'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type InvoiceTab = 'faktura' | 'podatki' | 'dodatkowe'

type PaymentMetadata = {
  method: PaymentMethod
  methodOther?: string
  termDays?: number
  bankAccount?: string
  bankName?: string
  swift?: string
  paid?: true
  paidDate?: string
}

function todayInput(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(dateInput: string, days: number): string {
  const date = dateInput.trim()
  if (!date || !Number.isFinite(days)) return date
  const parts = date.split('-').map((part) => Number(part))
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return date
  const [year, month, day] = parts
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return date
  }
  parsed.setUTCDate(parsed.getUTCDate() + Math.trunc(days))
  return parsed.toISOString().slice(0, 10)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value)
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function cleanOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function defaultPayment(): PaymentValue {
  return { method: 'transfer', termDays: DEFAULT_TERM_DAYS }
}

function normalizePaymentValue(value: Partial<PaymentValue> | undefined): PaymentValue {
  const method = isPaymentMethod(value?.method) ? value.method : 'transfer'
  const payment: PaymentValue = { method }
  const termDays = cleanOptionalNumber(value?.termDays)
  if (termDays !== undefined) payment.termDays = termDays
  const methodOther = cleanOptionalString(value?.methodOther)
  if (methodOther) payment.methodOther = methodOther
  if (method === 'transfer') {
    const bankAccount = cleanOptionalString(value?.bankAccount)
    const bankName = cleanOptionalString(value?.bankName)
    const swift = cleanOptionalString(value?.swift)
    if (bankAccount) payment.bankAccount = bankAccount
    if (bankName) payment.bankName = bankName
    if (swift) payment.swift = swift
  }
  if (value?.paid) {
    payment.paid = true
    const paidDate = cleanOptionalString(value.paidDate)
    if (paidDate) payment.paidDate = paidDate
  }
  return payment
}

function paymentFromMetadata(metadata: Record<string, unknown> | null | undefined): PaymentValue | undefined {
  const source = metadata?.payment
  if (!isRecord(source)) return undefined
  return normalizePaymentValue({
    method: isPaymentMethod(source.method) ? source.method : undefined,
    methodOther: cleanOptionalString(source.methodOther),
    termDays: cleanOptionalNumber(source.termDays),
    bankAccount: cleanOptionalString(source.bankAccount),
    bankName: cleanOptionalString(source.bankName),
    swift: cleanOptionalString(source.swift),
    paid: source.paid === true,
    paidDate: cleanOptionalString(source.paidDate),
  })
}

function metadataDate(metadata: Record<string, unknown> | null | undefined, key: string): string {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.slice(0, 10) : ''
}

function normalizeInvoiceFormValue(initialValue: InvoiceFormValue, isEdit: boolean): ControlledInvoiceFormValue {
  const payment = normalizePaymentValue(
    initialValue.payment ?? paymentFromMetadata(initialValue.metadata) ?? defaultPayment(),
  )
  const issueDate = initialValue.header.issueDate || todayInput()
  const saleDate = initialValue.header.saleDate || metadataDate(initialValue.metadata, 'saleDate') || issueDate
  const dueDate = initialValue.header.dueDate || (isEdit ? '' : addDays(issueDate, payment.termDays ?? DEFAULT_TERM_DAYS))
  return {
    ...initialValue,
    header: {
      ...initialValue.header,
      issueDate,
      dueDate,
      saleDate,
      currencyCode: initialValue.header.currencyCode || DEFAULT_CURRENCY,
    },
    payment,
  }
}

function buildPaymentMetadata(payment: PaymentValue): PaymentMetadata {
  const clean: PaymentMetadata = { method: payment.method }
  const termDays = cleanOptionalNumber(payment.termDays)
  if (termDays !== undefined) clean.termDays = termDays
  if (payment.method === 'other') {
    const methodOther = cleanOptionalString(payment.methodOther)
    if (methodOther) clean.methodOther = methodOther
  }
  if (payment.method === 'transfer') {
    const bankAccount = cleanOptionalString(payment.bankAccount)
    const bankName = cleanOptionalString(payment.bankName)
    const swift = cleanOptionalString(payment.swift)
    if (bankAccount) clean.bankAccount = bankAccount
    if (bankName) clean.bankName = bankName
    if (swift) clean.swift = swift
  }
  if (payment.paid) {
    clean.paid = true
    const paidDate = cleanOptionalString(payment.paidDate)
    if (paidDate) clean.paidDate = paidDate
  }
  return clean
}

function formString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isInvoiceTab(value: string): value is InvoiceTab {
  return value === 'faktura' || value === 'podatki' || value === 'dodatkowe'
}

type PaymentGroupProps = {
  ctx: CrudFormGroupComponentProps
  payment: PaymentValue
  onChange: (payment: PaymentValue) => void
  disabled?: boolean
  dueTouched: React.MutableRefObject<boolean>
  lastAutoDue: React.MutableRefObject<string>
}

function DateDerivationEffect({
  ctx,
  payment,
  dueTouched,
  saleTouched,
  lastAutoDue,
  lastAutoSale,
}: {
  ctx: CrudFormGroupComponentProps
  payment: PaymentValue
  dueTouched: React.MutableRefObject<boolean>
  saleTouched: React.MutableRefObject<boolean>
  lastAutoDue: React.MutableRefObject<string>
  lastAutoSale: React.MutableRefObject<string>
}) {
  const issueDate = formString(ctx.values.issueDate)
  const dueDate = formString(ctx.values.dueDate)
  const saleDate = formString(ctx.values.saleDate)
  const setFormValue = ctx.setValue

  React.useEffect(() => {
    if (!dueTouched.current && lastAutoDue.current && dueDate !== lastAutoDue.current) {
      dueTouched.current = true
    }
  }, [dueDate, dueTouched, lastAutoDue])

  React.useEffect(() => {
    if (!saleTouched.current && lastAutoSale.current && saleDate !== lastAutoSale.current) {
      saleTouched.current = true
    }
  }, [lastAutoSale, saleDate, saleTouched])

  React.useEffect(() => {
    if (!issueDate) return
    if (!saleTouched.current) {
      lastAutoSale.current = issueDate
      if (saleDate !== issueDate) setFormValue('saleDate', issueDate)
    }
    // Re-derive the due date only while it is untouched AND a payment term is set. Clearing the
    // term leaves the due date manual (jury C1/D-note) — an issue-date change must NOT silently
    // re-apply the default 14-day term over the operator's no-term/manual choice.
    if (!dueTouched.current && payment.termDays !== undefined) {
      const nextDue = addDays(issueDate, payment.termDays)
      lastAutoDue.current = nextDue
      if (dueDate !== nextDue) setFormValue('dueDate', nextDue)
    }
  }, [
    dueDate,
    dueTouched,
    issueDate,
    lastAutoDue,
    lastAutoSale,
    payment.termDays,
    saleDate,
    saleTouched,
    setFormValue,
  ])

  return null
}

function PaymentGroup({
  ctx,
  payment,
  onChange,
  disabled,
  dueTouched,
  lastAutoDue,
}: PaymentGroupProps) {
  const issueDate = formString(ctx.values.issueDate)
  const dueDate = formString(ctx.values.dueDate)
  const setFormValue = ctx.setValue

  const deriveDue = React.useCallback(
    (termDays: number | undefined) => {
      if (dueTouched.current || !issueDate || termDays === undefined) return
      const nextDue = addDays(issueDate, termDays)
      lastAutoDue.current = nextDue
      if (dueDate !== nextDue) setFormValue('dueDate', nextDue)
    },
    [dueDate, dueTouched, issueDate, lastAutoDue, setFormValue],
  )

  return (
    <PaymentFields
      value={payment}
      onChange={(next) => {
        onChange(next)
        if (next.termDays !== payment.termDays) deriveDue(next.termDays)
      }}
      disabled={disabled}
    />
  )
}

type InvoiceTabsProps = {
  ctx: CrudFormGroupComponentProps
  value: ControlledInvoiceFormValue
  isEdit: boolean
  readOnly?: boolean
  activeTab: InvoiceTab
  setActiveTab: (tab: InvoiceTab) => void
  setBuyer: (buyer: BuyerValue) => void
  setLines: (lines: InvoiceLineInput[]) => void
  setMeta: (meta: InvoiceMeta) => void
  setPayment: (payment: PaymentValue) => void
  dueTouched: React.MutableRefObject<boolean>
  saleTouched: React.MutableRefObject<boolean>
  lastAutoDue: React.MutableRefObject<string>
  lastAutoSale: React.MutableRefObject<string>
  t: ReturnType<typeof useT>
}

function InvoiceTabs({
  ctx,
  value,
  isEdit,
  readOnly,
  activeTab,
  setActiveTab,
  setBuyer,
  setLines,
  setMeta,
  setPayment,
  dueTouched,
  saleTouched,
  lastAutoDue,
  lastAutoSale,
  t,
}: InvoiceTabsProps) {
  const liveCurrency =
    (typeof ctx.values.currencyCode === 'string' ? ctx.values.currencyCode.trim().toUpperCase() : '') ||
    DEFAULT_CURRENCY
  const liveIssueDate = typeof ctx.values.issueDate === 'string' ? ctx.values.issueDate.trim() : ''
  const notesValue = typeof ctx.values.notes === 'string' ? ctx.values.notes : ''
  const orderIdValue = typeof ctx.values.orderId === 'string' ? ctx.values.orderId : ''
  const podatkiHasData = hasMeaningfulPlVatMeta(value.meta)
  const hasDataHint = t('financial_pl.invoices.form.tabs.hasDataHint', 'Has data')
  const tabsProps = {
    value: activeTab,
    onValueChange: (next: string) => {
      if (isInvoiceTab(next)) setActiveTab(next)
    },
    variant: 'underline' as const,
  }
  const hasOrderId = orderIdValue.trim().length > 0
  // The "section has data" cue is rendered inside the trigger CHILDREN (not the DS
  // `count` prop) so it renders robustly across @open-mercato/ui Tabs versions: the
  // sandbox runtime's Tabs did not render a count-only badge (verified live in preview),
  // so a count-only dot silently never showed. Trigger children render everywhere.
  const dataDot = (
    <span aria-label={hasDataHint} className="ml-1.5 text-accent-indigo" role="img">
      •
    </span>
  )

  return (
    <div className="flex flex-col gap-4">
      <DateDerivationEffect
        ctx={ctx}
        payment={value.payment}
        dueTouched={dueTouched}
        saleTouched={saleTouched}
        lastAutoDue={lastAutoDue}
        lastAutoSale={lastAutoSale}
      />
      <Tabs {...tabsProps}>
        <TabsList>
          <TabsTrigger value="faktura">
            {t('financial_pl.invoices.form.tabs.faktura', 'Invoice')}
          </TabsTrigger>
          <TabsTrigger value="podatki">
            {t('financial_pl.invoices.form.tabs.podatki', 'Taxes & KSeF')}
            {podatkiHasData ? dataDot : null}
          </TabsTrigger>
          <TabsTrigger value="dodatkowe">
            {t('financial_pl.invoices.form.tabs.dodatkowe', 'Additional')}
            {hasOrderId ? dataDot : null}
          </TabsTrigger>
        </TabsList>

        {/* Panels are ALWAYS mounted and toggled with `hidden` (not the DS `TabsContent`,
            which unmounts inactive panels). Unmounting drops uncommitted ComboboxInput
            buffer text (buyer/product name committed only on blur) when the user types and
            then clicks another tab — code-jury (Codex) confirmed live as data loss. Keeping
            every panel mounted preserves all field state across tab switches. */}
        <div
          role="tabpanel"
          aria-label={t('financial_pl.invoices.form.tabs.faktura', 'Invoice')}
          className={activeTab === 'faktura' ? 'mt-2 flex flex-col gap-4' : 'hidden'}
        >
          <section className="rounded-lg border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">
              {t('financial_pl.invoices.form.sections.buyer', 'Buyer (Nabywca)')}
            </h3>
            <BuyerFields value={value.buyer} onChange={setBuyer} disabled={readOnly} />
          </section>
          <section className="rounded-lg border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">
              {t('financial_pl.invoices.form.sections.lines', 'Lines')}
            </h3>
            {isEdit ? (
              <p className="text-sm text-muted-foreground">
                {t(
                  'financial_pl.invoices.form.linesReadOnlyOnEdit',
                  "Line items can't be changed after the invoice is created (core limitation). To change them, create a new invoice or issue a correction (KOR). All other fields remain editable.",
                )}
              </p>
            ) : null}
            <InvoiceLinesField
              value={value.lines}
              onChange={setLines}
              currencyCode={liveCurrency}
              disabled={readOnly || isEdit}
            />
          </section>
          <section className="rounded-lg border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">
              {t('financial_pl.invoices.form.sections.payment', 'Payment / settlement')}
            </h3>
            <PaymentGroup
              ctx={ctx}
              payment={value.payment}
              onChange={setPayment}
              disabled={readOnly}
              dueTouched={dueTouched}
              lastAutoDue={lastAutoDue}
            />
          </section>
          <section className="rounded-lg border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">
              {t('financial_pl.invoices.form.fields.notes', 'Notes (Uwagi)')}
            </h3>
            <Textarea
              value={notesValue}
              onChange={(event) => ctx.setValue('notes', event.target.value)}
              disabled={readOnly}
              aria-label={t('financial_pl.invoices.form.fields.notes', 'Notes (Uwagi)')}
              placeholder={t('financial_pl.invoices.form.fields.notesPlaceholder', 'Optional remarks shown on the invoice')}
              aria-invalid={Boolean(ctx.errors?.notes)}
            />
            {ctx.errors?.notes ? <p className="text-sm text-destructive">{ctx.errors.notes}</p> : null}
          </section>
        </div>

        <div
          role="tabpanel"
          aria-label={t('financial_pl.invoices.form.tabs.podatki', 'Taxes & KSeF')}
          className={activeTab === 'podatki' ? 'mt-2' : 'hidden'}
        >
          <PlVatMetaForm
            value={value.meta}
            onChange={setMeta}
            disabled={readOnly}
            currencyCode={liveCurrency}
            taxPointDate={liveIssueDate}
          />
        </div>

        <div
          role="tabpanel"
          aria-label={t('financial_pl.invoices.form.tabs.dodatkowe', 'Additional')}
          className={activeTab === 'dodatkowe' ? 'mt-2' : 'hidden'}
        >
          <section className="rounded-lg border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">
              {t('financial_pl.invoices.form.fields.orderId', 'Order ID (optional)')}
            </h3>
            <Input
              value={orderIdValue}
              onChange={(event) => ctx.setValue('orderId', event.target.value)}
              disabled={readOnly}
              aria-label={t('financial_pl.invoices.form.fields.orderId', 'Order ID (optional)')}
              aria-invalid={Boolean(ctx.errors?.orderId)}
            />
            {ctx.errors?.orderId ? <p className="text-sm text-destructive">{ctx.errors.orderId}</p> : null}
          </section>
        </div>
      </Tabs>
    </div>
  )
}

/** Build a fresh, empty header for create mode with sensible defaults. */
export function emptyHeader(): InvoiceHeaderValues {
  const today = todayInput()
  return {
    invoiceNumber: '',
    issueDate: today,
    dueDate: addDays(today, DEFAULT_TERM_DAYS),
    saleDate: today,
    currencyCode: DEFAULT_CURRENCY,
    orderId: '',
  }
}

/** Build a default create-mode value with one starter line and empty meta. */
export function emptyInvoiceFormValue(): InvoiceFormValue {
  return {
    header: emptyHeader(),
    buyer: { countryCode: 'PL' },
    lines: [withComputedTotals(
      { name: '', quantity: '1', quantityUnit: 'szt.', unitPriceNet: '0', taxRate: '23', currencyCode: DEFAULT_CURRENCY, kind: 'product' },
      DEFAULT_CURRENCY,
      1,
    )],
    payment: defaultPayment(),
    meta: {},
    notes: '',
    metadata: null,
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
    const sku = line.sku?.trim()
    if (sku) row.sku = sku
    const metadata = line.metadata ? { ...line.metadata } : {}
    const productId = line.productId?.trim()
    if (productId) metadata.productId = productId
    else delete metadata.productId
    if (Object.keys(metadata).length > 0) row.metadata = metadata
    return row
  })
}

/** Map the controlled PL-VAT meta value to the invoice-meta PUT body (keyed by salesInvoiceId). */
function buildMetaPayload(
  salesInvoiceId: string,
  meta: InvoiceMeta,
  effectiveCurrency: string,
  invoiceKind: InvoiceMeta['invoiceKind'],
): Record<string, unknown> {
  const normalizedInvoiceKind = String(invoiceKind ?? 'vat').trim().toLowerCase()
  const body: Record<string, unknown> = { salesInvoiceId, ...meta, invoiceKind: normalizedInvoiceKind }
  // Normalise the taxpayer NIP to bare digits before the meta PUT: the schema is ^[0-9]{10}$, so a
  // dashed/spaced value (e.g. 525-234-40-78 — which the client checksum check accepts) would otherwise
  // 422 server-side (code-jury r2, Codex). Empty / non-digit input ⇒ null (no taxpayer NIP).
  if (typeof body.contextNip === 'string') {
    const digits = body.contextNip.replace(/\D/g, '')
    body.contextNip = digits ? digits : null
  }
  if (body.consumptionCountryCode === '') body.consumptionCountryCode = null
  if (effectiveCurrency.trim().toUpperCase() === DEFAULT_CURRENCY) {
    body.exchangeRate = null
    body.exchangeRateDate = null
  } else {
    if (body.exchangeRate === '') body.exchangeRate = null
    if (body.exchangeRateDate === '') body.exchangeRateDate = null
  }
  if (!ADVANCE_INVOICE_KINDS.has(normalizedInvoiceKind)) {
    body.advancePayments = []
    body.advanceRefs = []
    body.orderSnapshot = null
  }
  return body
}

function hasNonEmptyString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasMeaningfulPlVatMeta(meta: InvoiceMeta): boolean {
  if ((meta.invoiceKind ?? 'vat') !== 'vat') return true
  if (
    meta.mppRequired ||
    meta.issuedOutsideKsef ||
    meta.selfBilling ||
    meta.reverseCharge ||
    meta.ossProcedure
  ) {
    return true
  }
  if (
    hasNonEmptyString(meta.contextNip) ||
    hasNonEmptyString(meta.vatExemptionBasis) ||
    hasNonEmptyString(meta.consumptionCountryCode) ||
    hasNonEmptyString(meta.exchangeRate) ||
    hasNonEmptyString(meta.exchangeRateDate) ||
    hasNonEmptyString(meta.badDebtReliefPeriod) ||
    hasNonEmptyString(meta.badDebtTerminPlatnosci) ||
    Boolean(meta.typDokumentu)
  ) {
    return true
  }
  if (
    (meta.advancePayments?.length ?? 0) > 0 ||
    (meta.advanceRefs?.length ?? 0) > 0 ||
    (meta.gtuCodes?.length ?? 0) > 0 ||
    Object.values(meta.procedureMarkings ?? {}).some(Boolean)
  ) {
    return true
  }
  return meta.orderSnapshot != null
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
 * - EDIT: PUT /api/sales/invoices (id + header + metadata) → PUT invoice-meta. Core 0.6.5
 *   `sales.invoices.update` ignores `lines`, so edit mode keeps lines read-only and does not send
 *   them; in-place line editing awaits an upstream core command.
 *
 * All writes go through `useGuardedMutation().runMutation(...)` with a real `retryLastMutation`
 * injected into the mutation context so conflict-resolution widgets can re-drive the save.
 */
export function InvoiceForm({ invoiceId, initialValue, readOnly, lockNotice }: InvoiceFormProps) {
  const t = useT()
  const router = useRouter()
  const isEdit = Boolean(invoiceId)
  const [activeTab, setActiveTab] = React.useState<InvoiceTab>('faktura')

  const [value, setValue] = React.useState<ControlledInvoiceFormValue>(() =>
    normalizeInvoiceFormValue(initialValue, isEdit),
  )
  const dueTouched = React.useRef(isEdit)
  const saleTouched = React.useRef(isEdit)
  const lastAutoDue = React.useRef(value.header.dueDate)
  const lastAutoSale = React.useRef(value.header.saleDate)
  React.useEffect(() => {
    const nextValue = normalizeInvoiceFormValue(initialValue, isEdit)
    setValue(nextValue)
    dueTouched.current = isEdit
    saleTouched.current = isEdit
    lastAutoDue.current = nextValue.header.dueDate
    lastAutoSale.current = nextValue.header.saleDate
  }, [initialValue, isEdit])

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
  const setBuyer = React.useCallback((buyer: BuyerValue) => {
    setValue((prev) => ({ ...prev, buyer }))
  }, [])
  const setPayment = React.useCallback((payment: PaymentValue) => {
    setValue((prev) => ({ ...prev, payment }))
  }, [])

  // --- Submit handler shared by create + edit -----------------------------------------------
  // Header values come straight from the CrudForm builtin fields (passed in by `onSubmit`) so the
  // payload reflects the latest edits without depending on async state propagation.
  const handleSubmit = React.useCallback(async (header: InvoiceHeaderValues & { notes?: string }) => {
    if (readOnly) return
    const effectiveCurrency = header.currencyCode.trim().toUpperCase() || DEFAULT_CURRENCY
    const linesPayload = buildLinesPayload(value.lines, effectiveCurrency)
    if (!isEdit) {
      if (linesPayload.length < 1) {
        setActiveTab('faktura')
        throw createCrudFormError(t('financial_pl.invoices.form.linesRequired', 'Add at least one invoice line.'))
      }
      if (value.lines.some((line) => !line.name.trim())) {
        setActiveTab('faktura')
        throw createCrudFormError(t('financial_pl.invoices.form.lineNameRequired', 'Every invoice line needs a name.'))
      }
    }

    // --- Commercial-grade validations (SPEC-014) — block save before a 422 at KSeF send --------
    const issue = header.issueDate.trim()
    const due = header.dueDate.trim()
    if (issue && due && due < issue) {
      setActiveTab('faktura')
      throw createCrudFormError(t('financial_pl.validation.dueBeforeIssue', 'The due date cannot be earlier than the issue date.'))
    }
    if (!isEdit) {
      for (const line of value.lines) {
        const qty = Number(line.quantity)
        if (!Number.isFinite(qty) || qty <= 0) {
          setActiveTab('faktura')
          throw createCrudFormError(t('financial_pl.validation.quantityPositive', 'Every line needs a quantity greater than zero.'))
        }
        const price = Number(line.unitPriceNet)
        if (!Number.isFinite(price) || price < 0) {
          setActiveTab('faktura')
          throw createCrudFormError(t('financial_pl.validation.unitPricePositive', 'A line unit price cannot be negative.'))
        }
        // Every line needs a VAT rate — a quick-pick (23/8/5/0) or a numeric "Other…" value. A blank
        // rate (e.g. "Other…" chosen but left empty) must NOT silently persist as 0%: a real 0% line is
        // the explicit "0%" pick. Custom rates are numeric-only — zw/np/oo/text are rejected here;
        // exemption / reverse-charge live in the Polish-VAT section (code-jury, Codex + Kimi).
        const rateText = (line.taxRate ?? '').trim()
        const rate = Number(rateText)
        if (!rateText || !Number.isFinite(rate) || rate < 0 || rate > 100) {
          setActiveTab('faktura')
          throw createCrudFormError(t('financial_pl.validation.vatRateNumeric', 'A line VAT rate must be a number between 0 and 100.'))
        }
      }
    }
    const buyer = value.buyer ?? {}
    // Any NON-EMPTY NIP field must be a valid Polish NIP — reject letters/garbage that normalise to ''
    // (else buyerToSnapshot / buildMetaPayload would silently drop it) as well as a wrong checksum
    // (code-jury r2, Codex). A blank field is fine (buyer NIP is optional outside UPR).
    const buyerNipRaw = (buyer.nip ?? '').trim()
    const buyerNip = normalizeNipDigits(buyerNipRaw)
    if (buyerNipRaw && !isValidPolishNip(buyerNip)) {
      setActiveTab('faktura')
      throw createCrudFormError(t('financial_pl.validation.nipChecksumBuyer', 'The buyer NIP is invalid (checksum failed).'))
    }
    const contextNipRaw = (typeof value.meta.contextNip === 'string' ? value.meta.contextNip : '').trim()
    const contextNip = normalizeNipDigits(contextNipRaw)
    if (contextNipRaw && !isValidPolishNip(contextNip)) {
      setActiveTab('podatki')
      throw createCrudFormError(t('financial_pl.validation.nipChecksumTaxpayer', 'The taxpayer NIP is invalid (checksum failed).'))
    }
    // Buyer presence: a non-UPR invoice needs a name + address (matches `buildBuyer`'s 422 rule); a
    // UPR (simplified) invoice may carry a NIP-only buyer.
    const kind = value.meta.invoiceKind ?? 'vat'
    const hasBuyerName = Boolean(buyer.companyName && buyer.companyName.trim())
    const hasBuyerAddress = Boolean(buyer.addressLine1 && buyer.addressLine1.trim())
    if (kind === 'upr') {
      // Mirror buildBuyer(uprNipOnly): a UPR buyer needs EITHER a full name + address OR a NIP — a
      // name-only / address-only UPR buyer with no NIP still 422s at send (code-jury, Codex).
      if (!(hasBuyerName && hasBuyerAddress) && !buyerNip) {
        setActiveTab('faktura')
        throw createCrudFormError(t('financial_pl.validation.buyerRequiredUpr', 'A simplified-invoice (UPR) buyer needs either a full name + address or at least a NIP.'))
      }
    } else if (!hasBuyerName || !hasBuyerAddress) {
      setActiveTab('faktura')
      throw createCrudFormError(t('financial_pl.validation.buyerRequired', 'The buyer needs a name and an address (line 1).'))
    }
    // Guard the payment term: metadata.payment.termDays must be a whole number in [0, 3650] to satisfy
    // invoicePaymentSchema. Otherwise resolve-fa3-from-invoice fail-opens on the parse error and
    // silently DROPS the entire <Platnosc> block (method/bank/term/paid) from the KSeF invoice. SPEC-018
    // removed the native min/step (they blocked native submit when the panel is hidden), so this JS
    // guard restores the bound on every path — including edit mode / a manually-touched due date, where
    // the smart derivation is suppressed so a negative term no longer trips `dueBeforeIssue` (code-jury).
    const termDaysValue = value.payment.termDays
    if (
      termDaysValue !== undefined &&
      (!Number.isInteger(termDaysValue) || termDaysValue < 0 || termDaysValue > 3650)
    ) {
      setActiveTab('faktura')
      throw createCrudFormError(
        t('financial_pl.validation.termDaysRange', 'The payment term must be a whole number of days between 0 and 3650.'),
      )
    }
    if (
      (value.payment.paid && !cleanOptionalString(value.payment.paidDate)) ||
      (value.payment.method === 'other' && !cleanOptionalString(value.payment.methodOther))
    ) {
      setActiveTab('faktura')
      throw createCrudFormError(
        t(
          'financial_pl.errors.payment_invalid',
          "Complete the payment details: a paid invoice needs a payment date, and 'Other' needs a description.",
        ),
      )
    }

    // Merge the buyer snapshot into the preserved core invoice metadata (never clobber other keys).
    const buyerSnapshot = buyerToSnapshot(buyer)
    const mergedMetadata: Record<string, unknown> = { ...(value.metadata ?? {}) }
    if (buyerSnapshot) mergedMetadata.buyerSnapshot = buyerSnapshot
    else delete mergedMetadata.buyerSnapshot
    const notes = (header.notes ?? '').trim()
    if (notes) mergedMetadata.notes = notes
    else delete mergedMetadata.notes
    const cleanPayment = buildPaymentMetadata(value.payment)
    if (cleanPayment) mergedMetadata.payment = cleanPayment
    else delete mergedMetadata.payment
    const saleDate = (header.saleDate ?? '').trim()
    if (saleDate) mergedMetadata.saleDate = saleDate
    else delete mergedMetadata.saleDate
    const hadMetadata = value.metadata != null && Object.keys(value.metadata).length > 0
    const metadataPayload: Record<string, unknown> =
      Object.keys(mergedMetadata).length || hadMetadata ? { metadata: mergedMetadata } : {}

    const headerPayload = buildInvoiceHeaderPayload(header)

    if (isEdit && invoiceId) {
      // EDIT — core 0.6.5 ignores lines, so only persist header + metadata here.
      const invoiceCall = await runMutation({
        operation: () =>
          apiCall<CreateResponse>('/api/sales/invoices', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: invoiceId, ...headerPayload, ...metadataPayload }),
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
            body: JSON.stringify(
              buildMetaPayload(invoiceId, value.meta, effectiveCurrency, value.meta.invoiceKind ?? 'vat'),
            ),
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
          body: JSON.stringify({ ...headerPayload, ...metadataPayload, lines: linesPayload }),
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
            body: JSON.stringify(
              buildMetaPayload(newId, value.meta, effectiveCurrency, value.meta.invoiceKind ?? 'vat'),
            ),
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
  }, [
    buildMutationContext,
    invoiceId,
    isEdit,
    readOnly,
    router,
    runMutation,
    setActiveTab,
    t,
    value.buyer,
    value.lines,
    value.meta,
    value.metadata,
    value.payment,
  ])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    {
      id: 'header',
      title: t('financial_pl.invoices.form.sections.header', 'Invoice details'),
      column: 1,
      fields: ['invoiceNumber', 'issueDate', 'saleDate', 'dueDate', 'currencyCode'],
    },
    {
      id: 'body',
      column: 1,
      bare: true,
      component: (ctx) => (
        <InvoiceTabs
          ctx={ctx}
          value={value}
          isEdit={isEdit}
          readOnly={readOnly}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          setBuyer={setBuyer}
          setLines={setLines}
          setMeta={setMeta}
          setPayment={setPayment}
          dueTouched={dueTouched}
          saleTouched={saleTouched}
          lastAutoDue={lastAutoDue}
          lastAutoSale={lastAutoSale}
          t={t}
        />
      ),
    },
  ], [
    activeTab,
    isEdit,
    readOnly,
    setBuyer,
    setLines,
    setMeta,
    setPayment,
    t,
    value,
  ])

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
            id: 'saleDate',
            label: t('financial_pl.invoices.form.fields.saleDate', 'Sale date (Data sprzedaży)'),
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
          {
            id: 'notes',
            label: t('financial_pl.invoices.form.fields.notes', 'Notes (Uwagi)'),
            type: 'textarea',
            placeholder: t('financial_pl.invoices.form.fields.notesPlaceholder', 'Optional invoice notes'),
          },
        ]}
        groups={groups}
        initialValues={{
          invoiceNumber: value.header.invoiceNumber,
          issueDate: value.header.issueDate,
          dueDate: value.header.dueDate,
          saleDate: value.header.saleDate,
          currencyCode: value.header.currencyCode,
          orderId: value.header.orderId,
          notes: value.notes ?? '',
        }}
        schema={z.object({
          invoiceNumber: z.string().optional(),
          issueDate: z.string().optional(),
          dueDate: z.string().optional(),
          saleDate: z.string().optional(),
          currencyCode: z.string().trim().min(1),
          orderId: z.string().optional(),
          notes: z.string().optional(),
        })}
        onSubmit={async (values) => {
          // CrudForm owns the header builtin fields; the lines + meta come from our controlled
          // state. Pass the just-submitted header straight into the two-step write.
          await handleSubmit({
            invoiceNumber: String(values.invoiceNumber ?? ''),
            issueDate: String(values.issueDate ?? ''),
            dueDate: String(values.dueDate ?? ''),
            saleDate: String(values.saleDate ?? ''),
            currencyCode: String(values.currencyCode ?? DEFAULT_CURRENCY),
            orderId: String(values.orderId ?? ''),
            notes: String(values.notes ?? ''),
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
