import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../lib/public-error'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { KsefCertificateInfo } from '../../../lib/ksef-client'
import type { KsefCertificateListInput } from '../../../commands/ksef-certificate'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

export async function GET(req: Request) {
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
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<KsefCertificateListInput, { items: KsefCertificateInfo[] }>(
      'financial_pl.ksef_certificate.list',
      { input: {}, ctx },
    )
    return NextResponse.json({ items: result?.items ?? [] }, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef_certificate.list failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const certificateSchema = z.object({
  certificateSerialNumber: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
})
const listResponseSchema = z.object({ items: z.array(certificateSchema) })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'List KSeF certificates',
  methods: {
    GET: {
      summary: "List the organization's KSeF certificates",
      description:
        "Authenticates with the organization's KSeF certificate credential and lists its KSeF certificates (queryCertificates), org/tenant-scoped. Requires an XAdES-capable certificate credential (409 otherwise).",
      responses: [{ status: 200, description: 'Certificate list', schema: listResponseSchema }],
      errors: [
        { status: 400, description: 'Organization scope unresolved', schema: errorSchema },
        { status: 409, description: 'No certificate credential configured', schema: errorSchema },
      ],
    },
  },
}
