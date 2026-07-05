import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createPrivateKey } from 'node:crypto'
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { KsefSubmission, SalesInvoicePlMeta, type KsefSubmissionStatusColumn } from '../../../data/entities'
import {
  resolveFa3FromSalesInvoice,
  type ResolveFa3QueryEngine,
} from '../../../lib/resolve-fa3-from-invoice'
import { buildFa3Xml, type Fa3Document } from '../../../lib/fa3'
import { buildInvoicePdfModel } from '../../../lib/invoice-pdf-model'
import { renderInvoicePdf } from '../../../lib/invoice-pdf'
import { generateQrPng } from '../../../lib/invoice-qr'
import { buildKodIUrl } from '../../../lib/ksef-qr'
import { buildKodIIUrl, type KsefKodIIAlgorithm } from '../../../lib/ksef-qr-cert'
import { loadInvoiceFontBytes } from '../../../lib/fonts/liberation-sans-regular.font'
import { resolveKsefEnvironment } from '../../../config'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

const querySchema = z.object({ salesInvoiceId: z.string().uuid() })

const VISUALIZATION_NOTICE_DEFAULT =
  'This is a visualization of a structured invoice; the source document is the invoice in KSeF.'

type CredentialsService = {
  getRaw: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<Record<string, unknown> | null>
}

type KsefCredentialDetails = {
  contextNip?: string
  environment?: string
  seller?: { name?: string; addressLine1?: string; addressLine2?: string }
  offlineCertificatePem?: string
  offlineCertificatePrivateKeyPem?: string
  offlineCertificateSerialNumber?: string
}

function credString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function detectKodIIAlgorithm(privateKeyPem: string): KsefKodIIAlgorithm {
  const type = createPrivateKey(privateKeyPem).asymmetricKeyType
  return type === 'ec' ? 'EC' : 'RSA'
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readInvoiceNotes(metadata: unknown): string | undefined {
  const value = metadataRecord(metadata).notes
  if (typeof value !== 'string') return undefined
  const notes = value.trim()
  return notes.length > 0 ? notes : undefined
}

async function readSalesInvoiceNotes(
  queryEngine: ResolveFa3QueryEngine,
  args: { salesInvoiceId: string; organizationId: string; tenantId: string },
): Promise<string | undefined> {
  const queryOptions: Parameters<ResolveFa3QueryEngine['query']>[1] & { fields: string[] } = {
    tenantId: args.tenantId,
    organizationIds: [args.organizationId],
    filters: { id: { $eq: args.salesInvoiceId } },
    fields: ['metadata'],
    page: { page: 1, pageSize: 1 },
  }
  const result = await queryEngine.query<{ metadata?: unknown }>(E.sales.sales_invoice, queryOptions)
  return readInvoiceNotes(result.items?.[0]?.metadata)
}

/**
 * Read the org's stored KSeF credentials (seller identity + environment + context
 * NIP) exactly as the send command does. Never logs the raw credentials; a read
 * failure degrades to an empty detail set (the resolver then fails cleanly on the
 * missing seller, never leaking the credential error).
 */
async function readKsefCredentials(
  container: Awaited<ReturnType<typeof createRequestContainer>>,
  scope: { organizationId: string; tenantId: string },
): Promise<KsefCredentialDetails> {
  try {
    const service = container.resolve('integrationCredentialsService') as CredentialsService
    const creds = await service.getRaw('ksef_pl', scope)
    if (!creds) return {}
    const nipDigits = typeof creds.contextNip === 'string' ? creds.contextNip.replace(/[^0-9]/g, '') : ''
    return {
      contextNip: /^[0-9]{10}$/.test(nipDigits) ? nipDigits : undefined,
      environment: credString(creds.environment),
      seller: {
        name: credString(creds.sellerName),
        addressLine1: credString(creds.sellerAddressLine1),
        addressLine2: credString(creds.sellerAddressLine2),
      },
      offlineCertificatePem: credString(creds.offlineCertificatePem),
      offlineCertificatePrivateKeyPem: credString(creds.offlineCertificatePrivateKeyPem),
      offlineCertificateSerialNumber: credString(creds.offlineCertificateSerialNumber),
    }
  } catch {
    return {}
  }
}

/**
 * GET ?salesInvoiceId=<uuid> → application/pdf. Renders the KSeF invoice
 * visualization (wizualizacja faktury ustrukturyzowanej): the resolved FA(3)
 * model laid out as a Polish Faktura VAT, annotated with the KSeF number + a
 * KOD I verification QR.
 *
 * The KSeF number / status / hashed bytes are sourced from the LATEST ACCEPTED
 * invoice submission so a later rejected re-submission never masks a prior
 * accepted one (which would wrongly show OFFLINE and hash unregistered bytes —
 * a QR that fails verification). When no accepted submission exists the number
 * falls back to SalesInvoicePlMeta.ksef_number, the status to the latest
 * submission's status (else not_applicable), and the QR hashes a freshly built
 * FA(3) XML with an OFFLINE label.
 *
 * Org/tenant-scoped throughout (resolver + submission read). Read-only.
 */
export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })

    const url = new URL(req.url)
    const parsed = querySchema.parse({ salesInvoiceId: url.searchParams.get('salesInvoiceId') ?? '' })
    const salesInvoiceId = parsed.salesInvoiceId

    // A per-invoice PDF needs ONE organization context (its credentials + scoped lookup). Use the
    // request's SELECTED organization — access-validated by resolveOrganizationScopeForRequest, so
    // for a super-admin it is their chosen org (NOT a silent own-org restriction via `??`), and for
    // a multi-org user it is the active org (NOT a wrong `orgIds[0]`). The invoice + credentials
    // queries below are scoped to (organizationId, tenantId), so a mismatch yields 404 — a financial
    // read never falls back to a tenant-wide query that would expose another org's KSeF documents.
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) {
      throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
    }
    const tenantId = auth.tenantId

    const { translate } = await resolveTranslations()
    const credentials = await readKsefCredentials(container, { organizationId, tenantId })
    const queryEngine = container.resolve('queryEngine') as ResolveFa3QueryEngine

    // Resolve the FA(3) payload exactly as the send command does (same deps:
    // queryEngine, credential seller, contextNip, translate). 404 when the
    // invoice is unknown; the resolver's 422 guards (currency/issue-date/VAT
    // mapping/seller/buyer) propagate as CrudHttpError below.
    const invoicePayload = await resolveFa3FromSalesInvoice(
      {
        queryEngine,
        contextNip: credentials.contextNip ?? '',
        translate,
        seller: credentials.seller,
      },
      { salesInvoiceId, organizationId, tenantId },
    )
    const invoiceNotes = await readSalesInvoiceNotes(queryEngine, { salesInvoiceId, organizationId, tenantId })

    // Wrap the validated payload into a Fa3Document (the shape the display model +
    // serializer consume) exactly as buildFa3XmlFromInput does.
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        systemInfo: 'Open Mercato',
        seller: invoicePayload.seller,
        buyer: invoicePayload.buyer,
        invoiceNumber: invoicePayload.invoiceNumber,
        issueDate: invoicePayload.issueDate,
        saleDate: invoicePayload.saleDate,
        currencyCode: invoicePayload.currencyCode,
        invoiceKind: invoicePayload.invoiceKind,
        vatBreakdown: invoicePayload.vatBreakdown,
        totalGross: invoicePayload.totalGross,
        annotations: invoicePayload.annotations,
        correction: invoicePayload.correction,
        // Advanced doc-type blocks (SPEC-009) — keep in sync with buildFa3XmlFromInput so the KOD I
        // hash + the PDF display model match the registered XML for ZAL/ROZ/KOR_ZAL/OSS.
        advancePayments: invoicePayload.advancePayments,
        advanceInvoiceRefs: invoicePayload.advanceInvoiceRefs,
        order: invoicePayload.order,
        selfBilling: invoicePayload.selfBilling,
      },
      lines: invoicePayload.lines,
    }

    const em = (container.resolve('em') as EntityManager).fork()
    const submissionScope = { organizationId, tenantId }

    // LATEST ACCEPTED invoice submission: a later rejected re-submission must not
    // mask a prior accepted one. Decrypts the stored invoice_xml so the KOD I hash
    // is computed over the exact bytes registered in KSeF.
    const acceptedSubmission = await findOneWithDecryption(
      em,
      KsefSubmission,
      {
        organizationId,
        tenantId,
        salesInvoiceId,
        documentKind: 'invoice',
        status: 'accepted',
        deletedAt: null,
      },
      { orderBy: { createdAt: 'desc' } },
      submissionScope,
    )

    let ksefNumber: string | null = null
    let ksefStatus: KsefSubmissionStatusColumn | string = 'not_applicable'
    let registeredXml: string | null = null

    if (acceptedSubmission) {
      ksefNumber = acceptedSubmission.ksefNumber ?? null
      ksefStatus = 'accepted'
      registeredXml = acceptedSubmission.invoiceXml ?? null
    } else {
      // No accepted submission: fall back to the meta KSeF number (if any) and the
      // latest invoice submission's status (else not_applicable). No registered XML.
      const meta = await findOneWithDecryption(
        em,
        SalesInvoicePlMeta,
        {
          organizationId,
          tenantId,
          salesInvoiceId,
          deletedAt: null,
        },
        undefined,
        { organizationId, tenantId },
      )
      const latest = await findOneWithDecryption(
        em,
        KsefSubmission,
        { organizationId, tenantId, salesInvoiceId, documentKind: 'invoice', deletedAt: null },
        { orderBy: { createdAt: 'desc' }, fields: ['status'] },
        { organizationId, tenantId },
      )
      ksefNumber = meta?.ksefNumber ?? null
      ksefStatus = latest?.status ?? 'not_applicable'
    }

    // KOD I verification URL: hash the registered XML when an accepted submission
    // exists, else hash a freshly built FA(3) XML (OFFLINE label). The seller NIP
    // comes from the resolved model (set from the credential context NIP).
    const sellerNip = doc.model.seller.nip ?? credentials.contextNip ?? ''
    // The QR host MUST match the register the invoice was accepted ON — use the
    // accepted submission's stored environment (authoritative), not the org's
    // current credential environment (which may have been switched since). Only the
    // OFFLINE/not-yet-accepted path falls back to the current credential environment.
    const environment = acceptedSubmission?.environment
      ? resolveKsefEnvironment(acceptedSubmission.environment).environment
      : resolveKsefEnvironment(credentials.environment).environment
    const invoiceXmlForQr = registeredXml ?? buildFa3Xml(doc)
    const kodIUrl = buildKodIUrl({
      environment,
      sellerNip,
      issueDate: doc.model.issueDate,
      invoiceXml: invoiceXmlForQr,
    })
    const qrPng = await generateQrPng(kodIUrl)

    let qrIiPng: Uint8Array | undefined
    const isOfflineIssued = ksefStatus === 'offline_issued' && !ksefNumber
    if (
      isOfflineIssued &&
      credentials.offlineCertificatePem &&
      credentials.offlineCertificatePrivateKeyPem &&
      credentials.offlineCertificateSerialNumber
    ) {
      try {
        const kodIIUrl = await buildKodIIUrl({
          environment,
          contextType: 'Nip',
          contextValue: credentials.contextNip ?? sellerNip,
          sellerNip,
          certSerial: credentials.offlineCertificateSerialNumber,
          invoiceXml: invoiceXmlForQr,
          offlineCertificatePrivateKeyPem: credentials.offlineCertificatePrivateKeyPem,
          algorithm: detectKodIIAlgorithm(credentials.offlineCertificatePrivateKeyPem),
        })
        qrIiPng = await generateQrPng(kodIIUrl)
      } catch (err) {
        console.error('[internal] financial_pl.ksef invoice-pdf KOD II failed', err)
      }
    }

    const model = buildInvoicePdfModel(doc, {
      ksefNumber,
      ksefStatus,
      notice: translate('financial_pl.pdf.visualizationNotice', VISUALIZATION_NOTICE_DEFAULT),
      ...(invoiceNotes ? { notes: invoiceNotes } : {}),
      ...(qrIiPng
        ? {
            hasKodII: true,
            qrOfflineLabel: translate('financial_pl.labels.qrOffline', 'OFFLINE'),
            qrCertyfikatLabel: translate('financial_pl.labels.qrCertyfikat', 'CERTYFIKAT'),
          }
        : {}),
    })

    const bytes = await renderInvoicePdf(model, {
      fontBytes: loadInvoiceFontBytes(),
      qrPng,
      ...(qrIiPng ? { qrIiPng } : {}),
    })

    // Sanitize the invoice number for the header filename (strip quotes/control
    // chars/path separators) to prevent Content-Disposition header injection.
    const safeName = (doc.model.invoiceNumber || 'invoice').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120)
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeName}.pdf"`,
      },
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    // Never dump credentials/XML — log only the error.
    console.error('[internal] financial_pl.ksef invoice-pdf failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Download a KSeF invoice PDF visualization',
  methods: {
    GET: {
      summary: 'Download the invoice PDF visualization',
      description:
        'Renders the invoice (?salesInvoiceId=<uuid>) as an application/pdf visualization (wizualizacja faktury ustrukturyzowanej): the resolved FA(3) document laid out as a Polish Faktura VAT, annotated with the KSeF number (or OFFLINE) and a KOD I verification QR. The number/status/hash are sourced from the latest accepted invoice submission (a later rejected re-submission never masks an accepted one); falls back to the PL VAT meta KSeF number with an OFFLINE QR otherwise. Org/tenant-scoped, read-only.',
      responses: [{ status: 200, description: 'Invoice PDF visualization (application/pdf)' }],
      errors: [
        { status: 400, description: 'Missing/invalid salesInvoiceId or unresolved organization scope', schema: errorSchema },
        { status: 404, description: 'Sales invoice not found', schema: errorSchema },
        {
          status: 422,
          description:
            'Cannot build FA(3): document_type_unsupported / currency_unsupported / vat_rate_unsupported / issue_date_required / seller_required / buyer_required',
          schema: errorSchema,
        },
      ],
    },
  },
}
