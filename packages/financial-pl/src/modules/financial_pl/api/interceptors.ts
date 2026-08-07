import type { ApiInterceptor, InterceptorRequest, InterceptorContext } from '@open-mercato/shared/lib/crud/api-interceptor'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { KsefSubmission } from '../data/entities'
import { enrichFinancialPlInvoices } from '../data/enrichers'

/**
 * SPEC-013 — KSeF-immutability guards.
 *
 * A KSeF-accepted or offline-issued invoice is legally immutable (corrections only); an in-flight
 * (`queued`/`processing`) submission must not race a concurrent edit either. A disabled UI button is insufficient — a stale
 * tab, another client, or a raw API call can still mutate. These fail-closed `before` interceptors
 * enforce the rule at the API boundary (§11.4) on the core sales-invoice write routes and on the
 * module's own invoice-meta PUT, with NO core code change (additive, conditional 409 only for
 * KSeF-locked invoices).
 *
 * The interceptors carry no `features` gate: the immutability check must run for every caller
 * regardless of their feature set (a feature gate would let a more-privileged user bypass it).
 */

const LOCKED_STATUSES = ['accepted', 'offline_issued', 'processing', 'queued'] as const
const LOCKED_MESSAGE_DEFAULT =
  'This invoice is locked: it has been issued offline, queued, or submitted to KSeF. Issue a correction (KOR) instead of editing it.'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve the target invoice id from the request, mirroring how the core CRUD route identifies its
 * target: a PUT body carries `{ id }`; a DELETE narrows via `?id=` (or a body `{ id }` fallback).
 */
function resolveInvoiceId(request: InterceptorRequest): string | undefined {
  // The core CRUD route identifies its target a few different ways and the interceptor must catch
  // ALL of them or it fails open:
  //  - PUT carries `{ id }` in the body;
  //  - the command-DELETE path passes ONLY the body (empty for `?id=` deletes);
  //  - the canonical delete sends `DELETE ?id=<uuid>` with an EMPTY body.
  // So fall back from body → parsed query → the raw URL's `?id=` (guarded for relative urls, which
  // would make the URL constructor throw).
  const fromBodyOrQuery = asString(request.body?.id) ?? asString(request.query?.id)
  if (fromBodyOrQuery) return fromBodyOrQuery
  try {
    return asString(new URL(request.url, 'http://internal.local').searchParams.get('id') ?? undefined)
  } catch {
    return undefined
  }
}

/**
 * True when the invoice has a KSeF submission in an immutable or in-flight state within the
 * caller's tenant, independent of the caller's selected organization. Reads via `context.em.fork()`
 * (NEVER imports core entities). Only the invoice's OWN submissions (document_kind='invoice'): a
 * correction stores sales_invoice_id = the CORRECTED original, so the discriminator prevents an
 * accepted correction from locking the original.
 */
async function isInvoiceKsefLocked(invoiceId: string, context: InterceptorContext): Promise<boolean> {
  // Fail closed on missing tenant scope: the org id is deliberately not required nor filtered,
  // because the lock must follow the invoice's org, not the caller's currently selected org.
  if (!asString(context.tenantId)) return true
  const em = context.em.fork()
  const count = await em.count(KsefSubmission, {
    salesInvoiceId: invoiceId,
    documentKind: 'invoice',
    status: { $in: [...LOCKED_STATUSES] },
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
    // Core 0.6.8's new invoice CRUD route declares an index entity but does not opt
    // into response enrichers. Preserve the extension contract at the public API
    // boundary until core activates `enrichers: { entityId }` on that route.
    id: 'financial_pl.ksef-status.sales-invoices',
    targetRoute: 'sales/invoices',
    methods: ['GET'],
    features: ['financial_pl.view'],
    priority: 10,
    timeoutMs: 2000,
    async after(_request, response, context) {
      if (response.statusCode >= 400 || !Array.isArray(response.body.items)) return {}
      const records = response.body.items.filter(
        (item): item is Record<string, unknown> & { id: string } =>
          typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).id === 'string',
      )
      if (records.length !== response.body.items.length) return {}
      try {
        const items = await enrichFinancialPlInvoices(records, context)
        return { replace: { ...response.body, items } }
      } catch {
        // Match the registered enricher's non-critical posture: a status decoration
        // failure must never turn an otherwise-valid core invoice read into a 500.
        return {}
      }
    },
  },
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
