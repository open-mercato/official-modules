import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { fa3InvoiceSchema, type Fa3InvoiceInput } from '../data/validators'
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
  roundMoneyTo2dp,
  scaled4ToMoney2dp,
  toIsoDate,
  toScaled4,
  asRecord,
  asString,
  type Fa3MappingDeps,
  type InvoiceLineRow,
  type InvoiceRow,
} from './fa3-mapping'

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

const DOCUMENT_TYPE_UNSUPPORTED_DEFAULT =
  'Only standard VAT invoices can be submitted to KSeF from an invoice. Corrections are submitted from a credit memo; advance/final invoices are not supported.'
const CURRENCY_UNSUPPORTED_DEFAULT =
  'Only PLN invoices can be submitted to KSeF yet. Foreign-currency invoices are not supported.'
const VAT_RATE_UNSUPPORTED_DEFAULT =
  'This invoice uses a VAT rate that cannot be mapped to a KSeF FA(3) field. Use a standard Polish VAT rate.'

/**
 * Resolve a validated FA(3) invoice payload for a standard sales invoice, reading
 * the invoice, its lines, and the PL meta extension through the platform query
 * engine. Validated with `fa3InvoiceSchema.parse(...)` before returning.
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
  const effectiveLineRows = lineRows.length > 0 ? lineRows : metadataLinesToRows(invoice)

  const issueDate =
    toIsoDate(invoice.issue_date) ?? toIsoDate(invoice.issued_at) ?? new Date().toISOString().slice(0, 10)

  // KSeF send scope from an invoice: only a standard `vat` invoice in PLN with KSeF-mappable
  // VAT rates is faithfully serializable here. Corrections are submitted from a credit memo
  // (resolve-fa3-from-credit-memo); advance/final and foreign currency are out of scope.
  const documentType = asString(invoice.document_type) ?? 'vat'
  if (documentType !== 'vat') {
    const message =
      deps.translate?.('financial_pl.errors.document_type_unsupported', DOCUMENT_TYPE_UNSUPPORTED_DEFAULT) ??
      DOCUMENT_TYPE_UNSUPPORTED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'document_type_unsupported' })
  }

  const currencyCode = (asString(invoice.currency_code) ?? 'PLN').toUpperCase()
  if (currencyCode !== 'PLN') {
    const message =
      deps.translate?.('financial_pl.errors.currency_unsupported', CURRENCY_UNSUPPORTED_DEFAULT) ??
      CURRENCY_UNSUPPORTED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'currency_unsupported' })
  }

  const vatBreakdown = buildVatBreakdown(
    effectiveLineRows,
    invoice.grand_total_net_amount,
    invoice.tax_total_amount,
  )
  assertMappedVatRates(vatBreakdown, deps.translate)

  // Header-only fallback reconcile guard (a rounded effective rate must reproduce the stored tax).
  if (effectiveLineRows.length === 0) {
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
  const fallbackLine: Fa3InvoiceInput['lines'][number] = {
    lineNumber: 1,
    name: asString(invoice.invoice_number) ?? 'Faktura',
    quantity: '1',
    unitNetPrice: roundMoneyTo2dp(headerNet),
    netValue: roundMoneyTo2dp(headerNet),
    vatRate: deriveHeaderVatRate(toScaled4(headerNet), toScaled4(headerVat)),
  }

  const fa3Invoice: Fa3InvoiceInput = {
    invoiceNumber: asString(invoice.invoice_number) ?? salesInvoiceId,
    issueDate,
    saleDate: toIsoDate(asRecord(invoice.metadata).saleDate) ?? toIsoDate(invoice.issue_date) ?? undefined,
    currencyCode,
    invoiceKind: 'VAT',
    seller,
    buyer: buildBuyer(invoice, deps),
    vatBreakdown,
    totalGross,
    lines: effectiveLineRows.length > 0 ? buildLines(effectiveLineRows) : [fallbackLine],
    ...(annotations ? { annotations } : {}),
  }

  return fa3InvoiceSchema.parse(fa3Invoice)
}
