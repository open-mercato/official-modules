import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { companyLookupQuerySchema } from '../../../data/validators'
import { lookupCompanyByNip } from '../../../lib/company-lookup'

export const metadata = {
  // Read-only convenience: looks a counterparty up in the PUBLIC MF "Wykaz podatników VAT" register
  // by the NIP the operator types. Exposes no tenant data, so the minimal financial_pl read feature
  // is sufficient (unlike the invoice reads, which expose core SalesInvoice business data).
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const companySchema = z.object({
  nip: z.string(),
  name: z.string().nullable(),
  statusVat: z.string().nullable(),
  regon: z.string().nullable(),
  address: z.string().nullable(),
})
const okSchema = z.object({ ok: z.literal(true), company: companySchema })
const failSchema = z.object({ ok: z.literal(false), reason: z.enum(['unavailable', 'not_found']) })
const errorSchema = z.object({ error: z.string() })

/**
 * GET /api/financial_pl/ksef/company-lookup?nip=<nip>
 *
 * Autofills a buyer from the Polish MF "Wykaz podatników VAT" register. Fail-open by design: an
 * invalid-checksum NIP returns 400, but any upstream error/timeout returns 200 `{ ok:false }` so the
 * invoice editor degrades to manual entry instead of failing. Never reaches a tenant DB.
 */
export async function GET(req: Request) {
  try {
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })

    const url = new URL(req.url)
    const parsed = companyLookupQuerySchema.safeParse({ nip: url.searchParams.get('nip') ?? '' })
    if (!parsed.success) throw new CrudHttpError(400, { error: 'A nip query parameter is required' })

    const result = await lookupCompanyByNip(parsed.data.nip)
    if (result.ok) return NextResponse.json(result)
    if (result.reason === 'invalid_nip') {
      return NextResponse.json({ error: 'The NIP is invalid (checksum failed)' }, { status: 400 })
    }
    // unavailable / not_found ⇒ fail-open 200 so the editor shows a non-blocking notice.
    return NextResponse.json({ ok: false, reason: result.reason })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.company-lookup failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Look up a company by NIP in the MF VAT register (Wykaz podatników VAT)',
  methods: {
    GET: {
      summary: 'Autofill a buyer from its NIP via the public MF VAT register',
      description:
        "Resolves a Polish company's registry name + working address + VAT status by NIP from the Ministry of Finance \"Wykaz podatników VAT\" (Biała lista) public register (https://wl-api.mf.gov.pl, no API key). The NIP checksum is validated locally first (400 on failure). Fail-open: any upstream error/timeout returns 200 { ok:false, reason } so invoice authoring never depends on the external service; the bank-account numbers MF returns are intentionally not exposed (white-list verification is out of scope). Reaches no tenant database; requires only financial_pl.view.",
      responses: [
        {
          status: 200,
          description: 'Company found (ok:true) or a fail-open miss (ok:false)',
          schema: z.union([okSchema, failSchema]),
        },
      ],
      errors: [
        { status: 400, description: 'Missing or invalid NIP', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
      ],
    },
  },
}
