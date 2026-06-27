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
import { sendFromCreditMemoSchema, type SendFromCreditMemoInput } from '../../../../data/validators'

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
    const parsed = sendFromCreditMemoSchema.parse(body)
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.ksef_submission',
      resourceId: parsed.creditMemoId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<SendFromCreditMemoInput, { submissionId: string }>(
      'financial_pl.ksef_submission.send_from_credit_memo',
      { input: parsed, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.ksef_submission',
        resourceId: parsed.creditMemoId,
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
        message: translate('financial_pl.actions.sendCorrectionToKsefQueued', 'Correction queued for KSeF submission.'),
      },
      { status: 202 },
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_submission.send_from_credit_memo failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({ ok: z.boolean(), submissionId: z.string().optional(), message: z.string().optional() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Submit a correction (faktura korygująca) to KSeF',
  methods: {
    POST: {
      summary: 'Submit a credit memo to KSeF as an FA(3) correction (KOR)',
      description:
        'Resolves an FA(3) RodzajFaktury=KOR document from a sales credit memo and queues an idempotent KSeF submission. The correction references the corrected original invoice by its KSeF number (or, with originalOutsideKsef=true, the NrKSeFN legacy marker). Amounts are filed as negative differences. Rejected (404) when the credit memo is unknown; (409) when the original invoice is not yet accepted by KSeF or credentials are missing; (422) for currency/VAT-rate/seller/buyer/missing-reason/unknown-original-number.',
      requestBody: { contentType: 'application/json', schema: sendFromCreditMemoSchema },
      responses: [{ status: 202, description: 'Correction queued', schema: okResponseSchema }],
      errors: [
        { status: 404, description: 'Credit memo or original invoice not found', schema: errorSchema },
        { status: 409, description: 'Original not accepted by KSeF / credentials missing', schema: errorSchema },
        {
          status: 422,
          description:
            'Cannot build FA(3) KOR: credit_memo_not_linked / correction_reason_required / correction_lines_required / original_ksef_number_unknown / currency_unsupported / vat_rate_unsupported / seller_required / buyer_required',
          schema: errorSchema,
        },
      ],
    },
  },
}
