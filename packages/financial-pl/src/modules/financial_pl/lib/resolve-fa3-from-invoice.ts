import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { getEuStandardVatRate } from '../config'
import { fa3InvoiceSchema, invoicePaymentSchema, type Fa3InvoiceInput } from '../data/validators'
import {
  assertMappedVatRates,
  buildAnnotations,
  buildBuyer,
  buildLines,
  buildSeller,
  buildVatBreakdown,
  deriveHeaderVatRate,
  headerVatRateReconciles,
  metadataLinesToRows,
  normalizeMarginScheme,
  roundMoneyTo2dp,
  readPriceModeFromMetadata,
  scaled4ToMoney2dp,
  toIsoDate,
  toScaled4,
  asNumericString,
  asRecord,
  asString,
  lineCarriesTaxRate,
  type Fa3MappingDeps,
  type InvoiceLineRow,
  type InvoiceRow,
} from './fa3-mapping'
import { resolveFa3Advance, resolveMetaExchangeRate } from './resolve-fa3-advance'
import { resolveFa3Settlement } from './resolve-fa3-settlement'

// Re-exported for back-compat with existing importers (tests, commands).
export { roundMoneyTo2dp }

/**
 * Minimal query-engine surface this resolver depends on. financial_pl reads sales
 * data ONLY through the query engine (no cross-module ORM relation/import). Result
 * fields come back snake_cased (the storage column names).
 */
export type ResolveFa3QueryEngine = {
  query: <TRow = Record<string, unknown>>(
    entityId: string,
    opts: {
      tenantId: string
      organizationIds?: Array<string | null>
      filters?: Record<string, unknown>
      page?: { page: number; pageSize: number }
      sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>
    },
  ) => Promise<{ items?: TRow[] }>
}

export type ResolveFa3Deps = Fa3MappingDeps & {
  queryEngine: ResolveFa3QueryEngine
}

export type ResolveFa3Args = {
  salesInvoiceId: string
  organizationId: string
  tenantId: string
}

const VAT_RATE_UNSUPPORTED_DEFAULT =
  'This invoice uses a VAT rate that cannot be mapped to a KSeF FA(3) field. Use a standard Polish VAT rate.'
const ISSUE_DATE_REQUIRED_DEFAULT = 'Invoice issue date is required before it can be submitted to KSeF.'
const OSS_COUNTRY_REQUIRED_DEFAULT =
  'An OSS (WSTO_EE) invoice requires the consumption-country code. Set the OSS destination country before submitting it to KSeF.'
const OSS_RATE_REQUIRED_DEFAULT =
  'An OSS (WSTO_EE) line requires a destination-country VAT rate. Set the consumption-country rate (or a known EU member state) before submitting it to KSeF.'
const MARGIN_SCHEME_MIXED_LINES_DEFAULT = 'marginSchemeMixedLines'
const MARGIN_SCHEME_REQUIRES_PLN_DEFAULT = 'marginSchemeRequiresPln'

/** The PL-meta `invoice_kind` text column → the FA(3) `RodzajFaktury` enum. */
type InvoiceKindMeta = 'vat' | 'zal' | 'roz' | 'upr' | 'kor_zal' | 'kor_roz'
const INVOICE_KIND_MAP: Record<InvoiceKindMeta, Fa3InvoiceInput['invoiceKind']> = {
  vat: 'VAT',
  zal: 'ZAL',
  roz: 'ROZ',
  upr: 'UPR',
  kor_zal: 'KOR_ZAL',
  kor_roz: 'KOR_ROZ',
}

function readInvoiceKind(meta: Record<string, unknown> | undefined): InvoiceKindMeta {
  const raw = (asString(meta?.invoice_kind) ?? 'vat').toLowerCase()
  return raw === 'zal' || raw === 'roz' || raw === 'upr' || raw === 'kor_zal' || raw === 'kor_roz'
    ? (raw as InvoiceKindMeta)
    : 'vat'
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const text = asString(value)
  return text === 'true' || text === '1'
}

/**
 * Annotate the invoice line rows for an OSS (WSTO_EE) invoice: each row carries the destination
 * VAT rate (`oss_rate` → `P_12_XII`), the procedure marker (`procedure=WSTO_EE`), and the per-line
 * FX rate to PLN (`fx_rate` → `KursWaluty`). The OSS rate is the line's own sales rate when present
 * (the trusted source), falling back to the consumption-country EU standard rate. A non-OSS invoice
 * returns the rows unchanged.
 */
function applyOssMarkers(
  rows: InvoiceLineRow[],
  ossProcedure: boolean,
  consumptionCountry: string | undefined,
  fxRate: string | undefined,
  deps: Fa3MappingDeps,
): InvoiceLineRow[] {
  if (!ossProcedure) return rows
  if (!consumptionCountry) {
    const message =
      deps.translate?.('financial_pl.errors.oss_country_required', OSS_COUNTRY_REQUIRED_DEFAULT) ??
      OSS_COUNTRY_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'oss_country_required' })
  }
  const tableRate = getEuStandardVatRate(consumptionCountry)
  return rows.map((row) => {
    // INVARIANT: on an OSS / WSTO_EE line, the stored `tax_rate` MUST be the CONSUMPTION-country
    // VAT rate (the destination rate, e.g. DE 19%), NOT the Polish sale rate — it is reported
    // verbatim as the destination rate (P_12_XII) and OSS buckets bypass the domestic
    // rate-reconciliation guard. When the line carries no positive rate we fall back to the EU
    // standard-rate table for the consumption country. Callers that persist the Polish rate on an
    // OSS line would file a wrong destination VAT rate.
    const lineRate = Number(asNumericString(row.tax_rate) ?? '')
    const ossRate =
      Number.isFinite(lineRate) && lineRate > 0 ? String(lineRate) : tableRate !== undefined ? String(tableRate) : null
    if (ossRate === null) {
      const message =
        deps.translate?.('financial_pl.errors.oss_rate_required', OSS_RATE_REQUIRED_DEFAULT) ?? OSS_RATE_REQUIRED_DEFAULT
      throw new CrudHttpError(422, { error: message, code: 'oss_rate_required' })
    }
    return {
      ...row,
      oss_rate: ossRate,
      procedure: 'WSTO_EE',
      ...(fxRate ? { fx_rate: fxRate } : {}),
    }
  })
}

/**
 * Resolve a validated FA(3) invoice payload for a sales invoice, reading the invoice, its lines,
 * and the PL meta extension through the platform query engine. SPEC-009 replaced the blanket
 * `document_type`/PLN-only rejects with a DISPATCH on the explicit PL-meta `invoice_kind`:
 * `vat` (default) → standard path; `zal` → advance (order + received payments, P_15 = paid amount,
 * FaWiersz optional); `roz` → settlement (full FaWiersz + advance refs, P_15 = residual); `upr` →
 * simplified (NIP-only buyer + threshold). OSS (WSTO_EE) lines + foreign currency are accepted when
 * the explicit `oss_procedure` marker / a resolvable exchange rate are present. Validated with
 * `fa3InvoiceSchema.parse(...)` before returning.
 */
export async function resolveFa3FromSalesInvoice(
  deps: ResolveFa3Deps,
  args: ResolveFa3Args,
): Promise<Fa3InvoiceInput> {
  const { queryEngine } = deps
  const { salesInvoiceId, organizationId, tenantId } = args
  const scope = { tenantId, organizationIds: [organizationId] }

  const invoiceResult = await queryEngine.query<InvoiceRow>(E.sales.sales_invoice, {
    ...scope,
    filters: { id: { $eq: salesInvoiceId } },
    page: { page: 1, pageSize: 1 },
  })
  const invoice = invoiceResult.items?.[0]
  if (!invoice) {
    throw new CrudHttpError(404, { error: '[internal] sales invoice not found for FA(3) resolution' })
  }

  const lineRows: InvoiceLineRow[] = []
  const linePageSize = 100
  for (let page = 1; ; page++) {
    const lineResult = await queryEngine.query<InvoiceLineRow>(E.sales.sales_invoice_line, {
      ...scope,
      filters: { invoice_id: { $eq: salesInvoiceId } },
      page: { page, pageSize: linePageSize },
      sort: [{ field: 'line_number', dir: 'asc' }],
    })
    const batch = lineResult.items ?? []
    lineRows.push(...batch)
    if (batch.length < linePageSize) break
  }

  const metaResult = await queryEngine.query<Record<string, unknown>>('financial_pl:sales_invoice_pl_meta', {
    ...scope,
    filters: { sales_invoice_id: { $eq: salesInvoiceId } },
    page: { page: 1, pageSize: 1 },
  })
  const meta = metaResult.items?.[0]

  const seller = buildSeller(deps)

  // A fiscal document's issue date is regulation-critical — reject a missing one
  // rather than silently defaulting to today (which would file a mis-dated invoice).
  const issueDate = toIsoDate(invoice.issue_date) ?? toIsoDate(invoice.issued_at)
  if (!issueDate) {
    const message =
      deps.translate?.('financial_pl.errors.issue_date_required', ISSUE_DATE_REQUIRED_DEFAULT) ?? ISSUE_DATE_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'issue_date_required' })
  }

  // SPEC-009 dispatch: the explicit PL-meta `invoice_kind` selects the FA(3) RodzajFaktury and
  // the per-kind blocks. Defaulting to `vat` preserves every existing invoice's behavior. (KOR is
  // not resolvable from an invoice — corrections are resolved from a credit memo.)
  const metaKind = readInvoiceKind(meta)
  const invoiceKind = INVOICE_KIND_MAP[metaKind]
  const isUpr = metaKind === 'upr'
  const ossProcedure = isTruthyFlag(meta?.oss_procedure)
  const consumptionCountry = asString(meta?.consumption_country_code) ?? undefined
  const exchangeRate = resolveMetaExchangeRate(meta)

  const currencyCode = (asString(invoice.currency_code) ?? 'PLN').toUpperCase()
  const invoiceMetadata = asRecord(invoice.metadata)
  const priceMode = readPriceModeFromMetadata(invoiceMetadata)
  const marginScheme = normalizeMarginScheme(meta?.margin_scheme)

  const baseLineRows = lineRows.length > 0 ? lineRows : metadataLinesToRows(invoice)
  if (marginScheme) {
    if (currencyCode !== 'PLN') {
      throw new CrudHttpError(422, {
        error:
          deps.translate?.('financial_pl.errors.margin_scheme_requires_pln', MARGIN_SCHEME_REQUIRES_PLN_DEFAULT) ??
          MARGIN_SCHEME_REQUIRES_PLN_DEFAULT,
        code: 'marginSchemeRequiresPln',
      })
    }
    if (baseLineRows.some(lineCarriesTaxRate)) {
      throw new CrudHttpError(422, {
        error:
          deps.translate?.('financial_pl.errors.margin_scheme_mixed_lines', MARGIN_SCHEME_MIXED_LINES_DEFAULT) ??
          MARGIN_SCHEME_MIXED_LINES_DEFAULT,
        code: 'marginSchemeMixedLines',
      })
    }
  }
  const ossLineRows = applyOssMarkers(baseLineRows, ossProcedure, consumptionCountry, exchangeRate, deps)
  // Non-OSS foreign-currency invoice: stamp the FX rate on every line too, so each FaWiersz emits
  // `KursWaluty` consistently with the `P_14_xW` (PLN-converted output VAT) the summary carries
  // (H3). OSS lines already receive fx_rate from applyOssMarkers.
  const effectiveLineRows =
    exchangeRate && !ossProcedure
      ? ossLineRows.map((row) => (asString(row.fx_rate) ? row : { ...row, fx_rate: exchangeRate }))
      : ossLineRows

  const vatBreakdown = buildVatBreakdown(
    effectiveLineRows,
    invoice.grand_total_net_amount,
    invoice.tax_total_amount,
    {
      ...(exchangeRate ? { fxRate: exchangeRate } : {}),
      priceMode,
      ...(marginScheme ? { marginScheme, headerGrossField: invoice.grand_total_gross_amount } : {}),
    },
  )
  assertMappedVatRates(vatBreakdown, deps.translate)

  // Header-only fallback reconcile guard (a rounded effective rate must reproduce the stored tax).
  // Skipped for OSS, whose buckets carry the destination rate, not a Polish-mappable one.
  if (effectiveLineRows.length === 0 && !ossProcedure && !marginScheme) {
    const headerNet = toScaled4(invoice.grand_total_net_amount)
    const headerVat = toScaled4(invoice.tax_total_amount)
    if (!headerVatRateReconciles(headerNet, headerVat, deriveHeaderVatRate(headerNet, headerVat))) {
      const message =
        deps.translate?.('financial_pl.errors.vat_rate_unsupported', VAT_RATE_UNSUPPORTED_DEFAULT) ??
        VAT_RATE_UNSUPPORTED_DEFAULT
      throw new CrudHttpError(422, { error: message, code: 'vat_rate_unsupported' })
    }
  }

  // P_15 derived from the SAME rounded buckets the summary emits, so the document is
  // internally consistent by construction.
  const totalGross = scaled4ToMoney2dp(
    vatBreakdown.reduce((sum, entry) => sum + toScaled4(entry.net) + toScaled4(entry.vat), 0n),
  )

  const annotations = buildAnnotations(meta)

  const headerNet = invoice.grand_total_net_amount
  const headerVat = invoice.tax_total_amount
  const fallbackGross = scaled4ToMoney2dp(toScaled4(headerNet) + toScaled4(headerVat))
  const fallbackLine: Fa3InvoiceInput['lines'][number] = {
    lineNumber: 1,
    name: asString(invoice.invoice_number) ?? 'Faktura',
    quantity: '1',
    unitNetPrice: roundMoneyTo2dp(headerNet),
    netValue: roundMoneyTo2dp(headerNet),
    vatRate: deriveHeaderVatRate(toScaled4(headerNet), toScaled4(headerVat)),
    ...(priceMode === 'gross' || marginScheme
      ? {
          unitGrossPrice: roundMoneyTo2dp(invoice.grand_total_gross_amount ?? fallbackGross),
          grossValue: roundMoneyTo2dp(invoice.grand_total_gross_amount ?? fallbackGross),
        }
      : {}),
    ...(marginScheme ? { marginRow: true } : {}),
    // Header-only foreign-currency invoice: the single fallback line carries KursWaluty too (H3).
    ...(exchangeRate ? { fxRate: exchangeRate } : {}),
  }

  const lines =
    effectiveLineRows.length > 0
      ? buildLines(effectiveLineRows, { priceMode, ...(marginScheme ? { marginScheme } : {}) })
      : metaKind === 'zal'
        ? []
        : [fallbackLine]

  // --- Per-kind blocks --------------------------------------------------------------------------
  let order: Fa3InvoiceInput['order']
  let advancePayments: Fa3InvoiceInput['advancePayments']
  let advanceInvoiceRefs: Fa3InvoiceInput['advanceInvoiceRefs']
  // P_15: a ZAL files the amount PAID (Σ received payments); a ROZ files the RESIDUAL remaining to
  // pay (full gross − Σ advances); every other kind files the bucket-derived total gross.
  let p15 = totalGross
  if (metaKind === 'zal') {
    const advance = resolveFa3Advance(meta, deps)
    order = advance.order
    advancePayments = advance.advancePayments
    p15 = advance.paidGross
  } else if (metaKind === 'roz') {
    const settlement = resolveFa3Settlement(meta, totalGross, deps)
    advanceInvoiceRefs = settlement.advanceInvoiceRefs
    p15 = settlement.residualGross
  }

  // SPEC-017 F1: optional payment block from metadata.payment. Fail-open: a malformed stored
  // payment must not block a send; just omit the <Platnosc> node. TerminPlatnosci = invoice due date.
  const rawPayment = invoiceMetadata.payment
  const parsedPayment = rawPayment !== undefined ? invoicePaymentSchema.safeParse(rawPayment) : null
  const payment =
    parsedPayment && parsedPayment.success
      ? { ...parsedPayment.data, terminDate: parsedPayment.data.terminDate ?? toIsoDate(invoice.due_date) ?? undefined }
      : undefined

  const fa3Invoice: Fa3InvoiceInput = {
    invoiceNumber: asString(invoice.invoice_number) ?? salesInvoiceId,
    issueDate,
    saleDate: toIsoDate(invoiceMetadata.saleDate) ?? toIsoDate(invoice.issue_date) ?? undefined,
    currencyCode,
    invoiceKind,
    seller,
    buyer: buildBuyer(invoice, deps, { uprNipOnly: isUpr }),
    vatBreakdown,
    totalGross: p15,
    lines,
    ...(annotations ? { annotations } : {}),
    ...(order ? { order } : {}),
    ...(advancePayments && advancePayments.length > 0 ? { advancePayments } : {}),
    ...(advanceInvoiceRefs ? { advanceInvoiceRefs } : {}),
    ...(exchangeRate ? { exchangeRate } : {}),
    ...(payment ? { payment } : {}),
  }

  return fa3InvoiceSchema.parse(fa3Invoice)
}
