import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../lib/public-error'
import { findAndCountWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { JpkVatFiling } from '../../../../data/entities'
import { jpkFilingUpsertSchema, type JpkFilingUpsertInput } from '../../../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

function toRow(filing: JpkVatFiling) {
  return {
    id: filing.id,
    contextNip: filing.contextNip ?? null,
    variant: filing.variant,
    year: filing.year,
    month: filing.month,
    quarter: filing.quarter ?? null,
    celZlozenia: filing.celZlozenia,
    correctionScope: filing.correctionScope,
    kodUrzedu: filing.kodUrzedu ?? null,
    declarationInputs: filing.declarationInputs ?? null,
    status: filing.status,
    generatedAt: filing.generatedAt ?? null,
    submissionReference: filing.submissionReference ?? null,
    submittedAt: filing.submittedAt ?? null,
    hasUpo: Boolean(filing.upoXml),
    createdAt: filing.createdAt,
    updatedAt: filing.updatedAt ?? null,
  }
}


/**
 * Translate a client sort request into an `orderBy`. Only whitelisted columns are accepted — the
 * value reaches the ORM, so an arbitrary field name from the query string must never get through.
 * Period always falls back to (year, month) together: sorting by year alone reorders nothing
 * useful within a year.
 */
function resolveOrderBy(
  sortField: string | null,
  sortDir: string | null,
  allowed: Record<string, string[]>,
  fallback: Record<string, 'asc' | 'desc'>,
): Record<string, 'asc' | 'desc'> {
  const fields = sortField ? allowed[sortField] : undefined
  if (!fields) return fallback
  const dir: 'asc' | 'desc' = sortDir === 'asc' ? 'asc' : 'desc'
  return Object.fromEntries(fields.map((field) => [field, dir]))
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
    const filter: FilterQuery<JpkVatFiling> = { tenantId: auth.tenantId, deletedAt: null }
    // Org-scope contract (mirror submissions/route.ts): filterIds===null ⇒ super-admin (all orgs in
    // the tenant); filterIds===[] ⇒ no accessible orgs ⇒ return nothing — NEVER drop the org filter,
    // which would leak other orgs' filings.
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
    const variant = url.searchParams.get('variant')
    if (variant === 'V7M' || variant === 'V7K') filter.variant = variant

    const em = (container.resolve('em') as EntityManager).fork()
    // JpkVatFiling.generated_xml is encrypted-at-rest: use the decryption-aware finder (the
    // prescribed convention) even though toRow projects the XML out. Per-row scope drives
    // decryption; (tenantId, orgId) is only a fallback.
    const [rows, total] = await findAndCountWithDecryption(
      em,
      JpkVatFiling,
      filter,
      {
        orderBy: resolveOrderBy(
          url.searchParams.get('sortField'),
          url.searchParams.get('sortDir'),
          { period: ['year', 'month'], variant: ['variant'], status: ['status'], generatedAt: ['generatedAt'] },
          { year: 'desc', month: 'desc', createdAt: 'desc' },
        ),
        limit: pageSize,
        offset: (page - 1) * pageSize,
      },
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
    )
    return NextResponse.json({ items: rows.map(toRow), total, page, pageSize })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    console.error('[internal] financial_pl.jpk filings list failed', err)
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
    const parsed = jpkFilingUpsertSchema.parse({
      ...body,
      organizationId: ctx.selectedOrganizationId ?? auth.orgId ?? undefined,
      tenantId: auth.tenantId,
    })
    const resourceId = parsed.id ?? `${parsed.variant}:${parsed.year}:${parsed.month}:${parsed.celZlozenia}`
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.jpk_filing',
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
    const { result } = await commandBus.execute<JpkFilingUpsertInput, { id: string }>(
      'financial_pl.jpk.upsert_filing',
      { input: parsed, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.jpk_filing',
        resourceId: result?.id ?? resourceId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }
    return NextResponse.json({ ok: true, id: result?.id }, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.jpk.upsert_filing failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const listResponseSchema = z.object({ items: z.array(z.object({}).loose()), total: z.number(), page: z.number(), pageSize: z.number() })
const upsertResponseSchema = z.object({ ok: z.boolean(), id: z.string().optional() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'JPK_V7 filings',
  methods: {
    GET: {
      summary: 'List JPK_V7 filings',
      description:
        'Returns the JPK_V7M/V7K filing headers (period × variant × purpose) for the current org/tenant. Supports ?year=, ?month=, ?variant=V7M|V7K and ?page=/?pageSize=.',
      responses: [{ status: 200, description: 'Filing list', schema: listResponseSchema }],
    },
    POST: {
      summary: 'Upsert a JPK_V7 filing',
      description:
        'Creates or updates a JPK_V7 filing header (variant, period, correction scope, kod urzedu, declaration operator inputs). Org/tenant-scoped; at most one active filing per period/variant/purpose.',
      requestBody: { contentType: 'application/json', schema: jpkFilingUpsertSchema },
      responses: [{ status: 200, description: 'Filing saved', schema: upsertResponseSchema }],
      errors: [{ status: 400, description: 'Validation failed', schema: errorSchema }],
    },
  },
}
