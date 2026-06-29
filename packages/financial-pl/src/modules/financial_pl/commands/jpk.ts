import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureTenantScope, ensureOrganizationScope } from '@open-mercato/shared/lib/commands/scope'
import { CrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { PurchaseVatRecord, JpkVatFiling } from '../data/entities'
import {
  jpkPurchaseRecordUpsertSchema,
  jpkPurchaseRecordDeleteSchema,
  jpkFilingUpsertSchema,
  jpkGenerateSchema,
  type JpkPurchaseRecordUpsertInput,
  type JpkFilingUpsertInput,
  type JpkGenerateInput,
} from '../data/validators'
import { buildJpkXml } from '../lib/jpk/build-jpk-xml'
import { resolveJpkFiling, type ResolveJpkQueryEngine } from '../lib/jpk/resolve-jpk-filing'

function resolveCommandScope(ctx: CommandRuntimeContext): { organizationId: string; tenantId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId =
    ctx.selectedOrganizationId ?? ctx.organizationIds?.[0] ?? ctx.auth?.orgId ?? null
  if (!organizationId || !tenantId) {
    throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
  }
  return { organizationId, tenantId }
}

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

export const upsertPurchaseRecordCommand: CommandHandler<JpkPurchaseRecordUpsertInput, { id: string }> = {
  id: 'financial_pl.jpk.upsert_purchase_record',
  async execute(input, ctx) {
    const parsed = jpkPurchaseRecordUpsertSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const now = new Date()

    const fields = {
      contextNip: parsed.contextNip ?? null,
      year: parsed.year,
      month: parsed.month,
      supplierNip: parsed.supplierNip ?? null,
      supplierCountryCode: parsed.supplierCountryCode ?? null,
      supplierName: parsed.supplierName ?? null,
      documentNumber: parsed.documentNumber,
      purchaseDate: parsed.purchaseDate,
      receiptDate: parsed.receiptDate ?? null,
      documentType: parsed.documentType ?? null,
      imp: parsed.imp ?? false,
      ksefMarking: parsed.ksefMarking ?? null,
      nrKsef: parsed.nrKsef ?? null,
      transactionClass: parsed.transactionClass,
      netFixedAssets: parsed.netFixedAssets ?? null,
      vatFixedAssets: parsed.vatFixedAssets ?? null,
      netOther: parsed.netOther ?? null,
      vatOther: parsed.vatOther ?? null,
      corrFixedAssets: parsed.corrFixedAssets ?? null,
      corrOther: parsed.corrOther ?? null,
      corr89b1: parsed.corr89b1 ?? null,
      corr89b4: parsed.corr89b4 ?? null,
      marginGross: parsed.marginGross ?? null,
      selfAssessedNet: parsed.selfAssessedNet ?? null,
      selfAssessedVat: parsed.selfAssessedVat ?? null,
      selfAssessedRate: parsed.selfAssessedRate ?? null,
    }

    if (parsed.id) {
      const existing = await em.findOne(PurchaseVatRecord, {
        id: parsed.id,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
      })
      if (!existing) throw new CrudHttpError(404, { error: '[internal] purchase record not found' })
      Object.assign(existing, fields, { updatedAt: now })
      await em.flush()
      return { id: existing.id }
    }

    const record = em.create(PurchaseVatRecord, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      ...fields,
      createdAt: now,
      updatedAt: now,
    })
    await em.persist(record).flush()
    return { id: record.id }
  },
}

export const deletePurchaseRecordCommand: CommandHandler<{ id: string }, { id: string }> = {
  id: 'financial_pl.jpk.delete_purchase_record',
  async execute(input, ctx) {
    const parsed = jpkPurchaseRecordDeleteSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const existing = await em.findOne(PurchaseVatRecord, {
      id: parsed.id,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    })
    if (!existing) throw new CrudHttpError(404, { error: '[internal] purchase record not found' })
    existing.deletedAt = new Date()
    existing.updatedAt = existing.deletedAt
    await em.flush()
    return { id: existing.id }
  },
}

export const upsertFilingCommand: CommandHandler<JpkFilingUpsertInput, { id: string }> = {
  id: 'financial_pl.jpk.upsert_filing',
  async execute(input, ctx) {
    const parsed = jpkFilingUpsertSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const now = new Date()

    const fields = {
      contextNip: parsed.contextNip ?? null,
      variant: parsed.variant,
      year: parsed.year,
      month: parsed.month,
      quarter: parsed.quarter ?? null,
      celZlozenia: parsed.celZlozenia,
      correctionScope: parsed.correctionScope,
      kodUrzedu: parsed.kodUrzedu ?? null,
      declarationInputs: parsed.declarationInputs ?? null,
    }

    if (parsed.id) {
      const existing = await em.findOne(JpkVatFiling, {
        id: parsed.id,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
      })
      if (!existing) throw new CrudHttpError(404, { error: '[internal] JPK filing not found' })
      Object.assign(existing, fields, { updatedAt: now })
      await em.flush()
      return { id: existing.id }
    }

    const filing = em.create(JpkVatFiling, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      ...fields,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    try {
      await em.persist(filing).flush()
    } catch (err) {
      // The partial unique index rejects a second ACTIVE filing for the same
      // (organization, tenant, contextNip, variant, year, month, celZlozenia) — typically an
      // operator double-submit. Surface a clean 409 (with the existing filing id) instead of a
      // raw 500, so the UI can route to the existing filing.
      if (isUniqueViolation(err, 'financial_pl_jpk_filing_active_unique')) {
        const winner = await em.findOne(JpkVatFiling, {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          contextNip: parsed.contextNip ?? null,
          variant: parsed.variant,
          year: parsed.year,
          month: parsed.month,
          celZlozenia: parsed.celZlozenia,
          deletedAt: null,
        })
        throw new CrudHttpError(409, {
          error: '[internal] a JPK filing already exists for this NIP, variant, period and purpose',
          ...(winner ? { filingId: winner.id } : {}),
        })
      }
      throw err
    }
    return { id: filing.id }
  },
}

export const generateCommand: CommandHandler<JpkGenerateInput, { filingId: string; status: 'generated' }> = {
  id: 'financial_pl.jpk.generate',
  async execute(input, ctx) {
    const parsed = jpkGenerateSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const { translate } = await resolveTranslations()
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const filing = await em.findOne(JpkVatFiling, {
      id: parsed.filingId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    })
    if (!filing) throw new CrudHttpError(404, { error: '[internal] JPK filing not found' })
    // A filing already submitted to the Ministry must not be silently regenerated/clobbered
    // (a terminal state). Fail loud rather than overwrite the filed XML + status.
    if (filing.status === 'submitted') {
      throw new CrudHttpError(409, { error: '[internal] a submitted JPK filing cannot be regenerated' })
    }

    const credentials = await readKsefCredentials(ctx, scope)
    const contextNip = filing.contextNip ?? credentials.contextNip
    if (!contextNip) {
      throw new CrudHttpError(409, {
        error: translate('financial_pl.errors.credentials_missing', 'KSeF credentials are not configured for this organization.'),
      })
    }

    const queryEngine = ctx.container.resolve('queryEngine') as ResolveJpkQueryEngine
    const buildInput = await resolveJpkFiling(
      { queryEngine, em, contextNip, seller: credentials.seller, translate },
      { filing, organizationId: scope.organizationId, tenantId: scope.tenantId },
    )
    const xml = buildJpkXml(buildInput)

    filing.generatedXml = xml
    filing.status = 'generated'
    filing.generatedAt = new Date()
    filing.updatedAt = filing.generatedAt
    await em.flush()

    return { filingId: filing.id, status: 'generated' }
  },
}

registerCommand(upsertPurchaseRecordCommand)
registerCommand(deletePurchaseRecordCommand)
registerCommand(upsertFilingCommand)
registerCommand(generateCommand)
