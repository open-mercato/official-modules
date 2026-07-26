import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { DEFAULT_INVOICE_NUMBER_FORMAT } from '@open-mercato/core/modules/sales/lib/documentNumberTokens'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const DEFAULT_SEQUENCE_START = 1

/**
 * Render the number template. Mirrors the token set core documents in `documentNumberTokens`; the
 * result is shown to the operator as a SUGGESTION only — the authoritative number is produced by
 * core's generator when the invoice is saved, so a template token this renderer does not know is
 * left as-is rather than guessed at.
 */
function renderNumberTemplate(template: string, sequence: number, date: Date): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return template.replace(/\{([a-zA-Z]+)(?::([^}]+))?\}/g, (match, rawToken: string, rawArg?: string) => {
    const token = rawToken.toLowerCase()
    const width = Number((rawArg ?? '').trim())
    switch (token) {
      case 'yyyy':
        return String(date.getFullYear())
      case 'yy':
        return String(date.getFullYear()).slice(-2)
      case 'mm':
        return pad(date.getMonth() + 1, 2)
      case 'dd':
        return pad(date.getDate(), 2)
      case 'seq':
        return pad(sequence, Number.isFinite(width) && width > 0 ? width : 1)
      default:
        return match
    }
  })
}

/**
 * Peek the next invoice number WITHOUT consuming it.
 *
 * Core's generator claims a sequence on every call (`current_value + 1`), so calling it just to
 * prefill the create form would burn a number each time the form is opened and abandoned, leaving
 * gaps in a numbering series that must stay continuous. This route only READS the sequence row and
 * renders the template, so the operator can see what they will get before committing to it.
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
    const rows = await em.getConnection().execute<{ current_value: string }[]>(
      `select current_value from sales_document_sequences
        where organization_id = ? and tenant_id = ? and document_kind = 'invoice' limit 1`,
      [organizationId, auth.tenantId],
    )
    const current = Number(rows?.[0]?.current_value)
    const sequence = Number.isFinite(current) ? current + 1 : DEFAULT_SEQUENCE_START
    const number = renderNumberTemplate(DEFAULT_INVOICE_NUMBER_FORMAT, sequence, new Date())
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
        'Returns the number the next invoice would receive, WITHOUT consuming the sequence. Provisional: the authoritative number is assigned by core when the invoice is saved.',
      responses: [
        {
          status: 200,
          description: 'Provisional number',
          schema: z.object({
            number: z.string().nullable(),
            sequence: z.number().optional(),
            provisional: z.boolean().optional(),
          }),
        },
      ],
    },
  },
}
