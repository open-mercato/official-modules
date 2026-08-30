import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { CommandRuntimeContext, CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../../lib/public-error'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { JpkVatFiling } from '../../../../data/entities'
import { jpkGenerateSchema, type JpkGenerateInput } from '../../../../data/validators'

// Generation WRITES (it persists the encrypted XML and flips the filing status), so it is gated by
// the write feature (`financial_pl.manage`) on POST. Downloading an already-generated filing is a
// pure read gated by `financial_pl.view` on GET — a view-only role can fetch but never generate.
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

const querySchema = z.object({ filingId: z.string().uuid() })

/** Resolve the request's single organization context (access-validated) + tenant, or throw. */
async function resolveScope(req: Request) {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  // A JPK export resolves ONE organization context. Use the request's SELECTED organization —
  // access-validated by resolveOrganizationScopeForRequest — so a super-admin gets their chosen org
  // and a multi-org user the active org. Reads below are scoped to (organizationId, tenantId), so a
  // mismatch yields 404 — a financial read never falls back to a tenant-wide query.
  const organizationId = scope?.selectedId ?? auth.orgId ?? null
  if (!organizationId) throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
  return { container, auth, scope, organizationId, tenantId: auth.tenantId }
}

/**
 * POST ?filingId=<uuid> → { ok, filingId, status }. Runs the JPK generate command (builds the
 * XSD-exact JPK_V7M/V7K XML for the persisted filing and stores it under the encrypted
 * `generated_xml` column, flipping status → 'generated'). A write — gated by `financial_pl.manage`.
 */
export async function POST(req: Request) {
  try {
    const { container, auth, scope, organizationId, tenantId } = await resolveScope(req)
    const url = new URL(req.url)
    const parsed = querySchema.parse({ filingId: url.searchParams.get('filingId') ?? '' })

    // Run the mutation-guard registry around this custom write, like every sibling mutating route
    // (invoice-meta / submissions / certificates), so any registered policy / optimistic-lock /
    // conflict guard for the JPK-filing resource applies to generation too (M7).
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId,
      organizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.jpk_filing',
      resourceId: parsed.filingId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: { filingId: parsed.filingId },
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const ctx: CommandRuntimeContext = {
      container,
      auth,
      organizationScope: scope,
      selectedOrganizationId: organizationId,
      organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
      request: req,
    }
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<JpkGenerateInput, { filingId: string; status: string }>(
      'financial_pl.jpk.generate',
      { input: { filingId: parsed.filingId }, ctx },
    )

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId,
        organizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.jpk_filing',
        resourceId: parsed.filingId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ ok: true, filingId: result?.filingId, status: result?.status }, { status: 200 })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.jpk.generate failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * GET ?filingId=<uuid> → application/xml. Streams the ALREADY-generated JPK XML for the filing as a
 * download; it does NOT generate (POST does). A filing with no generated XML yields 422. The
 * filename encodes the variant + period (e.g. `JPK_V7M_2026-10.xml`). Org/tenant-scoped (404 on
 * mismatch). A pure read — gated by `financial_pl.view`.
 */
export async function GET(req: Request) {
  try {
    const { container, organizationId, tenantId } = await resolveScope(req)
    const url = new URL(req.url)
    const parsed = querySchema.parse({ filingId: url.searchParams.get('filingId') ?? '' })
    const filingId = parsed.filingId

    const em = (container.resolve('em') as EntityManager).fork()
    const filing = await findOneWithDecryption(
      em,
      JpkVatFiling,
      { id: filingId, organizationId, tenantId, deletedAt: null },
      {},
      { organizationId, tenantId },
    )
    if (!filing) throw new CrudHttpError(404, { error: 'Filing not found' })

    const xml = filing.generatedXml ?? null
    if (!xml) throw new CrudHttpError(422, { error: 'Filing has not been generated yet' })

    const period = `${filing.year}-${String(filing.month).padStart(2, '0')}`
    const filename = `JPK_${filing.variant}_${period}.xml`

    return new NextResponse(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    if (isCrudHttpError(err)) return respondPublicError(err)
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    // Never dump the generated XML — log only the error.
    console.error('[internal] financial_pl.jpk export failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const errorSchema = z.object({ error: z.string() })
const generateResponseSchema = z.object({ ok: z.boolean(), filingId: z.string().optional(), status: z.string().optional() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Generate and download a JPK_V7 XML export',
  methods: {
    POST: {
      summary: 'Generate the JPK_V7 XML for a filing',
      description:
        'Runs the JPK generate command for ?filingId=<uuid> (builds the XSD-exact JPK_V7M/V7K XML and stores it on the filing, status → generated). Org/tenant-scoped write — requires financial_pl.manage.',
      responses: [{ status: 200, description: 'Filing generated', schema: generateResponseSchema }],
      errors: [
        { status: 400, description: 'Missing/invalid filingId or unresolved organization scope', schema: errorSchema },
        { status: 404, description: 'Filing not found', schema: errorSchema },
        { status: 409, description: 'Filing is already submitted, or KSeF credentials are missing', schema: errorSchema },
      ],
    },
    GET: {
      summary: 'Download the generated JPK_V7 XML for a filing',
      description:
        'Returns the already-generated JPK_V7 XML for ?filingId=<uuid> as an application/xml attachment named JPK_<variant>_<year>-<month>.xml. Read-only (does not generate) — requires financial_pl.view. POST first to generate.',
      responses: [{ status: 200, description: 'JPK_V7 XML export (application/xml)' }],
      errors: [
        { status: 400, description: 'Missing/invalid filingId or unresolved organization scope', schema: errorSchema },
        { status: 404, description: 'Filing not found', schema: errorSchema },
        { status: 422, description: 'Filing has not been generated yet (POST to generate first)', schema: errorSchema },
      ],
    },
  },
}
