import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { EnrichmentRecord } from '../data/entities'
import type { SubjectType } from '../lib/constants'
import { createEnrichmentRecord } from '../lib/enrichment-service'
import type { SubjectIdentity } from '../lib/normalize'

type Scope = { tenantId: string; organizationId: string }

export type CreateRecordInput = Scope & {
  subjectType: SubjectType
  subjectId: string
  identity: SubjectIdentity | Record<string, unknown>
  requestedByUserId: string | null
  endpointId?: string
}

export type MarkAppliedInput = Scope & {
  recordId: string
  fields: string[]
  appliedByUserId: string
}

type AppliedSnapshot = {
  appliedFields: string[] | null
  appliedAt: string | null
  appliedByUserId: string | null
}

export const RECORD_RESOURCE_KIND = 'enrichment_treg.record'

function resolveEm(ctx: CommandRuntimeContext): EntityManager {
  return ((ctx.container as AwilixContainer).resolve('em') as EntityManager).fork()
}

async function loadRecord(em: EntityManager, recordId: string, scope: Scope): Promise<EnrichmentRecord | null> {
  return findOneWithDecryption(
    em,
    EnrichmentRecord,
    { id: recordId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    scope,
  )
}

function snapshotApplied(record: EnrichmentRecord): AppliedSnapshot {
  return {
    appliedFields: record.appliedFields ?? null,
    appliedAt: record.appliedAt ? record.appliedAt.toISOString() : null,
    appliedByUserId: record.appliedByUserId ?? null,
  }
}

function readCreatedRecordId(logEntry: { resourceId?: string | null }): string | null {
  return typeof logEntry.resourceId === 'string' && logEntry.resourceId.length > 0 ? logEntry.resourceId : null
}

const createRecordCommand: CommandHandler<CreateRecordInput, { recordId: string }> = {
  id: 'enrichment_treg.records.create',
  isUndoable: true,
  async execute(input, ctx) {
    const em = resolveEm(ctx)
    const record = createEnrichmentRecord(em, {
      scope: { tenantId: input.tenantId, organizationId: input.organizationId },
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      identity: input.identity,
      requestedByUserId: input.requestedByUserId,
      endpointId: input.endpointId,
    })
    await em.flush()
    return { recordId: record.id }
  },
  buildLog({ input, result }) {
    return {
      actionLabel: 'enrichment_treg.records.create',
      resourceKind: RECORD_RESOURCE_KIND,
      resourceId: result.recordId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      relatedResourceKind: input.subjectType === 'person' ? 'customers.person' : 'customers.company',
      relatedResourceId: input.subjectId,
      payload: { subjectType: input.subjectType, subjectId: input.subjectId, endpointId: input.endpointId ?? null },
    }
  },
  async undo({ input, ctx, logEntry }) {
    const recordId = readCreatedRecordId(logEntry)
    if (!recordId) return
    const em = resolveEm(ctx)
    const record = await loadRecord(em, recordId, input)
    if (!record) return
    record.deletedAt = new Date()
    await em.flush()
  },
}

const markAppliedCommand: CommandHandler<MarkAppliedInput, { recordId: string; appliedFields: string[] }> = {
  id: 'enrichment_treg.records.mark_applied',
  isUndoable: true,
  async prepare(input, ctx) {
    const record = await loadRecord(resolveEm(ctx), input.recordId, input)
    return record ? { before: snapshotApplied(record) } : null
  },
  async execute(input, ctx) {
    const em = resolveEm(ctx)
    const record = await loadRecord(em, input.recordId, input)
    if (!record) throw new CrudHttpError(404, { error: 'record_not_found' })
    if (record.status !== 'completed' || !record.proposal) {
      throw new CrudHttpError(409, { error: 'record_not_applicable' })
    }
    const proposal = record.proposal
    const unknownField = input.fields.find((field) => !(field in proposal))
    if (unknownField) throw new CrudHttpError(400, { error: 'field_not_in_proposal', message: unknownField })

    record.appliedFields = [...new Set([...(record.appliedFields ?? []), ...input.fields])]
    record.appliedAt = new Date()
    record.appliedByUserId = input.appliedByUserId
    await em.flush()
    return { recordId: record.id, appliedFields: record.appliedFields }
  },
  buildLog({ input, result, snapshots }) {
    return {
      actionLabel: 'enrichment_treg.records.mark_applied',
      resourceKind: RECORD_RESOURCE_KIND,
      resourceId: result.recordId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      snapshotBefore: snapshots.before ?? null,
      payload: { fields: input.fields },
    }
  },
  async undo({ input, ctx, logEntry }) {
    const before = logEntry.snapshotBefore as AppliedSnapshot | null | undefined
    if (!before) return
    const em = resolveEm(ctx)
    const record = await loadRecord(em, input.recordId, input)
    if (!record) return
    record.appliedFields = before.appliedFields
    record.appliedAt = before.appliedAt ? new Date(before.appliedAt) : null
    record.appliedByUserId = before.appliedByUserId
    await em.flush()
  },
}

registerCommand(createRecordCommand)
registerCommand(markAppliedCommand)

export { createRecordCommand, markAppliedCommand }
