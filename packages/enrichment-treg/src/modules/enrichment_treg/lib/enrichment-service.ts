import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { EnrichmentRecord, EnrichmentSignal } from '../data/entities'
import { emitEnrichmentTregEvent } from '../events'
import { callTregEndpoint, parseTregSettings, TregError, type FetchLike } from './client'
import {
  ENDPOINT_BY_SUBJECT,
  SIGNAL_LIST_KEY_BY_KIND,
  signalKindForEndpoint,
  TREG_INTEGRATION_ID,
  type SignalKind,
  type SubjectType,
} from './constants'
import { normalizeOutput, type SubjectIdentity } from './normalize'
import { normalizeSignals, type NormalizedSignal } from './signals'

const logger = createLogger('enrichment_treg').child({ component: 'enrichment-service' })

const MISS_KEY_BY_SUBJECT: Record<SubjectType, string> = {
  person: 'full_name',
  company: 'name',
}

export type EnrichmentScope = { tenantId: string; organizationId: string }

type CredentialsResolver = {
  resolve(integrationId: string, scope: EnrichmentScope): Promise<Record<string, unknown> | null>
}

export type IntegrationErrorLogger = {
  scoped(integrationId: string, scope: EnrichmentScope): {
    error(message: string, payload?: Record<string, unknown>): Promise<unknown>
  }
}

export const RUNNING_STALE_AFTER_MS = 5 * 60_000

function isResumable(record: EnrichmentRecord, now: Date): boolean {
  if (record.status === 'pending') return true
  if (record.status !== 'running') return false
  return now.getTime() - record.updatedAt.getTime() >= RUNNING_STALE_AFTER_MS
}

async function reportFailure(
  logService: IntegrationErrorLogger | undefined,
  scope: EnrichmentScope,
  record: EnrichmentRecord,
  httpStatus: number | null,
): Promise<void> {
  if (!logService) return
  try {
    await logService.scoped(TREG_INTEGRATION_ID, scope).error('treg enrichment failed', {
      recordId: record.id,
      subjectType: record.subjectType,
      endpointId: record.endpointId,
      reason: record.failureReason,
      httpStatus,
    })
  } catch (err) {
    logger.warn('Failed to write treg enrichment failure to the integration log', { err, recordId: record.id })
  }
}

export function createEnrichmentRecord(
  em: EntityManager,
  input: {
    scope: EnrichmentScope
    subjectType: SubjectType
    subjectId: string
    identity: SubjectIdentity | Record<string, unknown>
    requestedByUserId: string | null
    endpointId?: string
  },
): EnrichmentRecord {
  return em.create(EnrichmentRecord, {
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    endpointId: input.endpointId ?? ENDPOINT_BY_SUBJECT[input.subjectType],
    identity: { ...input.identity },
    requestedByUserId: input.requestedByUserId,
  })
}

async function emitOutcome(record: EnrichmentRecord): Promise<void> {
  const eventId = record.status === 'failed' ? 'enrichment_treg.record.failed' : 'enrichment_treg.record.completed'
  try {
    await emitEnrichmentTregEvent(eventId, {
      id: record.id,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      status: record.status,
      tenantId: record.tenantId,
      organizationId: record.organizationId,
    })
  } catch (err) {
    logger.warn('Failed to emit enrichment outcome event', { err, recordId: record.id })
  }
}

export type StoredSignalsSummary = {
  newCount: number
  totalCount: number
  skippedRows: number
}

export async function storeSignals(
  em: EntityManager,
  record: EnrichmentRecord,
  signals: NormalizedSignal[],
  now: Date,
): Promise<number> {
  if (signals.length === 0) return 0
  const scope = { tenantId: record.tenantId, organizationId: record.organizationId }
  const existing = await findWithDecryption(
    em,
    EnrichmentSignal,
    { ...scope, subjectId: record.subjectId, dedupeHash: { $in: signals.map((signal) => signal.dedupeHash) } },
    undefined,
    scope,
  )
  const byHash = new Map(existing.map((signal) => [signal.dedupeHash, signal]))
  let newCount = 0
  for (const signal of signals) {
    const known = byHash.get(signal.dedupeHash)
    if (known) {
      if (!known.deletedAt) known.lastSeenAt = now
      continue
    }
    em.create(EnrichmentSignal, {
      ...scope,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      recordId: record.id,
      signalType: signal.signalType,
      title: signal.title,
      summary: signal.summary,
      url: signal.url,
      location: signal.location,
      occurredAt: signal.occurredAt,
      source: record.servedBy ?? null,
      payload: signal.payload,
      dedupeHash: signal.dedupeHash,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    newCount += 1
  }
  return newCount
}

async function emitSignalsDetected(record: EnrichmentRecord, signalType: SignalKind, newCount: number): Promise<void> {
  if (newCount === 0) return
  try {
    await emitEnrichmentTregEvent('enrichment_treg.signal.detected', {
      recordId: record.id,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      signalType,
      newCount,
      tenantId: record.tenantId,
      organizationId: record.organizationId,
    })
  } catch (err) {
    logger.warn('Failed to emit signals detected event', { err, recordId: record.id })
  }
}

export async function runEnrichment(params: {
  em: EntityManager
  credentialsService: CredentialsResolver
  logService?: IntegrationErrorLogger
  recordId: string
  scope: EnrichmentScope
  fetchImpl?: FetchLike
  now?: () => Date
}): Promise<EnrichmentRecord | null> {
  const { em, scope } = params
  const record = await findOneWithDecryption(
    em,
    EnrichmentRecord,
    { id: params.recordId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    scope,
  )
  if (!record) return null
  if (!isResumable(record, params.now?.() ?? new Date())) return record

  record.status = 'running'
  await em.flush()

  let failureStatus: number | null = null
  let newSignals = 0
  const signalKind = signalKindForEndpoint(record.endpointId)

  try {
    const settings = parseTregSettings(await params.credentialsService.resolve(TREG_INTEGRATION_ID, scope))
    const result = await callTregEndpoint({
      settings,
      endpointId: record.endpointId,
      body: record.identity,
      missWhenEmpty: signalKind ? SIGNAL_LIST_KEY_BY_KIND[signalKind] : MISS_KEY_BY_SUBJECT[record.subjectType],
      missOnNotFound: signalKind !== null,
      idempotencyKey: `om-enrichment-${record.id}`,
      meta: { tenant: scope.tenantId, subject: signalKind ? `${record.subjectType}-${signalKind}` : record.subjectType },
      fetchImpl: params.fetchImpl,
    })
    record.servedBy = result.servedBy
    record.tregCallId = result.callId
    record.costMicro = result.costMicro
    record.rawPayload = result.raw ?? null
    const fetchedAt = new Date()
    record.fetchedAt = fetchedAt
    if (result.status === 'hit' && signalKind) {
      const normalized = normalizeSignals({ kind: signalKind, output: result.output, raw: result.raw })
      newSignals = await storeSignals(em, record, normalized.signals, fetchedAt)
      const summary: StoredSignalsSummary = {
        newCount: newSignals,
        totalCount: normalized.signals.length,
        skippedRows: normalized.skippedRows,
      }
      record.summary = summary
      record.status = normalized.signals.length > 0 ? 'completed' : 'no_match'
    } else if (result.status === 'hit') {
      const normalized = normalizeOutput(record.subjectType, result.output)
      record.proposal = normalized.proposal
      record.summary = normalized.summary
      record.status = 'completed'
    } else {
      record.status = 'no_match'
    }
  } catch (error) {
    record.status = 'failed'
    record.failureReason = error instanceof TregError ? error.reason : 'unexpected'
    failureStatus = error instanceof TregError ? error.httpStatus : null
  }

  await em.flush()
  if (record.status === 'failed') await reportFailure(params.logService, scope, record, failureStatus)
  await emitOutcome(record)
  if (signalKind) await emitSignalsDetected(record, signalKind, newSignals)
  return record
}

export type SerializedEnrichmentRecord = {
  id: string
  subjectType: SubjectType
  subjectId: string
  status: EnrichmentRecord['status']
  failureReason: string | null
  servedBy: string | null
  costMicro: number
  proposal: Record<string, string> | null
  summary: Record<string, unknown> | null
  appliedFields: string[] | null
  appliedAt: string | null
  fetchedAt: string | null
  createdAt: string
  updatedAt: string
}

export function serializeRecord(record: EnrichmentRecord): SerializedEnrichmentRecord {
  return {
    id: record.id,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    status: record.status,
    failureReason: record.failureReason ?? null,
    servedBy: record.servedBy ?? null,
    costMicro: record.costMicro ?? 0,
    proposal: record.proposal ?? null,
    summary: record.summary ?? null,
    appliedFields: record.appliedFields ?? null,
    appliedAt: record.appliedAt ? record.appliedAt.toISOString() : null,
    fetchedAt: record.fetchedAt ? record.fetchedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}
