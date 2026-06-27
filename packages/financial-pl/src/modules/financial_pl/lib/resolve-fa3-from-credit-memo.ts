import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { fa3InvoiceSchema, type Fa3InvoiceInput } from '../data/validators'
import {
  asString,
  assertMappedVatRates,
  buildBuyer,
  buildLines,
  buildSeller,
  buildVatBreakdown,
  scaled4ToMoney2dp,
  toIsoDate,
  toScaled4,
  type Fa3MappingDeps,
  type InvoiceLineRow,
  type InvoiceRow,
} from './fa3-mapping'
import type { ResolveFa3QueryEngine } from './resolve-fa3-from-invoice'

export type ResolveKorDeps = Fa3MappingDeps & {
  queryEngine: ResolveFa3QueryEngine
}

export type ResolveKorArgs = {
  creditMemoId: string
  organizationId: string
  tenantId: string
  /**
   * Set true only when the corrected ORIGINAL invoice was lawfully issued OUTSIDE
   * KSeF (legacy/paper/pre-obligation). It selects the `NrKSeFN` marker. It is
   * NEVER inferred from a missing number (that would mislabel a pending original).
   */
  originalOutsideKsef?: boolean
}

export type ResolveKorResult = {
  invoice: Fa3InvoiceInput
  /** The corrected ORIGINAL sales invoice id — stored as the submission's `salesInvoiceId`. */
  correctedInvoiceId: string
}

const CREDIT_MEMO_NOT_LINKED_DEFAULT =
  'This credit memo is not linked to an invoice, so the corrected invoice cannot be referenced in KSeF. Link it to the original invoice first.'
const CORRECTION_REASON_REQUIRED_DEFAULT =
  'A KSeF correction requires a reason. Set the credit memo reason before submitting it to KSeF.'
const CORRECTION_LINES_REQUIRED_DEFAULT =
  'This credit memo has no lines, so the correction amounts cannot be derived. Add the corrected lines before submitting it to KSeF.'
const ORIGINAL_NOT_ACCEPTED_DEFAULT =
  'The original invoice has not been accepted by KSeF yet. Wait until it has a KSeF number before issuing a correction.'
const ORIGINAL_KSEF_NUMBER_UNKNOWN_DEFAULT =
  'The original invoice has no KSeF number and is not marked as issued outside KSeF. Submit the original to KSeF first, or confirm it was issued outside KSeF.'
const ORIGINAL_ISSUE_DATE_UNKNOWN_DEFAULT =
  'The original invoice has no issue date, so the correction cannot reference it in KSeF. Set the original invoice issue date first.'
const CURRENCY_UNSUPPORTED_DEFAULT =
  'Only PLN corrections can be submitted to KSeF yet. Foreign-currency corrections are not supported.'

function tr(deps: ResolveKorDeps, key: string, fallback: string): string {
  return deps.translate?.(key, fallback) ?? fallback
}

/** Negate a numeric(18,4) money magnitude to a 2-dp string (e.g. "80.00" → "-80.00"). */
function negateMoney(value: unknown): string {
  return scaled4ToMoney2dp(-toScaled4(value))
}

/** Negate a quantity string, preserving its decimals (e.g. "2.0000" → "-2.0000"); zero stays zero. */
function negateQuantity(value: unknown): string {
  const text = asString(value) ?? '1'
  if (text.startsWith('-')) return text.slice(1)
  if (/^0(\.0+)?$/.test(text)) return text
  return `-${text}`
}

/**
 * Resolve a validated FA(3) **correction (KOR)** payload from a `sales.credit_memo`.
 *
 * A credit memo is always a reduction and stores non-negative amounts; FA(3) files
 * corrections by DIFFERENCE, so every amount is emitted NEGATED. The corrected
 * original is referenced by its KSeF number when accepted, or the `NrKSeFN` legacy
 * marker only when the caller explicitly confirms it was issued outside KSeF — a
 * pending/rejected original is rejected, never silently mislabeled.
 */
export async function resolveFa3FromCreditMemo(
  deps: ResolveKorDeps,
  args: ResolveKorArgs,
): Promise<ResolveKorResult> {
  const { queryEngine } = deps
  const { creditMemoId, organizationId, tenantId } = args
  const scope = { tenantId, organizationIds: [organizationId] }

  const creditMemoResult = await queryEngine.query<InvoiceRow>(E.sales.sales_credit_memo, {
    ...scope,
    filters: { id: { $eq: creditMemoId }, deleted_at: { $eq: null } },
    page: { page: 1, pageSize: 1 },
  })
  const creditMemo = creditMemoResult.items?.[0]
  if (!creditMemo) {
    throw new CrudHttpError(404, { error: '[internal] credit memo not found for FA(3) KOR resolution' })
  }

  const correctedInvoiceId = asString(creditMemo.invoice_id)
  if (!correctedInvoiceId) {
    throw new CrudHttpError(422, {
      error: tr(deps, 'financial_pl.errors.credit_memo_not_linked', CREDIT_MEMO_NOT_LINKED_DEFAULT),
      code: 'credit_memo_not_linked',
    })
  }

  const reason = asString(creditMemo.reason)
  if (!reason) {
    throw new CrudHttpError(422, {
      error: tr(deps, 'financial_pl.errors.correction_reason_required', CORRECTION_REASON_REQUIRED_DEFAULT),
      code: 'correction_reason_required',
    })
  }

  const currencyCode = (asString(creditMemo.currency_code) ?? 'PLN').toUpperCase()
  if (currencyCode !== 'PLN') {
    throw new CrudHttpError(422, {
      error: tr(deps, 'financial_pl.errors.currency_unsupported', CURRENCY_UNSUPPORTED_DEFAULT),
      code: 'currency_unsupported',
    })
  }

  // The corrected ORIGINAL invoice — for the buyer snapshot + DaneFaKorygowanej reference.
  const originalResult = await queryEngine.query<InvoiceRow>(E.sales.sales_invoice, {
    ...scope,
    filters: { id: { $eq: correctedInvoiceId }, deleted_at: { $eq: null } },
    page: { page: 1, pageSize: 1 },
  })
  const original = originalResult.items?.[0]
  if (!original) {
    throw new CrudHttpError(404, { error: '[internal] corrected original invoice not found' })
  }

  // DataWystFaKorygowanej MUST be the ORIGINAL invoice's issue date — never the credit
  // memo's (that would file a false statutory date). It is required by the FA(3) XSD, so a
  // corrected original with no issue date cannot produce a valid correction.
  const correctedIssueDate = toIsoDate(original.issue_date) ?? toIsoDate(original.issued_at)
  if (!correctedIssueDate) {
    throw new CrudHttpError(422, {
      error: tr(deps, 'financial_pl.errors.original_issue_date_unknown', ORIGINAL_ISSUE_DATE_UNKNOWN_DEFAULT),
      code: 'original_issue_date_unknown',
    })
  }

  const correctedKsefNumber = await resolveCorrectedKsefNumber(deps, scope, correctedInvoiceId, args.originalOutsideKsef)

  // Credit memo lines → negated correction lines (reduction differences).
  const lineRows = await loadNegatedCreditMemoLines(queryEngine, scope, creditMemoId)
  if (lineRows.length === 0) {
    throw new CrudHttpError(422, {
      error: tr(deps, 'financial_pl.errors.correction_lines_required', CORRECTION_LINES_REQUIRED_DEFAULT),
      code: 'correction_lines_required',
    })
  }

  const seller = buildSeller(deps)
  const buyer = buildBuyer(original, deps)
  const vatBreakdown = buildVatBreakdown(lineRows, negateMoney(creditMemo.grand_total_net_amount), negateMoney(creditMemo.tax_total_amount))
  assertMappedVatRates(vatBreakdown, deps.translate)

  const totalGross = scaled4ToMoney2dp(
    vatBreakdown.reduce((sum, entry) => sum + toScaled4(entry.net) + toScaled4(entry.vat), 0n),
  )

  const issueDate =
    toIsoDate(creditMemo.issue_date) ?? toIsoDate(creditMemo.created_at) ?? new Date().toISOString().slice(0, 10)

  const fa3Invoice: Fa3InvoiceInput = {
    invoiceNumber: asString(creditMemo.credit_memo_number) ?? creditMemoId,
    issueDate,
    currencyCode,
    invoiceKind: 'KOR',
    seller,
    buyer,
    vatBreakdown,
    totalGross,
    lines: buildLines(lineRows),
    correction: {
      reason,
      correctedInvoices: [
        {
          correctedIssueDate,
          correctedInvoiceNumber: asString(original.invoice_number) ?? correctedInvoiceId,
          ...(correctedKsefNumber ? { correctedKsefNumber } : {}),
        },
      ],
    },
  }

  return { invoice: fa3InvoiceSchema.parse(fa3Invoice), correctedInvoiceId }
}

/**
 * Classify the corrected original three ways (never silently mislabel a pending one):
 * accepted KSeF number → use it; a non-accepted submission exists → 409; no submission
 * at all → require the explicit `originalOutsideKsef` flag (→ NrKSeFN), else 422.
 */
async function resolveCorrectedKsefNumber(
  deps: ResolveKorDeps,
  scope: { tenantId: string; organizationIds: Array<string | null> },
  correctedInvoiceId: string,
  originalOutsideKsef: boolean | undefined,
): Promise<string | undefined> {
  const { queryEngine } = deps
  const onlyInvoiceSubs = (rows: Array<Record<string, unknown>> | undefined) =>
    (rows ?? []).filter((s) => (asString(s.document_kind) ?? 'invoice') === 'invoice' && asString(s.deleted_at) === null)

  // Targeted query for an ACCEPTED submission first, so a corrected invoice with many
  // rejected retries can never push the accepted row out of an unbounded page window.
  const acceptedRes = await queryEngine.query<Record<string, unknown>>('financial_pl:ksef_submission', {
    ...scope,
    // document_kind='invoice' in the QUERY (not just JS): a correction of this same invoice
    // also has sales_invoice_id=correctedInvoiceId, so without it an accepted correction
    // could fill the page window and hide the invoice's own accepted submission.
    filters: { sales_invoice_id: { $eq: correctedInvoiceId }, status: { $eq: 'accepted' }, document_kind: { $eq: 'invoice' }, deleted_at: { $eq: null } },
    page: { page: 1, pageSize: 50 },
    sort: [{ field: 'created_at', dir: 'desc' }],
  })
  const acceptedSub = onlyInvoiceSubs(acceptedRes.items).find((s) => s.status === 'accepted' && asString(s.ksef_number))
  if (acceptedSub) return asString(acceptedSub.ksef_number) ?? undefined

  // Fallback source of the accepted number: the PL meta extension.
  const metaRes = await queryEngine.query<Record<string, unknown>>('financial_pl:sales_invoice_pl_meta', {
    ...scope,
    filters: { sales_invoice_id: { $eq: correctedInvoiceId }, deleted_at: { $eq: null } },
    page: { page: 1, pageSize: 1 },
  })
  const meta = metaRes.items?.[0]
  if (meta && meta.ksef_status === 'accepted' && asString(meta.ksef_number)) {
    return asString(meta.ksef_number) ?? undefined
  }

  // No accepted number: does the original have ANY (non-accepted) submission? If so it is
  // pending/rejected — reject, don't mislabel as outside-KSeF.
  const anyRes = await queryEngine.query<Record<string, unknown>>('financial_pl:ksef_submission', {
    ...scope,
    // document_kind='invoice' in the QUERY: with pageSize 1 a correction row could otherwise
    // be returned, get filtered out in JS, and wrongly read as "no invoice submission" — which
    // would emit NrKSeFN for an actually-pending original.
    filters: { sales_invoice_id: { $eq: correctedInvoiceId }, document_kind: { $eq: 'invoice' }, deleted_at: { $eq: null } },
    page: { page: 1, pageSize: 1 },
  })
  if (onlyInvoiceSubs(anyRes.items).length > 0) {
    throw new CrudHttpError(409, {
      error: tr(deps, 'financial_pl.errors.original_not_accepted', ORIGINAL_NOT_ACCEPTED_DEFAULT),
      code: 'original_not_accepted',
    })
  }

  if (originalOutsideKsef) return undefined // emits NrKSeFN (legacy/outside-KSeF original)

  throw new CrudHttpError(422, {
    error: tr(deps, 'financial_pl.errors.original_ksef_number_unknown', ORIGINAL_KSEF_NUMBER_UNKNOWN_DEFAULT),
    code: 'original_ksef_number_unknown',
  })
}

/**
 * Load credit-memo lines and negate the monetary fields (a credit memo stores
 * non-negative magnitudes; FA(3) corrections file the negative difference). Quantity
 * stays positive and the unit price carries the sign, so `P_11 = P_8B × P_9A` still
 * reconciles regardless of whether the correction is by quantity or by price.
 */
async function loadNegatedCreditMemoLines(
  queryEngine: ResolveFa3QueryEngine,
  scope: { tenantId: string; organizationIds: Array<string | null> },
  creditMemoId: string,
): Promise<InvoiceLineRow[]> {
  const rows: InvoiceLineRow[] = []
  const pageSize = 100
  for (let page = 1; ; page++) {
    const res = await queryEngine.query<InvoiceLineRow>(E.sales.sales_credit_memo_line, {
      ...scope,
      filters: { credit_memo_id: { $eq: creditMemoId }, deleted_at: { $eq: null } },
      page: { page, pageSize },
      sort: [{ field: 'line_number', dir: 'asc' }],
    })
    const batch = res.items ?? []
    for (const line of batch) {
      rows.push({
        line_number: line.line_number,
        name: asString(line.name) ?? asString(line.description) ?? undefined,
        description: line.description,
        quantity_unit: line.quantity_unit,
        // The reduction sign is carried by the QUANTITY (negative) with a POSITIVE unit price —
        // the standard faktura korygująca representation. P_11 = P_8B(−) × P_9A(+) reconciles,
        // and a negative quantity reads naturally (a unit price is never negative).
        quantity: negateQuantity(line.quantity),
        unit_price_net: asString(line.unit_price_net) ?? '0',
        total_net_amount: negateMoney(line.total_net_amount),
        tax_amount: negateMoney(line.tax_amount),
        tax_rate: line.tax_rate,
      })
    }
    if (batch.length < pageSize) break
  }
  return rows
}
