import { LockMode } from '@mikro-orm/core'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureTenantScope, ensureOrganizationScope } from '@open-mercato/shared/lib/commands/scope'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { PurchaseVatRecord, JpkVatFiling } from '../data/entities'
import {
  jpkPurchaseRecordUpsertSchema,
  jpkPurchaseRecordDeleteSchema,
  jpkFilingUpsertSchema,
  jpkGenerateSchema,
  jpkSubmitSchema,
  type JpkPurchaseRecordUpsertInput,
  type JpkFilingUpsertInput,
  type JpkGenerateInput,
} from '../data/validators'
import { resolveKsefEnvironment } from '../config'
import { readKsefCredentials as readSharedKsefCredentials } from '../lib/credentials'
import { buildJpkXml } from '../lib/jpk/build-jpk-xml'
import { resolveJpkFiling, type ResolveJpkQueryEngine } from '../lib/jpk/resolve-jpk-filing'
import { submitJpk } from '../lib/jpk/jpk-submission-client'

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

type RuntimeJpkFilingStatus = JpkVatFiling['status'] | 'submitting'
const JPK_SUBMITTING_STATUS = 'submitting' as JpkVatFiling['status']

function runtimeJpkStatus(filing: JpkVatFiling): RuntimeJpkFilingStatus {
  return filing.status as RuntimeJpkFilingStatus
}

function setJpkFilingStatus(filing: JpkVatFiling, status: RuntimeJpkFilingStatus): void {
  filing.status = status as JpkVatFiling['status']
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

// --- Undo snapshots (M8) ----------------------------------------------------------------------
// The JPK CRUD commands are reversible: create → soft-delete the created row; update → restore the
// captured before-fields; delete → clear deleted_at. The snapshot rides on the command result and
// is persisted to the action log via buildLog so the bus can replay it through undo().
type JpkUndoSnapshot = {
  kind: 'purchase_record' | 'filing'
  op: 'create' | 'update' | 'delete'
  id: string
  tenantId: string
  organizationId: string
  before?: Record<string, unknown>
}

function jpkBuildLog(resourceKind: string, undo: JpkUndoSnapshot) {
  return { resourceKind, resourceId: undo.id, tenantId: undo.tenantId, organizationId: undo.organizationId, payload: { undo } }
}

function readJpkUndo(logEntry: unknown): JpkUndoSnapshot | null {
  const payload = extractUndoPayload(logEntry as never) as JpkUndoSnapshot | null
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.id !== 'string' || typeof payload.tenantId !== 'string' || typeof payload.organizationId !== 'string') {
    return null
  }
  return payload
}

/** Capture the current value of the mutated columns on an entity (for an update undo). */
function snapshotFields(entity: object, keys: string[]): Record<string, unknown> {
  const view = entity as unknown as Record<string, unknown>
  const before: Record<string, unknown> = {}
  for (const key of keys) before[key] = view[key]
  return before
}

export const upsertPurchaseRecordCommand: CommandHandler<JpkPurchaseRecordUpsertInput, { id: string; undo: JpkUndoSnapshot }> = {
  id: 'financial_pl.jpk.upsert_purchase_record',
  isUndoable: true,
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
      const before = snapshotFields(existing, Object.keys(fields))
      Object.assign(existing, fields, { updatedAt: now })
      await em.flush()
      return {
        id: existing.id,
        undo: { kind: 'purchase_record', op: 'update', id: existing.id, tenantId: scope.tenantId, organizationId: scope.organizationId, before },
      }
    }

    const record = em.create(PurchaseVatRecord, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      ...fields,
      createdAt: now,
      updatedAt: now,
    })
    await em.persist(record).flush()
    return {
      id: record.id,
      undo: { kind: 'purchase_record', op: 'create', id: record.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    }
  },
  async buildLog({ result }) {
    return jpkBuildLog('financial_pl.jpk_purchase_record', result.undo)
  },
  async undo({ ctx, logEntry }) {
    const snap = readJpkUndo(logEntry)
    if (!snap || snap.kind !== 'purchase_record') return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await em.findOne(PurchaseVatRecord, { id: snap.id, tenantId: snap.tenantId, organizationId: snap.organizationId })
    if (!record) return
    if (snap.op === 'create') {
      record.deletedAt = new Date()
      record.updatedAt = record.deletedAt
    } else if (snap.op === 'update' && snap.before) {
      Object.assign(record, snap.before, { updatedAt: new Date() })
    }
    await em.flush()
  },
}

export const deletePurchaseRecordCommand: CommandHandler<{ id: string }, { id: string; undo: JpkUndoSnapshot }> = {
  id: 'financial_pl.jpk.delete_purchase_record',
  isUndoable: true,
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
    return {
      id: existing.id,
      undo: { kind: 'purchase_record', op: 'delete', id: existing.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    }
  },
  async buildLog({ result }) {
    return jpkBuildLog('financial_pl.jpk_purchase_record', result.undo)
  },
  async undo({ ctx, logEntry }) {
    const snap = readJpkUndo(logEntry)
    if (!snap || snap.kind !== 'purchase_record' || snap.op !== 'delete') return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await em.findOne(PurchaseVatRecord, { id: snap.id, tenantId: snap.tenantId, organizationId: snap.organizationId })
    if (!record) return
    record.deletedAt = null
    record.updatedAt = new Date()
    await em.flush()
  },
}

export const upsertFilingCommand: CommandHandler<JpkFilingUpsertInput, { id: string; undo: JpkUndoSnapshot }> = {
  id: 'financial_pl.jpk.upsert_filing',
  isUndoable: true,
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
      const before = snapshotFields(existing, Object.keys(fields))
      Object.assign(existing, fields, { updatedAt: now })
      await em.flush()
      return {
        id: existing.id,
        undo: { kind: 'filing', op: 'update', id: existing.id, tenantId: scope.tenantId, organizationId: scope.organizationId, before },
      }
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
    return {
      id: filing.id,
      undo: { kind: 'filing', op: 'create', id: filing.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    }
  },
  async buildLog({ result }) {
    return jpkBuildLog('financial_pl.jpk_filing', result.undo)
  },
  async undo({ ctx, logEntry }) {
    const snap = readJpkUndo(logEntry)
    if (!snap || snap.kind !== 'filing') return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const filing = await em.findOne(JpkVatFiling, { id: snap.id, tenantId: snap.tenantId, organizationId: snap.organizationId })
    if (!filing) return
    if (snap.op === 'create') {
      filing.deletedAt = new Date()
      filing.updatedAt = filing.deletedAt
    } else if (snap.op === 'update' && snap.before) {
      Object.assign(filing, snap.before, { updatedAt: new Date() })
    }
    await em.flush()
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

type ClaimedJpkSubmission = {
  filingId: string
  generatedXml: string
}

export const submitFilingCommand: CommandHandler<
  { filingId: string },
  { filingId: string; status: 'submitted'; referenceNumber: string }
> = {
  id: 'financial_pl.jpk.submit',
  async execute(input, ctx) {
    const parsed = jpkSubmitSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const credentials = await readSharedKsefCredentials(ctx.container, scope)
    if (!credentials.jpkSignerCertPem || !credentials.jpkSignerPrivateKeyPem) {
      throw new CrudHttpError(422, { error: 'JPK signer credential not configured', code: 'jpk_signer_missing' })
    }
    const mfPublicCertPem = credString(process.env.OM_JPK_MF_CERT_PEM)
    if (!mfPublicCertPem) {
      throw new CrudHttpError(422, {
        error: 'MF JPK public certificate is not configured',
        code: 'jpk_mf_cert_missing',
      })
    }

    const environment = resolveKsefEnvironment(credentials.environment).environment
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const claimed = await em.transactional(async (tx: EntityManager): Promise<ClaimedJpkSubmission> => {
      const filing = await findOneWithDecryption(
        tx,
        JpkVatFiling,
        {
          id: parsed.filingId,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          deletedAt: null,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!filing) throw new CrudHttpError(404, { error: '[internal] JPK filing not found' })

      const currentStatus = runtimeJpkStatus(filing)
      if (currentStatus === 'submitted' || currentStatus === 'submitting') {
        throw new CrudHttpError(409, {
          error: '[internal] JPK filing is already submitted or in progress',
          code: 'jpk_already_submitted_or_in_progress',
        })
      }
      if (currentStatus !== 'generated' || !filing.generatedXml) {
        throw new CrudHttpError(422, { error: '[internal] JPK filing has not been generated', code: 'jpk_not_generated' })
      }

      const now = new Date()
      const updated = await tx.nativeUpdate(
        JpkVatFiling,
        {
          id: filing.id,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          deletedAt: null,
          status: 'generated',
        },
        { status: JPK_SUBMITTING_STATUS, submissionError: null, updatedAt: now },
      )
      if (updated !== 1) {
        throw new CrudHttpError(409, {
          error: '[internal] JPK filing is already submitted or in progress',
          code: 'jpk_already_submitted_or_in_progress',
        })
      }

      return { filingId: filing.id, generatedXml: filing.generatedXml }
    })

    const result = await submitJpk(claimed.generatedXml, {
      environment,
      signer: {
        certificatePem: credentials.jpkSignerCertPem,
        privateKeyPem: credentials.jpkSignerPrivateKeyPem,
      },
      mfPublicCertPem,
    })

    if (result.ok) {
      const submittedAt = new Date()
      await em.transactional(async (tx: EntityManager) => {
        const filing = await findOneWithDecryption(
          tx,
          JpkVatFiling,
          {
            id: claimed.filingId,
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            deletedAt: null,
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
          scope,
        )
        if (!filing) throw new CrudHttpError(404, { error: '[internal] JPK filing not found' })
        filing.submissionReference = result.referenceNumber
        filing.upoXml = result.upoXml ?? null
        filing.submittedAt = submittedAt
        setJpkFilingStatus(filing, 'submitted')
        filing.submissionError = null
        filing.updatedAt = submittedAt
        await tx.flush()
      })
      return { filingId: claimed.filingId, status: 'submitted', referenceNumber: result.referenceNumber }
    }

    await em.transactional(async (tx: EntityManager) => {
      const filing = await findOneWithDecryption(
        tx,
        JpkVatFiling,
        {
          id: claimed.filingId,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          deletedAt: null,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!filing) throw new CrudHttpError(404, { error: '[internal] JPK filing not found' })
      if (result.referenceNumber) filing.submissionReference = result.referenceNumber
      filing.submissionError = result.error
      setJpkFilingStatus(filing, 'generated')
      filing.updatedAt = new Date()
      await tx.flush()
    })
    throw new CrudHttpError(502, { error: result.error, code: 'jpk_submit_failed' })
  },
}

registerCommand(upsertPurchaseRecordCommand)
registerCommand(deletePurchaseRecordCommand)
registerCommand(upsertFilingCommand)
registerCommand(generateCommand)
registerCommand(submitFilingCommand)
