import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { nbpRateQuerySchema } from '../../../data/validators'
import { fetchNbpMidRate } from '../../../lib/nbp-fx'

export const metadata = {
  // Read-only convenience: fetches a PUBLIC NBP table-A mid-rate for the invoice currency/date.
  // It never reaches tenant data, but the editor affordance still stays behind the financial_pl read gate.
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const okSchema = z.object({
  ok: z.literal(true),
  currency: z.string(),
  rate: z.string(),
  tableDate: z.string(),
})
const failSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['invalid_currency', 'unavailable', 'not_found']),
})
const errorSchema = z.object({ error: z.string() })

/**
 * GET /api/financial_pl/ksef/nbp-rate?currency=<ISO>&date=<YYYY-MM-DD>
 *
 * Resolves the statutory NBP table-A mid-rate for a foreign-currency invoice. Fail-open by design:
 * upstream NBP misses/timeouts return 200 `{ ok:false }` so invoice authoring remains manual.
 * Never reaches a tenant DB.
 */
export async function GET(req: Request) {
  try {
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })

    const url = new URL(req.url)
    const parsed = nbpRateQuerySchema.safeParse({
      currency: url.searchParams.get('currency') ?? '',
      date: url.searchParams.get('date') ?? '',
    })
    if (!parsed.success) {
      throw new CrudHttpError(400, { error: 'A currency and date query parameter are required' })
    }

    try {
      const result = await fetchNbpMidRate(parsed.data.currency, parsed.data.date)
      if (result.ok) return NextResponse.json(result)
      return NextResponse.json({ ok: false, reason: result.reason })
    } catch (err) {
      console.error('[internal] financial_pl.nbp-rate upstream lookup failed', err)
      return NextResponse.json({ ok: false, reason: 'unavailable' })
    }
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.nbp-rate failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Fetch an NBP table-A mid-rate for a foreign-currency invoice',
  methods: {
    GET: {
      summary: 'Autofill the invoice exchange rate from the public NBP API',
      description:
        'Resolves the NBP table-A mid-rate for the last business day before the supplied tax-point date. Fail-open: upstream NBP errors/timeouts return 200 { ok:false, reason } so invoice authoring can continue with manual entry. Reaches no tenant database; requires financial_pl.view.',
      responses: [
        {
          status: 200,
          description: 'NBP rate found (ok:true) or a fail-open miss (ok:false)',
          schema: z.union([okSchema, failSchema]),
        },
      ],
      errors: [
        { status: 400, description: 'Missing or invalid currency/date query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
      ],
    },
  },
}
