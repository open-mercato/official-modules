import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { respondPublicError } from '../../../lib/public-error'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
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

    // Org-scope contract (mirror submissions/upo): filterIds===null ⇒ super-admin (all orgs in the
    // tenant); filterIds===[] ⇒ no accessible orgs ⇒ deny; [ids] ⇒ restrict to those orgs. `??` is
    // wrong here — it neither preserves the legitimate null (super-admin) case nor denies on [].
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
    }
    const em = (container.resolve('em') as EntityManager).fork()
    const baseScope = {
      tenantId: auth.tenantId,
      deletedAt: null,
      // null ⇒ super-admin: no org filter (tenant-wide). [ids] ⇒ restrict.
      ...(Array.isArray(orgIds) && orgIds.length > 0 ? { organizationId: { $in: orgIds } } : {}),
    }

    // Single batched read of the latest INVOICE submission per id (no N+1; corrections
    // are excluded via document_kind so they never mislabel the original invoice).
    const decryptionScope = {
      tenantId: auth.tenantId,
      organizationId: Array.isArray(orgIds) && orgIds.length === 1 ? orgIds[0] : null,
    }
    const submissions = await findWithDecryption(
      em,
      KsefSubmission,
      { ...baseScope, salesInvoiceId: { $in: ids }, documentKind: 'invoice' },
      { orderBy: { createdAt: 'desc' }, fields: ['salesInvoiceId', 'status', 'ksefNumber', 'mode', 'createdAt'] },
      decryptionScope,
    )
    const submissionByInvoice = new Map<string, (typeof submissions)[number]>()
    for (const submission of submissions) {
      if (!submissionByInvoice.has(submission.salesInvoiceId)) {
        submissionByInvoice.set(submission.salesInvoiceId, submission)
      }
    }

    const metaRows = await findWithDecryption(
      em,
      SalesInvoicePlMeta,
      { ...baseScope, salesInvoiceId: { $in: ids } },
      undefined,
      decryptionScope,
    )
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
    if (isCrudHttpError(err)) return respondPublicError(err)
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
