import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { KsefSubmission } from '../../../../data/entities'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

/**
 * Download the UPO (Urzędowe Poświadczenie Odbioru) — the signed KSeF acceptance
 * receipt and the legally-authoritative proof an invoice was accepted. The receipt
 * is stored encrypted on the KsefSubmission; this route locates the submission in
 * the caller's tenant/org scope first (access + org check), then decrypts the UPO
 * with the row's OWN organization so a multi-org caller still gets the right key.
 */
export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) throw new CrudHttpError(400, { error: '[internal] id is required' })
    // Reject a malformed id up front so a non-UUID never reaches the uuid column query
    // (which would surface as a 500 rather than a clean not-found).
    if (!z.string().uuid().safeParse(id).success) {
      throw new CrudHttpError(404, { error: '[internal] KSeF submission not found' })
    }

    // Honor the org-scope contract exactly: `scope.filterIds === null` is the super-admin
    // ALL-ORGS case (no org filter); `[]` means no accessible org (deny — never widen to a
    // tenant-wide lookup that would leak another org's UPO); `[ids]` restricts. A naive
    // `scope?.filterIds ?? fallback` would wrongly fall the legitimate `null` case through to
    // the auth.orgId fallback and restrict an all-orgs super-admin to a single org (#3481).
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      throw new CrudHttpError(404, { error: '[internal] KSeF submission not found' })
    }
    const accessFilter: Record<string, unknown> = { id, tenantId: auth.tenantId, deletedAt: null }
    if (Array.isArray(orgIds) && orgIds.length > 0) accessFilter.organizationId = { $in: orgIds }

    const em = (container.resolve('em') as EntityManager).fork()
    const located = await em.findOne(KsefSubmission, accessFilter)
    if (!located) throw new CrudHttpError(404, { error: '[internal] KSeF submission not found' })
    // A UPO only exists once KSeF accepted the invoice; never serve a blank/partial
    // receipt for a queued/processing/rejected submission.
    if (located.status !== 'accepted') {
      throw new CrudHttpError(404, { error: '[internal] UPO not available for this submission' })
    }

    // Decrypt with the submission's OWN organization (not the selected one) so the key
    // derivation matches how the receipt was encrypted at submission time.
    const submission = await findOneWithDecryption(
      em.fork(),
      KsefSubmission,
      { id: located.id, organizationId: located.organizationId, tenantId: located.tenantId, deletedAt: null },
      undefined,
      { organizationId: located.organizationId, tenantId: located.tenantId },
    )
    const upoXml = submission?.upoXml ?? null
    if (!upoXml) throw new CrudHttpError(404, { error: '[internal] UPO not available for this submission' })

    const filenameBase = submission?.ksefNumber ?? located.id
    return new NextResponse(upoXml, {
      status: 200,
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="upo-${filenameBase}.xml"`,
      },
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.ksef UPO download failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Download a KSeF UPO acceptance receipt',
  methods: {
    GET: {
      summary: 'Download the UPO XML for a KSeF submission',
      description:
        'Returns the decrypted UPO (signed acceptance receipt) for ?id=<submissionId> as application/xml. 404 when the submission has no UPO yet.',
      responses: [{ status: 200, description: 'UPO XML document' }],
      errors: [
        { status: 400, description: 'Missing id', schema: errorSchema },
        { status: 404, description: 'Submission or UPO not found', schema: errorSchema },
      ],
    },
  },
}
