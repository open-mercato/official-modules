import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { ksefIssueOfflineSchema, type KsefIssueOfflineInput } from '../../../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const selectedOrganizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!selectedOrganizationId) {
      throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
    }
    const ctx: CommandRuntimeContext = {
      container,
      auth,
      organizationScope: scope,
      selectedOrganizationId,
      organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
      request: req,
    }
    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const parsed = ksefIssueOfflineSchema.parse(body)
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
    const { result } = await commandBus.execute<
      KsefIssueOfflineInput,
      { submissionId: string; status: 'offline_issued'; deadline: string }
    >('financial_pl.ksef_submission.issue_offline', { input: parsed, ctx })
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
    return NextResponse.json(
      {
        submissionId: result?.submissionId,
        status: result?.status ?? 'offline_issued',
        deadline: result?.deadline,
      },
      { status: 202 },
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_submission.issue_offline failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({
  submissionId: z.string().optional(),
  status: z.string(),
  deadline: z.string().optional(),
})
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Issue an invoice offline (offline24 / awaryjny)',
  methods: {
    POST: {
      summary: 'Issue a sales invoice offline and persist it as offline_issued with the statutory deadline',
      description:
        "Issues a sales invoice OUTSIDE KSeF (offline24 — own initiative; awaryjny — MF-announced failure). Builds the byte-stable FA(3) XML, computes KOD I (label OFFLINE) + the cert-signed KOD II, computes the statutory send-to-KSeF deadline, and persists a KsefSubmission with status='offline_issued' and NO KSeF number yet (a worker sends it within the deadline and reconciles the retroactive number). Requires an enrolled, currently-valid Offline certificate. `awaryjny` requires a `failureEndsAt`; `offline24` must not carry one. Org/tenant-scoped.",
      requestBody: { contentType: 'application/json', schema: ksefIssueOfflineSchema },
      responses: [{ status: 202, description: 'Invoice issued offline', schema: okResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid body (incl. offline_mode_invalid) / organization scope unresolved', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 404, description: 'Sales invoice not found', schema: errorSchema },
        { status: 409, description: 'No Offline certificate (offline_certificate_required) or it is invalid (offline_certificate_invalid)', schema: errorSchema },
      ],
    },
  },
}
