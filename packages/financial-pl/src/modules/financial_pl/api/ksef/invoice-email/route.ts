import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveDefaultEmailFromAddress } from '@open-mercato/shared/lib/email/config'
import { ksefInvoiceEmailSchema } from '../../../data/validators'

// Sending an invoice PDF to a customer is a view-level action (the same actor can already download
// that PDF via invoice-pdf) — gate on `financial_pl.view`.
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * POST { salesInvoiceId, to, subject, message? } → emails the invoice PDF to a recipient.
 *
 * SKELETON: auth, org scope, feature gate and body validation are enforced now; the actual PDF
 * render + attachment + delivery is intentionally not wired yet. Delivery needs a configured
 * transport (Resend + a default From address) which this environment does not have, so the route
 * fails fast with a typed `EMAIL_NOT_CONFIGURED` result the UI surfaces as an informational message.
 * The `TODO(email)` block below is the single place to add render-and-send once transport exists.
 */
export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) {
      throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
    }

    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const parsed = ksefInvoiceEmailSchema.parse(body)

    // Deliverability gate — mirrors @open-mercato/shared/lib/email/send: no transport / delivery
    // switched off ⇒ report as not-configured rather than pretending the mail was sent.
    const deliveryDisabled = isTruthyEnv(process.env.OM_DISABLE_EMAIL_DELIVERY) || isTruthyEnv(process.env.OM_TEST_MODE)
    const fromAddress = resolveDefaultEmailFromAddress()
    if (deliveryDisabled || !fromAddress) {
      return NextResponse.json(
        {
          ok: false,
          code: 'EMAIL_NOT_CONFIGURED',
          error: 'Email delivery is not configured in this environment.',
        },
        { status: 503 },
      )
    }

    // TODO(email): render the invoice PDF (buildInvoicePdfModel + renderInvoicePdf, org/tenant-scoped
    // to `organizationId`/`auth.tenantId`), attach it, render a MessageEmail-style body, and call
    // sendEmail({ to: parsed.to, subject: parsed.subject, react, from: fromAddress, attachments }).
    return NextResponse.json(
      {
        ok: false,
        code: 'EMAIL_SEND_NOT_IMPLEMENTED',
        error: 'Invoice email delivery is not implemented yet.',
      },
      { status: 501 },
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef invoice-email failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const resultSchema = z.object({ ok: z.boolean(), code: z.string().optional(), error: z.string().optional() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Email an invoice PDF to a recipient',
  methods: {
    POST: {
      summary: 'Send the invoice PDF visualization to an email recipient',
      description:
        'Emails the invoice PDF (wizualizacja faktury ustrukturyzowanej) to a chosen recipient. SKELETON: validates the request and enforces auth/feature/org scope; returns EMAIL_NOT_CONFIGURED when no email transport is available in the environment, and EMAIL_SEND_NOT_IMPLEMENTED until render-and-send is wired.',
      requestBody: { contentType: 'application/json', schema: ksefInvoiceEmailSchema },
      responses: [
        { status: 200, description: 'Invoice email queued', schema: resultSchema },
        { status: 501, description: 'Delivery not implemented yet', schema: resultSchema },
        { status: 503, description: 'Email transport not configured', schema: resultSchema },
      ],
    },
  },
}
