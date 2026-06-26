import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

export type KsefSubmissionStatusColumn =
  | 'not_applicable'
  | 'ready'
  | 'queued'
  | 'processing'
  | 'accepted'
  | 'rejected'
  | 'offline_issued'

export type KsefSubmissionMode = 'online' | 'batch' | 'offline24' | 'awaryjny'
export type KsefEnvironmentColumn = 'test' | 'demo' | 'prod'

/**
 * Tracks one KSeF submission attempt for a sales invoice. Links to the invoice
 * by FK-id only (no cross-module ORM relation, §4). `invoice_xml` is the FA(3)
 * document built at send time; `upo_xml` is the signed acceptance receipt — both
 * are compliance-sensitive and declared in encryption.ts.
 */
@Entity({ tableName: 'financial_pl_ksef_submissions' })
@Index({ name: 'financial_pl_ksef_submissions_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'financial_pl_ksef_submissions_invoice_idx', properties: ['organizationId', 'tenantId', 'salesInvoiceId'] })
// At most one ACTIVE (queued/processing/accepted) submission per invoice at a time,
// enforced at the DB level so two concurrent sends can't both create a row and
// double-send. A `rejected` (or soft-deleted) submission does not block a fresh
// re-submission. The send command catches the resulting 23505 and returns the
// winner of the race.
@Index({
  name: 'financial_pl_ksef_submissions_active_unique',
  expression:
    `create unique index "financial_pl_ksef_submissions_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id") where "status" in ('queued', 'processing', 'accepted') and "deleted_at" is null`,
})
export class KsefSubmission {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'sales_invoice_id', type: 'uuid' })
  salesInvoiceId!: string

  @Property({ name: 'environment', type: 'text' })
  environment: KsefEnvironmentColumn = 'test'

  @Property({ name: 'mode', type: 'text' })
  mode: KsefSubmissionMode = 'online'

  @Property({ name: 'status', type: 'text' })
  status: KsefSubmissionStatusColumn = 'queued'

  @Property({ name: 'context_nip', type: 'text' })
  contextNip!: string

  @Property({ name: 'invoice_xml', type: 'text', nullable: true })
  invoiceXml?: string | null

  @Property({ name: 'session_reference', type: 'text', nullable: true })
  sessionReference?: string | null

  @Property({ name: 'invoice_reference', type: 'text', nullable: true })
  invoiceReference?: string | null

  @Property({ name: 'ksef_number', type: 'text', nullable: true })
  ksefNumber?: string | null

  @Property({ name: 'upo_ref', type: 'text', nullable: true })
  upoRef?: string | null

  @Property({ name: 'upo_xml', type: 'text', nullable: true })
  upoXml?: string | null

  @Property({ name: 'last_status_code', type: 'integer', nullable: true })
  lastStatusCode?: number | null

  @Property({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode?: string | null

  @Property({ name: 'last_error_message', type: 'text', nullable: true })
  lastErrorMessage?: string | null

  @Property({ name: 'attempt_count', type: 'integer' })
  attemptCount = 0

  @Property({ name: 'submitted_at', type: Date, nullable: true })
  submittedAt?: Date | null

  @Property({ name: 'accepted_at', type: Date, nullable: true })
  acceptedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date | null

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Polish statutory metadata for a sales invoice, kept out of the country-agnostic
 * core `sales` schema. Extension of `sales.SalesInvoice` declared in
 * data/extensions.ts; linked by FK-id.
 */
@Entity({ tableName: 'financial_pl_invoice_meta' })
@Index({ name: 'financial_pl_invoice_meta_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'financial_pl_invoice_meta_invoice_unique', properties: ['organizationId', 'tenantId', 'salesInvoiceId'] })
export class SalesInvoicePlMeta {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'sales_invoice_id', type: 'uuid' })
  salesInvoiceId!: string

  @Property({ name: 'context_nip', type: 'text', nullable: true })
  contextNip?: string | null

  @Property({ name: 'ksef_status', type: 'text' })
  ksefStatus: KsefSubmissionStatusColumn = 'not_applicable'

  @Property({ name: 'ksef_number', type: 'text', nullable: true })
  ksefNumber?: string | null

  @Property({ name: 'mpp_required', type: 'boolean' })
  mppRequired = false

  @Property({ name: 'vat_exemption_basis', type: 'text', nullable: true })
  vatExemptionBasis?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date | null

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
