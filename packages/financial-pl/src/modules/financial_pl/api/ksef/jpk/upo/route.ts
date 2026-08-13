import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../lib/public-error'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { JpkVatFiling } from '../../../../data/entities'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const querySchema = z.object({ filingId: z.string().uuid() })
const errorSchema = z.object({ error: z.string() })

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })

    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })

    const url = new URL(req.url)
    const { filingId } = querySchema.parse({ filingId: url.searchParams.get('filingId') ?? '' })
    const em = (container.resolve('em') as EntityManager).fork()
    const filing = await findOneWithDecryption(
      em,
      JpkVatFiling,
      { id: filingId, organizationId, tenantId: auth.tenantId, deletedAt: null },
      {},
      { organizationId, tenantId: auth.tenantId },
    )
    if (!filing) throw new CrudHttpError(404, { error: 'JPK filing not found' })
    if (filing.status !== 'submitted' || !filing.upoXml) {
      throw new CrudHttpError(404, { error: 'UPO is not available for this JPK filing' })
    }

    const period = `${filing.year}-${String(filing.month).padStart(2, '0')}`
    const reference = filing.submissionReference ? `_${filing.submissionReference}` : ''
    return new NextResponse(filing.upoXml, {
      status: 200,
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="UPO_JPK_${filing.variant}_${period}${reference}.xml"`,
      },
    })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[internal] financial_pl.jpk UPO download failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Download a JPK UPO receipt',
  methods: {
    GET: {
      summary: 'Download the UPO XML for a submitted JPK filing',
      description:
        'Returns the decrypted MF receipt for ?filingId=<uuid> as an application/xml attachment. The filing is restricted to the selected organization and tenant; 404 is returned until an UPO is available.',
      responses: [{ status: 200, description: 'JPK UPO XML document' }],
      errors: [
        { status: 400, description: 'Missing/invalid filingId or organization scope', schema: errorSchema },
        { status: 404, description: 'Filing or UPO not found', schema: errorSchema },
      ],
    },
  },
}
