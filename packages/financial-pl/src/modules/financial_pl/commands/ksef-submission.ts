import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureTenantScope, ensureOrganizationScope } from '@open-mercato/shared/lib/commands/scope'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { CrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import type { EntityManager } from '@mikro-orm/postgresql'
import { KsefSubmission } from '../data/entities'
import {
  ksefSubmissionSendSchema,
  ksefSubmissionRetrySchema,
  sendFromInvoiceSchema,
  type KsefSubmissionSendInput,
  type KsefSubmissionRetryInput,
  type SendFromInvoiceInput,
} from '../data/validators'
import { buildFa3XmlFromInput } from '../lib/build-submission'
import {
  resolveFa3FromSalesInvoice,
  type ResolveFa3QueryEngine,
} from '../lib/resolve-fa3-from-invoice'
import { emitFinancialPlEvent } from '../events'
import { resolveKsefEnvironment } from '../config'

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

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // Idempotent per invoice: if a submission for this invoice is already in
    // flight (queued/processing) or already accepted, return it instead of
    // queuing a second live send. A prior `rejected` submission does NOT block a
    // fresh attempt (re-submission after fixing the invoice is allowed).
    const existing = await em.findOne(KsefSubmission, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      salesInvoiceId: parsed.salesInvoiceId,
      status: { $in: ['queued', 'processing', 'accepted'] },
      deletedAt: null,
    })
    if (existing) return { submissionId: existing.id }

    const invoiceXml = buildFa3XmlFromInput(parsed.invoice)
    const now = new Date()
    const submission = em.create(KsefSubmission, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      salesInvoiceId: parsed.salesInvoiceId,
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
      // Lost a concurrent insert race: the partial unique index
      // (financial_pl_ksef_submissions_active_unique) rejected this row because a
      // simultaneous request already created an active submission for this invoice.
      // Return the winner rather than queuing a second live send.
      if (isUniqueViolation(err, 'financial_pl_ksef_submissions_active_unique')) {
        const winner = await em.findOne(KsefSubmission, {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          salesInvoiceId: parsed.salesInvoiceId,
          status: { $in: ['queued', 'processing', 'accepted'] },
          deletedAt: null,
        })
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
    if (invoice.is_immutable !== true) {
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

registerCommand(sendCommand)
registerCommand(retryCommand)
registerCommand(sendFromInvoiceCommand)
