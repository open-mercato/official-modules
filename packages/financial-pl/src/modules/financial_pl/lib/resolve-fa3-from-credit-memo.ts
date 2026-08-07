import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { getEuStandardVatRate } from '../config'
import { fa3InvoiceSchema, type Fa3InvoiceInput } from '../data/validators'
import {
  asRecord,
  asString,
  assertMappedVatRates,
  buildAnnotations,
  buildBuyer,
  buildLines,
  buildSeller,
  buildVatBreakdown,
  buildZamowienie,
  lineCarriesTaxRate,
  normalizeMarginScheme,
  readPriceModeFromMetadata,
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
const ISSUE_DATE_REQUIRED_DEFAULT = 'The credit memo has no issue date, which a KSeF correction requires. Set the credit memo issue date first.'
const OSS_COUNTRY_REQUIRED_DEFAULT =
  'An OSS (WSTO_EE) correction requires the consumption-country code. Set the OSS destination country before submitting it to KSeF.'
const OSS_RATE_REQUIRED_DEFAULT =
  'An OSS (WSTO_EE) correction line requires a destination-country VAT rate. Set the consumption-country rate (or a known EU member state) before submitting it to KSeF.'
const MARGIN_SCHEME_MIXED_LINES_DEFAULT = 'marginSchemeMixedLines'
const MARGIN_SCHEME_REQUIRES_PLN_DEFAULT = 'marginSchemeRequiresPln'

function tr(deps: ResolveKorDeps, key: string, fallback: string): string {
  return deps.translate?.(key, fallback) ?? fallback
}

/** The PL-meta `invoice_kind` of the corrected ORIGINAL → the FA(3) correction RodzajFaktury. */
function readCorrectionKindFromOriginal(meta: Record<string, unknown> | undefined): 'KOR' | 'KOR_ZAL' | 'KOR_ROZ' {
  const raw = (asString(meta?.invoice_kind) ?? 'vat').toLowerCase()
  if (raw === 'zal' || raw === 'kor_zal') return 'KOR_ZAL'
  if (raw === 'roz' || raw === 'kor_roz') return 'KOR_ROZ'
  return 'KOR'
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const text = asString(value)
  return text === 'true' || text === '1'
}

/**
 * Annotate the (already-negated) correction line rows for an OSS (WSTO_EE) correction so the OSS
 * serialization is SHARED by the invoice and the KOR path (jury resolution 2): each row carries the
 * destination rate (`oss_rate` → `P_12_XII`), the procedure marker, and the per-line FX rate. The
 * monetary fields stay negated (a correction files the negated OSS difference). The OSS rate is the
 * line's own sales rate when present, else the consumption-country EU standard rate.
 */
function applyOssMarkersToCorrection(
  rows: InvoiceLineRow[],
  ossProcedure: boolean,
  consumptionCountry: string | undefined,
  fxRate: string | undefined,
  deps: ResolveKorDeps,
): InvoiceLineRow[] {
  if (!ossProcedure) return rows
  if (!consumptionCountry) {
    throw new CrudHttpError(422, {
      error: tr(deps, 'financial_pl.errors.oss_country_required', OSS_COUNTRY_REQUIRED_DEFAULT),
      code: 'oss_country_required',
    })
  }
  const tableRate = getEuStandardVatRate(consumptionCountry)
  return rows.map((row) => {
    const lineRate = Number(asString(row.tax_rate) ?? '')
    const ossRate =
      Number.isFinite(lineRate) && lineRate > 0 ? String(lineRate) : tableRate !== undefined ? String(tableRate) : null
    if (ossRate === null) {
      throw new CrudHttpError(422, {
        error: tr(deps, 'financial_pl.errors.oss_rate_required', OSS_RATE_REQUIRED_DEFAULT),
        code: 'oss_rate_required',
      })
    }
    return { ...row, oss_rate: ossRate, procedure: 'WSTO_EE', ...(fxRate ? { fx_rate: fxRate } : {}) }
  })
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

  // `invoice_id` is the canonical core link. The module also writes the same immutable reference
  // into metadata when creating a KOR: older core/query projections have been observed to return a
  // null `invoice_id`, and rejecting that freshly-created credit memo strands the operator after an
  // irreversible create. Prefer the real column and use metadata only as a compatibility fallback.
  const creditMemoMetadata = asRecord(creditMemo.metadata)
  const correctedInvoiceId =
    asString(creditMemo.invoice_id) ??
    asString(creditMemoMetadata.correctedInvoiceId) ??
    asString(creditMemoMetadata.corrected_invoice_id)
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

  // The corrected ORIGINAL's PL-meta drives the correction kind (KOR / KOR_ZAL / KOR_ROZ) and the
  // OSS signals (jury resolution 2: an OSS correction reuses the OSS serialization). The credit
  // memo's OWN meta (when present) overrides for OSS markers that may differ on the correction.
  const originalMetaResult = await queryEngine.query<Record<string, unknown>>('financial_pl:sales_invoice_pl_meta', {
    ...scope,
    filters: { sales_invoice_id: { $eq: correctedInvoiceId }, deleted_at: { $eq: null } },
    page: { page: 1, pageSize: 1 },
  })
  const originalMeta = originalMetaResult.items?.[0]
  const invoiceKind = readCorrectionKindFromOriginal(originalMeta)
  const ossProcedure = isTruthyFlag(originalMeta?.oss_procedure)
  const consumptionCountry = asString(originalMeta?.consumption_country_code) ?? undefined
  const exchangeRate = asString(originalMeta?.exchange_rate) ?? undefined
  const marginScheme = normalizeMarginScheme(originalMeta?.margin_scheme)
  const priceMode =
    readPriceModeFromMetadata(creditMemo.metadata) === 'gross'
      ? 'gross'
      : readPriceModeFromMetadata(original.metadata)

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
  if (marginScheme) {
    if (currencyCode !== 'PLN') {
      throw new CrudHttpError(422, {
        error: tr(deps, 'financial_pl.errors.margin_scheme_requires_pln', MARGIN_SCHEME_REQUIRES_PLN_DEFAULT),
        code: 'marginSchemeRequiresPln',
      })
    }
    if (lineRows.some(lineCarriesTaxRate)) {
      throw new CrudHttpError(422, {
        error: tr(deps, 'financial_pl.errors.margin_scheme_mixed_lines', MARGIN_SCHEME_MIXED_LINES_DEFAULT),
        code: 'marginSchemeMixedLines',
      })
    }
  }

  const seller = buildSeller(deps)
  const buyer = buildBuyer(original, deps)
  // OSS correction (jury resolution 2): annotate the negated lines with the OSS markers so the same
  // P_12_XII / Procedura=WSTO_EE / P_13_5 / P_14_5 serialization is shared with the invoice path.
  const effectiveLineRows = applyOssMarkersToCorrection(lineRows, ossProcedure, consumptionCountry, exchangeRate, deps)
  const vatBreakdown = buildVatBreakdown(
    effectiveLineRows,
    negateMoney(creditMemo.grand_total_net_amount),
    negateMoney(creditMemo.tax_total_amount),
    {
      ...(exchangeRate ? { fxRate: exchangeRate } : {}),
      priceMode,
      ...(marginScheme ? { marginScheme, headerGrossField: negateMoney(creditMemo.grand_total_gross_amount) } : {}),
    },
  )
  assertMappedVatRates(vatBreakdown, deps.translate)

  const totalGross = scaled4ToMoney2dp(
    vatBreakdown.reduce((sum, entry) => sum + toScaled4(entry.net) + toScaled4(entry.vat), 0n),
  )

  // The KOR document's own issue date (P_1) — reject a missing one rather than
  // silently defaulting to today (a mis-dated correction is a regulatory defect).
  const issueDate = toIsoDate(creditMemo.issue_date) ?? toIsoDate(creditMemo.created_at)
  if (!issueDate) {
    const message =
      deps.translate?.('financial_pl.errors.issue_date_required', ISSUE_DATE_REQUIRED_DEFAULT) ?? ISSUE_DATE_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'issue_date_required' })
  }

  // KOR_ZAL / KOR_ROZ carry the correction-tail `P_15ZK` (the payment amount for a ZAL, or the
  // amount-remaining for a ROZ, BEFORE the correction) negated like the rest of the correction. A
  // KOR_ZAL additionally carries the corrected `Zamowienie` (order) block from the original's
  // PL-meta snapshot; a KOR_ROZ carries the full (negated) FaWiersz already built above.
  const isAdvanceOrSettlementCorrection = invoiceKind === 'KOR_ZAL' || invoiceKind === 'KOR_ROZ'
  // P_15ZK is the ORIGINAL document's pre-correction amount (the "before" value shown on the
  // corrected invoice) — NOT the correction's own (negated) total: for KOR_ZAL the advance
  // invoice's paid gross; for KOR_ROZ the settlement residual = original gross − Σ already-invoiced
  // advances. Positive (a pre-state amount, not a negated difference). NOTE: the exact KSeF-accepted
  // P_15ZK for a correction-of-advance/settlement is pending a live correction-of-advance round-trip;
  // this derives it from the original's stored amounts.
  let preCorrectionPaymentAmount: string | undefined
  if (isAdvanceOrSettlementCorrection) {
    const sumMetaAmounts = (rows: unknown): bigint =>
      (Array.isArray(rows) ? rows : []).reduce<bigint>((sum, row) => {
        const amount = asString(asRecord(row).amount)
        return amount ? sum + toScaled4(amount) : sum
      }, 0n)
    const originalGrossScaled =
      toScaled4(asString(original.grand_total_net_amount) ?? '0') +
      toScaled4(asString(original.tax_total_amount) ?? '0')
    if (invoiceKind === 'KOR_ZAL') {
      // P_15ZK = the original ZAL's paid amount = Σ original advance_payments (the ZAL's own P_15),
      // NOT the invoice gross — they can differ. Fall back to the original gross only when the
      // original carries no advance snapshot (e.g. issued outside this connector).
      const paidScaled = sumMetaAmounts(originalMeta?.advance_payments)
      preCorrectionPaymentAmount = scaled4ToMoney2dp(paidScaled !== 0n ? paidScaled : originalGrossScaled)
    } else {
      // KOR_ROZ: P_15ZK = the settlement residual = original gross − Σ already-invoiced advances.
      preCorrectionPaymentAmount = scaled4ToMoney2dp(originalGrossScaled - sumMetaAmounts(originalMeta?.advance_refs))
    }
  }
  const order = invoiceKind === 'KOR_ZAL' ? buildZamowienie(asRecord(originalMeta).order_snapshot) : undefined
  const annotations = marginScheme ? buildAnnotations(originalMeta) : undefined

  const fa3Invoice: Fa3InvoiceInput = {
    invoiceNumber: asString(creditMemo.credit_memo_number) ?? creditMemoId,
    issueDate,
    currencyCode,
    invoiceKind,
    seller,
    buyer,
    vatBreakdown,
    totalGross,
    lines: buildLines(effectiveLineRows, { priceMode, ...(marginScheme ? { marginScheme } : {}) }),
    correction: {
      reason,
      correctedInvoices: [
        {
          correctedIssueDate,
          correctedInvoiceNumber: asString(original.invoice_number) ?? correctedInvoiceId,
          ...(correctedKsefNumber ? { correctedKsefNumber } : {}),
        },
      ],
      ...(preCorrectionPaymentAmount !== undefined ? { preCorrectionPaymentAmount } : {}),
      ...(exchangeRate && isAdvanceOrSettlementCorrection ? { preCorrectionFxRate: exchangeRate } : {}),
    },
    ...(order ? { order } : {}),
    ...(annotations ? { annotations } : {}),
    ...(exchangeRate ? { exchangeRate } : {}),
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
      // Core credit-memo lines are immutable children and have no deleted_at column. Asking the
      // query engine for that extension-only field produces an `ei.deleted_at` predicate without
      // an extension join on a stock install (Postgres 42P01), blocking every live KOR filing.
      filters: { credit_memo_id: { $eq: creditMemoId } },
      page: { page, pageSize },
      sort: [{ field: 'line_number', dir: 'asc' }],
    })
    const batch = res.items ?? []
    for (const line of batch) {
      const metadata = asRecord(line.metadata)
      const discountAmount = asString(metadata.discountAmount) ?? asString(metadata.discount_amount) ?? asString(line.discount_amount)
      const discountPercent = asString(metadata.discountPercent) ?? asString(metadata.discount_percent) ?? asString(line.discount_percent)
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
        unit_price_gross: asString(line.unit_price_gross) ?? undefined,
        total_net_amount: negateMoney(line.total_net_amount),
        total_gross_amount: negateMoney(line.total_gross_amount),
        tax_amount: negateMoney(line.tax_amount),
        tax_rate: line.tax_rate,
        ...(discountAmount ? { discount_amount: negateMoney(discountAmount) } : {}),
        ...(discountPercent ? { discount_percent: discountPercent } : {}),
      })
    }
    if (batch.length < pageSize) break
  }
  return rows
}
