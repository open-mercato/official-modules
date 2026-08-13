import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../lib/public-error'
import { findAndCountWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { ReceivedInvoice } from '../../../data/entities'
import {
  receivedInvoicesListQuerySchema,
  receiveSyncSchema,
  type ReceiveSyncInput,
} from '../../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  POST: { requireAuth: true, requireFeatures: ['financial_pl.submit'] },
}

function dateOnlyFromValue(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

// Cap on the rows scanned for the summary totals (gross / VAT). The received set is small per NIP;
// if it ever exceeds this, `capped` flags that the totals cover only the most recent rows.
const RECEIVED_SUMMARY_CAP = 1000

type ReceivedInvoiceSummary = {
  count: number
  totalGross: string
  vatTotal: string
  correctionCount: number
  capped: boolean
}

const EMPTY_RECEIVED_SUMMARY: ReceivedInvoiceSummary = {
  count: 0,
  totalGross: '0.00',
  vatTotal: '0.00',
  correctionCount: 0,
  capped: false,
}

/**
 * Summary KPIs for the Purchases (received) tab — count, gross total, deductible VAT total, and a
 * correction (KOR) count. `grossAmount`/`vatAmount`/`invoiceType` are plaintext columns, so this
 * projects just those (no decryption) over a capped window; the exact count comes from `em.count`.
 */
async function computeReceivedSummary(
  em: EntityManager,
  filter: FilterQuery<ReceivedInvoice>,
): Promise<ReceivedInvoiceSummary> {
  const count = await em.count(ReceivedInvoice, filter)
  if (count === 0) return EMPTY_RECEIVED_SUMMARY
  const rows = await em.find(ReceivedInvoice, filter, {
    fields: ['grossAmount', 'vatAmount', 'invoiceType'],
    limit: RECEIVED_SUMMARY_CAP,
    orderBy: { acquisitionDate: 'desc', createdAt: 'desc' },
  })
  let totalGross = 0
  let vatTotal = 0
  let correctionCount = 0
  for (const row of rows) {
    const gross = Number(row.grossAmount)
    if (Number.isFinite(gross)) totalGross += gross
    const vat = Number(row.vatAmount)
    if (Number.isFinite(vat)) vatTotal += vat
    if (typeof row.invoiceType === 'string' && /kor/i.test(row.invoiceType)) correctionCount += 1
  }
  return {
    count,
    totalGross: totalGross.toFixed(2),
    vatTotal: vatTotal.toFixed(2),
    correctionCount,
    capped: count > rows.length,
  }
}

function toRow(invoice: ReceivedInvoice) {
  return {
    id: invoice.id,
    contextNip: invoice.contextNip ?? null,
    ksefNumber: invoice.ksefNumber,
    issuerNip: invoice.issuerNip ?? null,
    issuerName: invoice.issuerName ?? null,
    buyerIdentifierType: invoice.buyerIdentifierType ?? null,
    buyerIdentifierValue: invoice.buyerIdentifierValue ?? null,
    issueDate: dateOnlyFromValue(invoice.issueDate),
    acquisitionDate: dateOnlyFromValue(invoice.acquisitionDate),
    invoiceType: invoice.invoiceType ?? null,
    currency: invoice.currency ?? null,
    netAmount: invoice.netAmount ?? null,
    grossAmount: invoice.grossAmount ?? null,
    vatAmount: invoice.vatAmount ?? null,
    invoiceHash: invoice.invoiceHash ?? null,
    correctedKsefNumber: invoice.correctedKsefNumber ?? null,
    hasXml: Boolean(invoice.fa3Xml),
    linkedPurchaseRecordId: invoice.linkedPurchaseRecordId ?? null,
    fetchedAt: invoice.fetchedAt,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt ?? null,
  }
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const url = new URL(req.url)
    const parsed = receivedInvoicesListQuerySchema.parse({
      page: url.searchParams.get('page') ?? undefined,
      pageSize: url.searchParams.get('pageSize') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
    })
    const filter: FilterQuery<ReceivedInvoice> = { tenantId: auth.tenantId, deletedAt: null }
    // Free-text search over the plaintext identity columns (issuer name/NIP + KSeF number). fa3_xml is
    // the only encrypted column on this entity, so these `$ilike` matches run directly in the DB.
    if (parsed.search) {
      const term = `%${parsed.search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`
      Object.assign(filter, {
        $or: [
          { issuerName: { $ilike: term } },
          { issuerNip: { $ilike: term } },
          { ksefNumber: { $ilike: term } },
        ],
      })
    }
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      return NextResponse.json({
        items: [],
        total: 0,
        page: parsed.page,
        pageSize: parsed.pageSize,
        summary: EMPTY_RECEIVED_SUMMARY,
      })
    }
    if (Array.isArray(orgIds) && orgIds.length > 0) filter.organizationId = { $in: orgIds }

    const em = (container.resolve('em') as EntityManager).fork()
    const [rows, total] = await findAndCountWithDecryption(
      em,
      ReceivedInvoice,
      filter,
      {
        orderBy: { acquisitionDate: 'desc', createdAt: 'desc' },
        limit: parsed.pageSize,
        offset: (parsed.page - 1) * parsed.pageSize,
      },
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
    )
    const summary = await computeReceivedSummary(em, filter)
    return NextResponse.json({
      items: rows.map(toRow),
      total,
      page: parsed.page,
      pageSize: parsed.pageSize,
      summary,
    })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef received-invoices list failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const ctx: CommandRuntimeContext = {
      container,
      auth,
      organizationScope: scope,
      selectedOrganizationId: scope?.selectedId ?? auth.orgId ?? null,
      organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
      request: req,
    }
    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const parsed = receiveSyncSchema.parse(body)
    const resourceId = `${parsed.dateType}:${parsed.dateFrom}:${parsed.dateTo}`
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.received_invoice',
      resourceId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<ReceiveSyncInput, { synced: number }>(
      'financial_pl.ksef_receive.receive_invoices',
      { input: parsed, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.received_invoice',
        resourceId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }
    return NextResponse.json({ ok: true, synced: result?.synced ?? 0 }, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_receive.receive_invoices failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const listResponseSchema = z.object({
  items: z.array(z.object({}).loose()),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  summary: z.object({
    count: z.number(),
    totalGross: z.string(),
    vatTotal: z.string(),
    correctionCount: z.number(),
    capped: z.boolean(),
  }),
})
const syncResponseSchema = z.object({ ok: z.boolean(), synced: z.number() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'KSeF received invoices',
  methods: {
    GET: {
      summary: 'List received KSeF invoices',
      description:
        'Returns KSeF invoices received by the current taxpayer as buyer, scoped by tenant and accessible organizations. Supports ?page=, ?pageSize= and ?search= (issuer name/NIP + KSeF number). Includes a summary (count, gross total, deductible VAT, corrections).',
      responses: [{ status: 200, description: 'Received invoice list', schema: listResponseSchema }],
    },
    POST: {
      summary: 'Synchronize received KSeF invoices',
      description:
        'Queries KSeF received-invoice metadata for the requested date window as Subject2 and stores rows idempotently without overwriting first-write legal fields.',
      requestBody: { contentType: 'application/json', schema: receiveSyncSchema },
      responses: [{ status: 200, description: 'Synchronization completed', schema: syncResponseSchema }],
      errors: [{ status: 400, description: 'Validation failed', schema: errorSchema }],
    },
  },
}
