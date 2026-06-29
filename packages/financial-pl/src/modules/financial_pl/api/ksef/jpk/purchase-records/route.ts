import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { PurchaseVatRecord } from '../../../../data/entities'
import { jpkPurchaseRecordUpsertSchema, type JpkPurchaseRecordUpsertInput } from '../../../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

function toRow(record: PurchaseVatRecord) {
  return {
    id: record.id,
    contextNip: record.contextNip ?? null,
    year: record.year,
    month: record.month,
    supplierNip: record.supplierNip ?? null,
    supplierCountryCode: record.supplierCountryCode ?? null,
    supplierName: record.supplierName ?? null,
    documentNumber: record.documentNumber,
    purchaseDate: record.purchaseDate,
    receiptDate: record.receiptDate ?? null,
    documentType: record.documentType ?? null,
    imp: record.imp,
    ksefMarking: record.ksefMarking ?? null,
    nrKsef: record.nrKsef ?? null,
    transactionClass: record.transactionClass,
    netFixedAssets: record.netFixedAssets ?? null,
    vatFixedAssets: record.vatFixedAssets ?? null,
    netOther: record.netOther ?? null,
    vatOther: record.vatOther ?? null,
    corrFixedAssets: record.corrFixedAssets ?? null,
    corrOther: record.corrOther ?? null,
    corr89b1: record.corr89b1 ?? null,
    corr89b4: record.corr89b4 ?? null,
    marginGross: record.marginGross ?? null,
    selfAssessedNet: record.selfAssessedNet ?? null,
    selfAssessedVat: record.selfAssessedVat ?? null,
    selfAssessedRate: record.selfAssessedRate ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? null,
  }
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const url = new URL(req.url)
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '50') || 50))
    const filter: FilterQuery<PurchaseVatRecord> = { tenantId: auth.tenantId, deletedAt: null }
    // Org-scope contract (mirror submissions/route.ts): filterIds===null ⇒ super-admin (all orgs in
    // the tenant); filterIds===[] ⇒ no accessible orgs ⇒ return nothing — NEVER drop the org filter,
    // which would leak other orgs' purchase records.
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      return NextResponse.json({ items: [], total: 0, page, pageSize })
    }
    if (Array.isArray(orgIds) && orgIds.length > 0) filter.organizationId = { $in: orgIds }
    const yearParam = url.searchParams.get('year')
    if (yearParam) {
      const year = Number(yearParam)
      if (Number.isInteger(year)) filter.year = year
    }
    const monthParam = url.searchParams.get('month')
    if (monthParam) {
      const month = Number(monthParam)
      if (Number.isInteger(month)) filter.month = month
    }

    const em = (container.resolve('em') as EntityManager).fork()
    const [rows, total] = await em.findAndCount(PurchaseVatRecord, filter, {
      orderBy: { year: 'desc', month: 'desc', createdAt: 'desc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return NextResponse.json({ items: rows.map(toRow), total, page, pageSize })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.jpk purchase-records list failed', err)
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
    const parsed = jpkPurchaseRecordUpsertSchema.parse({
      ...body,
      organizationId: ctx.selectedOrganizationId ?? auth.orgId ?? undefined,
      tenantId: auth.tenantId,
    })
    const resourceId = parsed.id ?? `${parsed.year}:${parsed.month}:${parsed.documentNumber}`
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.jpk_purchase_record',
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
    const { result } = await commandBus.execute<JpkPurchaseRecordUpsertInput, { id: string }>(
      'financial_pl.jpk.upsert_purchase_record',
      { input: parsed, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.jpk_purchase_record',
        resourceId: result?.id ?? resourceId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }
    return NextResponse.json({ ok: true, id: result?.id }, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.jpk.upsert_purchase_record failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
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
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) throw new CrudHttpError(400, { error: '[internal] id is required' })
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.jpk_purchase_record',
      resourceId: id,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: { id },
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    await commandBus.execute<{ id: string }, { id: string }>(
      'financial_pl.jpk.delete_purchase_record',
      { input: { id }, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.jpk_purchase_record',
        resourceId: id,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.jpk.delete_purchase_record failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const listResponseSchema = z.object({ items: z.array(z.object({}).loose()), total: z.number(), page: z.number(), pageSize: z.number() })
const upsertResponseSchema = z.object({ ok: z.boolean(), id: z.string().optional() })
const okResponseSchema = z.object({ ok: z.boolean() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'JPK_V7 purchase VAT records',
  methods: {
    GET: {
      summary: 'List JPK purchase VAT records',
      description:
        'Returns the JPK-shaped purchase (zakup) evidence rows for the current org/tenant. Supports ?year= and ?month= period filters plus ?page=/?pageSize=.',
      responses: [{ status: 200, description: 'Purchase record list', schema: listResponseSchema }],
    },
    POST: {
      summary: 'Upsert a JPK purchase VAT record',
      description:
        'Creates or updates a JPK-shaped purchase (zakup) evidence row (period, supplier, document, transaction class, K_40..K_47 amounts and self-assessment fields). Org/tenant-scoped.',
      requestBody: { contentType: 'application/json', schema: jpkPurchaseRecordUpsertSchema },
      responses: [{ status: 200, description: 'Record saved', schema: upsertResponseSchema }],
      errors: [{ status: 400, description: 'Validation failed', schema: errorSchema }],
    },
    DELETE: {
      summary: 'Delete a JPK purchase VAT record',
      description: 'Soft-deletes the purchase record identified by ?id=. Org/tenant-scoped.',
      responses: [{ status: 200, description: 'Record deleted', schema: okResponseSchema }],
      errors: [
        { status: 400, description: 'Missing id', schema: errorSchema },
        { status: 404, description: 'Record not found', schema: errorSchema },
      ],
    },
  },
}
