import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { InvoiceSettings } from '../../../data/entities'
import { findActiveSeries, seriesDocumentKind } from '../../../lib/invoice-numbering'

export const metadata = {
  // Claiming advances a counter that becomes an invoice number, so it is gated exactly like the
  // invoice-creating flow that consumes it (same composed gate as the invoice-meta PUT).
  POST: { requireAuth: true, requireFeatures: ['financial_pl.manage', 'sales.invoices.manage'] },
}

const claimSchema = z.object({ seriesId: z.string().trim().min(1).max(64) })

/** The slice of core's `salesDocumentNumberGenerator` this route consumes (structural — the
 *  service is resolved from DI, core does not export its class type for modules). */
type NumberGenerator = {
  generate: (params: {
    kind: string
    format?: string
    organizationId: string
    tenantId: string
  }) => Promise<{ number: string; format: string; sequence: number }>
}

/**
 * Claim the next number from a numbering series — consumes the counter.
 *
 * The counter is core's `sales_document_sequences` row under the namespaced kind
 * `invoice:<CODE>`, incremented by core's own generator in a single atomic upsert, so two
 * operators claiming concurrently get consecutive numbers, never the same one. The caller then
 * passes the returned number to invoice creation as `invoiceNumber`; core's unique index on
 * `(organization, tenant, invoice_number)` backstops anything unexpected.
 *
 * Claim-before-create means a create that fails AFTER claiming leaves a gap in the series. The
 * form minimizes that: it claims only after all client-side validation passes and reuses the
 * claimed number on retry. A rare gap is legally explicable; a duplicate is not — this trade is
 * deliberate.
 */
export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) throw new CrudHttpError(400, { error: 'Select an organization before claiming an invoice number.' })

    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const { seriesId } = claimSchema.parse(body)

    const em = (container.resolve('em') as EntityManager).fork()
    const settings = await em.findOne(InvoiceSettings, { organizationId, tenantId: auth.tenantId, deletedAt: null })
    const series = findActiveSeries(settings?.numberingSeries, seriesId)
    if (!series) {
      // Unknown and deactivated look the same on purpose: neither may mint numbers.
      throw new CrudHttpError(404, { error: 'Numbering series not found or inactive.' })
    }

    const generator = container.resolve('salesDocumentNumberGenerator') as NumberGenerator
    const { number, sequence } = await generator.generate({
      kind: seriesDocumentKind(series.code),
      format: series.format,
      organizationId,
      tenantId: auth.tenantId,
    })
    return NextResponse.json({ number, sequence, seriesId: series.id, seriesCode: series.code })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[internal] financial_pl.next-invoice-number claim failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Claim an invoice number from a series',
  methods: {
    POST: {
      summary: 'Claim the next number from a numbering series',
      description:
        'Atomically consumes the series counter (core sales_document_sequences under document kind invoice:<CODE>) and returns the rendered number to pass to invoice creation as invoiceNumber. Unlike the GET peek, this advances the sequence.',
      requestBody: { contentType: 'application/json', schema: claimSchema },
      responses: [
        {
          status: 200,
          description: 'Claimed number',
          schema: z.object({
            number: z.string(),
            sequence: z.number(),
            seriesId: z.string(),
            seriesCode: z.string(),
          }),
        },
      ],
      errors: [
        { status: 404, description: 'Series not found or inactive', schema: z.object({ error: z.string() }) },
        { status: 400, description: 'Validation failed', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
