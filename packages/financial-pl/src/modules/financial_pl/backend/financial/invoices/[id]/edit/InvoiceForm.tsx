'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { z } from 'zod'
import {
  AlertTriangle,
  PenLine,
  Plus,
  Building2,
  FileText,
  Hash,
  ListOrdered,
  ReceiptText,
  StickyNote,
  Wallet,
} from 'lucide-react'
import { CrudForm, type CrudFormGroup, type CrudFormGroupComponentProps } from '@open-mercato/ui/backend/CrudForm'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs'
import { Tabs, TabsList, TabsTrigger } from '@open-mercato/ui/primitives/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Separator } from '@open-mercato/ui/primitives/separator'
import { Alert, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { FormSection } from '../../../../../components/FormSection'
import { useInvoiceSettings } from '../../../../../components/useInvoiceSettings'
import { SwitchField } from '@open-mercato/ui/primitives/switch-field'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT, useLocale } from '@open-mercato/shared/lib/i18n/context'
import { DatePicker } from '@open-mercato/ui/primitives/date-picker'
import { de as deLocale, enUS, es as esLocale, pl as plLocale } from 'date-fns/locale'
import {
  convertLinesPriceMode,
  InvoiceLinesField,
  withComputedTotals,
  type InvoiceLineInput,
  type MarginScheme,
  type PriceMode,
  collectLineGtuCodes,
} from '../../../../../components/InvoiceLinesField'
import { PlVatMetaForm, type InvoiceMeta } from '../../../../../components/PlVatMetaForm'
import type { InvoiceKindColumn, InvoiceNumberingSeries } from '../../../../../data/entities'
import { BuyerFields, buyerToSnapshot, type BuyerValue } from '../../../../../components/BuyerFields'
import {
  PaymentFields,
  PAYMENT_METHODS,
  type PaymentMethod,
  type PaymentValue,
  type PaymentAccountOption,
} from '../../../../../components/PaymentFields'
import { isValidPolishNip } from '../../../../../lib/nip'
import { searchCurrencies, isValidCurrencyCode } from '../../../../../lib/currencies'
import { normalizeNipDigits } from '../../../../../lib/company-lookup'
import {
  collectInvoiceFieldProblems,
  hasAdvanceSettlementData,
  invoiceDateProblems,
  isAdvanceInvoiceKind,
  pruneInvoiceFieldErrors,
  todayInWarsaw,
  type InvoiceFieldProblem,
} from '../../../../../data/validators'

/** Header fields edited directly through the core sales invoice contract. */
export type InvoiceHeaderValues = {
  invoiceNumber: string
  issueDate: string
  dueDate: string
  saleDate?: string
  currencyCode: string
  orderId: string
  signatureMode: string
  issuerSignatory: string
  recipientSignatory: string
  contractNumber: string
  transportTerms: string
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
  /** Invoice-wide pricing mode — persisted as core SalesInvoice `metadata.priceMode`. */
  priceMode?: PriceMode
  /** Invoice note (Uwagi) — persisted in core SalesInvoice `metadata.notes`. */
  notes?: string
  /** The core invoice `metadata` loaded in edit mode — carried so `buyerSnapshot` merges without
   * clobbering other keys. `null`/absent in create mode. */
  metadata?: Record<string, unknown> | null
  /** Present in edit mode — the meta row's updatedAt for optimistic locking, if known. */
  metaUpdatedAt?: string | null
}

export type ControlledInvoiceFormValue = Omit<InvoiceFormValue, 'header' | 'payment' | 'priceMode'> & {
  header: InvoiceHeaderValues & { saleDate: string }
  payment: PaymentValue
  priceMode: PriceMode
}

/** Everything the document preview needs, emitted on every edit. */
export type InvoicePreviewSnapshot = {
  /** Typed number, or the provisional peek when the field is left blank. */
  invoiceNumber?: string | null
  invoiceNumberProvisional?: boolean
  signature?: { mode?: string; issuerSignatory?: string; recipientSignatory?: string }
  header: Pick<
    InvoiceHeaderValues,
    'invoiceNumber' | 'issueDate' | 'dueDate' | 'currencyCode' | 'orderId'
  > & { saleDate: string; notes?: string }
  buyer: BuyerValue
  lines: InvoiceLineInput[]
  payment: PaymentValue
  meta: InvoiceMeta
  notes: string
}

export type InvoiceFormProps = {
  /** `undefined` in create mode; the invoice id in edit mode. */
  invoiceId?: string
  initialValue: InvoiceFormValue
  /** When true the form renders read-only (KSeF-locked invoice). */
  readOnly?: boolean
  /** Emits the live form state so a caller can render a preview beside the form. */
  onPreviewChange?: (snapshot: InvoicePreviewSnapshot) => void
  /** Rendered in the form's own header row, beside Cancel/Save. */
  headerActions?: React.ReactNode
  /** Rendered in CrudForm's SECOND column, so the header stays full width above both columns. */
  asideContent?: React.ReactNode
  /** Lock reason banner — rendered above the form when read-only. */
  lockNotice?: React.ReactNode
}

const DEFAULT_CURRENCY = 'PLN'

/** FA(3) invoice kinds offered at the top of the form. */
const FORM_INVOICE_KINDS: readonly InvoiceKindColumn[] = ['vat', 'zal', 'roz', 'upr', 'kor_zal', 'kor_roz']
const INVOICE_FORM_ID = 'financial-pl-invoice-form'

/** Optional document annotations offered beside the note, revealed only when asked for. */
const OPTIONAL_NOTE_FIELDS = [
  { id: 'contractNumber', labelKey: 'financial_pl.invoices.form.fields.contractNumber', fallback: 'Contract number' },
  { id: 'transportTerms', labelKey: 'financial_pl.invoices.form.fields.transportTerms', fallback: 'Transport terms' },
] as const

/** What the document prints in place of a signature. */
export const SIGNATURE_MODES = [
  'recipient_authorized',
  'no_recipient_signature',
  'authorization',
  'no_signatures',
] as const
export type SignatureMode = (typeof SIGNATURE_MODES)[number]
const DEFAULT_SIGNATURE_MODE: SignatureMode = 'no_signatures'

function isSignatureMode(v: unknown): v is SignatureMode {
  return typeof v === 'string' && (SIGNATURE_MODES as readonly string[]).includes(v)
}
const DEFAULT_TERM_DAYS = 14
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type InvoiceTab = 'faktura' | 'podatki' | 'uwagi' | 'dodatkowe'

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
  return todayInWarsaw()
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

function isPriceMode(value: unknown): value is PriceMode {
  return value === 'net' || value === 'gross'
}

function priceModeFromMetadata(metadata: Record<string, unknown> | null | undefined): PriceMode {
  return isPriceMode(metadata?.priceMode) ? metadata.priceMode : 'net'
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

export function paymentFromMetadata(metadata: Record<string, unknown> | null | undefined): PaymentValue | undefined {
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

export function normalizeInvoiceFormValue(initialValue: InvoiceFormValue, isEdit: boolean): ControlledInvoiceFormValue {
  const payment = normalizePaymentValue(
    initialValue.payment ?? paymentFromMetadata(initialValue.metadata) ?? defaultPayment(),
  )
  const issueDate = initialValue.header.issueDate || todayInput()
  const saleDate = initialValue.header.saleDate || metadataDate(initialValue.metadata, 'saleDate') || issueDate
  const dueDate = initialValue.header.dueDate || (isEdit ? '' : addDays(issueDate, payment.termDays ?? DEFAULT_TERM_DAYS))
  const marginScheme = initialValue.meta.marginScheme ?? null
  const priceMode = marginScheme ? 'gross' : initialValue.priceMode ?? priceModeFromMetadata(initialValue.metadata)
  const currencyCode = initialValue.header.currencyCode || DEFAULT_CURRENCY
  return {
    ...initialValue,
    header: {
      ...initialValue.header,
      issueDate,
      dueDate,
      saleDate,
      currencyCode,
      signatureMode: isSignatureMode(initialValue.header.signatureMode)
        ? initialValue.header.signatureMode
        : DEFAULT_SIGNATURE_MODE,
      issuerSignatory: initialValue.header.issuerSignatory ?? '',
      recipientSignatory: initialValue.header.recipientSignatory ?? '',
      contractNumber: initialValue.header.contractNumber ?? '',
      transportTerms: initialValue.header.transportTerms ?? '',
    },
    lines: initialValue.lines.map((line, index) =>
      withComputedTotals(line, currencyCode, index + 1, priceMode, marginScheme),
    ),
    payment,
    priceMode,
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
  return value === 'faktura' || value === 'podatki' || value === 'uwagi' || value === 'dodatkowe'
}

type PaymentGroupProps = {
  accounts?: PaymentAccountOption[]
  onCreateAccount?: (account: Omit<PaymentAccountOption, 'id'>) => Promise<boolean>
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
  accounts,
  onCreateAccount,
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
      accounts={accounts}
      onCreateAccount={onCreateAccount}
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
  setPriceMode: (priceMode: PriceMode) => void
  fieldErrors: Record<string, string>
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
  setPriceMode,
  dueTouched,
  saleTouched,
  fieldErrors,
  lastAutoDue,
  lastAutoSale,
  t,
  part,
}: InvoiceTabsProps & { part: 'bar' | 'panels' }) {
  const liveCurrency =
    (typeof ctx.values.currencyCode === 'string' ? ctx.values.currencyCode.trim().toUpperCase() : '') ||
    DEFAULT_CURRENCY
  const liveIssueDate = typeof ctx.values.issueDate === 'string' ? ctx.values.issueDate.trim() : ''
  const notesValue = typeof ctx.values.notes === 'string' ? ctx.values.notes : ''
  const orderIdValue = typeof ctx.values.orderId === 'string' ? ctx.values.orderId : ''
  const podatkiHasData = hasMeaningfulPlVatMeta(value.meta)
  const hasDataHint = t('financial_pl.invoices.form.tabs.hasDataHint', 'This section contains data')
  const tabsProps = {
    value: activeTab,
    onValueChange: (next: string) => {
      if (isInvoiceTab(next)) setActiveTab(next)
    },
    variant: 'underline' as const,
  }
  const hasOrderId = orderIdValue.trim().length > 0
  const hasNotes = notesValue.trim().length > 0
  const [revealedNoteFields, setRevealedNoteFields] = React.useState<string[]>([])
  // The "section has data" cue is rendered inside the trigger CHILDREN (not the DS
  // `count` prop) so it renders robustly across @open-mercato/ui Tabs versions: the
  // sandbox runtime's Tabs did not render a count-only badge (verified live in preview),
  // so a count-only dot silently never showed. Trigger children render everywhere.
  // The dot lived inside the trigger's truncating label span, so it relied on `align-middle` and
  // still sat high against the text. Wrapping label + dot in their own flex row centres it properly
  // and keeps one consistent gap, whatever the label length.
  const withDot = (label: string, hasData: boolean) => (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {hasData ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-accent-indigo"
          role="img"
          aria-label={hasDataHint}
          title={hasDataHint}
        />
      ) : null}
    </span>
  )

  // Rendered in two passes so the CrudForm "Dane faktury" group can sit BETWEEN them: the tab bar
  // is its own group placed above, the panels below. Previously the header fields rendered above the
  // tab bar entirely, so the invoice's own number and dates looked like they belonged to no tab.
  if (part === 'bar') {
    return (
      // PADDING, not margin: the group stack is block flow with `space-y-3`, so a bottom margin
      // here would simply collapse against the next group's top margin and add nothing. The rail
      // separates navigation from the content it switches, so it earns more air than two sibling
      // cards get between them.
      <div className="flex flex-col gap-4 pb-3">
        <DateDerivationEffect
          ctx={ctx}
          payment={value.payment}
          dueTouched={dueTouched}
          saleTouched={saleTouched}
          lastAutoDue={lastAutoDue}
          lastAutoSale={lastAutoSale}
        />
        <Tabs {...tabsProps}>
          <TabsList className="w-full">
            <TabsTrigger value="faktura">
              {withDot(t('financial_pl.invoices.form.tabs.faktura', 'Invoice'), false)}
            </TabsTrigger>
            <TabsTrigger value="podatki">
              {withDot(t('financial_pl.invoices.form.tabs.podatki', 'Taxes & KSeF'), podatkiHasData)}
            </TabsTrigger>
            <TabsTrigger value="uwagi">
              {withDot(t('financial_pl.invoices.form.tabs.uwagi', 'Notes'), hasNotes)}
            </TabsTrigger>
            <TabsTrigger value="dodatkowe">
              {withDot(t('financial_pl.invoices.form.tabs.dodatkowe', 'Additional'), hasOrderId)}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Tabs {...tabsProps}>
        <TabsList className="hidden">
          <TabsTrigger value="faktura">
            {withDot(t('financial_pl.invoices.form.tabs.faktura', 'Invoice'), false)}
            </TabsTrigger>
          <TabsTrigger value="podatki">
            {withDot(t('financial_pl.invoices.form.tabs.podatki', 'Taxes & KSeF'), podatkiHasData)}
            </TabsTrigger>
          <TabsTrigger value="uwagi">
            {withDot(t('financial_pl.invoices.form.tabs.uwagi', 'Notes'), hasNotes)}
            </TabsTrigger>
          <TabsTrigger value="dodatkowe">
            {withDot(t('financial_pl.invoices.form.tabs.dodatkowe', 'Additional'), hasOrderId)}
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
          <FormSection allowOverflow icon={<ListOrdered className="size-4" />} title={t('financial_pl.invoices.form.sections.lines', 'Lines')}>
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
              priceMode={value.priceMode}
              onPriceModeChange={setPriceMode}
              errors={fieldErrors}
              marginScheme={value.meta.marginScheme ?? null}
            />
          </FormSection>
        </div>

        <div
          role="tabpanel"
          aria-label={t('financial_pl.invoices.form.tabs.podatki', 'Taxes & KSeF')}
          className={activeTab === 'podatki' ? 'mt-2' : 'hidden'}
        >
          {/*
            Kind is promoted to the top of the Faktura tab (it decides what the rest of the form
            means), and the taxpayer NIP is not a per-invoice field at all — it identifies the
            SELLER and lives on the ksef_pl integration credential, which is what the KSeF filing
            actually uses. Keeping an editable copy here invited the two to disagree.
          */}
          <PlVatMetaForm
            value={value.meta}
            onChange={setMeta}
            disabled={readOnly}
            currencyCode={liveCurrency}
            taxPointDate={liveIssueDate}
            hideContextNip
            hideInvoiceKind
          />
        </div>

        <div
          role="tabpanel"
          aria-label={t('financial_pl.invoices.form.tabs.uwagi', 'Notes')}
          className={activeTab === 'uwagi' ? 'mt-2 flex max-w-xl flex-col gap-4' : 'hidden'}
        >
          <FormSection
            icon={<StickyNote className="size-4" />}
            title={t('financial_pl.invoices.form.fields.notes', 'Notes (Uwagi)')}
          >
            <Textarea
              value={notesValue}
              onChange={(event) => ctx.setValue('notes', event.target.value)}
              disabled={readOnly}
              aria-label={t('financial_pl.invoices.form.fields.notes', 'Notes (Uwagi)')}
              placeholder={t('financial_pl.invoices.form.fields.notesPlaceholder', 'Optional remarks shown on the invoice')}
              aria-invalid={Boolean(ctx.errors?.notes)}
            />
            {ctx.errors?.notes ? <p className="text-sm text-destructive">{ctx.errors.notes}</p> : null}

            {/* Optional annotations, revealed on demand: most invoices carry neither, and two more
                permanently-empty inputs would just be two more things to scroll past. */}
            <div className="flex flex-wrap gap-2">
              {OPTIONAL_NOTE_FIELDS.map((field) => {
                const value = typeof ctx.values[field.id] === 'string' ? (ctx.values[field.id] as string) : ''
                if (value || revealedNoteFields.includes(field.id)) return null
                return (
                  <Button
                    key={field.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={readOnly}
                    onClick={() => setRevealedNoteFields((prev) => [...prev, field.id])}
                  >
                    <Plus className="mr-1 size-4" />
                    {t(field.labelKey, field.fallback)}
                  </Button>
                )
              })}
            </div>

            {OPTIONAL_NOTE_FIELDS.map((field) => {
              const value = typeof ctx.values[field.id] === 'string' ? (ctx.values[field.id] as string) : ''
              if (!value && !revealedNoteFields.includes(field.id)) return null
              return (
                <div key={field.id} className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor={`financial_pl-${field.id}`}>
                    {t(field.labelKey, field.fallback)}
                  </label>
                  <Input
                    id={`financial_pl-${field.id}`}
                    value={value}
                    disabled={readOnly}
                    onChange={(event) => ctx.setValue(field.id, event.target.value)}
                  />
                </div>
              )
            })}
          </FormSection>
          <FormSection
            icon={<PenLine className="size-4" />}
            title={t('financial_pl.invoices.form.sections.signature', 'Signature')}
          >
            {/* No Polish VAT invoice has required a signature since 2004 — these choices only
                decide what the printed document states in place of one. */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-signature-mode">
                {t('financial_pl.invoices.form.signature.mode', 'Signature note')}
              </label>
              <Select
                value={
                  typeof ctx.values.signatureMode === 'string' && ctx.values.signatureMode
                    ? ctx.values.signatureMode
                    : 'no_signatures'
                }
                onValueChange={(next) => ctx.setValue('signatureMode', next)}
                disabled={readOnly}
              >
                <SelectTrigger id="financial_pl-signature-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIGNATURE_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`financial_pl.invoices.form.signature.modes.${mode}`, mode)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-signature-issuer">
                {t('financial_pl.invoices.form.signature.issuer', 'Person authorised to issue the invoice')}
              </label>
              <Input
                id="financial_pl-signature-issuer"
                value={typeof ctx.values.issuerSignatory === 'string' ? ctx.values.issuerSignatory : ''}
                disabled={readOnly}
                onChange={(event) => ctx.setValue('issuerSignatory', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="financial_pl-signature-recipient">
                {t('financial_pl.invoices.form.signature.recipient', 'Person authorised to receive the invoice')}
              </label>
              <Input
                id="financial_pl-signature-recipient"
                value={typeof ctx.values.recipientSignatory === 'string' ? ctx.values.recipientSignatory : ''}
                disabled={readOnly}
                onChange={(event) => ctx.setValue('recipientSignatory', event.target.value)}
              />
            </div>
          </FormSection>
        </div>

        <div
          role="tabpanel"
          aria-label={t('financial_pl.invoices.form.tabs.dodatkowe', 'Additional')}
          className={activeTab === 'dodatkowe' ? 'mt-2 max-w-xl' : 'hidden'}
        >
          <FormSection icon={<Hash className="size-4" />} title={t('financial_pl.invoices.form.fields.orderId', 'Order UUID (optional)')}>
            <Input
              value={orderIdValue}
              onChange={(event) => ctx.setValue('orderId', event.target.value)}
              disabled={readOnly}
              aria-label={t('financial_pl.invoices.form.fields.orderId', 'Order UUID (optional)')}
              aria-invalid={Boolean(fieldErrors.orderId ?? ctx.errors?.orderId)}
            />
            {fieldErrors.orderId ?? ctx.errors?.orderId ? (
              <p className="text-sm text-destructive">{fieldErrors.orderId ?? ctx.errors?.orderId}</p>
            ) : null}
          </FormSection>
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
    signatureMode: DEFAULT_SIGNATURE_MODE,
    issuerSignatory: '',
    recipientSignatory: '',
    contractNumber: '',
    transportTerms: '',
  }
}

/** Build a default create-mode value with one starter line and empty meta. */
export function emptyInvoiceFormValue(): InvoiceFormValue {
  return {
    header: emptyHeader(),
    buyer: { countryCode: 'PL' },
    lines: [withComputedTotals(
      { name: '', quantity: '1', quantityUnit: 'szt.', unitPriceNet: '0', unitPriceGross: '0', taxRate: '23', currencyCode: DEFAULT_CURRENCY, kind: 'product' },
      DEFAULT_CURRENCY,
      1,
    )],
    payment: defaultPayment(),
    meta: {},
    priceMode: 'net',
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

function roundMoneyNumber(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

function moneyNumber(value: string | undefined): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? roundMoneyNumber(numeric) : 0
}

/** Map editor lines to the core invoice-line wire shape (drop empty optionals). */
function buildLinesPayload(
  lines: InvoiceLineInput[],
  currencyCode: string,
  priceMode: PriceMode,
  marginScheme?: MarginScheme | null,
): Array<Record<string, unknown>> {
  const marginMode = Boolean(marginScheme)
  return lines.map((line, index) => {
    const computed = withComputedTotals(line, currencyCode, index + 1, marginMode ? 'gross' : priceMode, marginScheme)
    const discountPercent = Number((line.discountPercent ?? '').trim() || 0)
    const row: Record<string, unknown> = {
      name: computed.name,
      quantity: computed.quantity,
      unitPriceNet: computed.unitPriceNet,
      currencyCode,
      lineNumber: index + 1,
      kind: computed.kind ?? 'product',
      discountPercent: Number.isFinite(discountPercent) ? discountPercent : 0,
      discountAmount: moneyNumber(computed.discountAmount),
      totalNetAmount: moneyNumber(computed.totalNetAmount),
      totalGrossAmount: moneyNumber(computed.totalGrossAmount),
    }
    if ((marginMode || priceMode === 'gross') && computed.unitPriceGross) {
      row.unitPriceGross = moneyNumber(computed.unitPriceGross)
    }
    if (computed.quantityUnit && computed.quantityUnit.trim()) row.quantityUnit = computed.quantityUnit.trim()
    if (!marginMode && computed.taxRate != null && computed.taxRate !== '') row.taxRate = computed.taxRate
    if (!marginMode) row.taxAmount = moneyNumber(computed.taxAmount)
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

function buildInvoiceTotalsPayload(
  lines: InvoiceLineInput[],
  currencyCode: string,
  priceMode: PriceMode,
  payment: PaymentValue,
  marginScheme?: MarginScheme | null,
): Record<string, number> {
  const marginMode = Boolean(marginScheme)
  const totals = lines.reduce(
    (sum, line, index) => {
      const computed = withComputedTotals(line, currencyCode, index + 1, marginMode ? 'gross' : priceMode, marginScheme)
      sum.net += moneyNumber(computed.totalNetAmount)
      sum.gross += moneyNumber(computed.totalGrossAmount)
      sum.tax += marginMode ? 0 : moneyNumber(computed.taxAmount)
      sum.discount += moneyNumber(computed.discountAmount)
      return sum
    },
    { net: 0, gross: 0, tax: 0, discount: 0 },
  )
  const grandGross = roundMoneyNumber(totals.gross)
  const paidTotalAmount = payment.paid ? grandGross : 0
  return {
    subtotalNetAmount: roundMoneyNumber(totals.net),
    subtotalGrossAmount: grandGross,
    discountTotalAmount: roundMoneyNumber(totals.discount),
    taxTotalAmount: marginMode ? 0 : roundMoneyNumber(totals.tax),
    grandTotalNetAmount: roundMoneyNumber(totals.net),
    grandTotalGrossAmount: grandGross,
    paidTotalAmount,
    outstandingAmount: roundMoneyNumber(grandGross - paidTotalAmount),
  }
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
  if (body.marginScheme === '') body.marginScheme = null
  if (!body.marginScheme) {
    body.marginPurchaseCost = null
    body.marginVatRate = null
  } else {
    if (body.marginPurchaseCost === '') body.marginPurchaseCost = null
    if (body.marginVatRate == null) body.marginVatRate = 23
  }
  if (!isAdvanceInvoiceKind(normalizedInvoiceKind)) {
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
    hasNonEmptyString(meta.marginPurchaseCost) ||
    hasNonEmptyString(meta.badDebtReliefPeriod) ||
    hasNonEmptyString(meta.badDebtTerminPlatnosci) ||
    Boolean(meta.typDokumentu) ||
    Boolean(meta.marginScheme) ||
    meta.marginVatRate != null
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
/**
 * Date pattern for the form's date pickers. Without an explicit format the DS picker falls back to
 * the US `MMM d, yyyy` ("Jul 26, 2026") because no date-fns locale is threaded through CrudForm —
 * which read as English inside an otherwise Polish invoice, and disagreed with the invoice list
 * (`05.07.2026`). `dd.MM.yyyy` is the Polish convention and matches the list exactly.
 */
const PL_DATE_DISPLAY_FORMAT = 'dd.MM.yyyy'

const DATE_LOCALES = { pl: plLocale, en: enUS, de: deLocale, es: esLocale } as const

/** Payment terms offered as one-click picks; anything else goes through the calendar. */
const DUE_DATE_TERM_DAYS = [7, 14, 30] as const

/**
 * Due date: the DS calendar plus the terms an operator actually uses. Typing a date for "14 days"
 * is arithmetic the form already knows how to do (`addDays`), so it offers it — the calendar stays
 * for everything else. The active term is highlighted so the current value is readable at a glance.
 */
/**
 * Module-scope so its identity is stable. `ComboboxInput` lists `loadSuggestions` in the deps of
 * two effects, so an inline arrow re-ran the load on every render — which showed up as the currency
 * input flickering continuously after a pick.
 */
const loadCurrencySuggestions = async (query?: string) => searchCurrencies(query)

/**
 * The provisional next invoice number, or null. Create mode only: on an existing invoice the number
 * is already assigned, and nothing is consumed on an abandoned form — the endpoint reads the
 * sequence rather than claiming it. With a numbering series selected the peek targets that series'
 * own counter and format.
 */
function useNextInvoiceNumber(enabled: boolean, seriesId: string | null): string | null {
  const [number, setNumber] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Reset so a slow response for the previously selected series never lingers as the suggestion.
    setNumber(null)
    void (async () => {
      const url = seriesId
        ? `/api/financial_pl/next-invoice-number?seriesId=${encodeURIComponent(seriesId)}`
        : '/api/financial_pl/next-invoice-number'
      const res = await apiCall<{ number?: string | null }>(url)
      if (cancelled || !res.ok) return
      const next = typeof res.result?.number === 'string' ? res.result.number.trim() : ''
      if (next) setNumber(next)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, seriesId])
  return number
}

/** Radix `SelectItem` forbids an empty value, so "no series" travels as this sentinel. */
const SYSTEM_NUMBERING_VALUE = '__system__'

function InvoiceDetailFields({
  ctx,
  disabled,
  invoiceKind,
  onInvoiceKindChange,
  suggestedNumber,
  numberingSeries,
  numberingSeriesId,
  onNumberingSeriesChange,
  fieldErrors,
}: {
  ctx: CrudFormGroupComponentProps
  disabled?: boolean
  invoiceKind: InvoiceKindColumn
  onInvoiceKindChange: (next: InvoiceKindColumn) => void
  suggestedNumber?: string | null
  /** Active series to offer; absent/empty hides the picker (edit mode, or none configured). */
  numberingSeries?: InvoiceNumberingSeries[]
  numberingSeriesId?: string | null
  onNumberingSeriesChange?: (next: string | null) => void
  fieldErrors: Record<string, string>
}) {
  const t = useT()
  const locale = useLocale()
  const dateLocale = DATE_LOCALES[locale as keyof typeof DATE_LOCALES] ?? plLocale
  const labelClass = 'text-sm font-medium text-foreground'
  const str = (id: string) => (typeof ctx.values?.[id] === 'string' ? (ctx.values[id] as string) : '')
  const dateValue = (id: string) => {
    const raw = str(id)
    if (!raw) return null
    const parsed = new Date(`${raw}T00:00:00`)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  const required = <span aria-hidden="true" className="text-status-error-text"> *</span>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className={labelClass} htmlFor="financial_pl-invoice-kind">
          {t('financial_pl.fields.invoiceKind', 'Invoice kind')}
        </label>
        <Select
          value={invoiceKind}
          onValueChange={(next) => onInvoiceKindChange((next as InvoiceKindColumn) || 'vat')}
          disabled={disabled}
        >
          <SelectTrigger id="financial_pl-invoice-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORM_INVOICE_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`financial_pl.invoiceKind.${kind}`, kind.toUpperCase())}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {numberingSeries && numberingSeries.length > 0 ? (
        <div className="flex flex-col gap-2" data-invalid={fieldErrors.issueDate ? 'true' : undefined}>
          <label className={labelClass} htmlFor="financial_pl-numbering-series">
            {t('financial_pl.invoices.form.fields.numberingSeries', 'Numbering series')}
          </label>
          <Select
            value={numberingSeriesId ?? SYSTEM_NUMBERING_VALUE}
            onValueChange={(next) => onNumberingSeriesChange?.(next === SYSTEM_NUMBERING_VALUE ? null : next)}
            disabled={disabled}
          >
            <SelectTrigger id="financial_pl-numbering-series" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {numberingSeries.map((series) => (
                <SelectItem key={series.id} value={series.id}>
                  {series.name ? `${series.code} — ${series.name}` : series.code}
                </SelectItem>
              ))}
              <SelectItem value={SYSTEM_NUMBERING_VALUE}>
                {t('financial_pl.invoices.form.fields.numberingSeriesSystem', 'System default')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label className={labelClass} htmlFor="financial_pl-invoice-number">
          {t('financial_pl.invoices.form.fields.invoiceNumber', 'Invoice number')}
        </label>
        <Input
          id="financial_pl-invoice-number"
          value={str('invoiceNumber')}
          disabled={disabled}
          onChange={(event) => ctx.setValue('invoiceNumber', event.target.value)}
          placeholder={
            suggestedNumber
              ? t('financial_pl.invoices.form.fields.invoiceNumberSuggested', 'Auto: {number}', { number: suggestedNumber })
              : t('financial_pl.invoices.form.fields.invoiceNumberPlaceholder', 'Auto-assigned if left blank')
          }
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className={labelClass}>
          {t('financial_pl.invoices.form.fields.currencyCode', 'Currency')}
          {required}
        </label>
        <ComboboxInput
          value={str('currencyCode')}
          onChange={(next) => ctx.setValue('currencyCode', next)}
          disabled={disabled}
          allowCustomValues={false}
          placeholder={t('financial_pl.invoices.form.fields.currencyPlaceholder', 'Search currency (e.g. PLN, EUR)…')}
          loadSuggestions={loadCurrencySuggestions}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <label className={labelClass}>
            {t('financial_pl.invoices.form.fields.issueDate', 'Issue date')}
            {required}
          </label>
          <DatePicker
            id="financial_pl-issue-date"
            value={dateValue('issueDate')}
            onChange={(next) => ctx.setValue('issueDate', next ? toIsoDateLocal(next) : '')}
            disabled={disabled}
            displayFormat={PL_DATE_DISPLAY_FORMAT}
            locale={dateLocale}
            aria-describedby={fieldErrors.issueDate ? 'financial_pl-issue-date-error' : undefined}
          />
          {fieldErrors.issueDate ? (
            <p id="financial_pl-issue-date-error" className="text-sm text-destructive">
              {fieldErrors.issueDate}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2" data-invalid={fieldErrors.saleDate ? 'true' : undefined}>
          <label className={labelClass}>
            {t('financial_pl.invoices.form.fields.saleDate', 'Sale date (Data sprzedaży)')}
            {required}
          </label>
          <DatePicker
            id="financial_pl-sale-date"
            value={dateValue('saleDate')}
            onChange={(next) => ctx.setValue('saleDate', next ? toIsoDateLocal(next) : '')}
            disabled={disabled}
            displayFormat={PL_DATE_DISPLAY_FORMAT}
            locale={dateLocale}
            aria-describedby={fieldErrors.saleDate ? 'financial_pl-sale-date-error' : undefined}
          />
          {fieldErrors.saleDate ? (
            <p id="financial_pl-sale-date-error" className="text-sm text-destructive">
              {fieldErrors.saleDate}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2" data-invalid={fieldErrors.dueDate ? 'true' : undefined}>
        <label className={labelClass}>
          {t('financial_pl.invoices.form.fields.dueDate', 'Due date')}
        </label>
        <DueDateField
          value={str('dueDate')}
          issueDate={str('issueDate')}
          disabled={disabled}
          onChange={(next) => ctx.setValue('dueDate', next)}
        />
        {fieldErrors.dueDate ? <p className="text-sm text-destructive">{fieldErrors.dueDate}</p> : null}
      </div>
    </div>
  )
}

function DueDateField({
  value,
  issueDate,
  disabled,
  onChange,
}: {
  value: string
  issueDate: string
  disabled?: boolean
  onChange: (next: string) => void
}) {
  const t = useT()
  const locale = useLocale()
  const dateLocale = DATE_LOCALES[locale as keyof typeof DATE_LOCALES] ?? plLocale
  const selected = value ? new Date(`${value}T00:00:00`) : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DatePicker
        value={selected && !Number.isNaN(selected.getTime()) ? selected : null}
        onChange={(next) => onChange(next ? toIsoDateLocal(next) : '')}
        disabled={disabled}
        displayFormat={PL_DATE_DISPLAY_FORMAT}
        locale={dateLocale}
        className="w-auto"
      />
      <div className="flex flex-wrap items-center gap-1">
        {DUE_DATE_TERM_DAYS.map((days) => {
          const target = issueDate ? addDays(issueDate, days) : ''
          const active = Boolean(target) && target === value
          return (
            <Button
              key={days}
              type="button"
              size="sm"
              variant="outline"
              // Selected state uses the same `accent-indigo` token the DS checkbox uses when
              // checked, so "chosen" reads the same way everywhere; `secondary` was grey and barely
              // distinguishable from the unselected chips beside it.
              className={
                active
                  ? 'border-accent-indigo bg-accent-indigo text-accent-indigo-foreground hover:bg-accent-indigo/90 hover:text-accent-indigo-foreground'
                  : undefined
              }
              disabled={disabled || !issueDate}
              aria-pressed={active}
              onClick={() => onChange(target)}
            >
              {t('financial_pl.invoices.form.fields.dueInDays', '{count} days', { count: days })}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

/** `Date` → `yyyy-mm-dd` in LOCAL time; `toISOString()` can shift the day across a timezone. */
function toIsoDateLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Invisible bridge: reports CrudForm's live values upward in an effect (never during render). */
function PreviewSync({
  values,
  onValues,
}: {
  values?: Record<string, unknown>
  onValues: (next: Record<string, unknown>) => void
}) {
  const serialized = JSON.stringify(values ?? {})
  React.useEffect(() => {
    onValues(JSON.parse(serialized) as Record<string, unknown>)
  }, [serialized, onValues])
  return null
}

const RESET_SENSITIVE_HEADER_FIELDS = [
  'invoiceNumber',
  'issueDate',
  'dueDate',
  'saleDate',
  'currencyCode',
  'orderId',
  'notes',
  'signatureMode',
  'issuerSignatory',
  'recipientSignatory',
  'contractNumber',
  'transportTerms',
] as const

/**
 * Resolve a settings currency only while every CrudForm-owned header value still matches its
 * mount baseline. Returning null is load-bearing: changing `initialValues` after a header edit can
 * reset unrelated fields, so an async default must never be applied once editing has begun.
 */
export function resolveUntouchedCurrencyDefault(
  defaultCurrencyCode: string | null | undefined,
  liveValues: Readonly<Record<string, unknown>>,
  initialValues: Readonly<Record<string, unknown>>,
): string | null {
  const currencyCode = (defaultCurrencyCode ?? '').trim().toUpperCase()
  if (!isValidCurrencyCode(currencyCode)) return null
  const liveCurrency = String(liveValues.currencyCode ?? '').trim().toUpperCase()
  if (liveCurrency !== DEFAULT_CURRENCY) return null
  const untouched = RESET_SENSITIVE_HEADER_FIELDS.every(
    (field) => String(liveValues[field] ?? '') === String(initialValues[field] ?? ''),
  )
  return untouched ? currencyCode : null
}

export function buildInvoiceCrudInitialValues(value: ControlledInvoiceFormValue): Record<string, string> {
  return {
    invoiceNumber: value.header.invoiceNumber,
    issueDate: value.header.issueDate,
    dueDate: value.header.dueDate,
    saleDate: value.header.saleDate,
    currencyCode: value.header.currencyCode,
    orderId: value.header.orderId,
    notes: value.notes ?? '',
    signatureMode: value.header.signatureMode,
    issuerSignatory: value.header.issuerSignatory,
    recipientSignatory: value.header.recipientSignatory,
    contractNumber: value.header.contractNumber,
    transportTerms: value.header.transportTerms,
  }
}

export function buildInvoicePreviewSnapshot(
  value: ControlledInvoiceFormValue,
  liveHeader: Readonly<Record<string, unknown>>,
  suggestedNumber: string | null,
): InvoicePreviewSnapshot {
  const typedNumber = String(liveHeader.invoiceNumber ?? value.header.invoiceNumber ?? '').trim()
  return {
    invoiceNumber: typedNumber || suggestedNumber,
    invoiceNumberProvisional: !typedNumber && Boolean(suggestedNumber),
    signature: {
      mode: String(liveHeader.signatureMode ?? value.header.signatureMode ?? '') || undefined,
      issuerSignatory: String(liveHeader.issuerSignatory ?? value.header.issuerSignatory ?? '') || undefined,
      recipientSignatory: String(liveHeader.recipientSignatory ?? value.header.recipientSignatory ?? '') || undefined,
    },
    header: {
      invoiceNumber: String(liveHeader.invoiceNumber ?? value.header.invoiceNumber ?? ''),
      issueDate: String(liveHeader.issueDate ?? value.header.issueDate ?? ''),
      dueDate: String(liveHeader.dueDate ?? value.header.dueDate ?? ''),
      saleDate: String(liveHeader.saleDate ?? value.header.saleDate ?? ''),
      currencyCode: String(liveHeader.currencyCode ?? value.header.currencyCode ?? ''),
      orderId: String(liveHeader.orderId ?? value.header.orderId ?? ''),
      notes: String(liveHeader.notes ?? value.notes ?? ''),
    },
    buyer: value.buyer,
    lines: value.lines,
    payment: value.payment,
    meta: value.meta,
    notes: String(liveHeader.notes ?? value.notes ?? ''),
  }
}

export function InvoiceForm({ invoiceId, initialValue, readOnly, lockNotice, onPreviewChange, headerActions, asideContent }: InvoiceFormProps) {
  const t = useT()
  const router = useRouter()
  const [clientReady, setClientReady] = React.useState(false)
  React.useEffect(() => setClientReady(true), [])
  const isEdit = Boolean(invoiceId)
  const formTitle = isEdit
    ? t('financial_pl.invoices.edit.title', 'Edit invoice')
    : t('financial_pl.invoices.create.title', 'Create invoice')
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [activeTab, setActiveTab] = React.useState<InvoiceTab>('faktura')
  // CrudForm owns the header inputs and exposes no onChange, so a hidden custom field reports its
  // `values` back here — that is what lets the preview update as the header is typed.
  const [liveHeader, setLiveHeader] = React.useState<Record<string, unknown>>({})
  // Opt-in: creating still saves a DRAFT by default. With this on, the same action also files the
  // invoice to KSeF, which is irreversible — so it is off unless the operator asks for it, and it
  // asks for confirmation before filing.
  const [sendToKsef, setSendToKsef] = React.useState(false)
  /**
   * Field-level validation results. Validation used to `throw` on the FIRST failure, so the operator
   * fixed one problem, submitted, and discovered the next — and nothing pointed at the offending
   * field. Every check now records into this map, the form reports them all at once, and the fields
   * themselves show the error.
   */
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const hasSubmittedRef = React.useRef(false)
  const { settings: invoiceSettings, refresh: refreshInvoiceSettings } = useInvoiceSettings()
  const bankAccounts: PaymentAccountOption[] = invoiceSettings?.bankAccounts ?? []
  const numberingSeriesOptions = React.useMemo(
    () => (invoiceSettings?.numberingSeries ?? []).filter((series) => series.isActive !== false),
    [invoiceSettings],
  )
  const [numberingSeriesId, setNumberingSeriesId] = React.useState<string | null>(null)
  // Preselect the default series once settings arrive — but never fight an operator who already
  // picked one (mirrors the dueTouched pattern for the smart date defaults).
  const seriesTouched = React.useRef(false)
  React.useEffect(() => {
    if (isEdit || seriesTouched.current) return
    const preset = numberingSeriesOptions.find((series) => series.isDefault) ?? null
    setNumberingSeriesId(preset ? preset.id : null)
  }, [isEdit, numberingSeriesOptions])
  /**
   * One claimed number per (form session, series), kept for retry: a create that fails after the
   * claim would otherwise burn a second number on resubmit. Only a series switch abandons a kept
   * claim (that gap is deliberate and rare — see the claim route).
   */
  const claimedNumberRef = React.useRef<{ seriesId: string; number: string } | null>(null)
  const suggestedNumber = useNextInvoiceNumber(!isEdit && !readOnly, numberingSeriesId)


  // Submit-failure summary. `CrudForm` does render the thrown message, but only in a plain div at
  // the very bottom of the form — on this form that lands ~1900px down, so on a failed save nothing
  // appears to happen. We mirror the message into an alert at the TOP of the form, announce it via
  // role="alert", and move focus to it, so the failure is seen (and heard) without scrolling.
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const submitErrorRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!submitError) return
    const node = submitErrorRef.current
    if (!node) return
    // `nearest` so an already-visible alert never scrolls the form out from under the user.
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    node.focus()
  }, [submitError])

  /**
   * Records a submit failure for the top-of-form alert and returns the error to throw, so a call
   * site stays a single `throw failSubmit(...)`. Keeps `CrudForm`'s own handling intact.
   */
  const failSubmit = React.useCallback((message: string) => {
    setSubmitError(message)
    return createCrudFormError(message)
  }, [])

  const [value, setValue] = React.useState<ControlledInvoiceFormValue>(() =>
    normalizeInvoiceFormValue(initialValue, isEdit),
  )
  const initialCrudHeaderValuesRef = React.useRef(buildInvoiceCrudInitialValues(value))
  const currencyDefaultAppliedRef = React.useRef(isEdit)
  React.useEffect(() => {
    if (!onPreviewChange) return
    onPreviewChange(buildInvoicePreviewSnapshot(value, liveHeader, suggestedNumber))
  }, [onPreviewChange, liveHeader, value, suggestedNumber])

  const dateWarnings = React.useMemo(
    () => invoiceDateProblems({
      issueDate: String(liveHeader.issueDate ?? value.header.issueDate ?? ''),
      saleDate: String(liveHeader.saleDate ?? value.header.saleDate ?? ''),
      dueDate: String(liveHeader.dueDate ?? value.header.dueDate ?? ''),
      today: todayInWarsaw(),
      invoiceKind: value.meta.invoiceKind,
    }).warnings,
    [liveHeader, value.header.dueDate, value.header.issueDate, value.header.saleDate, value.meta.invoiceKind],
  )

  React.useEffect(() => {
    if (!hasSubmittedRef.current) return
    const currentProblems = collectInvoiceFieldProblems(
      value,
      {
        issueDate: String(liveHeader.issueDate ?? value.header.issueDate ?? ''),
        saleDate: String(liveHeader.saleDate ?? value.header.saleDate ?? ''),
        dueDate: String(liveHeader.dueDate ?? value.header.dueDate ?? ''),
        orderId: String(liveHeader.orderId ?? value.header.orderId ?? ''),
      },
      {
        isEdit,
        today: todayInWarsaw(),
        priceMode: value.meta.marginScheme ? 'gross' : value.priceMode,
        marginScheme: value.meta.marginScheme ?? null,
      },
    )
    const failing = Object.fromEntries(
      currentProblems.map((problem) => [problem.field, t(problem.messageKey)]),
    )
    setFieldErrors((current) => {
      const next = pruneInvoiceFieldErrors(current, failing)
      const currentEntries = Object.entries(current)
      const nextEntries = Object.entries(next)
      return currentEntries.length === nextEntries.length &&
        currentEntries.every(([field, message]) => next[field] === message)
        ? current
        : next
    })
  }, [isEdit, liveHeader, t, value])

  const dueTouched = React.useRef(isEdit)
  const saleTouched = React.useRef(isEdit)
  const lastAutoDue = React.useRef(value.header.dueDate)
  const lastAutoSale = React.useRef(value.header.saleDate)
  React.useEffect(() => {
    const nextValue = normalizeInvoiceFormValue(initialValue, isEdit)
    setValue(nextValue)
    initialCrudHeaderValuesRef.current = buildInvoiceCrudInitialValues(nextValue)
    currencyDefaultAppliedRef.current = isEdit
    hasSubmittedRef.current = false
    setFieldErrors({})
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
    setValue((prev) => {
      const marginScheme = meta.marginScheme ?? null
      const priceMode: PriceMode = marginScheme ? 'gross' : prev.priceMode
      const sourceLines = marginScheme && prev.priceMode !== 'gross'
        ? convertLinesPriceMode(prev.lines, 'gross', marginScheme)
        : prev.lines
      return {
        ...prev,
        meta,
        priceMode,
        lines: sourceLines.map((line, index) =>
          withComputedTotals(line, prev.header.currencyCode || DEFAULT_CURRENCY, index + 1, priceMode, marginScheme),
        ),
      }
    })
  }, [])
  const setBuyer = React.useCallback((buyer: BuyerValue) => {
    setValue((prev) => ({ ...prev, buyer }))
  }, [])
  const setPayment = React.useCallback((payment: PaymentValue) => {
    setValue((prev) => ({ ...prev, payment }))
  }, [])

  const handleCreateAccount = React.useCallback(
    async (account: Omit<PaymentAccountOption, 'id'>) => {
      const current = await apiCall<{ settings?: { bankAccounts?: PaymentAccountOption[] } }>(
        '/api/financial_pl/invoice-settings',
      )
      if (!current.ok) {
        flash(t('financial_pl.invoices.form.payment.accountAddFailed', 'Could not save the account.'), 'error')
        return false
      }
      const existing = current.result?.settings?.bankAccounts ?? []
      const next = [
        ...existing,
        { ...account, id: crypto.randomUUID(), isDefault: existing.length === 0 },
      ]
      const saved = await apiCall<{ ok?: boolean; error?: string }>('/api/financial_pl/invoice-settings', {
        method: 'PUT',
        body: JSON.stringify({ bankAccounts: next }),
      })
      if (!saved.ok) {
        flash(
          saved.result?.error ??
            t('financial_pl.invoices.form.payment.accountAddFailed', 'Could not save the account.'),
          'error',
        )
        return false
      }
      refreshInvoiceSettings()
      setValue((prev) => ({
        ...prev,
        payment: {
          ...prev.payment,
          bankAccount: account.accountNumber,
          bankName: account.bankName ?? '',
          swift: account.swift ?? '',
        },
      }))
      flash(t('financial_pl.invoices.form.payment.accountAdded', 'Account added.'), 'success')
      return true
    },
    [refreshInvoiceSettings, t],
  )
  // Defaults apply ONCE, and only while creating: settings arrive asynchronously, so overwriting a
  // field the operator is already typing into would be worse than having no default at all.
  const defaultsAppliedRef = React.useRef(false)
  React.useEffect(() => {
    if (isEdit || readOnly || !invoiceSettings || defaultsAppliedRef.current) return
    defaultsAppliedRef.current = true
    const defaultAccount =
      invoiceSettings.bankAccounts?.find((account) => account.isDefault) ??
      invoiceSettings.bankAccounts?.[0] ??
      null
    setValue((prev) => {
      const payment: PaymentValue = { ...prev.payment }
      if (invoiceSettings.defaultPaymentMethod) {
        payment.method = invoiceSettings.defaultPaymentMethod as PaymentValue['method']
      }
      if (invoiceSettings.defaultTermDays != null) payment.termDays = invoiceSettings.defaultTermDays
      if (defaultAccount && !(payment.bankAccount ?? '').trim() && payment.method === 'transfer') {
        payment.bankAccount = defaultAccount.accountNumber
        payment.bankName = defaultAccount.bankName ?? ''
        payment.swift = defaultAccount.swift ?? ''
      }
      const priceMode: PriceMode =
        invoiceSettings.defaultPriceMode === 'gross' || invoiceSettings.defaultPriceMode === 'net'
          ? invoiceSettings.defaultPriceMode
          : prev.priceMode
      const taxRate = invoiceSettings.defaultTaxRate
      return {
        ...prev,
        payment,
        priceMode: prev.meta.marginScheme ? 'gross' : priceMode,
        // Only the starter line: a default rate is a starting point, not a correction to lines the
        // operator has already filled in.
        lines: taxRate
          ? prev.lines.map((line, index) => (index === 0 && !line.name.trim() ? { ...line, taxRate } : line))
          : prev.lines,
      }
    })
  }, [invoiceSettings, isEdit, readOnly])

  React.useEffect(() => {
    if (
      isEdit ||
      readOnly ||
      !invoiceSettings ||
      currencyDefaultAppliedRef.current ||
      Object.keys(liveHeader).length === 0
    ) {
      return
    }
    currencyDefaultAppliedRef.current = true
    const currencyCode = resolveUntouchedCurrencyDefault(
      invoiceSettings.defaultCurrencyCode,
      liveHeader,
      initialCrudHeaderValuesRef.current,
    )
    if (!currencyCode || currencyCode === value.header.currencyCode) return
    setValue((current) => {
      const marginScheme = current.meta.marginScheme ?? null
      const priceMode: PriceMode = marginScheme ? 'gross' : current.priceMode
      return {
        ...current,
        header: { ...current.header, currencyCode },
        lines: current.lines.map((line, index) => withComputedTotals(
          { ...line, currencyCode },
          currencyCode,
          index + 1,
          priceMode,
          marginScheme,
        )),
      }
    })
  }, [invoiceSettings, isEdit, liveHeader, readOnly, value.header.currencyCode])

  const saveAsDraftRef = React.useRef(false)

  const setPriceMode = React.useCallback((priceMode: PriceMode) => {
    setValue((prev) => ({ ...prev, priceMode: prev.meta.marginScheme ? 'gross' : priceMode }))
  }, [])

  // --- Submit handler shared by create + edit -----------------------------------------------
  // Header values come straight from the CrudForm builtin fields (passed in by `onSubmit`) so the
  // payload reflects the latest edits without depending on async state propagation.
  const handleSubmit = React.useCallback(async (header: InvoiceHeaderValues & { notes?: string }) => {
    if (readOnly) return
    setSubmitError(null)
    const asDraft = saveAsDraftRef.current
    saveAsDraftRef.current = false
    if (!isEdit && sendToKsef && !asDraft) {
      const ok = await confirm({
        title: t('financial_pl.invoices.form.sendToKsefOnCreate', 'Send to KSeF after saving'),
        text: t(
          'financial_pl.actions.sendToKsefConfirmDialog',
          'Sending to KSeF is an irreversible legal filing. Send this invoice now?',
        ),
        confirmText: t('financial_pl.actions.sendToKsef', 'Send to KSeF'),
        variant: 'destructive',
      })
      if (!ok) return
    }
    hasSubmittedRef.current = true
    const effectiveCurrency = header.currencyCode.trim().toUpperCase() || DEFAULT_CURRENCY
    if (!isValidCurrencyCode(effectiveCurrency)) {
      throw failSubmit(t('financial_pl.validation.currencyInvalid', 'Select a valid ISO currency code.'))
    }
    const marginScheme = value.meta.marginScheme ?? null
    const effectivePriceMode: PriceMode = marginScheme ? 'gross' : value.priceMode
    const linesPayload = buildLinesPayload(value.lines, effectiveCurrency, effectivePriceMode, marginScheme)
    if (marginScheme && effectiveCurrency !== DEFAULT_CURRENCY) {
      setActiveTab('podatki')
      throw failSubmit(
        t('financial_pl.validation.marginSchemeRequiresPln', 'Margin-scheme invoices are available only in PLN.'),
      )
    }
    if (marginScheme && effectivePriceMode !== 'gross') {
      setActiveTab('faktura')
      throw failSubmit(
        t('financial_pl.validation.grossModeMixed', 'Margin-scheme invoices must use gross price entry.'),
      )
    }

    const buyer = value.buyer ?? {}
    const contextNipRaw = (typeof value.meta.contextNip === 'string' ? value.meta.contextNip : '').trim()
    const contextNip = normalizeNipDigits(contextNipRaw)
    if (contextNipRaw && !isValidPolishNip(contextNip)) {
      setActiveTab('podatki')
      throw failSubmit(t('financial_pl.validation.nipChecksumTaxpayer', 'The taxpayer NIP is invalid (checksum failed).'))
    }
    const kind = value.meta.invoiceKind ?? 'vat'
    if (!isAdvanceInvoiceKind(kind) && hasAdvanceSettlementData(value.meta)) {
      setActiveTab('podatki')
      throw failSubmit(
        t(
          'financial_pl.invoices.form.advances.kindRequired',
          'Advance payments and order data can be saved only on ZAL/ROZ invoices or their corrections. Switch the invoice kind or clear the advance data.',
        ),
      )
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
      throw failSubmit(
        t('financial_pl.validation.termDaysRange', 'The payment term must be a whole number of days between 0 and 3650.'),
      )
    }
    const problems = collectInvoiceFieldProblems(
      value,
      header,
      {
        isEdit,
        today: todayInWarsaw(),
        priceMode: effectivePriceMode,
        marginScheme,
      },
    ).map((problem): InvoiceFieldProblem & { message: string } => ({
      ...problem,
      message: t(problem.messageKey),
    }))

    // One gate for every field check: report them all, mark the fields, and land the operator on the
    // tab holding the first problem.
    // Drafts may intentionally be incomplete, but values that are present still have to be
    // persistable. Core stores orderId as a UUID, so letting an invalid value reach the API turns
    // a useful field error into a generic failed-to-create response.
    const blockingProblems = asDraft
      ? problems.filter((problem) => problem.field === 'orderId')
      : problems
    if (blockingProblems.length > 0) {
      setFieldErrors(Object.fromEntries(blockingProblems.map((p) => [p.field, p.message])))
      setActiveTab(blockingProblems[0].tab)
      // Land the caret on the first offending control. Deferred twice: the tab switch and the
      // freshly-marked inputs both have to render before there is anything to focus.
      // A timeout, not rAF: CrudForm runs its own post-submit focus handling, and a frame-level
      // callback lost the race with it. 120ms lands after both the tab switch and that handler.
      window.setTimeout(() => {
        // `data-invalid`, not a class match: the DS Input wrapper's own class string contains the
        // substring "border-destructive" (inside `has-[input[aria-invalid=true]]:…`), so matching on
        // it selected every input on the page — including the sidebar search, which is where focus
        // actually landed. Document order then picks the topmost offending field.
        const first = document.querySelector<HTMLElement>(
          '[aria-invalid="true"], [data-invalid="true"] input, [data-invalid="true"] button',
        )
        if (!first) return
        first.focus({ preventScroll: true })
        first.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 120)
      throw failSubmit([...new Set(blockingProblems.map((p) => p.message))].join(' '))
    }
    setFieldErrors({})

    // GTU is a DOCUMENT-level marking in JPK_V7. The per-line picker is an input convenience, so
    // the union of the lines' codes becomes the invoice's own set before the meta payload is built.
    const lineGtu = collectLineGtuCodes(value.lines)
    const metaForSubmit: InvoiceMeta =
      lineGtu.length > 0
        ? { ...value.meta, gtuCodes: Array.from(new Set([...(value.meta.gtuCodes ?? []), ...lineGtu])) }
        : value.meta

    // Merge the buyer snapshot into the preserved core invoice metadata (never clobber other keys).
    const buyerSnapshot = buyerToSnapshot(buyer)
    const mergedMetadata: Record<string, unknown> = { ...(value.metadata ?? {}) }
    if (buyerSnapshot) mergedMetadata.buyerSnapshot = buyerSnapshot
    else delete mergedMetadata.buyerSnapshot
    const notes = (header.notes ?? '').trim()
    if (notes) mergedMetadata.notes = notes
    else delete mergedMetadata.notes
    const contractNumber = (header.contractNumber ?? '').trim()
    if (contractNumber) mergedMetadata.contractNumber = contractNumber
    else delete mergedMetadata.contractNumber
    const transportTerms = (header.transportTerms ?? '').trim()
    if (transportTerms) mergedMetadata.transportTerms = transportTerms
    else delete mergedMetadata.transportTerms

    const signatureMode = isSignatureMode(header.signatureMode) ? header.signatureMode : DEFAULT_SIGNATURE_MODE
    const issuerSignatory = (header.issuerSignatory ?? '').trim()
    const recipientSignatory = (header.recipientSignatory ?? '').trim()
    if (signatureMode !== DEFAULT_SIGNATURE_MODE || issuerSignatory || recipientSignatory) {
      mergedMetadata.signature = {
        mode: signatureMode,
        ...(issuerSignatory ? { issuerSignatory } : {}),
        ...(recipientSignatory ? { recipientSignatory } : {}),
      }
    } else delete mergedMetadata.signature

    const cleanPayment = buildPaymentMetadata(value.payment)
    if (cleanPayment) mergedMetadata.payment = cleanPayment
    else delete mergedMetadata.payment
    mergedMetadata.priceMode = effectivePriceMode
    const saleDate = (header.saleDate ?? '').trim()
    if (saleDate) mergedMetadata.saleDate = saleDate
    else delete mergedMetadata.saleDate
    const hadMetadata = value.metadata != null && Object.keys(value.metadata).length > 0
    const metadataPayload: Record<string, unknown> =
      Object.keys(mergedMetadata).length || hadMetadata ? { metadata: mergedMetadata } : {}

    const headerPayload = buildInvoiceHeaderPayload(header)
    // Series numbering — claim only NOW, after every validation above has passed, so an abandoned
    // or invalid form never consumes the counter. A manually typed number always wins (it is a
    // legal override; core's unique index catches an accidental duplicate). The claimed number is
    // kept for retry so a transient create failure does not leave a gap in the series.
    if (!isEdit && !headerPayload.invoiceNumber && numberingSeriesId) {
      const kept = claimedNumberRef.current
      if (kept && kept.seriesId === numberingSeriesId) {
        headerPayload.invoiceNumber = kept.number
      } else {
        const claim = await apiCall<{ number?: string; seriesCode?: string }>(
          '/api/financial_pl/next-invoice-number/claim',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: numberingSeriesId }),
          },
        )
        const claimedNumber = claim.ok ? (claim.result?.number ?? '').trim() : ''
        if (!claimedNumber) {
          throw failSubmit(
            t('financial_pl.invoices.form.errors.claimNumber', 'Failed to reserve the next number in the selected series.'),
          )
        }
        claimedNumberRef.current = { seriesId: numberingSeriesId, number: claimedNumber }
        headerPayload.invoiceNumber = claimedNumber
      }
      // Provenance on the invoice itself: which series minted the number. `metadataPayload` holds a
      // reference to this object, and it is never empty here (priceMode is always set above).
      const claimedSeries = numberingSeriesOptions.find((series) => series.id === numberingSeriesId)
      if (claimedSeries) mergedMetadata.numberingSeries = { id: claimedSeries.id, code: claimedSeries.code }
    }
    const totalsPayload = buildInvoiceTotalsPayload(
      value.lines,
      effectiveCurrency,
      effectivePriceMode,
      value.payment,
      marginScheme,
    )

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
        throw failSubmit(t('financial_pl.invoices.form.errors.saveInvoice', 'Failed to save the invoice.'))
      }
      const metaCall = await runMutation({
        operation: () =>
          apiCall(`/api/financial_pl/ksef/invoice-meta`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              buildMetaPayload(invoiceId, metaForSubmit, effectiveCurrency, metaForSubmit.invoiceKind ?? 'vat'),
            ),
          }),
        context: buildMutationContext('updateMeta', invoiceId),
        mutationPayload: { salesInvoiceId: invoiceId },
      })
      if (!metaCall.ok) {
        throw failSubmit(t('financial_pl.errors.meta_save_failed', 'Failed to save the Polish VAT metadata.'))
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
            body: JSON.stringify({ ...headerPayload, ...totalsPayload, ...metadataPayload, lines: linesPayload }),
          }),
      context: buildMutationContext('createInvoice', null),
      mutationPayload: { ...headerPayload },
    })
    if (!createCall.ok) {
      throw failSubmit(t('financial_pl.invoices.form.errors.createInvoice', 'Failed to create the invoice.'))
    }
    const newId = createCall.result?.invoiceId ?? createCall.result?.id ?? null
    if (!newId || !UUID_RE.test(newId)) {
      throw failSubmit(t('financial_pl.invoices.form.errors.createInvoice', 'Failed to create the invoice.'))
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
              buildMetaPayload(newId, metaForSubmit, effectiveCurrency, metaForSubmit.invoiceKind ?? 'vat'),
            ),
          }),
        context: buildMutationContext('createMeta', newId),
        mutationPayload: { salesInvoiceId: newId },
      })
      metaOk = metaCall.ok
    } catch {
      metaOk = false
    }
    if (sendToKsef) {
      try {
        const send = await apiCall<{ ok?: boolean; error?: string }>(
          '/api/financial_pl/ksef/submissions/from-invoice',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ salesInvoiceId: newId }),
          },
        )
        if (!send.ok || send.result?.ok !== true) throw new Error(send.result?.error || 'send failed')
        flash(t('financial_pl.actions.sendToKsefQueued', 'Invoice queued for KSeF submission.'), 'success')
      } catch (err) {
        // The invoice IS saved; only the filing failed. Say so rather than implying nothing happened
        // — the operator can retry the send from the invoice itself.
        flash(
          err instanceof Error && err.message !== 'send failed'
            ? err.message
            : t('financial_pl.invoices.form.savedButSendFailed', 'Invoice saved, but sending to KSeF failed. Retry it from the invoice.'),
          'warning',
        )
      }
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
    confirm,
    sendToKsef,
    failSubmit,
    invoiceId,
    isEdit,
    readOnly,
    router,
    runMutation,
    setActiveTab,
    t,
    numberingSeriesId,
    numberingSeriesOptions,
    value.buyer,
    value.lines,
    value.meta,
    value.metadata,
    value.payment,
    value.priceMode,
  ])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    {
      id: 'tabsbar',
      column: 1,
      bare: true,
      component: (ctx) => (
        <InvoiceTabs
          part="bar"
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
          setPriceMode={setPriceMode}
          fieldErrors={fieldErrors}
          dueTouched={dueTouched}
          saleTouched={saleTouched}
          lastAutoDue={lastAutoDue}
          lastAutoSale={lastAutoSale}
          t={t}
        />
      ),
    },
    // Only on the Faktura tab — these are the invoice's own fields, so they belong inside it.
    // Buyer / invoice details / payment as one row of three: at full page width each gets ~370px,
    // which is enough for every control in it, and it puts the whole "who, which document, how it
    // settles" answer above the fold instead of three stacked cards deep.
    {
      id: 'topRow',
      column: 1 as const,
      bare: true,
      component: (ctx: CrudFormGroupComponentProps) => (
        <>
          <PreviewSync values={ctx.values} onValues={setLiveHeader} />
          <div
            className={
              activeTab === 'faktura'
                ? 'grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-stretch'
                : 'hidden'
            }
          >
              <FormSection icon={<Building2 className="size-4" />} title={t('financial_pl.invoices.form.sections.buyer', 'Buyer (Nabywca)')}>
                <BuyerFields value={value.buyer} onChange={setBuyer} disabled={readOnly} errors={fieldErrors} />
              </FormSection>
              <FormSection icon={<FileText className="size-4" />} title={t('financial_pl.invoices.form.sections.header', 'Invoice details')}>
                <InvoiceDetailFields
                  ctx={ctx}
                  disabled={readOnly}
                  invoiceKind={value.meta.invoiceKind ?? 'vat'}
                  onInvoiceKindChange={(next) => setMeta({ ...value.meta, invoiceKind: next })}
                  suggestedNumber={suggestedNumber}
                  numberingSeries={isEdit ? undefined : numberingSeriesOptions}
                  numberingSeriesId={numberingSeriesId}
                  fieldErrors={fieldErrors}
                  onNumberingSeriesChange={(next) => {
                    // Radix emits '' when CrudForm resets on mount — that is not an operator pick,
                    // so it must not mark the picker touched (it would block the default-preselect
                    // effect forever). Same hazard the invoice-kind select guards with `|| 'vat'`.
                    if (next === '') return
                    seriesTouched.current = true
                    setNumberingSeriesId(next)
                  }}
                />
              </FormSection>
              <FormSection icon={<Wallet className="size-4" />} title={t('financial_pl.invoices.form.sections.payment', 'Payment / settlement')}>
                <PaymentGroup
                  accounts={bankAccounts}
                  onCreateAccount={readOnly ? undefined : handleCreateAccount}
                  ctx={ctx}
                  payment={value.payment}
                  onChange={setPayment}
                  disabled={readOnly}
                  dueTouched={dueTouched}
                  lastAutoDue={lastAutoDue}
                />
              </FormSection>
          </div>
        </>
      ),
    },
    ...(asideContent
      ? [{
          // Column 2 of CrudForm's own layout: this is what puts the action header full width ABOVE
          // both columns, instead of trapping it inside a page-level grid cell.
          id: 'preview',
          column: 2 as const,
          bare: true,
          component: () => <>{asideContent}</>,
        }]
      : []),
    {
      id: 'body',
      column: 1,
      bare: true,
      component: (ctx) => (
        <InvoiceTabs
          part="panels"
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
          setPriceMode={setPriceMode}
          fieldErrors={fieldErrors}
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
    asideContent,
    isEdit,
    readOnly,
    setBuyer,
    setLines,
    setMeta,
    setPayment,
    setPriceMode,
    fieldErrors,
    suggestedNumber,
    numberingSeriesOptions,
    numberingSeriesId,
    bankAccounts,
    handleCreateAccount,
    t,
    value,
  ])

  // CrudForm resets its controlled values whenever `initialValues` changes by identity. Keep the
  // object stable while buyer, line, payment, and tax state changes; otherwise interacting with
  // those sections can silently restore invoice dates and header fields to their mount defaults.
  const crudInitialValues = React.useMemo(() => buildInvoiceCrudInitialValues(value), [
    value.header.invoiceNumber,
    value.header.issueDate,
    value.header.dueDate,
    value.header.saleDate,
    value.header.currencyCode,
    value.header.orderId,
    value.header.signatureMode,
    value.header.issuerSignatory,
    value.header.recipientSignatory,
    value.header.contractNumber,
    value.header.transportTerms,
    value.notes,
  ])

  return (
    <div
      className="flex flex-col gap-4"
      data-financial-pl-invoice-form-ready={clientReady ? '1' : '0'}
      data-financial-pl-invoice-settings-ready={invoiceSettings ? '1' : '0'}
    >
      {/*
        Page heading. `CrudForm` renders its own title through the DS `EditHeader`, which uses a
        plain <div> — so a CrudForm page ships no <h1> and its sections jump straight to <h3>,
        leaving screen-reader heading navigation broken (WCAG 1.3.1). The visible title stays with
        CrudForm; this supplies the missing document heading without duplicating it on screen.
      */}
      <h1 className="sr-only">{formTitle}</h1>
      {lockNotice}
      {submitError ? (
        <div
          ref={submitErrorRef}
          role="alert"
          tabIndex={-1}
          className="flex items-start gap-2 rounded-md border border-status-error-border bg-status-error-bg p-3 text-sm text-status-error-text outline-none"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-error-icon" aria-hidden="true" />
          <div>
            <p className="font-medium">
              {t('financial_pl.invoices.form.submitFailed', 'The invoice could not be saved')}
            </p>
            <p>{submitError}</p>
          </div>
        </div>
      ) : null}
      {dateWarnings.length > 0 ? (
        <Alert status="warning" style="light">
          <AlertTitle>
            {t('financial_pl.invoices.form.dateWarningsTitle', 'Check the invoice dates')}
          </AlertTitle>
          {/*
            Deliberately NOT wrapped in `AlertDescription`: that renders a <p>, and a <ul> inside a
            <p> is invalid DOM — React logged a validateDOMNesting warning every time this banner
            appeared. `Alert` puts its children in a plain <div>, so the list is a valid sibling of
            the title; it carries the description's own typography classes to look unchanged.
          */}
          <ul className="list-disc space-y-1 pl-5 text-sm leading-5">
            {dateWarnings.map((warning) => (
              <li key={`${warning.field}:${warning.messageKey}`}>{t(warning.messageKey)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {!isEdit ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {value.meta.issuedOutsideKsef
            ? t('financial_pl.invoices.create.ksefHintOutside', 'This invoice is marked “issued outside KSeF” (Wystawiona poza KSeF), so it will NOT be sent to KSeF. It will be saved as a draft.')
            : t('financial_pl.invoices.create.ksefHint', 'Creating saves the invoice as a draft — it is NOT sent to KSeF automatically. Open the saved invoice and use “Send to KSeF” to file it (unless you mark it “Wystawiona poza KSeF” in the Taxes & KSeF tab).')}
        </div>
      ) : null}
      {/*
        `hideFooterActions`: CrudForm repeats Cancel/Save at the bottom of the form. With the header
        row now sticky those buttons are always reachable, so the bottom copy was only a second place
        to click the same thing — and on a form this tall it read as a different action.
      */}
      {/*
        CrudForm's two-column layout is fixed at 7fr/3fr. The document preview needs more room than
        30% to stay readable, so this scopes a 60/40 override to THIS form only — keyed on a wrapper
        class rather than editing the DS, and only applied when a second column is actually rendered.
      */}
      <style>{[
        // Two-column split when a second column is rendered: CrudForm hard-codes 7fr/3fr and the
        // document preview needs more than 30% to stay readable.
        '@media (min-width:1024px){.fpl-invoice-form-60-40 form > div.grid{grid-template-columns:3fr 2fr}}',
        // Pin the action row under the app's own sticky top bar (61px tall) rather than at the
        // viewport top, which is why the first attempt slid underneath it. DS `FormHeader` exposes
        // no slot for this, so the rule is scoped to this form's wrapper instead of patching the DS.
        '.fpl-invoice-form .space-y-4 > div.sm\\:justify-between:first-child{position:sticky;top:61px;z-index:20;background:var(--background);padding-top:0.75rem;padding-bottom:0.75rem;border-bottom:1px solid var(--border)}',
      ].join('')}</style>
      <div className={`fpl-invoice-form${asideContent ? ' fpl-invoice-form-60-40' : ''}`}>
      <CrudForm
        formId={INVOICE_FORM_ID}
        hideFooterActions
        extraActions={
          /*
            Ordered by what each control does, not by what was added when. Looking at the document
            comes first and is ruled off from everything that writes; the KSeF switch is a modifier
            on the primary action, so it sits inside the commit cluster next to it rather than
            floating between two unrelated buttons.
          */
          <>
            {headerActions}
            {!isEdit && !readOnly ? (
              <Separator orientation="vertical" className="mx-1 h-6" />
            ) : null}
            {!isEdit && !readOnly ? (
              <SwitchField
                label={t('financial_pl.invoices.form.sendToKsefOnCreate', 'Send to KSeF')}
                checked={sendToKsef}
                onCheckedChange={(next) => setSendToKsef(Boolean(next))}
              />
            ) : null}
            {!isEdit && !readOnly ? (
              <Button
                type="submit"
                form={INVOICE_FORM_ID}
                variant="outline"
                onClick={() => {
                  saveAsDraftRef.current = true
                }}
              >
                {t('financial_pl.invoices.form.saveDraft', 'Save draft')}
              </Button>
            ) : null}
          </>
        }
        backHref="/backend/financial/invoices"
        cancelHref="/backend/financial/invoices"
        submitLabel={isEdit
          ? t('financial_pl.invoices.form.save', 'Save invoice')
          : t('financial_pl.invoices.form.create', 'Create invoice')}
        readOnly={readOnly}
        fields={[
          {
            id: 'invoiceNumber',
            // Paired with the currency on one row — a number and a 3-letter code do not each need
            // the full width, and every full-width field is another line to scroll past.
            layout: 'half',
            label: t('financial_pl.invoices.form.fields.invoiceNumber', 'Invoice number'),
            type: 'text',
            placeholder: t('financial_pl.invoices.form.fields.invoiceNumberPlaceholder', 'Auto-assigned if left blank'),
          },
          {
            id: 'issueDate',
            label: t('financial_pl.invoices.form.fields.issueDate', 'Issue date'),
            type: 'date',
            required: true,
            layout: 'half',
            displayFormat: PL_DATE_DISPLAY_FORMAT,
          },
          {
            id: 'dueDate',
            label: t('financial_pl.invoices.form.fields.dueDate', 'Due date'),
            type: 'custom',
            component: ({ value, setValue, values, disabled }) => (
              <DueDateField
                value={typeof value === 'string' ? value : ''}
                issueDate={typeof values?.issueDate === 'string' ? values.issueDate : ''}
                disabled={disabled}
                onChange={(next) => setValue(next)}
              />
            ),
          },
          {
            id: 'saleDate',
            label: t('financial_pl.invoices.form.fields.saleDate', 'Sale date (Data sprzedaży)'),
            type: 'date',
            required: true,
            layout: 'half',
            displayFormat: PL_DATE_DISPLAY_FORMAT,
          },
          {
            id: 'currencyCode',
            label: t('financial_pl.invoices.form.fields.currencyCode', 'Currency'),
            layout: 'half',
            type: 'combobox',
            required: true,
            allowCustomValues: false,
            placeholder: t('financial_pl.invoices.form.fields.currencyPlaceholder', 'Search currency (e.g. PLN, EUR)…'),
            loadOptions: async (query?: string) => searchCurrencies(query),
          },
          {
            id: 'contractNumber',
            label: t('financial_pl.invoices.form.fields.contractNumber', 'Contract number'),
            type: 'text',
          },
          {
            id: 'transportTerms',
            label: t('financial_pl.invoices.form.fields.transportTerms', 'Transport terms'),
            type: 'text',
          },
          {
            id: 'signatureMode',
            label: t('financial_pl.invoices.form.signature.mode', 'Signature note'),
            type: 'text',
          },
          {
            id: 'issuerSignatory',
            label: t('financial_pl.invoices.form.signature.issuer', 'Person authorised to issue the invoice'),
            type: 'text',
          },
          {
            id: 'recipientSignatory',
            label: t('financial_pl.invoices.form.signature.recipient', 'Person authorised to receive the invoice'),
            type: 'text',
          },
          {
            id: 'orderId',
            label: t('financial_pl.invoices.form.fields.orderId', 'Order UUID (optional)'),
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
        initialValues={crudInitialValues}
        schema={z.object({
          invoiceNumber: z.string().optional(),
          issueDate: z.string().optional(),
          dueDate: z.string().optional(),
          saleDate: z.string().optional(),
          currencyCode: z.string().trim().min(1),
          orderId: z.string().optional(),
          notes: z.string().optional(),
          signatureMode: z.string().optional(),
          issuerSignatory: z.string().optional(),
          recipientSignatory: z.string().optional(),
          contractNumber: z.string().optional(),
          transportTerms: z.string().optional(),
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
            signatureMode: String(values.signatureMode ?? DEFAULT_SIGNATURE_MODE),
            issuerSignatory: String(values.issuerSignatory ?? ''),
            recipientSignatory: String(values.recipientSignatory ?? ''),
            contractNumber: String(values.contractNumber ?? ''),
            transportTerms: String(values.transportTerms ?? ''),
          })
        }}
      />
      </div>
      {ConfirmDialogElement}
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
