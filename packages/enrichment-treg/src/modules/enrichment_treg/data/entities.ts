import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import type { FailureReason, RecordStatus, SignalKind, SubjectType } from '../lib/constants'

@Entity({ tableName: 'enrichment_treg_records' })
@Index({
  name: 'enrichment_treg_records_subject_idx',
  properties: ['tenantId', 'organizationId', 'subjectType', 'subjectId', 'createdAt'],
})
export class EnrichmentRecord {
  [OptionalProps]?: 'status' | 'costMicro' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'subject_type', type: 'text' })
  subjectType!: SubjectType

  @Property({ name: 'subject_id', type: 'uuid' })
  subjectId!: string

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: RecordStatus = 'pending'

  @Property({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: FailureReason | null

  @Property({ name: 'endpoint_id', type: 'text' })
  endpointId!: string

  @Property({ name: 'identity', type: 'jsonb' })
  identity!: Record<string, unknown>

  @Property({ name: 'served_by', type: 'text', nullable: true })
  servedBy?: string | null

  @Property({ name: 'treg_call_id', type: 'text', nullable: true })
  tregCallId?: string | null

  @Property({ name: 'cost_micro', type: 'integer', default: 0 })
  costMicro: number = 0

  @Property({ name: 'proposal', type: 'jsonb', nullable: true })
  proposal?: Record<string, string> | null

  @Property({ name: 'summary', type: 'jsonb', nullable: true })
  summary?: Record<string, unknown> | null

  @Property({ name: 'raw_payload', type: 'jsonb', nullable: true })
  rawPayload?: unknown | null

  @Property({ name: 'applied_fields', type: 'jsonb', nullable: true })
  appliedFields?: string[] | null

  @Property({ name: 'applied_at', type: Date, nullable: true })
  appliedAt?: Date | null

  @Property({ name: 'applied_by_user_id', type: 'uuid', nullable: true })
  appliedByUserId?: string | null

  @Property({ name: 'requested_by_user_id', type: 'uuid', nullable: true })
  requestedByUserId?: string | null

  @Property({ name: 'fetched_at', type: Date, nullable: true })
  fetchedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'enrichment_treg_signals' })
@Index({
  name: 'enrichment_treg_signals_timeline_idx',
  properties: ['tenantId', 'organizationId', 'subjectType', 'subjectId', 'occurredAt'],
})
@Unique({
  name: 'enrichment_treg_signals_dedupe_uq',
  properties: ['tenantId', 'organizationId', 'subjectId', 'dedupeHash'],
})
export class EnrichmentSignal {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'subject_type', type: 'text' })
  subjectType!: SubjectType

  @Property({ name: 'subject_id', type: 'uuid' })
  subjectId!: string

  @Property({ name: 'record_id', type: 'uuid' })
  recordId!: string

  @Property({ name: 'signal_type', type: 'text' })
  signalType!: SignalKind

  @Property({ name: 'title', type: 'text' })
  title!: string

  @Property({ name: 'summary', type: 'text', nullable: true })
  summary?: string | null

  @Property({ name: 'url', type: 'text', nullable: true })
  url?: string | null

  @Property({ name: 'location', type: 'text', nullable: true })
  location?: string | null

  @Property({ name: 'occurred_at', type: Date, nullable: true })
  occurredAt?: Date | null

  @Property({ name: 'source', type: 'text', nullable: true })
  source?: string | null

  @Property({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>

  @Property({ name: 'dedupe_hash', type: 'text' })
  dedupeHash!: string

  @Property({ name: 'first_seen_at', type: Date })
  firstSeenAt!: Date

  @Property({ name: 'last_seen_at', type: Date })
  lastSeenAt!: Date

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
