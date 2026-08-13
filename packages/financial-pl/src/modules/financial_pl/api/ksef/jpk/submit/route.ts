import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../lib/public-error'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { jpkSubmitSchema, type JpkSubmitInput } from '../../../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['financial_pl.submit'] },
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })

    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const parsed = jpkSubmitSchema.parse(body)
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.jpk_filing',
      resourceId: parsed.filingId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const ctx: CommandRuntimeContext = {
      container,
      auth,
      organizationScope: scope,
      selectedOrganizationId: organizationId,
      organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
      request: req,
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<
      JpkSubmitInput,
      { filingId: string; status: 'submitted'; referenceNumber: string }
    >('financial_pl.jpk.submit', { input: parsed, ctx })

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.jpk_filing',
        resourceId: parsed.filingId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.jpk.submit failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const submitResponseSchema = z.object({
  filingId: z.string().uuid(),
  status: z.literal('submitted'),
  referenceNumber: z.string(),
})
const errorSchema = z.object({ error: z.string(), code: z.string().optional() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Submit a generated JPK_V7 filing to the MF JPK gateway',
  methods: {
    POST: {
      summary: 'Submit JPK_V7 to MF',
      description:
        'Submits an already-generated JPK_V7 filing to the Ministry of Finance JPK gateway with a dedicated JPK signer credential. The filing is org/tenant-scoped, claimed with a generated-to-submitting transition, and persisted as submitted with its MF reference number and UPO on success.',
      requestBody: { contentType: 'application/json', schema: jpkSubmitSchema },
      responses: [{ status: 200, description: 'JPK filing submitted', schema: submitResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid body or unresolved organization scope', schema: errorSchema },
        { status: 404, description: 'Filing not found', schema: errorSchema },
        { status: 409, description: 'Filing is already submitted or in progress', schema: errorSchema },
        { status: 422, description: 'Filing is not generated, signer is missing, or MF public cert is missing', schema: errorSchema },
        { status: 502, description: 'MF JPK gateway submission failed', schema: errorSchema },
      ],
    },
  },
}
