import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { DEFAULT_INVOICE_NUMBER_FORMAT } from '@open-mercato/core/modules/sales/lib/documentNumberTokens'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { InvoiceSettings } from '../../data/entities'
import { findActiveSeries, renderInvoiceNumberTemplate, seriesDocumentKind } from '../../lib/invoice-numbering'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const DEFAULT_SEQUENCE_START = 1

async function peekSequence(em: EntityManager, organizationId: string, tenantId: string, documentKind: string): Promise<number> {
  const rows = await em.getConnection().execute<{ current_value: string }[]>(
    `select current_value from sales_document_sequences
      where organization_id = ? and tenant_id = ? and document_kind = ? limit 1`,
    [organizationId, tenantId, documentKind],
  )
  const current = Number(rows?.[0]?.current_value)
  return Number.isFinite(current) ? current + 1 : DEFAULT_SEQUENCE_START
}

/**
 * Peek the next invoice number WITHOUT consuming it.
 *
 * Core's generator claims a sequence on every call (`current_value + 1`), so calling it just to
 * prefill the create form would burn a number each time the form is opened and abandoned, leaving
 * gaps in a numbering series that must stay continuous. This route only READS the sequence row and
 * renders the template, so the operator can see what they will get before committing to it.
 *
 * With `?seriesId=`, the peek targets that numbering series instead of the system default: its
 * counter lives under the namespaced document kind `invoice:<CODE>` and renders with the series'
 * own format (see `lib/invoice-numbering.ts`). An unknown or deactivated series yields
 * `{ number: null }` — same soft behavior as every other failure of a mere suggestion.
 */
export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) return NextResponse.json({ number: null })

    const em = (container.resolve('em') as EntityManager).fork()
    const seriesId = new URL(req.url).searchParams.get('seriesId')?.trim() || null

    if (seriesId) {
      const settings = await em.findOne(InvoiceSettings, { organizationId, tenantId: auth.tenantId, deletedAt: null })
      const series = findActiveSeries(settings?.numberingSeries, seriesId)
      if (!series) return NextResponse.json({ number: null, seriesId })
      const sequence = await peekSequence(em, organizationId, auth.tenantId, seriesDocumentKind(series.code))
      const number = renderInvoiceNumberTemplate(series.format, sequence, new Date())
      return NextResponse.json({ number, sequence, provisional: true, seriesId, seriesCode: series.code })
    }

    const sequence = await peekSequence(em, organizationId, auth.tenantId, 'invoice')
    const number = renderInvoiceNumberTemplate(DEFAULT_INVOICE_NUMBER_FORMAT, sequence, new Date())
    return NextResponse.json({ number, sequence, provisional: true })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    // A suggestion is not worth failing the form over — the field simply stays empty.
    console.error('[internal] financial_pl.next-invoice-number failed', err)
    return NextResponse.json({ number: null })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Peek the next invoice number',
  methods: {
    GET: {
      summary: 'Next invoice number (provisional)',
      description:
        'Returns the number the next invoice would receive, WITHOUT consuming the sequence. With ?seriesId=, previews the number the given numbering series would assign. Provisional: the authoritative number is assigned when the invoice is saved.',
      responses: [
        {
          status: 200,
          description: 'Provisional number',
          schema: z.object({
            number: z.string().nullable(),
            sequence: z.number().optional(),
            provisional: z.boolean().optional(),
            seriesId: z.string().optional(),
            seriesCode: z.string().optional(),
          }),
        },
      ],
    },
  },
}
