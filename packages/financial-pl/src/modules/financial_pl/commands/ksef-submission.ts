import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureTenantScope, ensureOrganizationScope } from '@open-mercato/shared/lib/commands/scope'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { CrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { KsefSubmission, type KsefSubmissionStatusColumn } from '../data/entities'
import { createPrivateKey } from 'node:crypto'
import {
  ksefSubmissionSendSchema,
  ksefSubmissionRetrySchema,
  sendFromInvoiceSchema,
  sendFromCreditMemoSchema,
  ksefIssueOfflineSchema,
  ksefRecomputeOfflineDeadlineSchema,
  type KsefSubmissionSendInput,
  type KsefSubmissionRetryInput,
  type SendFromInvoiceInput,
  type SendFromCreditMemoInput,
  type KsefIssueOfflineInput,
  type KsefRecomputeOfflineDeadlineInput,
} from '../data/validators'
import { buildFa3XmlFromInput } from '../lib/build-submission'
import {
  resolveFa3FromSalesInvoice,
  type ResolveFa3QueryEngine,
} from '../lib/resolve-fa3-from-invoice'
import { resolveFa3FromCreditMemo } from '../lib/resolve-fa3-from-credit-memo'
import { emitFinancialPlEvent } from '../events'
import { resolveKsefEnvironment } from '../config'
import { readKsefCredentials as readKsefCredentialsFull } from '../lib/credentials'
import { assertCertificateValidNow, CertificateValidityError } from '../lib/cert-enrollment'
import { buildKodIUrl } from '../lib/ksef-qr'
import { chooseRecovery } from '../lib/recovery'
import { buildKodIIUrl, type KsefKodIIAlgorithm } from '../lib/ksef-qr-cert'
import { computeOfflineSendDeadline } from '../lib/offline-deadline'
import { isInvoiceIssued } from '../lib/invoice-status'

type CredentialsService = {
  getRaw: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<Record<string, unknown> | null>
}

function resolveCommandScope(ctx: CommandRuntimeContext): { organizationId: string; tenantId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId =
    ctx.selectedOrganizationId ?? ctx.organizationIds?.[0] ?? ctx.auth?.orgId ?? null
  if (!organizationId || !tenantId) {
    throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
  }
  return { organizationId, tenantId }
}

type KsefCredentialDetails = {
  contextNip?: string
  environment?: string
  seller?: { name?: string; addressLine1?: string; addressLine2?: string }
}

function credString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

async function readKsefCredentials(
  ctx: CommandRuntimeContext,
  scope: { organizationId: string; tenantId: string },
): Promise<KsefCredentialDetails> {
  try {
    const service = ctx.container.resolve('integrationCredentialsService') as CredentialsService
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
    }
  } catch {
    return {}
  }
}

function requireScope(input: { organizationId?: string; tenantId?: string }): { organizationId: string; tenantId: string } {
  if (!input.organizationId || !input.tenantId) {
    throw new CrudHttpError(400, { error: 'Organization scope is required' })
  }
  return { organizationId: input.organizationId, tenantId: input.tenantId }
}

/**
 * Self-billing (samofakturowanie, art. 106d) is issued by the BUYER on the seller's behalf,
 * so the issuing context NIP must differ from the seller. This connector files EVERY invoice
 * as the authenticated taxpayer (`seller.nip === contextNip` is enforced for online sends, and
 * the offline path resolves the seller from the same credential), so a self-billed flag is
 * contradictory and KSeF rejects it at submission (HTTP 410, "Faktura wystawiana we własnym
 * imieniu nie może posiadać adnotacji 'samofakturowanie'"). Reject at EVERY submit-to-KSeF
 * creation path — online queue (`sendCommand`, the choke point for send/send_from_invoice/
 * send_from_credit_memo) AND offline issuance (`issueOfflineCommand`, whose deferred send via
 * `subscribers/ksef-send-offline.ts` bypasses `sendCommand`) — so a self-billed invoice never
 * reaches KSeF, and an offline invoice is never "issued" with a printed KOD II ahead of that
 * late rejection. Both annotation channels feed FA(3) `P_17`. Storing `self_billing` on PL meta
 * for JPK is unaffected — only SUBMITTING a self-billed invoice as the seller is blocked.
 * External-seller self-billing (relaxing the seller===context invariant + buyer context +
 * delegated permissions) is a separate roadmap item (SPEC-011).
 */
export function assertNotSelfBilled(invoice: {
  selfBilling?: boolean
  annotations?: { selfBilling?: boolean } | null
}): void {
  if (invoice.selfBilling === true || invoice.annotations?.selfBilling === true) {
    throw new CrudHttpError(422, {
      error:
        '[internal] Self-billing (samofakturowanie) requires the issuer to differ from the seller; ' +
        'this connector files invoices as the authenticated seller, so a self-billed invoice cannot be submitted in this configuration.',
      code: 'self_billing_unsupported',
    })
  }
}

export const sendCommand: CommandHandler<KsefSubmissionSendInput, { submissionId: string }> = {
  id: 'financial_pl.ksef_submission.send',
  async execute(input, ctx) {
    const parsed = ksefSubmissionSendSchema.parse(input)
    const scope = requireScope(parsed)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    // The FA(3) seller (Podmiot1) NIP MUST equal the authenticated submission context
    // NIP — including on the direct explicit-payload path. A payload that declares a
    // different or missing seller NIP would authenticate under one taxpayer while filing
    // an invoice for another, which KSeF rejects (and is incorrect data either way).
    if (parsed.invoice.seller.nip !== parsed.contextNip) {
      throw new CrudHttpError(422, {
        error: '[internal] FA(3) seller NIP must match the submission context NIP',
        code: 'seller_nip_mismatch',
      })
    }

    // Self-billing is invalid here (issuer === seller); reject before queueing. See
    // assertNotSelfBilled — applied at every submit-to-KSeF creation path.
    assertNotSelfBilled(parsed.invoice)

    // Defense in depth on the direct explicit-payload path: the submission context NIP
    // must match the org's STORED ksef_pl credential NIP (the NIP the stored token
    // actually belongs to). Fail fast at queue time rather than relying on KSeF auth to
    // reject a token/context mismatch. When no credential is configured the read returns
    // undefined and the check is skipped (the send then fails later on the missing token).
    const stored = await readKsefCredentials(ctx, scope)
    if (stored.contextNip && parsed.contextNip !== stored.contextNip) {
      throw new CrudHttpError(422, {
        error: '[internal] submission context NIP must match the configured KSeF credential NIP',
        code: 'context_nip_mismatch',
      })
    }

    const documentKind = parsed.documentKind ?? 'invoice'
    if (documentKind === 'credit_memo' && !parsed.creditMemoId) {
      throw new CrudHttpError(400, {
        error: '[internal] creditMemoId is required for a credit_memo submission',
        code: 'credit_memo_id_required',
      })
    }
    // document_kind and the FA(3) RodzajFaktury must agree BOTH ways:
    //  - A KOR payload must be a credit_memo submission — else it stores document_kind='invoice'
    //    for the corrected invoice id, dedupes against the original, and bleeds onto invoice reads.
    //  - A credit_memo submission must be a KOR payload — else a normal VAT invoice could set
    //    document_kind='credit_memo' with fresh creditMemoIds and bypass the invoice-scoped
    //    active-unique dedupe, queuing multiple active submissions for the same invoice.
    // Any correction RodzajFaktury (KOR / KOR_ZAL / KOR_ROZ) is a credit-memo payload — gating only
    // on 'KOR' would reject advance/settlement corrections (correction_kind_mismatch) and block
    // them from ever being sent.
    const isKorPayload =
      parsed.invoice.invoiceKind === 'KOR' ||
      parsed.invoice.invoiceKind === 'KOR_ZAL' ||
      parsed.invoice.invoiceKind === 'KOR_ROZ'
    if (isKorPayload !== (documentKind === 'credit_memo')) {
      throw new CrudHttpError(422, {
        error: '[internal] document_kind=credit_memo and FA(3) RodzajFaktury=KOR must be used together',
        code: 'correction_kind_mismatch',
      })
    }

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // Idempotent per SOURCE document — keyed on the credit memo for a correction, else
    // the invoice — and always scoped to document_kind so a correction never matches the
    // corrected invoice's own submission (or vice versa). If one is already in flight
    // (queued/processing) or accepted, return it instead of queuing a second live send.
    // A prior `rejected` submission does NOT block a fresh attempt.
    const activeStatuses: KsefSubmissionStatusColumn[] = ['queued', 'processing', 'accepted']
    const dedupeWhere: FilterQuery<KsefSubmission> =
      documentKind === 'credit_memo'
        ? {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            documentKind: 'credit_memo',
            creditMemoId: parsed.creditMemoId,
            status: { $in: activeStatuses },
            deletedAt: null,
          }
        : {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            documentKind: 'invoice',
            salesInvoiceId: parsed.salesInvoiceId,
            status: { $in: activeStatuses },
            deletedAt: null,
          }
    const existing = await em.findOne(KsefSubmission, dedupeWhere)
    if (existing) return { submissionId: existing.id }

    const invoiceXml = buildFa3XmlFromInput(parsed.invoice)
    const now = new Date()
    const submission = em.create(KsefSubmission, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      salesInvoiceId: parsed.salesInvoiceId,
      documentKind,
      creditMemoId: documentKind === 'credit_memo' ? parsed.creditMemoId ?? null : null,
      environment: parsed.environment ?? resolveKsefEnvironment().environment,
      mode: 'online',
      status: 'queued',
      contextNip: parsed.contextNip,
      invoiceXml,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    try {
      await em.persist(submission).flush()
    } catch (err) {
      // Lost a concurrent insert race: the matching partial unique index (per invoice or
      // per credit memo) rejected this row because a simultaneous request already created
      // an active submission for the same source document. Return the winner.
      const indexName =
        documentKind === 'credit_memo'
          ? 'financial_pl_ksef_submissions_credit_memo_active_unique'
          : 'financial_pl_ksef_submissions_active_unique'
      if (isUniqueViolation(err, indexName)) {
        const winner = await em.findOne(KsefSubmission, dedupeWhere)
        if (winner) return { submissionId: winner.id }
      }
      throw err
    }

    await emitFinancialPlEvent(
      'financial_pl.ksef_submission.queued',
      { submissionId: submission.id, organizationId: scope.organizationId, tenantId: scope.tenantId },
      { persistent: true },
    )
    return { submissionId: submission.id }
  },
}

export const retryCommand: CommandHandler<KsefSubmissionRetryInput, { submissionId: string }> = {
  id: 'financial_pl.ksef_submission.retry',
  async execute(input, ctx) {
    const parsed = ksefSubmissionRetrySchema.parse(input)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const submission = await em.findOne(KsefSubmission, { id: parsed.id, deletedAt: null })
    if (!submission) throw new CrudHttpError(404, { error: '[internal] KSeF submission not found' })
    ensureTenantScope(ctx, submission.tenantId)
    ensureOrganizationScope(ctx, submission.organizationId)
    enforceCommandOptimisticLock({
      resourceKind: 'financial_pl.ksef_submission',
      resourceId: submission.id,
      current: submission.updatedAt,
      request: ctx.request ?? null,
    })
    if (submission.status === 'accepted') {
      throw new CrudHttpError(409, { error: '[internal] submission already accepted' })
    }

    // A 'processing' row that already reached KSeF (both session + invoice references persisted)
    // must be RE-POLLED, not re-sent — resetting it to 'queued' would force an unnecessary re-send
    // (saved from a true duplicate only by KSeF's 440 content-dedup). Mirror the reconcile worker's
    // recovery routing: keep the row 'processing' and emit the repoll event.
    if (submission.status === 'processing' && chooseRecovery(submission) === 'repoll') {
      submission.updatedAt = new Date()
      await em.flush()
      await emitFinancialPlEvent(
        'financial_pl.ksef_submission.repoll_requested',
        { submissionId: submission.id, organizationId: submission.organizationId, tenantId: submission.tenantId },
        { persistent: true },
      )
      return { submissionId: submission.id }
    }

    // Offline-issued (offline24 / awaryjny) submissions retry through the DEFERRED OFFLINE send
    // path — never the online queue — so offlineMode and the statutory send-by deadline are
    // preserved. (A 'processing' offline row that already reached KSeF is routed to repoll above.)
    const isOfflineMode = submission.mode === 'offline24' || submission.mode === 'awaryjny'
    if (isOfflineMode) {
      submission.status = 'offline_issued'
      submission.lastErrorCode = null
      submission.lastErrorMessage = null
      submission.updatedAt = new Date()
      await em.flush()
      await emitFinancialPlEvent(
        'financial_pl.ksef_submission.offline_send_requested',
        { submissionId: submission.id, organizationId: submission.organizationId, tenantId: submission.tenantId },
        { persistent: true },
      )
      return { submissionId: submission.id }
    }

    submission.status = 'queued'
    submission.lastErrorCode = null
    submission.lastErrorMessage = null
    submission.updatedAt = new Date()
    await em.flush()

    await emitFinancialPlEvent(
      'financial_pl.ksef_submission.queued',
      { submissionId: submission.id, organizationId: submission.organizationId, tenantId: submission.tenantId },
      { persistent: true },
    )
    return { submissionId: submission.id }
  },
}

export const sendFromInvoiceCommand: CommandHandler<SendFromInvoiceInput, { submissionId: string }> = {
  id: 'financial_pl.ksef_submission.send_from_invoice',
  async execute(input, ctx) {
    const parsed = sendFromInvoiceSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const queryEngine = ctx.container.resolve('queryEngine') as ResolveFa3QueryEngine
    const invoiceResult = await queryEngine.query<Record<string, unknown>>(E.sales.sales_invoice, {
      tenantId: scope.tenantId,
      organizationIds: [scope.organizationId],
      filters: { id: { $eq: parsed.salesInvoiceId } },
      page: { page: 1, pageSize: 1 },
    })
    const invoice = invoiceResult.items?.[0]
    const { translate } = await resolveTranslations()
    if (!invoice) {
      throw new CrudHttpError(404, { error: '[internal] sales invoice not found' })
    }

    const documentType = typeof invoice.document_type === 'string' ? invoice.document_type : 'vat'
    if (documentType === 'proforma') {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.proforma_not_supported', 'A proforma invoice cannot be submitted to KSeF.'),
      })
    }
    // Core has no `is_immutable` column — an invoice is immutable once its lifecycle status leaves
    // the editable set (draft/void/canceled/…). Mirrors the JPK resolver + credit-memo draft gate.
    if (!isInvoiceIssued(invoice.status)) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.invoice_not_issued', 'Only an issued (immutable) invoice can be submitted to KSeF.'),
      })
    }

    const credentials = await readKsefCredentials(ctx, scope)
    const contextNip = credentials.contextNip
    if (!contextNip) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.credentials_missing', 'KSeF credentials are not configured for this organization.'),
      })
    }

    const invoicePayload = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip, translate, seller: credentials.seller },
      {
        salesInvoiceId: parsed.salesInvoiceId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      },
    )

    return sendCommand.execute(
      {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        salesInvoiceId: parsed.salesInvoiceId,
        contextNip,
        environment: resolveKsefEnvironment(credentials.environment).environment,
        invoice: invoicePayload,
      },
      ctx,
    )
  },
}

export const sendFromCreditMemoCommand: CommandHandler<SendFromCreditMemoInput, { submissionId: string }> = {
  id: 'financial_pl.ksef_submission.send_from_credit_memo',
  async execute(input, ctx) {
    const parsed = sendFromCreditMemoSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const { translate } = await resolveTranslations()
    const queryEngine = ctx.container.resolve('queryEngine') as ResolveFa3QueryEngine

    // Existence check BEFORE the credentials check (mirrors send_from_invoice): an unknown
    // credit memo must return 404, not a 409 credentials_missing, in an org without creds.
    const creditMemoExists = await queryEngine.query<Record<string, unknown>>(E.sales.sales_credit_memo, {
      tenantId: scope.tenantId,
      organizationIds: [scope.organizationId],
      filters: { id: { $eq: parsed.creditMemoId }, deleted_at: { $eq: null } },
      page: { page: 1, pageSize: 1 },
    })
    if (!creditMemoExists.items?.[0]) {
      throw new CrudHttpError(404, { error: '[internal] credit memo not found' })
    }

    const credentials = await readKsefCredentials(ctx, scope)
    const contextNip = credentials.contextNip
    if (!contextNip) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.credentials_missing', 'KSeF credentials are not configured for this organization.'),
      })
    }

    const { invoice, correctedInvoiceId } = await resolveFa3FromCreditMemo(
      { queryEngine, contextNip, translate, seller: credentials.seller },
      {
        creditMemoId: parsed.creditMemoId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        originalOutsideKsef: parsed.originalOutsideKsef,
      },
    )

    return sendCommand.execute(
      {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        // The CORRECTED original invoice id; dedup keys on creditMemoId for corrections.
        salesInvoiceId: correctedInvoiceId,
        documentKind: 'credit_memo',
        creditMemoId: parsed.creditMemoId,
        contextNip,
        environment: resolveKsefEnvironment(credentials.environment).environment,
        invoice,
      },
      ctx,
    )
  },
}

/** Detect the Offline cert key algorithm (RSA-PSS vs ECDSA-P256) from the stored PEM. */
function detectKodIIAlgorithm(privateKeyPem: string): KsefKodIIAlgorithm {
  const type = createPrivateKey(privateKeyPem).asymmetricKeyType
  return type === 'ec' ? 'EC' : 'RSA'
}

/**
 * Issue an invoice OFFLINE (offline24 / awaryjny) — SPEC-010. Builds the byte-stable FA(3)
 * XML now, computes KOD I (labelled OFFLINE) + the cert-signed KOD II, computes the statutory
 * send-to-KSeF deadline, and persists a `KsefSubmission` with `status='offline_issued'` and NO
 * KSeF number yet (the worker sends it within the deadline and reconciles the retroactive
 * number). Requires an enrolled Offline certificate (409 `offline_certificate_required`) that is
 * valid now (409 `offline_certificate_invalid`, jury delta #3). The extended active-unique index
 * prevents a duplicate active row for the same invoice (jury delta #2).
 */
export const issueOfflineCommand: CommandHandler<KsefIssueOfflineInput, { submissionId: string; status: 'offline_issued'; deadline: string }> = {
  id: 'financial_pl.ksef_submission.issue_offline',
  async execute(input, ctx) {
    const parsed = ksefIssueOfflineSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const { translate } = await resolveTranslations()
    const queryEngine = ctx.container.resolve('queryEngine') as ResolveFa3QueryEngine

    // The full credential read surfaces the Offline cert triple (separate from the
    // Authentication credential) + the context NIP + the resolved environment.
    const creds = await readKsefCredentialsFull(
      { resolve: (name) => ctx.container.resolve(name) },
      scope,
    )
    const details = await readKsefCredentials(ctx, scope)
    const contextNip = details.contextNip
    if (!contextNip) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.credentials_missing', 'KSeF credentials are not configured for this organization.'),
      })
    }

    // An Offline cert (PEM + private key) is mandatory: KOD II is signed by it. Without it the
    // invoice cannot carry a verifiable certificate QR, so issuance is refused up front.
    if (!creds.offlineCertificatePem || !creds.offlineCertificatePrivateKeyPem) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.offline_certificate_required', 'An Offline KSeF certificate must be enrolled before issuing an invoice offline.'),
        code: 'offline_certificate_required',
      })
    }

    // Jury delta #3: refuse issuance with an expired / not-yet-valid Offline cert — its KOD II
    // signature would fail KSeF verification and be legally non-compliant.
    try {
      await assertCertificateValidNow(creds.offlineCertificatePem)
    } catch (err) {
      if (err instanceof CertificateValidityError) {
        throw new CrudHttpError(409, {
          error: translate('financial_pl.errors.offline_certificate_invalid', 'The Offline KSeF certificate is expired or not yet valid.'),
          code: 'offline_certificate_invalid',
        })
      }
      throw err
    }

    // Build the byte-stable FA(3) XML from sales (same resolver/builder as the online path).
    const invoicePayload = await resolveFa3FromSalesInvoice(
      { queryEngine, contextNip, translate, seller: details.seller },
      {
        salesInvoiceId: parsed.salesInvoiceId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      },
    )
    // Self-billing is invalid for a self-issued invoice (KSeF 410). Reject BEFORE building the
    // KOD II / persisting an offline_issued row, so an offline invoice is never "issued" (with a
    // printed certificate QR) only to be rejected when the deferred send reaches KSeF.
    assertNotSelfBilled(invoicePayload)
    const invoiceXml = buildFa3XmlFromInput(invoicePayload)

    const environment = resolveKsefEnvironment(creds.environment ?? details.environment).environment
    const sellerNip = invoicePayload.seller.nip ?? contextNip

    // KOD I (label OFFLINE — the QR carries no KSeF number yet) + the cert-signed KOD II.
    const kodIUrl = buildKodIUrl({
      environment,
      sellerNip,
      issueDate: invoicePayload.issueDate,
      invoiceXml,
    })
    const algorithm = detectKodIIAlgorithm(creds.offlineCertificatePrivateKeyPem)
    const kodIiUrl = await buildKodIIUrl({
      environment,
      contextType: 'Nip',
      contextValue: contextNip,
      sellerNip,
      certSerial: creds.offlineCertificateSerialNumber ?? '',
      invoiceXml,
      offlineCertificatePrivateKeyPem: creds.offlineCertificatePrivateKeyPem,
      algorithm,
    })

    const now = new Date()
    const deadline = computeOfflineSendDeadline({
      issuedAt: now,
      mode: parsed.mode,
      failureEndsAt: parsed.failureEndsAt ? new Date(parsed.failureEndsAt) : null,
    })

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // The active-unique index (status in queued/processing/accepted/offline_issued) already
    // blocks a second active row for the same invoice; pre-check so a duplicate returns the
    // existing offline-issued row rather than racing the unique violation.
    const activeStatuses: KsefSubmissionStatusColumn[] = ['queued', 'processing', 'accepted', 'offline_issued']
    const dedupeWhere: FilterQuery<KsefSubmission> = {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      documentKind: 'invoice',
      salesInvoiceId: parsed.salesInvoiceId,
      status: { $in: activeStatuses },
      deletedAt: null,
    }
    const existing = await em.findOne(KsefSubmission, dedupeWhere)
    if (existing) {
      return {
        submissionId: existing.id,
        status: 'offline_issued',
        deadline: (existing.offlineSendDeadlineAt ?? deadline).toISOString(),
      }
    }

    const submission = em.create(KsefSubmission, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      salesInvoiceId: parsed.salesInvoiceId,
      documentKind: 'invoice',
      creditMemoId: null,
      environment,
      mode: parsed.mode,
      status: 'offline_issued',
      contextNip,
      invoiceXml,
      kodIUrl,
      kodIiUrl,
      offlineCertificateSerial: creds.offlineCertificateSerialNumber ?? null,
      offlineIssuedAt: now,
      offlineSendDeadlineAt: deadline,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    try {
      await em.persist(submission).flush()
    } catch (err) {
      if (isUniqueViolation(err, 'financial_pl_ksef_submissions_active_unique')) {
        const winner = await em.findOne(KsefSubmission, dedupeWhere)
        if (winner) {
          return {
            submissionId: winner.id,
            status: 'offline_issued',
            deadline: (winner.offlineSendDeadlineAt ?? deadline).toISOString(),
          }
        }
      }
      throw err
    }

    return { submissionId: submission.id, status: 'offline_issued', deadline: deadline.toISOString() }
  },
}

/**
 * Recompute the offline send deadline for the affected `offline_issued` rows when an MF failure
 * is announced (jury delta #1). The operator supplies the failure-end window; every active
 * offline-issued row in scope (optionally narrowed to one invoice) switches to the awaryjny
 * +7-business-day rule. Never touches a row that already left the offline_issued state.
 */
export const recomputeOfflineDeadlineCommand: CommandHandler<KsefRecomputeOfflineDeadlineInput, { updated: number; deadline: string }> = {
  id: 'financial_pl.ksef_submission.recompute_offline_deadline',
  async execute(input, ctx) {
    const parsed = ksefRecomputeOfflineDeadlineSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const failureEndsAt = new Date(parsed.failureEndsAt)
    // The deadline anchors on the failure end + 7 business days for every affected row, so it is
    // identical across them (issuedAt no longer governs once a failure overtakes offline24).
    const deadline = computeOfflineSendDeadline({
      issuedAt: failureEndsAt,
      mode: 'awaryjny',
      failureEndsAt,
    })

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const where: FilterQuery<KsefSubmission> = {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      status: 'offline_issued',
      deletedAt: null,
      ...(parsed.salesInvoiceId ? { salesInvoiceId: parsed.salesInvoiceId } : {}),
    }
    const updated = await em.nativeUpdate(KsefSubmission, where, {
      offlineSendDeadlineAt: deadline,
      updatedAt: new Date(),
    })

    return { updated, deadline: deadline.toISOString() }
  },
}

registerCommand(sendCommand)
registerCommand(retryCommand)
registerCommand(sendFromInvoiceCommand)
registerCommand(sendFromCreditMemoCommand)
registerCommand(issueOfflineCommand)
registerCommand(recomputeOfflineDeadlineCommand)
