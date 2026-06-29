import type { ApiInterceptor, InterceptorRequest, InterceptorContext } from '@open-mercato/shared/lib/crud/api-interceptor'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { KsefSubmission } from '../data/entities'

/**
 * SPEC-013 — KSeF-immutability guards.
 *
 * A KSeF-accepted invoice is legally immutable (corrections only); an in-flight ('processing')
 * submission must not race a concurrent edit either. A disabled UI button is insufficient — a stale
 * tab, another client, or a raw API call can still mutate. These fail-closed `before` interceptors
 * enforce the rule at the API boundary (§11.4) on the core sales-invoice write routes and on the
 * module's own invoice-meta PUT, with NO core code change (additive, conditional 409 only for
 * KSeF-locked invoices).
 *
 * The interceptors carry no `features` gate: the immutability check must run for every caller
 * regardless of their feature set (a feature gate would let a more-privileged user bypass it).
 */

const LOCKED_STATUSES = ['accepted', 'processing'] as const
const LOCKED_MESSAGE_DEFAULT =
  'This invoice is locked: it has an accepted or in-progress KSeF submission. Issue a correction (KOR) instead of editing it.'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve the target invoice id from the request, mirroring how the core CRUD route identifies its
 * target: a PUT body carries `{ id }`; a DELETE narrows via `?id=` (or a body `{ id }` fallback).
 */
function resolveInvoiceId(request: InterceptorRequest): string | undefined {
  return asString(request.body?.id) ?? asString(request.query?.id)
}

/**
 * True when the invoice has a KSeF submission in `accepted` OR `processing` state for the caller's
 * org/tenant. Reads via `context.em.fork()` (NEVER imports core entities). Only the invoice's OWN
 * submissions (document_kind='invoice'): a correction stores sales_invoice_id = the CORRECTED
 * original, so the discriminator prevents an accepted correction from locking the original.
 */
async function isInvoiceKsefLocked(invoiceId: string, context: InterceptorContext): Promise<boolean> {
  const em = context.em.fork()
  const count = await em.count(KsefSubmission, {
    salesInvoiceId: invoiceId,
    documentKind: 'invoice',
    status: { $in: [...LOCKED_STATUSES] },
    organizationId: context.organizationId,
    tenantId: context.tenantId,
    deletedAt: null,
  })
  return count > 0
}

async function lockedMessage(): Promise<string> {
  try {
    const { translate } = await resolveTranslations()
    return translate('financial_pl.errors.invoice_locked_ksef', LOCKED_MESSAGE_DEFAULT)
  } catch {
    return LOCKED_MESSAGE_DEFAULT
  }
}

async function guard(request: InterceptorRequest, context: InterceptorContext) {
  const invoiceId = resolveInvoiceId(request)
  // No resolvable target id ⇒ nothing to lock against; let the route handle its own validation.
  if (!invoiceId) return { ok: true }
  if (await isInvoiceKsefLocked(invoiceId, context)) {
    return { ok: false as const, statusCode: 409, message: await lockedMessage() }
  }
  return { ok: true }
}

export const interceptors: ApiInterceptor[] = [
  {
    // Core sales-invoice write route: block PUT (edit) / DELETE of a KSeF-locked invoice.
    id: 'financial_pl.ksef-immutability.sales-invoices',
    targetRoute: 'sales/invoices',
    methods: ['PUT', 'DELETE'],
    priority: 100,
    timeoutMs: 2000,
    async before(request, context) {
      return guard(request, context)
    },
  },
  {
    // The module's own PL-VAT metadata PUT: block edits once the invoice is KSeF-locked. The body
    // carries `salesInvoiceId`, so resolve it explicitly rather than the generic `{ id }`.
    id: 'financial_pl.ksef-immutability.invoice-meta',
    targetRoute: 'financial_pl/ksef/invoice-meta',
    methods: ['PUT'],
    priority: 100,
    timeoutMs: 2000,
    async before(request, context) {
      const invoiceId = asString(request.body?.salesInvoiceId)
      if (!invoiceId) return { ok: true }
      if (await isInvoiceKsefLocked(invoiceId, context)) {
        return { ok: false as const, statusCode: 409, message: await lockedMessage() }
      }
      return { ok: true }
    },
  },
]
