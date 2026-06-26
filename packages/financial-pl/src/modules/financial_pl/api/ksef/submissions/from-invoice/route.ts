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
import { sendFromInvoiceSchema, type SendFromInvoiceInput } from '../../../../data/validators'

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
    const parsed = sendFromInvoiceSchema.parse(body)
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
    const { result } = await commandBus.execute<SendFromInvoiceInput, { submissionId: string }>(
      'financial_pl.ksef_submission.send_from_invoice',
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
    const { translate } = await resolveTranslations()
    return NextResponse.json(
      {
        ok: true,
        submissionId: result?.submissionId,
        message: translate('financial_pl.actions.sendToKsefQueued', 'Invoice queued for KSeF submission.'),
      },
      { status: 202 },
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_submission.send_from_invoice failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({ ok: z.boolean(), submissionId: z.string().optional(), message: z.string().optional() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Submit a sales invoice to KSeF',
  methods: {
    POST: {
      summary: 'Submit a sales invoice to KSeF',
      description:
        'Resolves the FA(3) document directly from an issued sales invoice and queues an idempotent KSeF submission. Rejected (409) when the invoice is not yet issued (immutable), is a proforma, or has no KSeF credentials. Rejected (422) when the FA(3) document cannot be faithfully produced: an unsupported document type (correction/advance/final), a non-PLN currency, a VAT rate with no FA(3) mapping, no configured seller identity, or no resolvable buyer.',
      requestBody: { contentType: 'application/json', schema: sendFromInvoiceSchema },
      responses: [{ status: 202, description: 'Submission queued', schema: okResponseSchema }],
      errors: [
        { status: 404, description: 'Invoice not found', schema: errorSchema },
        { status: 409, description: 'Invoice not issued / proforma / credentials missing', schema: errorSchema },
        {
          status: 422,
          description:
            'Cannot build FA(3): document_type_unsupported / currency_unsupported / vat_rate_unsupported / seller_required / buyer_required',
          schema: errorSchema,
        },
      ],
    },
  },
}
