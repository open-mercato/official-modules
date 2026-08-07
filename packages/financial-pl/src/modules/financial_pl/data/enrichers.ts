/**
 * KSeF status enricher for sales invoices.
 *
 * Adds a `_financial_pl` namespace ({ ksefStatus, ksefNumber }) to the
 * `sales.sales_invoice` CRUD responses so the invoice list/detail can render the
 * Polish KSeF status without the sales module knowing anything about KSeF. The
 * `SalesInvoicePlMeta` extension row is the canonical source; when no meta row
 * exists yet, the latest `KsefSubmission` for the invoice is used as a fallback.
 *
 * Batched via `enrichMany` ($in) to prevent N+1. `cacheableOnListHit: false`:
 * the enriched value reflects submission/meta state that the sales list cache
 * does not invalidate on, so it MUST re-run on every request.
 */
import type { ResponseEnricher, EnricherContext } from '@open-mercato/shared/lib/crud/response-enricher'
import type { EntityManager } from '@mikro-orm/postgresql'
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { KsefSubmission, SalesInvoicePlMeta } from './entities'
import { deriveJpkVatMarking, type JpkVatMarking } from '../lib/jpk-vat-marking'

type InvoiceRecord = Record<string, unknown> & { id: string }
type EnricherScope = EnricherContext & { em: EntityManager }

type FinancialPlEnrichment = {
  _financial_pl: {
    ksefStatus: string | null
    ksefNumber: string | null
    /** Latest submission id — lets the UI build the UPO download/retry link. */
    submissionId: string | null
    /** Whether the latest submission holds a stored UPO receipt (download available). */
    upoAvailable: boolean
    /**
     * For an offline-issued submission: the statutory send-to-KSeF deadline (ISO
     * string) so the status column can surface it + flag overdue. Null otherwise.
     */
    offlineSendDeadlineAt: string | null
    /** JPK_VAT KSeF marking for this invoice (null while undetermined/in-flight). */
    jpkVatMarking: JpkVatMarking | null
  }
}

const EMPTY: FinancialPlEnrichment['_financial_pl'] = {
  ksefStatus: null,
  ksefNumber: null,
  submissionId: null,
  upoAvailable: false,
  offlineSendDeadlineAt: null,
  jpkVatMarking: null,
}

export async function enrichFinancialPlInvoices(
  records: InvoiceRecord[],
  context: EnricherScope,
): Promise<(InvoiceRecord & FinancialPlEnrichment)[]> {
  if (records.length === 0) return records.map((record) => ({ ...record, _financial_pl: EMPTY }))
  const em = context.em.fork()
  const invoiceIds = records.map((record) => record.id)

  // The latest KsefSubmission per invoice is the source of truth for live KSeF
  // status/number/UPO — the submit subscriber writes the outcome there, NOT onto the
  // SalesInvoicePlMeta row (whose ksef_status stays 'not_applicable' once the MPP /
  // VAT-exemption UI creates it). Project ONLY the plaintext columns we need: the
  // encrypted `invoice_xml`/`upo_xml` are deliberately excluded so the on-load encryption
  // subscriber never decrypts the (potentially large) receipt just to enrich a list.
  // UPO availability is derived from the accepted status (the flow stores the receipt
  // before flipping to 'accepted'), so no encrypted column is read at all.
  // Only the invoice's OWN submissions (document_kind='invoice'): a correction
  // submission stores sales_invoice_id = the CORRECTED original, so without this filter
  // an accepted correction would bleed its status/number/marking onto the original.
  const submissions = await findWithDecryption(
    em,
    KsefSubmission,
    {
      salesInvoiceId: { $in: invoiceIds },
      documentKind: 'invoice',
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      deletedAt: null,
    },
    {
      orderBy: { createdAt: 'desc' },
      fields: ['id', 'salesInvoiceId', 'status', 'ksefNumber', 'mode', 'offlineSendDeadlineAt', 'createdAt'],
    },
    { organizationId: context.organizationId, tenantId: context.tenantId },
  )
  const submissionByInvoice = new Map<string, (typeof submissions)[number]>()
  for (const submission of submissions) {
    if (!submissionByInvoice.has(submission.salesInvoiceId)) {
      submissionByInvoice.set(submission.salesInvoiceId, submission)
    }
  }

  // The meta row is the FALLBACK status/number source when no submission exists yet.
  const metaRows = await findWithDecryption(
    em,
    SalesInvoicePlMeta,
    {
      salesInvoiceId: { $in: invoiceIds },
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      deletedAt: null,
    },
    undefined,
    { organizationId: context.organizationId, tenantId: context.tenantId },
  )
  const metaByInvoice = new Map<string, SalesInvoicePlMeta>()
  for (const row of metaRows) metaByInvoice.set(row.salesInvoiceId, row)

  return records.map((record) => {
    const submission = submissionByInvoice.get(record.id)
    const meta = metaByInvoice.get(record.id)
    const ksefStatus = submission?.status ?? meta?.ksefStatus ?? null
    const ksefNumber = submission?.ksefNumber ?? meta?.ksefNumber ?? null
    const marking = deriveJpkVatMarking({
      ksefStatus,
      ksefNumber,
      mode: submission?.mode ?? null,
      issuedOutsideKsef: meta?.issuedOutsideKsef ?? false,
    })
    return {
      ...record,
      _financial_pl: {
        ksefStatus,
        ksefNumber,
        submissionId: submission?.id ?? null,
        // Accepted ⟺ a stored UPO (finalizeAccepted only flips to 'accepted' after the
        // receipt is persisted), so this is an accurate, decryption-free availability flag.
        upoAvailable: submission?.status === 'accepted',
        offlineSendDeadlineAt: submission?.offlineSendDeadlineAt
          ? submission.offlineSendDeadlineAt.toISOString()
          : null,
        jpkVatMarking: marking.marking,
      },
    }
  })
}

const ksefInvoiceStatusEnricher: ResponseEnricher<InvoiceRecord, FinancialPlEnrichment> = {
  id: 'financial_pl.ksef-invoice-status',
  targetEntity: E.sales.sales_invoice,
  features: ['financial_pl.view'],
  priority: 10,
  timeout: 1000,
  critical: false,
  cacheableOnListHit: false,
  fallback: { _financial_pl: EMPTY },

  async enrichOne(record, context) {
    const enriched = await enrichFinancialPlInvoices([record], context as EnricherScope)
    return enriched[0]
  },

  async enrichMany(records, context) {
    return enrichFinancialPlInvoices(records, context as EnricherScope)
  },
}

export const enrichers: ResponseEnricher[] = [ksefInvoiceStatusEnricher]
