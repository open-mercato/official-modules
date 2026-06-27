import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { SalesInvoicePlMeta } from '../../../data/entities'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  PUT: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const url = new URL(req.url)
    const salesInvoiceId = url.searchParams.get('salesInvoiceId')
    if (!salesInvoiceId) throw new CrudHttpError(400, { error: '[internal] salesInvoiceId is required' })

    const filter: Record<string, unknown> = {
      tenantId: auth.tenantId,
      salesInvoiceId,
      deletedAt: null,
    }
    const orgIds = scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null)
    if (orgIds && orgIds.length > 0) filter.organizationId = { $in: orgIds }

    const em = (container.resolve('em') as EntityManager).fork()
    const record = await em.findOne(SalesInvoicePlMeta, filter)
    return NextResponse.json({
      item: record
        ? {
            id: record.id,
            salesInvoiceId: record.salesInvoiceId,
            contextNip: record.contextNip ?? null,
            mppRequired: record.mppRequired,
            issuedOutsideKsef: record.issuedOutsideKsef,
            vatExemptionBasis: record.vatExemptionBasis ?? null,
            ksefStatus: record.ksefStatus,
            ksefNumber: record.ksefNumber ?? null,
            updatedAt: record.updatedAt ?? null,
          }
        : null,
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.invoice_meta read failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const invoiceMetaPutSchema = z.object({
  salesInvoiceId: z.string().uuid(),
  contextNip: z
    .string()
    .regex(/^[0-9]{10}$/)
    .nullish(),
  mppRequired: z.boolean().optional(),
  vatExemptionBasis: z.string().max(500).nullish(),
  /** Mark the invoice as lawfully issued outside KSeF (drives the JPK_VAT `BFK` marking). */
  issuedOutsideKsef: z.boolean().optional(),
})

export async function PUT(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })

    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const parsed = invoiceMetaPutSchema.parse(body)

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.invoice_meta',
      resourceId: parsed.salesInvoiceId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const em = (container.resolve('em') as EntityManager).fork()
    const existing = await em.findOne(SalesInvoicePlMeta, {
      organizationId,
      tenantId: auth.tenantId,
      salesInvoiceId: parsed.salesInvoiceId,
      deletedAt: null,
    })

    // Optimistic lock on the existing meta row (additive — a request without the
    // header is a no-op; a stale edit gets the structured 409). Skipped on first
    // create when no row exists yet.
    if (existing) {
      enforceCommandOptimisticLock({
        resourceKind: 'financial_pl.invoice_meta',
        resourceId: parsed.salesInvoiceId,
        current: existing.updatedAt ?? null,
        request: req,
      })
    }

    const now = new Date()
    const record =
      existing ??
      em.create(SalesInvoicePlMeta, {
        organizationId,
        tenantId: auth.tenantId,
        salesInvoiceId: parsed.salesInvoiceId,
        ksefStatus: 'not_applicable',
        mppRequired: false,
        issuedOutsideKsef: false,
        createdAt: now,
        updatedAt: now,
      })
    if (parsed.contextNip !== undefined) record.contextNip = parsed.contextNip ?? null
    if (parsed.mppRequired !== undefined) record.mppRequired = parsed.mppRequired
    if (parsed.vatExemptionBasis !== undefined) record.vatExemptionBasis = parsed.vatExemptionBasis ?? null
    if (parsed.issuedOutsideKsef !== undefined) record.issuedOutsideKsef = parsed.issuedOutsideKsef
    record.updatedAt = now
    if (!existing) em.persist(record)
    await em.flush()

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.invoice_meta',
        resourceId: parsed.salesInvoiceId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({
      ok: true,
      item: {
        id: record.id,
        salesInvoiceId: record.salesInvoiceId,
        contextNip: record.contextNip ?? null,
        mppRequired: record.mppRequired,
        issuedOutsideKsef: record.issuedOutsideKsef,
        vatExemptionBasis: record.vatExemptionBasis ?? null,
        ksefStatus: record.ksefStatus,
        ksefNumber: record.ksefNumber ?? null,
        updatedAt: record.updatedAt ?? null,
      },
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.invoice_meta upsert failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({ ok: z.boolean(), item: z.object({}).loose() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Upsert Polish invoice metadata',
  methods: {
    GET: {
      summary: 'Read Polish statutory metadata for a sales invoice',
      description: 'Returns the SalesInvoicePlMeta row for ?salesInvoiceId=, or null when none exists yet.',
      responses: [{ status: 200, description: 'Metadata (or null)', schema: z.object({ item: z.object({}).loose().nullable() }) }],
    },
    PUT: {
      summary: 'Upsert Polish statutory metadata for a sales invoice',
      description: 'Creates or updates the SalesInvoicePlMeta row (context NIP, MPP flag, VAT exemption basis) for a sales invoice.',
      requestBody: { contentType: 'application/json', schema: invoiceMetaPutSchema },
      responses: [{ status: 200, description: 'Metadata saved', schema: okResponseSchema }],
      errors: [{ status: 400, description: 'Validation failed', schema: errorSchema }],
    },
  },
}
