import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { KsefSubmission, SalesInvoicePlMeta, type KsefSubmissionStatusColumn } from '../../../data/entities'
import { ksefInvoiceListQuerySchema } from '../../../data/validators'

export const metadata = {
  // Composed gate (SPEC-013): this endpoint exposes core SalesInvoice business data which core
  // itself gates behind `sales.invoices.manage` — gating on `financial_pl.view` alone would be a
  // permission bypass, so BOTH features are required.
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view', 'sales.invoices.manage'] },
}

const KSEF_SUBMISSION_STATUSES: ReadonlySet<KsefSubmissionStatusColumn> = new Set([
  'not_applicable', 'ready', 'queued', 'processing', 'accepted', 'rejected', 'offline_issued',
])

/**
 * Narrow query-engine surface this route depends on. financial_pl reads core sales data ONLY through
 * the platform query engine (no cross-module ORM relation/import) — same contract as
 * `resolve-fa3-from-invoice.ts`, extended with `total` for accurate pagination. Result fields come
 * back snake_cased (the storage column names).
 */
type InvoiceListQueryEngine = {
  query: <TRow = Record<string, unknown>>(
    entityId: string,
    opts: {
      tenantId: string
      organizationIds?: Array<string | null>
      filters?: Record<string, unknown>
      page?: { page: number; pageSize: number }
      sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>
    },
  ) => Promise<{ items?: TRow[]; total?: number }>
}

type SalesInvoiceRow = {
  id: string
  invoice_number?: string | null
  issue_date?: string | Date | null
  due_date?: string | Date | null
  currency_code?: string | null
  grand_total_net_amount?: string | number | null
  grand_total_gross_amount?: string | number | null
  status?: string | null
}

type InvoiceListItem = {
  id: string
  invoiceNumber: string | null
  issueDate: string | null
  dueDate: string | null
  currencyCode: string | null
  grandTotalNetAmount: string | null
  grandTotalGrossAmount: string | null
  status: string | null
  ksefStatus: string | null
  ksefNumber: string | null
  upoAvailable: boolean
  offlineSendDeadlineAt: string | null
  invoiceKind: string | null
}

type InvoiceListSummary = {
  count: number
  totalNet: string
  totalGross: string
  capped: boolean
}

const EMPTY_SUMMARY: InvoiceListSummary = {
  count: 0,
  totalNet: '0.00',
  totalGross: '0.00',
  capped: false,
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

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })

    const url = new URL(req.url)
    const parsed = ksefInvoiceListQuerySchema.safeParse({
      search: url.searchParams.get('search') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      issueDateFrom: url.searchParams.get('issueDateFrom') ?? undefined,
      issueDateTo: url.searchParams.get('issueDateTo') ?? undefined,
      page: url.searchParams.get('page') ?? undefined,
      pageSize: url.searchParams.get('pageSize') ?? undefined,
    })
    if (!parsed.success) throw new CrudHttpError(400, { error: 'Invalid query', details: parsed.error.issues })
    const { search, status, issueDateFrom, issueDateTo, page, pageSize } = parsed.data

    // Org-scope contract (mirror submissions/route.ts): filterIds===null ⇒ super-admin (all orgs in
    // the tenant); filterIds===[] ⇒ no accessible orgs ⇒ return nothing — NEVER drop the org filter,
    // which would leak other orgs' invoices. The queryEngine still requires tenantId.
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      return NextResponse.json({ items: [], total: 0, page, pageSize, summary: EMPTY_SUMMARY })
    }
    const organizationIds = Array.isArray(orgIds) && orgIds.length > 0 ? orgIds : undefined

    const em = (container.resolve('em') as EntityManager).fork()

    // When a KSeF status filter is supplied it constrains the JOINED submission status (not an
    // invoice column), so it can't be pushed into the queryEngine directly. Resolve the matching
    // invoice ids from our own (scoped) KsefSubmission table FIRST, then narrow the queryEngine read
    // by `id: { $in }` so `total`/pagination stay accurate at the DB level. An empty match short-
    // circuits to an empty page.
    let statusInvoiceIds: string[] | null = null
    if (status) {
      if (!KSEF_SUBMISSION_STATUSES.has(status as KsefSubmissionStatusColumn)) {
        throw new CrudHttpError(400, { error: 'Invalid status filter' })
      }
      const statusRows = await em.find(
        KsefSubmission,
        {
          status: status as KsefSubmissionStatusColumn,
          documentKind: 'invoice',
          tenantId: auth.tenantId,
          ...(organizationIds ? { organizationId: { $in: organizationIds } } : {}),
          deletedAt: null,
        },
        { fields: ['salesInvoiceId'] },
      )
      statusInvoiceIds = Array.from(new Set(statusRows.map((row) => row.salesInvoiceId)))
      if (statusInvoiceIds.length === 0) {
        return NextResponse.json({ items: [], total: 0, page, pageSize, summary: EMPTY_SUMMARY })
      }
    }

    const queryEngine = container.resolve('queryEngine') as InvoiceListQueryEngine
    const filters: Record<string, unknown> = {}
    if (search) filters.invoice_number = { $ilike: `%${escapeLikePattern(search)}%` }
    if (statusInvoiceIds) filters.id = { $in: statusInvoiceIds }
    if (issueDateFrom || issueDateTo) {
      const range: Record<string, string> = {}
      if (issueDateFrom) range.$gte = issueDateFrom
      if (issueDateTo) range.$lte = issueDateTo
      filters.issue_date = range
    }

    const result = await queryEngine.query<SalesInvoiceRow>(E.sales.sales_invoice, {
      tenantId: auth.tenantId,
      ...(organizationIds ? { organizationIds } : {}),
      filters,
      page: { page, pageSize },
      sort: [{ field: 'issue_date', dir: 'desc' }],
    })
    const invoices = result.items ?? []
    const total = typeof result.total === 'number' ? result.total : invoices.length
    const invoiceIds = invoices.map((invoice) => invoice.id)

    const summaryResult = await queryEngine.query<SalesInvoiceRow>(E.sales.sales_invoice, {
      tenantId: auth.tenantId,
      ...(organizationIds ? { organizationIds } : {}),
      filters,
      page: { page: 1, pageSize: 1000 },
      sort: [{ field: 'issue_date', dir: 'desc' }],
    })
    const summaryRows = summaryResult.items ?? []
    const summaryTotal = typeof summaryResult.total === 'number' ? summaryResult.total : summaryRows.length
    let totalNet = 0
    let totalGross = 0
    for (const row of summaryRows) {
      const net = Number(row.grand_total_net_amount)
      if (Number.isFinite(net)) totalNet += net
      const gross = Number(row.grand_total_gross_amount)
      if (Number.isFinite(gross)) totalGross += gross
    }
    const summary: InvoiceListSummary = {
      count: summaryTotal,
      totalNet: totalNet.toFixed(2),
      totalGross: totalGross.toFixed(2),
      capped: summaryTotal > summaryRows.length,
    }

    // Join the latest KsefSubmission + the SalesInvoicePlMeta row per invoice — same batched ($in),
    // own-module, org/tenant-scoped logic as the response enricher (data/enrichers.ts). Project ONLY
    // the plaintext columns we need: the encrypted invoice_xml/upo_xml are deliberately excluded so
    // the on-load encryption subscriber never decrypts a (potentially large) receipt to render a
    // list. UPO availability is derived from the accepted status (the flow stores the receipt before
    // flipping to 'accepted'), so no encrypted column is read at all. Only the invoice's OWN
    // submissions (document_kind='invoice'): a correction stores sales_invoice_id = the CORRECTED
    // original, so without this filter an accepted correction would bleed its status onto the
    // original.
    const submissionByInvoice = new Map<string, { status: KsefSubmissionStatusColumn; ksefNumber: string | null; offlineSendDeadlineAt: Date | null }>()
    const metaByInvoice = new Map<string, { invoiceKind: string }>()
    if (invoiceIds.length > 0) {
      const submissions = await em.find(
        KsefSubmission,
        {
          salesInvoiceId: { $in: invoiceIds },
          documentKind: 'invoice',
          tenantId: auth.tenantId,
          ...(organizationIds ? { organizationId: { $in: organizationIds } } : {}),
          deletedAt: null,
        },
        {
          orderBy: { createdAt: 'desc' },
          fields: ['id', 'salesInvoiceId', 'status', 'ksefNumber', 'offlineSendDeadlineAt', 'createdAt'],
        },
      )
      for (const submission of submissions) {
        if (!submissionByInvoice.has(submission.salesInvoiceId)) {
          submissionByInvoice.set(submission.salesInvoiceId, {
            status: submission.status,
            ksefNumber: submission.ksefNumber ?? null,
            offlineSendDeadlineAt: submission.offlineSendDeadlineAt ?? null,
          })
        }
      }
      const metaRows = await em.find(
        SalesInvoicePlMeta,
        {
          salesInvoiceId: { $in: invoiceIds },
          tenantId: auth.tenantId,
          ...(organizationIds ? { organizationId: { $in: organizationIds } } : {}),
          deletedAt: null,
        },
        { fields: ['salesInvoiceId', 'invoiceKind', 'ksefStatus', 'ksefNumber'] },
      )
      for (const row of metaRows) metaByInvoice.set(row.salesInvoiceId, { invoiceKind: row.invoiceKind })
    }

    const items: InvoiceListItem[] = invoices.map((invoice) => {
      const submission = submissionByInvoice.get(invoice.id)
      const meta = metaByInvoice.get(invoice.id)
      return {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number ?? null,
        issueDate: toIsoDate(invoice.issue_date),
        dueDate: toIsoDate(invoice.due_date),
        currencyCode: invoice.currency_code ?? null,
        grandTotalNetAmount: toAmount(invoice.grand_total_net_amount),
        grandTotalGrossAmount: toAmount(invoice.grand_total_gross_amount),
        status: invoice.status ?? null,
        ksefStatus: submission?.status ?? null,
        ksefNumber: submission?.ksefNumber ?? null,
        // Accepted ⟺ a stored UPO (finalizeAccepted only flips to 'accepted' after the receipt is
        // persisted), so this is an accurate, decryption-free availability flag.
        upoAvailable: submission?.status === 'accepted',
        offlineSendDeadlineAt: submission?.offlineSendDeadlineAt
          ? submission.offlineSendDeadlineAt.toISOString()
          : null,
        invoiceKind: meta?.invoiceKind ?? null,
      }
    })

    return NextResponse.json({ items, total, page, pageSize, summary })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef invoices list failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const listItemSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currencyCode: z.string().nullable(),
  grandTotalNetAmount: z.string().nullable(),
  grandTotalGrossAmount: z.string().nullable(),
  status: z.string().nullable(),
  ksefStatus: z.string().nullable(),
  ksefNumber: z.string().nullable(),
  upoAvailable: z.boolean(),
  offlineSendDeadlineAt: z.string().nullable(),
  invoiceKind: z.string().nullable(),
})
const listResponseSchema = z.object({
  items: z.array(listItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  summary: z.object({
    count: z.number(),
    totalNet: z.string(),
    totalGross: z.string(),
    capped: z.boolean(),
  }),
})
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'List sales invoices with KSeF status',
  methods: {
    GET: {
      summary: 'List sales invoices with their KSeF status',
      description:
        'Self-contained invoice list for the financial_pl backoffice: reads core SalesInvoice rows for the current org/tenant via the QueryEngine and joins the latest KsefSubmission + SalesInvoicePlMeta (batched, no N+1) to attach KSeF status/number/UPO availability/offline deadline and the PL invoice kind. Supports ?search= (invoice number), ?status= (KSeF submission status), ?issueDateFrom=, ?issueDateTo=, ?page=, ?pageSize= (default 25, max 100). The response includes a summary over the full filtered period with count, net/gross totals, and a capped flag when totals cover only the first 1000 matching invoices. Org/tenant scoped; encrypted columns are never projected into the response. Requires both financial_pl.view and sales.invoices.manage (composed gate).',
      responses: [{ status: 200, description: 'Invoice list with KSeF status', schema: listResponseSchema }],
      errors: [{ status: 400, description: 'Invalid query / status filter', schema: errorSchema }],
    },
  },
}
