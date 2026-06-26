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
import { parseIdsParam } from '@open-mercato/shared/lib/crud/ids'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { KsefSubmission } from '../../../data/entities'
import { ksefSubmissionSendSchema, type KsefSubmissionSendInput } from '../../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  POST: { requireAuth: true, requireFeatures: ['financial_pl.submit'] },
}

function toRow(submission: KsefSubmission) {
  return {
    id: submission.id,
    salesInvoiceId: submission.salesInvoiceId,
    status: submission.status,
    environment: submission.environment,
    ksefNumber: submission.ksefNumber ?? null,
    lastStatusCode: submission.lastStatusCode ?? null,
    lastErrorMessage: submission.lastErrorMessage ?? null,
    attemptCount: submission.attemptCount,
    submittedAt: submission.submittedAt ?? null,
    acceptedAt: submission.acceptedAt ?? null,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt ?? null,
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
    const filter: FilterQuery<KsefSubmission> = { tenantId: auth.tenantId, deletedAt: null }
    const orgIds = scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null)
    if (orgIds && orgIds.length > 0) filter.organizationId = { $in: orgIds }
    const ids = parseIdsParam(url.searchParams.get('ids'))
    if (ids && ids.length > 0) filter.id = { $in: ids }
    const salesInvoiceId = url.searchParams.get('salesInvoiceId')
    if (salesInvoiceId) filter.salesInvoiceId = salesInvoiceId
    const status = url.searchParams.get('status')
    if (status) filter.status = status as KsefSubmission['status']

    const em = (container.resolve('em') as EntityManager).fork()
    const [rows, total] = await em.findAndCount(KsefSubmission, filter, {
      orderBy: { createdAt: 'desc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return NextResponse.json({ items: rows.map(toRow), total, page, pageSize })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.ksef submissions list failed', err)
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
    const parsed = ksefSubmissionSendSchema.parse({
      ...body,
      organizationId: ctx.selectedOrganizationId ?? auth.orgId ?? undefined,
      tenantId: auth.tenantId,
    })
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.ksef_submission',
      resourceId: parsed.salesInvoiceId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<KsefSubmissionSendInput, { submissionId: string }>(
      'financial_pl.ksef_submission.send',
      { input: parsed, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.ksef_submission',
        resourceId: parsed.salesInvoiceId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }
    return NextResponse.json({ ok: true, submissionId: result?.submissionId }, { status: 202 })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_submission.send failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const listResponseSchema = z.object({ items: z.array(z.object({}).loose()), total: z.number(), page: z.number(), pageSize: z.number() })
const sendResponseSchema = z.object({ ok: z.boolean(), submissionId: z.string().optional() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'KSeF invoice submissions',
  methods: {
    GET: {
      summary: 'List KSeF submissions',
      description: 'Returns KSeF submission status rows for the current org/tenant. Supports ?ids=, ?salesInvoiceId=, ?status=.',
      responses: [{ status: 200, description: 'Submission list', schema: listResponseSchema }],
    },
    POST: {
      summary: 'Queue a KSeF submission',
      description: 'Builds the FA(3) document and queues an idempotent send to KSeF. Returns 202 with the submission id.',
      requestBody: { contentType: 'application/json', schema: ksefSubmissionSendSchema },
      responses: [{ status: 202, description: 'Submission queued', schema: sendResponseSchema }],
      errors: [{ status: 400, description: 'Validation failed', schema: errorSchema }],
    },
  },
}
