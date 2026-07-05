import { LockMode } from '@mikro-orm/core'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureTenantScope, ensureOrganizationScope } from '@open-mercato/shared/lib/commands/scope'
import { CrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { ReceivedInvoice, ReceiveCursor, PurchaseVatRecord } from '../data/entities'
import { receiveSyncSchema } from '../data/validators'
import { resolveKsefEnvironment } from '../config'
import {
  KsefClient,
  type KsefPublicKeyCertificate,
  type ReceivedInvoiceMetadata,
} from '../lib/ksef-client'
import { authenticate } from '../lib/ksef-auth'
import {
  buildKsefAuthConfig,
  readKsefCredentials as readKsefCredentialsFull,
  type ResolverContext,
} from '../lib/credentials'
import {
  mapMetadataToReceivedInvoice,
  mapReceivedInvoiceToPurchaseRecord,
  type ReceivedInvoiceFields,
} from '../lib/received-invoice'

type ReceiveInvoicesInput = {
  dateFrom: string
  dateTo: string
  dateType?: 'Issue' | 'Invoicing' | 'PermanentStorage'
}

type MaterializePurchaseRecordInput = { ksefNumber: string }

type KsefCredentialDetails = {
  contextNip?: string
  environment?: string
}

type CredentialsService = {
  getRaw: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<Record<string, unknown> | null>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const AUTH_POLL = { authMaxAttempts: 20, authDelayMs: 1500, wait } as const
const PAGE_SIZE = 100
const MAX_PAGES_PER_SYNC = 400
const MAX_CONSECUTIVE_PAGE_ERRORS = 3
const RECEIVED_INVOICE_UNIQUE_INDEX = 'financial_pl_received_invoice_active_unique'
const RECEIVE_CURSOR_UNIQUE_INDEX = 'financial_pl_receive_cursor_active_unique'
const SUBJECT_TYPE = 'Subject2' as const

function resolveCommandScope(ctx: CommandRuntimeContext): { organizationId: string; tenantId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId =
    ctx.selectedOrganizationId ?? ctx.organizationIds?.[0] ?? ctx.auth?.orgId ?? null
  if (!organizationId || !tenantId) {
    throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
  }
  return { organizationId, tenantId }
}

function credString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

async function readKsefCredentialDetails(
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
    }
  } catch {
    return {}
  }
}

function commandResolver(ctx: CommandRuntimeContext): ResolverContext {
  return {
    resolve: <T = unknown>(name: string): T => ctx.container.resolve(name) as T,
  }
}

function selectTokenCertificate(certs: KsefPublicKeyCertificate[]): KsefPublicKeyCertificate | undefined {
  const matches = certs.filter((cert) => cert.usage.some((usage) => usage.toLowerCase().includes('token')))
  return [...matches].sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0]
}

async function authenticateKsef(
  ctx: CommandRuntimeContext,
  scope: { organizationId: string; tenantId: string },
  preferredContextNip?: string | null,
): Promise<{ client: KsefClient; accessToken: string; contextNip: string }> {
  const details = await readKsefCredentialDetails(ctx, scope)
  const creds = await readKsefCredentialsFull(commandResolver(ctx), scope)
  const contextNip = preferredContextNip ?? details.contextNip
  if (!contextNip) {
    throw new CrudHttpError(409, {
      error: '[internal] KSeF credentials are not configured for this organization.',
      code: 'ksef_credentials_missing',
    })
  }
  const auth = buildKsefAuthConfig(creds, contextNip)
  if (!auth) {
    throw new CrudHttpError(409, {
      error: '[internal] KSeF credentials are not configured for this organization (token or certificate).',
      code: 'ksef_auth_missing',
    })
  }

  const client = new KsefClient(resolveKsefEnvironment(creds.environment ?? details.environment))
  const certs = await client.getPublicKeyCertificates()
  const tokenCert = selectTokenCertificate(certs)
  const result = await authenticate(client, tokenCert, auth, AUTH_POLL)
  if (!result.ok) {
    throw new CrudHttpError(502, { error: result.errorMessage, code: 'ksef_auth_failed' })
  }
  return { client, accessToken: result.accessToken, contextNip }
}

function dateOnlyToDate(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null
}

function dateOnlyFromValue(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function rangeDateFromMetadata(
  meta: ReceivedInvoiceMetadata,
  dateType: 'Issue' | 'Invoicing' | 'PermanentStorage',
): string | null {
  if (dateType === 'Issue') return meta.issueDate ?? null
  if (dateType === 'PermanentStorage') return meta.permanentStorageDate ?? null
  return meta.invoicingDate ?? meta.issueDate ?? null
}

function receivedWhere(
  scope: { organizationId: string; tenantId: string },
  contextNip: string | null,
  ksefNumber: string,
): FilterQuery<ReceivedInvoice> {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    contextNip,
    ksefNumber,
    deletedAt: null,
  }
}

async function upsertReceivedInvoice(
  em: EntityManager,
  scope: { organizationId: string; tenantId: string },
  contextNip: string | null,
  meta: ReceivedInvoiceMetadata,
): Promise<boolean> {
  const fields = mapMetadataToReceivedInvoice(meta)
  if (!fields.ksefNumber) return false

  const where = receivedWhere(scope, contextNip, fields.ksefNumber)
  const existing = await findOneWithDecryption(
    em,
    ReceivedInvoice,
    where,
    { fields: ['id', 'organizationId', 'tenantId', 'contextNip', 'ksefNumber', 'fetchedAt'] },
    scope,
  )
  if (existing) {
    existing.fetchedAt = new Date()
    await em.flush()
    return true
  }

  const now = new Date()
  const record = em.create(ReceivedInvoice, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    contextNip,
    ksefNumber: fields.ksefNumber,
    issuerNip: fields.issuerNip,
    issuerName: fields.issuerName,
    buyerIdentifierType: fields.buyerIdentifierType,
    buyerIdentifierValue: fields.buyerIdentifierValue,
    issueDate: dateOnlyToDate(fields.issueDate),
    acquisitionDate: dateOnlyToDate(fields.acquisitionDate),
    invoiceType: fields.invoiceType,
    currency: fields.currency,
    netAmount: fields.netAmount,
    grossAmount: fields.grossAmount,
    vatAmount: fields.vatAmount,
    invoiceHash: fields.invoiceHash,
    correctedKsefNumber: fields.correctedKsefNumber,
    fa3Xml: null,
    linkedPurchaseRecordId: null,
    fetchedAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })

  try {
    await em.persist(record).flush()
    return true
  } catch (err) {
    if (isUniqueViolation(err, RECEIVED_INVOICE_UNIQUE_INDEX)) {
      em.clear()
      const winner = await findOneWithDecryption(
        em,
        ReceivedInvoice,
        where,
        { fields: ['id', 'organizationId', 'tenantId', 'contextNip', 'ksefNumber', 'fetchedAt'] },
        scope,
      )
      if (winner) {
        winner.fetchedAt = new Date()
        await em.flush()
      }
      return true
    }
    throw err
  }
}

async function updateCursor(
  em: EntityManager,
  scope: { organizationId: string; tenantId: string },
  contextNip: string | null,
  permanentStorageHwmDate: string | null,
): Promise<void> {
  const where: FilterQuery<ReceiveCursor> = {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    contextNip,
    subjectType: SUBJECT_TYPE,
    deletedAt: null,
  }
  const now = new Date()
  const existing = await findOneWithDecryption(em, ReceiveCursor, where, undefined, scope)
  if (existing) {
    if (permanentStorageHwmDate) existing.permanentStorageHwmDate = permanentStorageHwmDate
    existing.lastSyncedAt = now
    await em.flush()
    return
  }

  const cursor = em.create(ReceiveCursor, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    contextNip,
    subjectType: SUBJECT_TYPE,
    permanentStorageHwmDate,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  try {
    await em.persist(cursor).flush()
  } catch (err) {
    if (isUniqueViolation(err, RECEIVE_CURSOR_UNIQUE_INDEX)) {
      em.clear()
      const winner = await findOneWithDecryption(em, ReceiveCursor, where, undefined, scope)
      if (winner) {
        if (permanentStorageHwmDate) winner.permanentStorageHwmDate = permanentStorageHwmDate
        winner.lastSyncedAt = now
        await em.flush()
      }
      return
    }
    throw err
  }
}

function toReceivedInvoiceFields(received: ReceivedInvoice): ReceivedInvoiceFields {
  return {
    ksefNumber: received.ksefNumber,
    issuerNip: received.issuerNip ?? null,
    issuerName: received.issuerName ?? null,
    buyerIdentifierType: received.buyerIdentifierType ?? null,
    buyerIdentifierValue: received.buyerIdentifierValue ?? null,
    issueDate: dateOnlyFromValue(received.issueDate),
    acquisitionDate: dateOnlyFromValue(received.acquisitionDate),
    invoiceType: received.invoiceType ?? null,
    currency: received.currency ?? null,
    netAmount: received.netAmount ?? null,
    grossAmount: received.grossAmount ?? null,
    vatAmount: received.vatAmount ?? null,
    invoiceHash: received.invoiceHash ?? null,
    correctedKsefNumber: received.correctedKsefNumber ?? null,
  }
}

export const receiveInvoicesCommand: CommandHandler<ReceiveInvoicesInput, { synced: number }> = {
  id: 'financial_pl.ksef_receive.receive_invoices',
  async execute(input, ctx) {
    const parsed = receiveSyncSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const { client, accessToken, contextNip } = await authenticateKsef(ctx, scope)
    const em = ctx.container.resolve('em') as EntityManager
    const contextNipScope = contextNip || null
    const dateType = parsed.dateType
    let dateFrom = parsed.dateFrom
    let pageOffset = 0
    let synced = 0
    let permanentStorageHwmDate: string | null = null
    let pages = 0
    let consecutiveErrors = 0

    while (pages < MAX_PAGES_PER_SYNC) {
      pages += 1
      try {
        const result = await client.queryReceivedInvoices({
          accessToken,
          filters: {
            subjectType: SUBJECT_TYPE,
            dateRange: { dateType, from: dateFrom, to: parsed.dateTo },
          },
          pageOffset,
          pageSize: PAGE_SIZE,
          sortOrder: 'Asc',
        })
        consecutiveErrors = 0
        if (result.permanentStorageHwmDate) permanentStorageHwmDate = result.permanentStorageHwmDate

        for (const meta of result.invoices) {
          try {
            if (await upsertReceivedInvoice(em, scope, contextNipScope, meta)) synced += 1
          } catch (err) {
            console.error('[internal] financial_pl.ksef_receive row sync failed', err)
          }
        }

        if (result.isTruncated) {
          const last = result.invoices[result.invoices.length - 1]
          const nextFrom = last ? rangeDateFromMetadata(last, dateType) : null
          if (!nextFrom || nextFrom <= dateFrom) {
            console.error('[internal] financial_pl.ksef_receive truncated page could not narrow date range')
            break
          }
          dateFrom = nextFrom
          pageOffset = 0
          continue
        }

        if (!result.hasMore) break
        pageOffset += PAGE_SIZE
      } catch (err) {
        consecutiveErrors += 1
        console.error('[internal] financial_pl.ksef_receive page sync failed', err)
        if (consecutiveErrors >= MAX_CONSECUTIVE_PAGE_ERRORS) break
        pageOffset += PAGE_SIZE
      }
    }

    await updateCursor(em, scope, contextNipScope, permanentStorageHwmDate)
    return { synced }
  },
}

const materializePurchaseRecordSchema = z.object({ ksefNumber: z.string().min(1) })

export const materializePurchaseRecordCommand: CommandHandler<
  MaterializePurchaseRecordInput,
  { purchaseRecordId: string }
> = {
  id: 'financial_pl.ksef_receive.materialize_purchase_record',
  async execute(input, ctx) {
    const parsed = materializePurchaseRecordSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = ctx.container.resolve('em') as EntityManager
    const preflight = await findOneWithDecryption(
      em,
      ReceivedInvoice,
      {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        ksefNumber: parsed.ksefNumber,
        deletedAt: null,
      },
      undefined,
      scope,
    )
    if (!preflight) throw new CrudHttpError(404, { error: '[internal] received invoice not found' })
    if (preflight.linkedPurchaseRecordId) {
      return { purchaseRecordId: preflight.linkedPurchaseRecordId }
    }

    let fetchedFa3Xml: string | null = null
    if (!preflight.fa3Xml) {
      const liveAuth = await authenticateKsef(ctx, scope, preflight.contextNip ?? null)
      fetchedFa3Xml = await liveAuth.client.downloadInvoiceByKsefNumber({
        accessToken: liveAuth.accessToken,
        ksefNumber: preflight.ksefNumber,
      })
    }

    const purchaseRecordId = await em.transactional(async (tx: EntityManager) => {
      const received = await findOneWithDecryption(
        tx,
        ReceivedInvoice,
        {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          ksefNumber: parsed.ksefNumber,
          deletedAt: null,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!received) throw new CrudHttpError(404, { error: '[internal] received invoice not found' })
      if (received.linkedPurchaseRecordId) return received.linkedPurchaseRecordId

      if (!received.fa3Xml && fetchedFa3Xml !== null) {
        received.fa3Xml = fetchedFa3Xml
      }

      const purchaseFields = mapReceivedInvoiceToPurchaseRecord(toReceivedInvoiceFields(received))
      if (!purchaseFields.purchaseDate || purchaseFields.year <= 0 || purchaseFields.month <= 0) {
        throw new CrudHttpError(422, { error: '[internal] received invoice is missing purchase period dates' })
      }

      const now = new Date()
      const purchaseRecord = tx.create(PurchaseVatRecord, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        contextNip: received.contextNip ?? null,
        year: purchaseFields.year,
        month: purchaseFields.month,
        supplierNip: purchaseFields.supplierNip,
        supplierCountryCode: purchaseFields.supplierCountryCode,
        supplierName: purchaseFields.supplierName,
        documentNumber: purchaseFields.documentNumber,
        purchaseDate: purchaseFields.purchaseDate,
        receiptDate: purchaseFields.receiptDate,
        documentType: null,
        imp: false,
        ksefMarking: purchaseFields.nrKsef ? 'NrKSeF' : null,
        nrKsef: purchaseFields.nrKsef,
        transactionClass: 'domestic',
        netFixedAssets: null,
        vatFixedAssets: null,
        netOther: purchaseFields.netOther,
        vatOther: purchaseFields.vatOther,
        corrFixedAssets: null,
        corrOther: null,
        corr89b1: null,
        corr89b4: null,
        marginGross: null,
        selfAssessedNet: null,
        selfAssessedVat: null,
        selfAssessedRate: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      await tx.persist(purchaseRecord).flush()
      received.linkedPurchaseRecordId = purchaseRecord.id
      received.fetchedAt = now
      await tx.flush()
      return purchaseRecord.id
    })

    return { purchaseRecordId }
  },
}

registerCommand(receiveInvoicesCommand)
registerCommand(materializePurchaseRecordCommand)
