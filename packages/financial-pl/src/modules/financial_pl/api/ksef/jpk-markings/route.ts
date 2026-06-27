import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { KsefSubmission, SalesInvoicePlMeta } from '../../../data/entities'
import { deriveJpkVatMarking } from '../../../lib/jpk-vat-marking'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const MAX_IDS = 100

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const url = new URL(req.url)
    const raw = url.searchParams.get('salesInvoiceId') ?? ''
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const ids = Array.from(
      new Set(
        raw
          .split(',')
          .map((value) => value.trim())
          .filter((value) => uuidRe.test(value)),
      ),
    )
    if (ids.length === 0) {
      throw new CrudHttpError(400, { error: 'salesInvoiceId is required (comma-separated UUIDs)' })
    }
    if (ids.length > MAX_IDS) {
      throw new CrudHttpError(400, { error: `Too many ids (max ${MAX_IDS} per request)` })
    }

    // Require a resolved organization scope (mirrors the invoice-meta route). A financial
    // read must NEVER fall back to an org-unscoped, tenant-wide query — that would expose
    // KSeF state across organizations within the tenant.
    const orgIds = scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null)
    if (!orgIds || orgIds.length === 0) {
      throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
    }
    const em = (container.resolve('em') as EntityManager).fork()
    const baseScope = {
      tenantId: auth.tenantId,
      deletedAt: null,
      organizationId: { $in: orgIds },
    }

    // Single batched read of the latest INVOICE submission per id (no N+1; corrections
    // are excluded via document_kind so they never mislabel the original invoice).
    const submissions = await em.find(
      KsefSubmission,
      { ...baseScope, salesInvoiceId: { $in: ids }, documentKind: 'invoice' },
      { orderBy: { createdAt: 'desc' }, fields: ['salesInvoiceId', 'status', 'ksefNumber', 'mode', 'createdAt'] },
    )
    const submissionByInvoice = new Map<string, (typeof submissions)[number]>()
    for (const submission of submissions) {
      if (!submissionByInvoice.has(submission.salesInvoiceId)) {
        submissionByInvoice.set(submission.salesInvoiceId, submission)
      }
    }

    const metaRows = await em.find(SalesInvoicePlMeta, { ...baseScope, salesInvoiceId: { $in: ids } })
    const metaByInvoice = new Map<string, SalesInvoicePlMeta>()
    for (const row of metaRows) metaByInvoice.set(row.salesInvoiceId, row)

    const items = ids.map((salesInvoiceId) => {
      const submission = submissionByInvoice.get(salesInvoiceId)
      const meta = metaByInvoice.get(salesInvoiceId)
      const result = deriveJpkVatMarking({
        ksefStatus: submission?.status ?? meta?.ksefStatus ?? null,
        ksefNumber: submission?.ksefNumber ?? meta?.ksefNumber ?? null,
        mode: submission?.mode ?? null,
        issuedOutsideKsef: meta?.issuedOutsideKsef ?? false,
      })
      return {
        salesInvoiceId,
        marking: result.marking,
        ksefNumber: result.marking === 'NrKSeF' ? result.ksefNumber ?? null : null,
        pending: result.marking === null,
      }
    })

    return NextResponse.json({ items })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.ksef jpk-markings failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const itemSchema = z.object({
  salesInvoiceId: z.string(),
  marking: z.enum(['NrKSeF', 'OFF', 'BFK', 'DI']).nullable(),
  ksefNumber: z.string().nullable(),
  pending: z.boolean(),
})
const listResponseSchema = z.object({ items: z.array(itemSchema) })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'JPK_VAT KSeF markings',
  methods: {
    GET: {
      summary: 'Resolve JPK_VAT KSeF markings for invoices',
      description:
        'Returns the JPK_V7M/V7K(3) KSeF marking (NrKSeF/OFF/BFK/DI, or pending when undetermined) for up to 100 comma-separated sales invoice ids, org/tenant-scoped. Derived from the latest invoice submission + PL meta; corrections are excluded.',
      responses: [{ status: 200, description: 'Per-invoice markings', schema: listResponseSchema }],
      errors: [{ status: 400, description: 'Missing/too many ids', schema: errorSchema }],
    },
  },
}
