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
import { ksefCertificateEnrollSchema, type KsefCertificateEnrollInput } from '../../../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

const enrollBodySchema = ksefCertificateEnrollSchema
type EnrollInput = KsefCertificateEnrollInput

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
    const parsed = enrollBodySchema.parse(body)
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.ksef_certificate',
      resourceId: parsed.certificateName,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<EnrollInput, { serial: string; status: 'issued' }>(
      'financial_pl.ksef_certificate.enroll',
      { input: parsed, ctx },
    )
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: ctx.selectedOrganizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.ksef_certificate',
        resourceId: parsed.certificateName,
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
        serial: result?.serial,
        status: result?.status,
        message: translate('financial_pl.actions.certificateEnrolled', 'KSeF certificate enrolled.'),
      },
      { status: 202 },
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_certificate.enroll failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({
  ok: z.boolean(),
  serial: z.string().optional(),
  status: z.string().optional(),
  message: z.string().optional(),
})
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Enroll a KSeF certificate',
  methods: {
    POST: {
      summary: 'Enroll a new KSeF certificate (Authentication or Offline)',
      description:
        "Drives the asynchronous KSeF certificate issuance for the resolved organization (auth -> CSR -> enroll -> poll -> retrieve) and persists the issued certificate + private key (encrypted) + serial into the ksef_pl credentials. `certificateType` selects the cert: 'Authentication' (default) writes the certificatePem/certificatePrivateKeyPem/certificateSerialNumber triple; 'Offline' writes the separate offlineCertificate* triple (KOD II QR signing) without clobbering the Authentication credential. Does NOT change the active authMethod. Never returns the private key. Requires an existing XAdES-capable certificate credential (409 otherwise).",
      requestBody: { contentType: 'application/json', schema: enrollBodySchema },
      responses: [{ status: 202, description: 'Certificate enrolled', schema: okResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid body / organization scope unresolved', schema: errorSchema },
        { status: 409, description: 'No certificate credential configured (certificate_auth_required_for_enrollment)', schema: errorSchema },
        { status: 422, description: 'KSeF certificate enrollment failed (certificate_enrollment_failed)', schema: errorSchema },
        { status: 502, description: 'KSeF certificate authentication failed (certificate_auth_failed)', schema: errorSchema },
      ],
    },
  },
}
