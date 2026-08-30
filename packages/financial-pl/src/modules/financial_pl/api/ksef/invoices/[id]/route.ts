import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../lib/public-error'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { KsefSubmission, SalesInvoicePlMeta } from '../../../../data/entities'
import { readSellerIdentity } from '../../../../lib/seller-identity'
import { selectSubmissionIdsWithUpo } from '../../../../lib/upo-availability'

export const metadata = {
  // Composed gate (SPEC-013): this endpoint exposes core SalesInvoice business data which core
  // itself gates behind `sales.invoices.manage` — gating on `financial_pl.view` alone would be a
  // permission bypass, so BOTH features are required (mirrors the sibling list endpoint).
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view', 'sales.invoices.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })

/**
 * Narrow query-engine surface this route depends on. financial_pl reads core sales data ONLY through
 * the platform query engine (no cross-module ORM relation/import) — same contract as
 * `resolve-fa3-from-invoice.ts` and the sibling list endpoint. Result fields come back snake_cased
 * (the storage column names).
 */
type InvoiceQueryEngine = {
  query: <TRow = Record<string, unknown>>(
    entityId: string,
    opts: {
      tenantId: string
      organizationIds?: Array<string | null>
      filters?: Record<string, unknown>
      fields?: string[]
      page?: { page: number; pageSize: number }
      sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>
    },
  ) => Promise<{ items?: TRow[]; total?: number }>
}

// Core SalesInvoice header row (snake_cased storage columns). Only the plaintext columns we project
// are declared. No encrypted columns exist on the invoice header; nothing here is decrypted.
type SalesInvoiceRow = {
  id: string
  invoice_number?: string | null
  order_id?: string | null
  status_entry_id?: string | null
  status?: string | null
  issue_date?: string | Date | null
  due_date?: string | Date | null
  currency_code?: string | null
  subtotal_net_amount?: string | number | null
  subtotal_gross_amount?: string | number | null
  tax_total_amount?: string | number | null
  grand_total_net_amount?: string | number | null
  grand_total_gross_amount?: string | number | null
  metadata?: Record<string, unknown> | null
}

// Core SalesInvoiceLine row (snake_cased storage columns), filtered by invoice_id — exactly the read
// `resolve-fa3-from-invoice.ts` performs against E.sales.sales_invoice_line.
type SalesInvoiceLineRow = {
  line_number?: number | null
  kind?: string | null
  name?: string | null
  quantity?: string | number | null
  quantity_unit?: string | null
  unit_price_net?: string | number | null
  unit_price_gross?: string | number | null
  discount_amount?: string | number | null
  discount_percent?: string | number | null
  tax_rate?: string | number | null
  total_net_amount?: string | number | null
  tax_amount?: string | number | null
  total_gross_amount?: string | number | null
  currency_code?: string | null
  sku?: string | null
  metadata?: Record<string, unknown> | null
}

type InvoiceDetail = {
  id: string
  invoiceNumber: string | null
  orderId: string | null
  statusEntryId: string | null
  status: string | null
  issueDate: string | null
  dueDate: string | null
  currencyCode: string | null
  subtotalNetAmount: string | null
  subtotalGrossAmount: string | null
  taxTotalAmount: string | null
  grandTotalNetAmount: string | null
  grandTotalGrossAmount: string | null
  metadata: Record<string, unknown> | null
}

// Line shape mirrors core's invoice-line CREATE payload field names (invoiceCreateSchema.lines[*]) so
// the edit page can round-trip these straight back into POST/PUT /api/sales/invoices.
type InvoiceLineDetail = {
  name: string | null
  quantity: string | null
  quantityUnit: string | null
  unitPriceNet: string | null
  unitPriceGross: string | null
  discountAmount: string | null
  discountPercent: string | null
  taxRate: string | null
  totalNetAmount: string | null
  taxAmount: string | null
  totalGrossAmount: string | null
  currencyCode: string | null
  lineNumber: number | null
  kind: string | null
  sku: string | null
  metadata: Record<string, unknown> | null
}

// Full SalesInvoicePlMeta field set (the PL-VAT layer) projected to camelCase for the editor.
type InvoiceMetaDetail = {
  contextNip: string | null
  ksefStatus: string
  ksefNumber: string | null
  mppRequired: boolean
  vatExemptionBasis: string | null
  issuedOutsideKsef: boolean
  invoiceKind: string
  selfBilling: boolean
  reverseCharge: boolean
  ossProcedure: boolean
  consumptionCountryCode: string | null
  exchangeRate: string | null
  exchangeRateDate: string | null
  advancePayments: SalesInvoicePlMeta['advancePayments']
  advanceRefs: SalesInvoicePlMeta['advanceRefs']
  orderSnapshot: SalesInvoicePlMeta['orderSnapshot']
  gtuCodes: string[]
  wstoEe: boolean
  ied: boolean
  tp: boolean
  ttWnt: boolean
  ttD: boolean
  mrT: boolean
  mrUz: boolean
  i42: boolean
  i63: boolean
  bSpv: boolean
  bSpvDostawa: boolean
  bMpvProwizja: boolean
  docType: string | null
  marginScheme: string | null
  marginPurchaseCost: string | null
  marginVatRate: number | null
  badDebtReliefPeriod: string | null
  badDebtTerminPlatnosci: string | null
}

type SubmissionDetail = {
  id: string
  status: string
  ksefNumber: string | null
  upoAvailable: boolean
  offlineSendDeadlineAt: string | null
}

function toIsoDate(value: string | Date | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return value
}

function toAmount(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

export async function GET(req: Request, ctx: { params: { id: string } }) {
  try {
    const parsedParams = paramsSchema.safeParse(ctx.params ?? {})
    if (!parsedParams.success) throw new CrudHttpError(400, { error: 'Invalid invoice id' })
    const { id } = parsedParams.data

    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })

    // Org-scope contract (mirror the sibling list route): filterIds===null ⇒ super-admin (all orgs in
    // the tenant); filterIds===[] ⇒ no accessible orgs ⇒ record is out of scope ⇒ 404. NEVER drop the
    // org filter, which would leak another org's invoice. The queryEngine still requires tenantId.
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      throw new CrudHttpError(404, { error: 'Record not found' })
    }
    const organizationIds = Array.isArray(orgIds) && orgIds.length > 0 ? orgIds : undefined

    const queryEngine = container.resolve('queryEngine') as InvoiceQueryEngine

    // Header via the query engine, scoped by org/tenant — same read as resolve-fa3-from-invoice.ts
    // (E.sales.sales_invoice, filter id). Out-of-scope / missing ⇒ 404 (RecordNotFound).
    const invoiceResult = await queryEngine.query<SalesInvoiceRow>(E.sales.sales_invoice, {
      tenantId: auth.tenantId,
      ...(organizationIds ? { organizationIds } : {}),
      filters: { id: { $eq: id } },
      page: { page: 1, pageSize: 1 },
    })
    const invoiceRow = invoiceResult.items?.[0]
    if (!invoiceRow) throw new CrudHttpError(404, { error: 'Record not found' })

    // Lines via the query engine, filtered by invoice_id (core's GET is header-only) — exactly the
    // paginated read at resolve-fa3-from-invoice.ts (E.sales.sales_invoice_line, sort line_number).
    const lineRows: SalesInvoiceLineRow[] = []
    const linePageSize = 100
    for (let page = 1; ; page++) {
      const lineResult = await queryEngine.query<SalesInvoiceLineRow>(E.sales.sales_invoice_line, {
        tenantId: auth.tenantId,
        ...(organizationIds ? { organizationIds } : {}),
        filters: { invoice_id: { $eq: id } },
        fields: [
          'line_number',
          'kind',
          'name',
          'quantity',
          'quantity_unit',
          'unit_price_net',
          'unit_price_gross',
          'discount_amount',
          'discount_percent',
          'tax_rate',
          'total_net_amount',
          'tax_amount',
          'total_gross_amount',
          'currency_code',
          'sku',
          'metadata',
        ],
        page: { page, pageSize: linePageSize },
        sort: [{ field: 'line_number', dir: 'asc' }],
      })
      const batch = lineResult.items ?? []
      lineRows.push(...batch)
      if (batch.length < linePageSize) break
    }

    const em = (container.resolve('em') as EntityManager).fork()

    // PL-VAT meta + latest KSeF submission via our OWN tables, org/tenant scoped — same join logic as
    // the sibling list endpoint / the response enricher. Project ONLY plaintext columns: the
    // encrypted invoice_xml/upo_xml are deliberately excluded so the on-load encryption subscriber
    // never decrypts a (potentially large) receipt. UPO availability is derived from the accepted
    // status (the flow persists the receipt before flipping to 'accepted'), so no encrypted column is
    // read at all. Only the invoice's OWN submissions (document_kind='invoice'): a correction stores
    // sales_invoice_id = the CORRECTED original, so without this filter an accepted correction would
    // bleed its status onto the original.
    const decryptionScope = {
      tenantId: auth.tenantId,
      organizationId: Array.isArray(organizationIds) && organizationIds.length === 1 ? organizationIds[0] : null,
    }
    const metaRow = await findOneWithDecryption(
      em,
      SalesInvoicePlMeta,
      {
        salesInvoiceId: id,
        tenantId: auth.tenantId,
        ...(organizationIds ? { organizationId: { $in: organizationIds } } : {}),
        deletedAt: null,
      },
      undefined,
      decryptionScope,
    )

    const submissionRow = await findOneWithDecryption(
      em,
      KsefSubmission,
      {
        salesInvoiceId: id,
        documentKind: 'invoice',
        tenantId: auth.tenantId,
        ...(organizationIds ? { organizationId: { $in: organizationIds } } : {}),
        deletedAt: null,
      },
      {
        orderBy: { createdAt: 'desc' },
        fields: ['id', 'status', 'ksefNumber', 'offlineSendDeadlineAt', 'createdAt'],
      },
      decryptionScope,
    )

    const invoice: InvoiceDetail = {
      id: invoiceRow.id,
      invoiceNumber: invoiceRow.invoice_number ?? null,
      orderId: invoiceRow.order_id ?? null,
      statusEntryId: invoiceRow.status_entry_id ?? null,
      status: invoiceRow.status ?? null,
      issueDate: toIsoDate(invoiceRow.issue_date),
      dueDate: toIsoDate(invoiceRow.due_date),
      currencyCode: invoiceRow.currency_code ?? null,
      subtotalNetAmount: toAmount(invoiceRow.subtotal_net_amount),
      subtotalGrossAmount: toAmount(invoiceRow.subtotal_gross_amount),
      taxTotalAmount: toAmount(invoiceRow.tax_total_amount),
      grandTotalNetAmount: toAmount(invoiceRow.grand_total_net_amount),
      grandTotalGrossAmount: toAmount(invoiceRow.grand_total_gross_amount),
      metadata: invoiceRow.metadata ?? null,
    }

    const lines: InvoiceLineDetail[] = lineRows.map((row) => ({
      name: row.name ?? null,
      quantity: toAmount(row.quantity),
      quantityUnit: row.quantity_unit ?? null,
      unitPriceNet: toAmount(row.unit_price_net),
      unitPriceGross: toAmount(row.unit_price_gross),
      discountAmount: toAmount(row.discount_amount),
      discountPercent: toAmount(row.discount_percent),
      taxRate: toAmount(row.tax_rate),
      totalNetAmount: toAmount(row.total_net_amount),
      taxAmount: toAmount(row.tax_amount),
      totalGrossAmount: toAmount(row.total_gross_amount),
      currencyCode: row.currency_code ?? null,
      lineNumber: row.line_number ?? null,
      kind: row.kind ?? null,
      sku: row.sku ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    }))

    const meta: InvoiceMetaDetail | null = metaRow
      ? {
          contextNip: metaRow.contextNip ?? null,
          ksefStatus: metaRow.ksefStatus,
          ksefNumber: metaRow.ksefNumber ?? null,
          mppRequired: metaRow.mppRequired,
          vatExemptionBasis: metaRow.vatExemptionBasis ?? null,
          issuedOutsideKsef: metaRow.issuedOutsideKsef,
          invoiceKind: metaRow.invoiceKind,
          selfBilling: metaRow.selfBilling,
          reverseCharge: metaRow.reverseCharge,
          ossProcedure: metaRow.ossProcedure,
          consumptionCountryCode: metaRow.consumptionCountryCode ?? null,
          exchangeRate: metaRow.exchangeRate ?? null,
          exchangeRateDate: metaRow.exchangeRateDate ? metaRow.exchangeRateDate.toISOString() : null,
          advancePayments: metaRow.advancePayments ?? [],
          advanceRefs: metaRow.advanceRefs ?? [],
          orderSnapshot: metaRow.orderSnapshot ?? null,
          gtuCodes: metaRow.gtuCodes ?? [],
          wstoEe: metaRow.wstoEe,
          ied: metaRow.ied,
          tp: metaRow.tp,
          ttWnt: metaRow.ttWnt,
          ttD: metaRow.ttD,
          mrT: metaRow.mrT,
          mrUz: metaRow.mrUz,
          i42: metaRow.i42,
          i63: metaRow.i63,
          bSpv: metaRow.bSpv,
          bSpvDostawa: metaRow.bSpvDostawa,
          bMpvProwizja: metaRow.bMpvProwizja,
          docType: metaRow.docType ?? null,
          marginScheme: metaRow.marginScheme ?? null,
          marginPurchaseCost: metaRow.marginPurchaseCost ?? null,
          marginVatRate: metaRow.marginVatRate != null ? Number(metaRow.marginVatRate) : null,
          badDebtReliefPeriod: metaRow.badDebtReliefPeriod ?? null,
          badDebtTerminPlatnosci: metaRow.badDebtTerminPlatnosci
            ? metaRow.badDebtTerminPlatnosci.toISOString()
            : null,
        }
      : null

    // Derived from the stored receipt, never from `status === 'accepted'`: an accepted row can
    // legitimately have no UPO yet, and offering the download for one 404s the user (QA #40).
    const submissionIdsWithUpo = await selectSubmissionIdsWithUpo(
      em,
      submissionRow ? [submissionRow.id] : [],
      auth.tenantId,
    )

    const submission: SubmissionDetail | null = submissionRow
      ? {
          id: submissionRow.id,
          status: submissionRow.status,
          ksefNumber: submissionRow.ksefNumber ?? null,
          upoAvailable: submissionIdsWithUpo.has(submissionRow.id),
          offlineSendDeadlineAt: submissionRow.offlineSendDeadlineAt
            ? submissionRow.offlineSendDeadlineAt.toISOString()
            : null,
        }
      : null

    const sellerOrganizationId =
      (Array.isArray(orgIds) && orgIds.length > 0 ? orgIds[0] : null) ?? auth.orgId ?? null
    const seller = sellerOrganizationId
      ? await readSellerIdentity(container, { organizationId: sellerOrganizationId, tenantId: auth.tenantId })
      : null

    return NextResponse.json({ invoice, lines, meta, submission, seller })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef invoice detail failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const invoiceSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string().nullable(),
  orderId: z.string().nullable(),
  statusEntryId: z.string().nullable(),
  status: z.string().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currencyCode: z.string().nullable(),
  subtotalNetAmount: z.string().nullable(),
  subtotalGrossAmount: z.string().nullable(),
  taxTotalAmount: z.string().nullable(),
  grandTotalNetAmount: z.string().nullable(),
  grandTotalGrossAmount: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
})
const lineSchema = z.object({
  name: z.string().nullable(),
  quantity: z.string().nullable(),
  quantityUnit: z.string().nullable(),
  unitPriceNet: z.string().nullable(),
  unitPriceGross: z.string().nullable().optional(),
  discountAmount: z.string().nullable().optional(),
  discountPercent: z.string().nullable().optional(),
  taxRate: z.string().nullable(),
  totalNetAmount: z.string().nullable(),
  taxAmount: z.string().nullable(),
  totalGrossAmount: z.string().nullable(),
  currencyCode: z.string().nullable(),
  lineNumber: z.number().nullable(),
  kind: z.string().nullable(),
  sku: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})
const submissionSchema = z.object({
  id: z.string(),
  status: z.string(),
  ksefNumber: z.string().nullable(),
  upoAvailable: z.boolean(),
  offlineSendDeadlineAt: z.string().nullable(),
})
const detailResponseSchema = z.object({
  invoice: invoiceSchema,
  lines: z.array(lineSchema),
  meta: z.record(z.string(), z.unknown()).nullable(),
  submission: submissionSchema.nullable(),
})
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Read a single sales invoice with lines, PL-VAT meta and KSeF status',
  methods: {
    GET: {
      summary: 'Read one sales invoice (header + lines + PL-VAT meta + KSeF submission)',
      description:
        'Self-contained single-invoice read for the financial_pl backoffice edit/detail pages (released core has no invoice-lines read API). Reads the core SalesInvoice header and its SalesInvoiceLine rows for the current org/tenant via the QueryEngine (core GET is header-only), and joins the SalesInvoicePlMeta row + the latest KsefSubmission (document_kind=invoice) from this module. Line field names mirror core\'s invoice-line create payload so the edit page can round-trip them straight into POST/PUT /api/sales/invoices. upoAvailable reports whether the submission actually stored a UPO receipt (an accepted submission whose receipt has not landed yet reports false); the encrypted receipt itself is never projected. Org/tenant scoped; encrypted columns are never projected into the response; returns 404 when the invoice is not in the caller\'s scope. Requires both financial_pl.view and sales.invoices.manage (composed gate).',
      responses: [{ status: 200, description: 'Invoice detail with lines, PL-VAT meta and KSeF status', schema: detailResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid invoice id', schema: errorSchema },
        { status: 404, description: 'Invoice not found in caller scope', schema: errorSchema },
      ],
    },
  },
}
