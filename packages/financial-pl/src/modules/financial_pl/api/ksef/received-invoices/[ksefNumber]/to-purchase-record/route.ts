import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../../lib/public-error'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

type RouteProps = { params: { ksefNumber?: string } }
type MaterializePurchaseRecordInput = { ksefNumber: string }

const paramSchema = z.object({ ksefNumber: z.string().min(1) })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

export async function POST(req: Request, props: RouteProps) {
  try {
    const parsed = paramSchema.parse({ ksefNumber: props.params.ksefNumber })
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

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.received_invoice',
      resourceId: parsed.ksefNumber,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<MaterializePurchaseRecordInput, { purchaseRecordId: string }>(
      'financial_pl.ksef_receive.materialize_purchase_record',
      { input: parsed, ctx },
    )

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.received_invoice',
        resourceId: parsed.ksefNumber,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ purchaseRecordId: result?.purchaseRecordId }, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_receive.materialize_purchase_record failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const responseSchema = z.object({ purchaseRecordId: z.string().optional() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Materialize received invoice as a purchase VAT record',
  methods: {
    POST: {
      summary: 'Create a purchase VAT record from a received invoice',
      description:
        'Idempotently links the received KSeF invoice to a JPK purchase VAT record, downloading the FA(3) XML first when it is not already stored.',
      responses: [{ status: 200, description: 'Purchase record id', schema: responseSchema }],
      errors: [
        { status: 404, description: 'Received invoice not found', schema: errorSchema },
        { status: 422, description: 'Received invoice cannot be materialized', schema: errorSchema },
      ],
    },
  },
}
