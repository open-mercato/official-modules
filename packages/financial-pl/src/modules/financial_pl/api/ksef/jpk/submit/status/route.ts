import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../../lib/public-error'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { JpkVatFiling } from '../../../../../data/entities'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const querySchema = z
  .object({
    filingId: z.string().uuid().optional(),
    ref: z.string().trim().min(1).max(200).optional(),
  })
  .refine((query) => Boolean(query.filingId) !== Boolean(query.ref), {
    message: 'Provide exactly one of filingId or ref',
  })

const statusResponseSchema = z.object({
  status: z.string(),
  submissionReference: z.string().nullable(),
  submittedAt: z.string().datetime().nullable(),
  upoAvailable: z.boolean(),
})
const errorSchema = z.object({ error: z.string(), code: z.string().optional() })

function toResponse(filing: JpkVatFiling): z.infer<typeof statusResponseSchema> {
  return {
    status: filing.status,
    submissionReference: filing.submissionReference ?? null,
    submittedAt: filing.submittedAt ? filing.submittedAt.toISOString() : null,
    upoAvailable: Boolean(filing.upoXml),
  }
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const url = new URL(req.url)
    const parsed = querySchema.parse({
      filingId: url.searchParams.get('filingId') ?? undefined,
      ref: url.searchParams.get('ref') ?? undefined,
    })

    const filter: FilterQuery<JpkVatFiling> = { tenantId: auth.tenantId, deletedAt: null }
    if (parsed.filingId) filter.id = parsed.filingId
    if (parsed.ref) filter.submissionReference = parsed.ref

    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      throw new CrudHttpError(404, { error: 'JPK filing not found' })
    }
    if (Array.isArray(orgIds) && orgIds.length > 0) filter.organizationId = { $in: orgIds }

    const em = (container.resolve('em') as EntityManager).fork()
    const filing = await findOneWithDecryption(
      em,
      JpkVatFiling,
      filter,
      {},
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
    )
    if (!filing) throw new CrudHttpError(404, { error: 'JPK filing not found' })

    return NextResponse.json(toResponse(filing))
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[internal] financial_pl.jpk submit status failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Read a JPK_V7 MF submission status',
  methods: {
    GET: {
      summary: 'Read JPK_V7 submission status',
      description:
        'Returns the locally persisted MF JPK submission state for a tenant-scoped filing, selected by ?filingId= or ?ref=. The response intentionally exposes only status metadata and whether a UPO is available; it never returns raw UPO XML.',
      query: querySchema,
      responses: [{ status: 200, description: 'JPK submission status', schema: statusResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or invalid filingId/ref query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 404, description: 'Filing not found in scope', schema: errorSchema },
      ],
    },
  },
}
