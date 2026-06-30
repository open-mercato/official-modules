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
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { batchSendSchema, type BatchSendInput } from '../../../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['financial_pl.submit'] },
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
    const parsed = batchSendSchema.parse(body)
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.ksef_submission',
      resourceId: 'batch',
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<BatchSendInput, { batchReference: string; count: number }>(
      'financial_pl.ksef_submission.send_batch',
      { input: parsed, ctx },
    )

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.ksef_submission',
        resourceId: result?.batchReference ?? 'batch',
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    const { translate } = await resolveTranslations()
    return NextResponse.json(
      {
        ok: true,
        batchReference: result?.batchReference,
        count: result?.count ?? 0,
        message: translate('financial_pl.actions.sendBatchToKsefQueued', 'Batch submitted to KSeF.'),
      },
      { status: 202 },
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_submission.send_batch failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({
  ok: z.boolean(),
  batchReference: z.string().optional(),
  count: z.number(),
  message: z.string().optional(),
})
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Submit a batch of sales invoices to KSeF',
  methods: {
    POST: {
      summary: 'Submit a batch of sales invoices to KSeF',
      description:
        'Builds an encrypted FA(3) batch package for eligible sales invoices, opens a KSeF batch session, uploads the encrypted package part, closes the session, and creates per-invoice processing submissions sharing one batch reference.',
      requestBody: { contentType: 'application/json', schema: batchSendSchema },
      responses: [{ status: 202, description: 'Batch submitted', schema: okResponseSchema }],
      errors: [
        { status: 400, description: 'Validation failed', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 409, description: 'KSeF credentials missing or no eligible invoices', schema: errorSchema },
        { status: 422, description: 'Cannot submit a self-billed invoice in this KSeF context', schema: errorSchema },
        { status: 502, description: 'KSeF authentication, public key, or batch upload failed', schema: errorSchema },
      ],
    },
  },
}
