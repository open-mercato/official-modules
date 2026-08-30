import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../lib/public-error'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { parseIdsParam } from '@open-mercato/shared/lib/crud/ids'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { findAndCountWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { KsefSubmission, type KsefSubmissionStatusColumn } from '../../../data/entities'
import { ksefSubmissionSendSchema, ksefSubmissionListQuerySchema, type KsefSubmissionSendInput } from '../../../data/validators'

const KSEF_SUBMISSION_STATUSES: ReadonlySet<KsefSubmissionStatusColumn> = new Set([
  'not_applicable', 'ready', 'queued', 'processing', 'accepted', 'rejected', 'offline_issued',
])

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  POST: { requireAuth: true, requireFeatures: ['financial_pl.submit'] },
}

function toRow(submission: KsefSubmission) {
  return {
    id: submission.id,
    salesInvoiceId: submission.salesInvoiceId,
    // Expose the discriminator: a correction (credit_memo) row stores salesInvoiceId = the
    // CORRECTED original, so a ?salesInvoiceId= query returns both — clients must distinguish.
    documentKind: submission.documentKind,
    creditMemoId: submission.creditMemoId ?? null,
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
    // Org-scope contract (mirror upo/route.ts): filterIds===null ⇒ super-admin (all orgs in the
    // tenant); filterIds===[] ⇒ no accessible orgs ⇒ return nothing — NEVER drop the org filter,
    // which would leak other orgs' submissions. `??` is wrong here: an empty [] is not nullish, so
    // it would skip the filter, and it also fails to preserve the legitimate null (super-admin) case.
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      return NextResponse.json({ items: [], total: 0, page, pageSize })
    }
    if (Array.isArray(orgIds) && orgIds.length > 0) filter.organizationId = { $in: orgIds }
    const ids = parseIdsParam(url.searchParams.get('ids'))
    if (ids && ids.length > 0) filter.id = { $in: ids }
    // Validate salesInvoiceId as a UUID via the shared list-query schema (L2/L3) — an invalid value
    // returns a clean 400 rather than silently matching zero rows.
    const queryCheck = ksefSubmissionListQuerySchema.safeParse({
      salesInvoiceId: url.searchParams.get('salesInvoiceId') ?? undefined,
    })
    if (!queryCheck.success) throw new CrudHttpError(400, { error: 'Invalid salesInvoiceId (expected a UUID)' })
    if (queryCheck.data.salesInvoiceId) filter.salesInvoiceId = queryCheck.data.salesInvoiceId
    const status = url.searchParams.get('status')
    if (status) {
      // Validate against the known status union rather than blindly casting — an unknown value
      // returns a clean 400 instead of silently matching zero rows.
      if (!KSEF_SUBMISSION_STATUSES.has(status as KsefSubmissionStatusColumn)) {
        throw new CrudHttpError(400, { error: 'Invalid status filter' })
      }
      filter.status = status as KsefSubmissionStatusColumn
    }
    // Discriminator filter. DEFAULTS to 'invoice' so a ?salesInvoiceId= query keeps its
    // pre-correction meaning (invoice submissions only) — a correction stores salesInvoiceId =
    // the corrected original, so without this default an existing invoice-facing client would
    // see a correction's status/number as the original invoice's state (a BC break). Pass
    // documentKind=credit_memo for corrections, or documentKind=all for both.
    const documentKind = url.searchParams.get('documentKind')
    if (documentKind === 'invoice' || documentKind === 'credit_memo') {
      filter.documentKind = documentKind
    } else if (documentKind !== 'all') {
      filter.documentKind = 'invoice'
    }

    const em = (container.resolve('em') as EntityManager).fork()
    // KsefSubmission.invoice_xml / upo_xml are encrypted-at-rest: use the decryption-aware finder
    // (the prescribed convention) even though toRow projects those columns out. Per-row scope drives
    // decryption; (tenantId, orgId) is only a fallback.
    const [rows, total] = await findAndCountWithDecryption(
      em,
      KsefSubmission,
      filter,
      {
        orderBy: { createdAt: 'desc' },
        limit: pageSize,
        offset: (page - 1) * pageSize,
      },
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
    )
    return NextResponse.json({ items: rows.map(toRow), total, page, pageSize })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
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
    if (isCrudHttpError(err)) return respondPublicError(err)
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
      description: 'Returns KSeF submission status rows for the current org/tenant. Supports ?ids=, ?salesInvoiceId=, ?status=, ?documentKind=invoice|credit_memo|all. DEFAULTS to documentKind=invoice (corrections store salesInvoiceId = the corrected original, so the default preserves an invoice-only view); pass documentKind=credit_memo for corrections or documentKind=all for both. Rows expose documentKind/creditMemoId.',
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
