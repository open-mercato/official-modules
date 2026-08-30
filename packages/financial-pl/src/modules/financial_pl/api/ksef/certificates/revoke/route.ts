import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../lib/public-error'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ksefCertificateRevokeSchema, type KsefCertificateRevokeInput } from '../../../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

const revokeBodySchema = ksefCertificateRevokeSchema
type RevokeInput = KsefCertificateRevokeInput

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
    const parsed = revokeBodySchema.parse(body)
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.ksef_certificate',
      resourceId: parsed.serialNumber,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<RevokeInput, { ok: true }>(
      'financial_pl.ksef_certificate.revoke',
      { input: parsed, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.ksef_certificate',
        resourceId: parsed.serialNumber,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }
    const { translate } = await resolveTranslations()
    return NextResponse.json(
      {
        ok: result?.ok ?? true,
        message: translate('financial_pl.actions.certificateRevoked', 'KSeF certificate revoked.'),
      },
      { status: 200 },
    )
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_certificate.revoke failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({ ok: z.boolean(), message: z.string().optional() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Revoke a KSeF certificate',
  methods: {
    POST: {
      summary: 'Revoke a KSeF certificate by serial number',
      description:
        "Authenticates with the organization's KSeF certificate credential and revokes the given certificate serial (revokeCertificate), org/tenant-scoped. Requires an XAdES-capable certificate credential (409 otherwise).",
      requestBody: { contentType: 'application/json', schema: revokeBodySchema },
      responses: [{ status: 200, description: 'Certificate revoked', schema: okResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid body / organization scope unresolved', schema: errorSchema },
        { status: 409, description: 'No certificate credential configured', schema: errorSchema },
      ],
    },
  },
}
