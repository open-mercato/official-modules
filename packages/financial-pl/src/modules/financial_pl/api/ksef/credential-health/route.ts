import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../lib/public-error'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { assessCredentialHealth } from '../../../lib/credential-health'
import { readKsefCredentials } from '../../../lib/credentials'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) {
      throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
    }

    const credentials = await readKsefCredentials(container, { organizationId, tenantId: auth.tenantId })
    const health = assessCredentialHealth({
      ksefToken: credentials.ksefToken ?? null,
      authCertPem: credentials.certificatePem ?? null,
      offlineCertPem: credentials.offlineCertificatePem ?? null,
    })

    return NextResponse.json(health, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    console.error('[internal] financial_pl.credential_health failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const tokenHealthSchema = z.object({
  present: z.boolean(),
  sunsetDate: z.string(),
  daysToSunset: z.number().nullable(),
})
const certificateHealthSchema = z.object({
  present: z.boolean(),
  notAfter: z.string().nullable(),
  daysToExpiry: z.number().nullable(),
  expiringSoon: z.boolean(),
})
const healthResponseSchema = z.object({
  token: tokenHealthSchema,
  authCert: certificateHealthSchema,
  offlineCert: certificateHealthSchema,
  warnings: z.array(z.string()),
})
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Report KSeF credential health',
  methods: {
    GET: {
      summary: 'Return token sunset and certificate expiry health',
      description:
        'Reads the organization-scoped ksef_pl credentials server-side and returns only token/certificate presence, expiry dates, day counts, and warning codes. Raw tokens, certificates, and private keys are never returned.',
      responses: [{ status: 200, description: 'Credential health summary', schema: healthResponseSchema }],
      errors: [
        { status: 400, description: 'Organization scope unresolved', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
      ],
    },
  },
}
