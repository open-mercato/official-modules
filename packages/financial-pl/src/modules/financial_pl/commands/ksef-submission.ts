import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureTenantScope, ensureOrganizationScope } from '@open-mercato/shared/lib/commands/scope'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { CrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import type { ProgressService, ProgressServiceContext } from '@open-mercato/core/modules/progress/lib/progressService'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { KsefSubmission, type KsefSubmissionStatusColumn } from '../data/entities'
import { createPrivateKey, randomUUID } from 'node:crypto'
import {
  ksefSubmissionSendSchema,
  ksefSubmissionRetrySchema,
  sendFromInvoiceSchema,
  sendFromCreditMemoSchema,
  ksefIssueOfflineSchema,
  ksefRecomputeOfflineDeadlineSchema,
  batchSendSchema,
  type KsefSubmissionSendInput,
  type KsefSubmissionRetryInput,
  type SendFromInvoiceInput,
  type SendFromCreditMemoInput,
  type KsefIssueOfflineInput,
  type KsefRecomputeOfflineDeadlineInput,
  type BatchSendInput,
} from '../data/validators'
import { buildFa3XmlFromInput } from '../lib/build-submission'
import {
  resolveFa3FromSalesInvoice,
  type ResolveFa3QueryEngine,
} from '../lib/resolve-fa3-from-invoice'
import { resolveFa3FromCreditMemo } from '../lib/resolve-fa3-from-credit-memo'
import { emitFinancialPlEvent } from '../events'
import { FA3_SCHEMA, resolveKsefEnvironment } from '../config'
import {
  buildKsefAuthConfig,
  readKsefCredentials as readKsefCredentialsFull,
  type ResolverContext,
} from '../lib/credentials'
import { KsefClient, type KsefPublicKeyCertificate, type KsefTransport } from '../lib/ksef-client'
import { authenticate } from '../lib/ksef-auth'
import { assertCertificateValidNow, CertificateValidityError } from '../lib/cert-enrollment'
import { buildKodIUrl } from '../lib/ksef-qr'
import { chooseRecovery, isOfflineSubmissionMode } from '../lib/recovery'
import { buildKodIIUrl, type KsefKodIIAlgorithm } from '../lib/ksef-qr-cert'
import { computeOfflineSendDeadline } from '../lib/offline-deadline'
import { canIssueInvoiceToKsef } from '../lib/invoice-status'
import { buildBatchPackage } from '../lib/batch-package'
import { FINANCIAL_PL_QUEUES, getFinancialPlQueue, type KsefBatchSendJobPayload } from '../lib/queue'

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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const AUTH_POLL = { authMaxAttempts: 20, authDelayMs: 1500, wait } as const

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

function commandResolver(ctx: CommandRuntimeContext): ResolverContext {
  return {
    resolve: <T = unknown>(name: string): T => ctx.container.resolve(name) as T,
  }
}

function resolveOptional<T>(ctx: CommandRuntimeContext, name: string): T | undefined {
  try {
    return ctx.container.resolve(name) as T | undefined
  } catch {
    return undefined
  }
}

function selectCertificate(
  certs: KsefPublicKeyCertificate[],
  usageNeedle: string,
): KsefPublicKeyCertificate | undefined {
  const matches = certs.filter(
    (cert) =>
      cert.certificate.trim().length > 0 &&
      cert.usage.some((usage) => usage.toLowerCase().includes(usageNeedle)),
  )
  return [...matches].sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0]
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
    // An offline-issued row is also active for the same source document: return it under
    // this command's idempotent contract (the deferred offline path will send it), instead
    // of leaking a unique-violation 500.
    // A prior `rejected` submission does NOT block a fresh attempt.
    const activeStatuses: KsefSubmissionStatusColumn[] = ['queued', 'processing', 'accepted', 'offline_issued']
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
    const existing = await findOneWithDecryption(em, KsefSubmission, dedupeWhere, undefined, scope)
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
        const winner = await findOneWithDecryption(em, KsefSubmission, dedupeWhere, undefined, scope)
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
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const submission = await findOneWithDecryption(
      em,
      KsefSubmission,
      {
        id: parsed.id,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
      undefined,
      scope,
    )
    if (!submission) throw new CrudHttpError(404, { error: '[internal] KSeF submission not found' })
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

    // Offline-issued (offline24 / awaryjny / niedostepnosc) submissions retry through the DEFERRED OFFLINE send
    // path — never the online queue — so offlineMode and the statutory send-by deadline are
    // preserved. (A 'processing' offline row that already reached KSeF is routed to repoll above.)
    if (isOfflineSubmissionMode(submission.mode)) {
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
    // The confirmed KSeF action is the issuance transition for a blank/draft core invoice. Creating
    // the queued submission immediately activates the module's server-side immutability guard.
    // Only terminal void/cancel states are ineligible.
    if (!canIssueInvoiceToKsef(invoice.status)) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.invoice_not_issued', 'A canceled or void invoice cannot be submitted to KSeF.'),
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

export const sendBatchCommand: CommandHandler<BatchSendInput, { batchReference: string; count: number }> = {
  id: 'financial_pl.ksef_submission.send_batch',
  async execute(input, ctx) {
    const parsed = batchSendSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const queryEngine = ctx.container.resolve('queryEngine') as ResolveFa3QueryEngine
    const { translate } = await resolveTranslations()

    const details = await readKsefCredentials(ctx, scope)
    const contextNip = details.contextNip
    if (!contextNip) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.credentials_missing', 'KSeF credentials are not configured for this organization.'),
        code: 'ksef_credentials_missing',
      })
    }

    const creds = await readKsefCredentialsFull(commandResolver(ctx), scope)
    const auth = buildKsefAuthConfig(creds, contextNip)
    if (!auth) {
      throw new CrudHttpError(409, {
        error: '[internal] KSeF credentials are not configured for this organization (token or certificate).',
        code: 'ksef_auth_missing',
      })
    }

    const activeStatuses: KsefSubmissionStatusColumn[] = ['queued', 'processing', 'accepted', 'offline_issued']
    const batchInvoices: Array<{ invoiceId: string; fileName: string; xml: string }> = []
    for (const invoiceId of [...new Set(parsed.invoiceIds)]) {
      const invoicePayload = await resolveFa3FromSalesInvoice(
        { queryEngine, contextNip, translate, seller: details.seller },
        {
          salesInvoiceId: invoiceId,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
        },
      )
      assertNotSelfBilled(invoicePayload)
      batchInvoices.push({
        invoiceId,
        fileName: `${invoiceId}.xml`,
        xml: buildFa3XmlFromInput(invoicePayload),
      })
    }

    if (batchInvoices.length === 0) {
      throw new CrudHttpError(409, {
        error: '[internal] no invoices are eligible for a new KSeF batch submission',
        code: 'ksef_batch_no_eligible_invoices',
      })
    }

    const localBatchReference = `local-${randomUUID()}`
    let claimedSubmissions: KsefSubmission[] = []
    try {
      claimedSubmissions = await em.transactional(async (tx) => {
        for (const invoice of batchInvoices) {
          const existing = await findOneWithDecryption(tx, KsefSubmission, {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            documentKind: 'invoice',
            salesInvoiceId: invoice.invoiceId,
            status: { $in: activeStatuses },
            deletedAt: null,
          }, undefined, scope)
          if (existing) {
            throw new CrudHttpError(409, {
              error: '[internal] invoice already has an active KSeF submission',
              code: 'ksef_submission_already_active',
              invoiceId: invoice.invoiceId,
            })
          }
        }

        const now = new Date()
        const submissions = batchInvoices.map((invoice) =>
          tx.create(KsefSubmission, {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            salesInvoiceId: invoice.invoiceId,
            documentKind: 'invoice',
            creditMemoId: null,
            environment: resolveKsefEnvironment(creds.environment ?? details.environment).environment,
            mode: 'batch',
            status: 'queued',
            contextNip,
            invoiceXml: invoice.xml,
            sessionReference: null,
            batchReference: localBatchReference,
            attemptCount: 0,
            submittedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
        )
        await tx.persist(submissions).flush()
        return submissions
      })
    } catch (err) {
      if (isUniqueViolation(err, 'financial_pl_ksef_submissions_active_unique')) {
        throw new CrudHttpError(409, {
          error: '[internal] one or more invoices already have an active KSeF submission',
          code: 'ksef_submission_already_active',
        })
      }
      throw err
    }

    const environmentConfig = resolveKsefEnvironment(creds.environment ?? details.environment)
    const client = new KsefClient(environmentConfig, resolveOptional<KsefTransport>(ctx, 'ksefTransport'))
    const claimedIds = claimedSubmissions.map((submission) => submission.id)
    let referenceNumber: string | undefined

    const batchFailureMessage = (err: unknown): string =>
      err instanceof Error ? `[internal] KSeF batch send failed: ${err.message}` : '[internal] KSeF batch send failed'

    const markClaimedRejected = async (err: unknown) => {
      const now = new Date()
      const update: Partial<KsefSubmission> = {
        status: 'rejected',
        lastErrorCode: 'ksef_batch_send_failed',
        lastErrorMessage: batchFailureMessage(err),
        updatedAt: now,
      }
      await em.nativeUpdate(
        KsefSubmission,
        { id: { $in: claimedIds }, organizationId: scope.organizationId, tenantId: scope.tenantId, deletedAt: null },
        update,
      )
    }

    const keepClaimedProcessing = async (err: unknown, externalReference: string) => {
      const now = new Date()
      await em.nativeUpdate(
        KsefSubmission,
        { id: { $in: claimedIds }, organizationId: scope.organizationId, tenantId: scope.tenantId, deletedAt: null },
        {
          // [internal] Once KSeF has returned a batch reference, upload/close failures are
          // ambiguous: the part or close may have been accepted. Keep the active rows processing
          // so the reconcile worker resumes by session reference instead of freeing the unique
          // guard and allowing the same invoices into a second fiscal batch.
          status: 'processing',
          sessionReference: externalReference,
          batchReference: externalReference,
          submittedAt: now,
          lastErrorCode: 'ksef_batch_send_ambiguous',
          lastErrorMessage: batchFailureMessage(err),
          updatedAt: now,
        },
      )
    }

    try {
      const certs = await client.getPublicKeyCertificates()
      const symmetricCert = selectCertificate(certs, 'symmetric')
      if (!symmetricCert?.certificate) {
        throw new CrudHttpError(502, {
          error: '[internal] KSeF public keys unavailable',
          code: 'ksef_public_keys_unavailable',
        })
      }
      const authResult = await authenticate(client, selectCertificate(certs, 'token'), auth, AUTH_POLL)
      if (!authResult.ok) {
        throw new CrudHttpError(502, { error: authResult.errorMessage, code: 'ksef_auth_failed' })
      }
      const pkg = buildBatchPackage(
        batchInvoices.map((invoice) => ({ fileName: invoice.fileName, xml: invoice.xml })),
        symmetricCert.certificate,
      )
      const session = await client.openBatchSession({
        accessToken: authResult.accessToken,
        formCode: {
          systemCode: FA3_SCHEMA.systemCode,
          schemaVersion: FA3_SCHEMA.schemaVersion,
          value: FA3_SCHEMA.formCode,
        },
        encryption: pkg.encryption,
        batchFile: pkg.batchFile,
        fileParts: pkg.fileParts,
      })
      referenceNumber = session.referenceNumber
      const now = new Date()
      await em.nativeUpdate(
        KsefSubmission,
        { id: { $in: claimedIds }, organizationId: scope.organizationId, tenantId: scope.tenantId, deletedAt: null },
        {
          status: 'processing',
          sessionReference: referenceNumber,
          batchReference: referenceNumber,
          submittedAt: now,
          updatedAt: now,
          attemptCount: 1,
        },
      )
      const uploadRequest = session.partUploadRequests[0]
      if (!uploadRequest) {
        throw new CrudHttpError(502, {
          error: '[internal] KSeF batch session did not return a part upload request',
          code: 'ksef_batch_upload_request_missing',
        })
      }
      await client.uploadBatchPart(uploadRequest, pkg.encryptedZip)
      await client.closeBatchSession({ accessToken: authResult.accessToken, referenceNumber })
    } catch (err) {
      if (referenceNumber) {
        await keepClaimedProcessing(err, referenceNumber)
        throw new CrudHttpError(502, {
          error: batchFailureMessage(err),
          code: 'ksef_batch_send_ambiguous',
          batchReference: referenceNumber,
        })
      }
      await markClaimedRejected(err)
      if (err instanceof CrudHttpError) throw err
      throw new CrudHttpError(502, {
        error: batchFailureMessage(err),
        code: 'ksef_batch_send_failed',
      })
    }

    if (!referenceNumber) {
      throw new CrudHttpError(502, {
        error: '[internal] KSeF batch session did not return a reference number',
        code: 'ksef_batch_reference_missing',
      })
    }
    return { batchReference: referenceNumber, count: claimedSubmissions.length }
  },
}

export const queueBatchCommand: CommandHandler<BatchSendInput, { progressJobId: string; count: number }> = {
  id: 'financial_pl.ksef_submission.queue_batch',
  async execute(input, ctx) {
    const parsed = batchSendSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const invoiceIds = [...new Set(parsed.invoiceIds)]
    const progressService = ctx.container.resolve('progressService') as ProgressService
    const progressContext: ProgressServiceContext = {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      userId: ctx.auth?.sub ?? null,
    }
    const { translate } = await resolveTranslations()
    const progressJob = await progressService.createJob(
      {
        jobType: 'financial_pl.ksef_submission.send_batch',
        name: translate('financial_pl.progress.ksefBatchSend.name', 'Send invoices to KSeF'),
        description: translate(
          'financial_pl.progress.ksefBatchSend.description',
          '{count} invoice(s) queued for KSeF batch send',
          { count: invoiceIds.length },
        ),
        totalCount: invoiceIds.length,
        cancellable: false,
        meta: {
          source: 'financial_pl.ksef_submission.queue_batch',
          invoiceCount: invoiceIds.length,
        },
      },
      progressContext,
    )

    const payload: KsefBatchSendJobPayload = {
      progressJobId: progressJob.id,
      invoiceIds,
      scope: {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        userId: ctx.auth?.sub ?? null,
      },
    }

    try {
      const queue = getFinancialPlQueue(FINANCIAL_PL_QUEUES.ksefBatchSend)
      await queue.enqueue(payload as unknown as Record<string, unknown>)
    } catch (err) {
      await progressService
        .failJob(
          progressJob.id,
          {
            errorMessage:
              err instanceof Error
                ? err.message
                : translate('financial_pl.progress.ksefBatchSend.enqueueFailed', 'Failed to enqueue KSeF batch send'),
          },
          progressContext,
        )
        .catch((failErr) => {
          console.warn('[internal] financial_pl.ksef_submission.queue_batch failed to mark progress job failed', failErr)
        })
      throw err
    }

    return { progressJobId: progressJob.id, count: invoiceIds.length }
  },
}

const SOURCE_NOT_READY_DEFAULT =
  'The correction was created but is not ready to send yet — please retry in a moment.'

/**
 * Projection-lag errors a freshly-created credit memo can transiently raise (QA #41): the memo or
 * its corrected original not yet visible in the eventually-consistent QueryEngine projection, or its
 * `invoice_id` link not yet materialized. These are RETRYABLE; genuine validation errors are not.
 */
export function isCreditMemoProjectionLag(err: unknown): boolean {
  if (!(err instanceof CrudHttpError)) return false
  // Genuine post-existence projection LAG: the memo HEADER is visible (the existence probe in the
  // command passed) but its LINE rows — loaded by a SEPARATE queryEngine projection query
  // (`loadNegatedCreditMemoLines`) — have not materialized yet, so the resolver sees zero lines and
  // raises `correction_lines_required`. That is the one resolver error a freshly-created, form-built
  // correction can transiently hit after its header appears, so it (and only it) is retried and, on
  // exhaustion, surfaced as a client-retryable 409 source_not_ready (QA #41).
  //
  // NOT retried — these are terminal, not lag:
  //  • `credit_memo_not_linked` rides entirely on the header row (invoice_id FK OR
  //    metadata.correctedInvoiceId, BOTH written at creation by buildCreditMemoPayload), so once the
  //    header is visible the link always resolves. Its presence therefore means a genuinely unlinked
  //    memo — a permanent condition that must stay a terminal, actionable 422 ("link it first"),
  //    never a retryable 409 that would loop the operator forever.
  //  • A 404 stays 404 (genuinely-unknown id; the existence probe owns that convergence window and
  //    must not mask an unknown id as "retry later"). TC-KSEF-003 + the OpenAPI contract.
  const code = (err.body as { code?: string } | undefined)?.code
  return err.status === 422 && code === 'correction_lines_required'
}

/**
 * Resolve a freshly-created credit memo tolerating QueryEngine projection lag with bounded retry.
 * On exhaustion raises a PUBLIC `source_not_ready` (409) so the client can safely retry the SAME
 * credit-memo id — the send is idempotent via the `credit_memo` active-unique index + the send
 * command's 23505 race handling — instead of masking the read-after-write race behind a 404 or
 * stranding the operator after an irreversible create (QA #41).
 */
export async function withCreditMemoProjectionRetry<T>(
  fn: () => Promise<T>,
  translate: (key: string, fallback: string) => string,
): Promise<T> {
  const MAX_ATTEMPTS = 5
  const BASE_DELAY_MS = 150
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      if (!isCreditMemoProjectionLag(err) || attempt >= MAX_ATTEMPTS) {
        if (isCreditMemoProjectionLag(err)) {
          throw new CrudHttpError(409, {
            code: 'source_not_ready',
            error: translate('financial_pl.errors.source_not_ready', SOURCE_NOT_READY_DEFAULT),
          })
        }
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** (attempt - 1)))
    }
  }
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
    // Probe the memo's existence with bounded retry: after a fresh create the memo itself can briefly
    // lag the projection, so give it a few attempts to appear. A memo that STILL does not exist is a
    // genuinely-unknown id and stays a 404 (never recoded to source_not_ready) — preserving both the
    // TC-KSEF-003 / OpenAPI 404 contract AND the read-after-write tolerance (QA #41, council). The
    // separate invoice_id-FK lag (memo present, FK null) is what resolveFa3FromCreditMemo's retry
    // converts to a client-retryable 409 source_not_ready below.
    let creditMemoFound = false
    for (let attempt = 1; ; attempt += 1) {
      const creditMemoExists = await queryEngine.query<Record<string, unknown>>(E.sales.sales_credit_memo, {
        tenantId: scope.tenantId,
        organizationIds: [scope.organizationId],
        filters: { id: { $eq: parsed.creditMemoId }, deleted_at: { $eq: null } },
        page: { page: 1, pageSize: 1 },
      })
      if (creditMemoExists.items?.[0]) {
        creditMemoFound = true
        break
      }
      if (attempt >= 5) break
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** (attempt - 1)))
    }
    if (!creditMemoFound) {
      throw new CrudHttpError(404, { error: '[internal] credit memo not found' })
    }

    const credentials = await readKsefCredentials(ctx, scope)
    const contextNip = credentials.contextNip
    if (!contextNip) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.credentials_missing', 'KSeF credentials are not configured for this organization.'),
      })
    }

    const { invoice, correctedInvoiceId } = await withCreditMemoProjectionRetry(
      () =>
        resolveFa3FromCreditMemo(
          { queryEngine, contextNip, translate, seller: credentials.seller },
          {
            creditMemoId: parsed.creditMemoId,
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            originalOutsideKsef: parsed.originalOutsideKsef,
          },
        ),
      translate,
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
 * Issue an invoice OFFLINE (offline24 / awaryjny / niedostepnosc) — SPEC-010/F3. Builds the byte-stable FA(3)
 * XML now, computes KOD I (labelled OFFLINE) + the cert-signed KOD II, computes the statutory
 * send-to-KSeF deadline, and persists a `KsefSubmission` with `status='offline_issued'` and NO
 * KSeF number yet (the worker sends it within the deadline and reconciles the retroactive
 * number). Requires an enrolled Offline certificate (409 `offline_certificate_required`) that is
 * valid now (409 `offline_certificate_invalid`, jury delta #3). The extended active-unique index
 * prevents a duplicate active row for the same invoice (jury delta #2).
 */
// [internal] Total-awaria is represented by issuedOutsideKsef + the JPK BFK marking, not by an OfflineSendMode.
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
      unavailabilityEndsAt: parsed.unavailabilityEndsAt ? new Date(parsed.unavailabilityEndsAt) : null,
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
    const existing = await findOneWithDecryption(em, KsefSubmission, dedupeWhere, undefined, scope)
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
        const winner = await findOneWithDecryption(em, KsefSubmission, dedupeWhere, undefined, scope)
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
registerCommand(sendBatchCommand)
registerCommand(queueBatchCommand)
registerCommand(issueOfflineCommand)
registerCommand(recomputeOfflineDeadlineCommand)
