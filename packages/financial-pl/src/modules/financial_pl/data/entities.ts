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
/** Which sales document this submission carries: a standard invoice or a correction (credit memo → FA(3) KOR). */
export type KsefSubmissionDocumentKind = 'invoice' | 'credit_memo'

/**
 * Explicit operator-set document kind for the FA(3) resolver dispatch (SPEC-009 §Data Models).
 * Stored as a plain `text` column (no DB-level enum, per the spec cross-model review); the value
 * is validated at the zod/API boundary. Defaults to `'vat'` so every existing invoice keeps the
 * unchanged VAT path. `zal`/`roz`/`upr` are the advance/settlement/simplified types and
 * `kor_zal`/`kor_roz` their corrections.
 */
export type InvoiceKindColumn = 'vat' | 'zal' | 'roz' | 'upr' | 'kor_zal' | 'kor_roz'

/** Pure-JPK `TypDokumentu` sales-register flag (never appears in the FA(3) XML). */
export type JpkTypDokumentuColumn = 'RO' | 'WEW' | 'FP'

/** ZAL received-payment snapshot → FA(3) `ZaliczkaCzesciowa`. */
export type AdvancePaymentSnapshot = { receivedDate: string; amount: string; fxRate?: string }

/**
 * ROZ prior-advance reference → FA(3) `FakturaZaliczkowa`. `amount` is the already-invoiced
 * gross of that advance; `resolve-fa3-settlement.ts` nets Σ amounts off the full gross to compute
 * the ROZ residual `P_15` (when absent the residual equals the full gross — no netting).
 */
export type AdvanceInvoiceRef = { ksefNumber?: string; invoiceNumber?: string; amount?: string }

/** ZAL/KOR_ZAL order line snapshot. */
export type OrderLineSnapshot = {
  name: string
  quantity?: string
  unitPrice?: string
  netValue?: string
  vatRate?: string
}

/** ZAL/KOR_ZAL order snapshot → FA(3) `Zamowienie`. */
export type OrderSnapshot = { totalValue: string; lines: OrderLineSnapshot[] }

/**
 * Tracks one KSeF submission attempt for a sales invoice. Links to the invoice
 * by FK-id only (no cross-module ORM relation, §4). `invoice_xml` is the FA(3)
 * document built at send time; `upo_xml` is the signed acceptance receipt — both
 * are compliance-sensitive and declared in encryption.ts.
 */
@Entity({ tableName: 'financial_pl_ksef_submissions' })
@Index({ name: 'financial_pl_ksef_submissions_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'financial_pl_ksef_submissions_invoice_idx', properties: ['organizationId', 'tenantId', 'salesInvoiceId'] })
// At most one ACTIVE (queued/processing/accepted/offline_issued) submission per INVOICE
// at a time, enforced at the DB level so two concurrent sends can't both create a row and
// double-send. `offline_issued` is in the active set so an offline-issued row blocks both a
// duplicate offline-issue AND an online submit for the same source document (SPEC-010).
// Scoped to document_kind='invoice' so a CORRECTION submission (whose
// sales_invoice_id is the corrected original) does not collide with the original
// invoice's own submission. A `rejected` (or soft-deleted) submission does not block
// a fresh re-submission. The send command catches the resulting 23505 and returns the
// winner of the race.
@Index({
  name: 'financial_pl_ksef_submissions_active_unique',
  expression:
    `create unique index "financial_pl_ksef_submissions_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id") where "status" in ('queued', 'processing', 'accepted', 'offline_issued') and "deleted_at" is null and "document_kind" = 'invoice'`,
})
// At most one ACTIVE correction submission per CREDIT MEMO, the correction-side twin
// of the active-unique index above (corrections are keyed by credit_memo_id, not the
// corrected invoice id, since one invoice can be corrected by many credit memos).
@Index({
  name: 'financial_pl_ksef_submissions_credit_memo_active_unique',
  expression:
    `create unique index "financial_pl_ksef_submissions_credit_memo_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "credit_memo_id") where "credit_memo_id" is not null and "status" in ('queued', 'processing', 'accepted', 'offline_issued') and "deleted_at" is null`,
})
export class KsefSubmission {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // For an invoice submission: the invoice id. For a correction submission: the
  // CORRECTED original invoice id (so the original can surface its corrections);
  // invoice-facing reads filter document_kind='invoice' to avoid mixing the two.
  @Property({ name: 'sales_invoice_id', type: 'uuid' })
  salesInvoiceId!: string

  @Property({ name: 'document_kind', type: 'text' })
  documentKind: KsefSubmissionDocumentKind = 'invoice'

  /** Set only for a correction submission (document_kind='credit_memo'): the credit memo id. */
  @Property({ name: 'credit_memo_id', type: 'uuid', nullable: true })
  creditMemoId?: string | null

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

  // --- SPEC-010: offline mode (offline24/awaryjny) + KOD I/II ---
  // All additive, nullable (§27). Populated only on the offline-issuance path
  // (status='offline_issued'); the online send + correction paths leave them null.

  // When the invoice was issued offline — start of the statutory send-deadline clock.
  @Property({ name: 'offline_issued_at', type: Date, nullable: true })
  offlineIssuedAt?: Date | null

  // Computed statutory deadline; drives the reconcile worker's prioritization and the overdue alert.
  @Property({ name: 'offline_send_deadline_at', type: Date, nullable: true })
  offlineSendDeadlineAt?: Date | null

  // KOD I verification URL (label OFFLINE) — stored for reproducible reprint without re-deriving.
  @Property({ name: 'kod_i_url', type: 'text', nullable: true })
  kodIUrl?: string | null

  // KOD II — the full signed verification URL (label CERTYFIKAT).
  @Property({ name: 'kod_ii_url', type: 'text', nullable: true })
  kodIiUrl?: string | null

  // Serial of the Offline cert that signed KOD II (audit / multi-cert disambiguation).
  @Property({ name: 'offline_certificate_serial', type: 'text', nullable: true })
  offlineCertificateSerial?: string | null

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

  // Explicit operator signal that this invoice was lawfully issued OUTSIDE KSeF
  // (consumer/legacy/pre-obligation). Drives the JPK_VAT `BFK` marking — the JPK
  // derivation never infers `BFK` from a merely-absent KSeF number.
  @Property({ name: 'issued_outside_ksef', type: 'boolean' })
  issuedOutsideKsef = false

  // --- SPEC-009: FA(3) advanced document types, self-billing, OSS/FX, GTU/JPK markings ---
  // All additive, nullable or defaulted (§27). `invoice_kind` is the explicit resolver-dispatch
  // signal (text, validated at the zod/API boundary); defaulting to 'vat' preserves every existing
  // invoice's path.

  @Property({ name: 'invoice_kind', type: 'text', default: 'vat' })
  invoiceKind: InvoiceKindColumn = 'vat'

  // Self-billing (art. 106d) → FA(3) `P_17`.
  @Property({ name: 'self_billing', type: 'boolean', default: false })
  selfBilling = false

  // Reverse charge → FA(3) `P_18` (feeds the existing annotation path).
  @Property({ name: 'reverse_charge', type: 'boolean', default: false })
  reverseCharge = false

  // OSS/WSTO_EE marker (explicit; never inferred).
  @Property({ name: 'oss_procedure', type: 'boolean', default: false })
  ossProcedure = false

  // OSS destination/consumption country (ISO alpha-2).
  @Property({ name: 'consumption_country_code', type: 'text', nullable: true })
  consumptionCountryCode?: string | null

  // FX rate to PLN (when `sales` does not carry it).
  @Property({ name: 'exchange_rate', type: 'text', nullable: true })
  exchangeRate?: string | null

  // FX rate date (art. 31a: last working day before the tax point).
  @Property({ name: 'exchange_rate_date', type: 'date', nullable: true })
  exchangeRateDate?: Date | null

  // ZAL received-payment snapshots → `ZaliczkaCzesciowa`. Nullable (migration-safe on the existing
  // table); read sites coalesce to `[]` (no DB json default to avoid a fragile ADD-COLUMN default).
  @Property({ name: 'advance_payments', type: 'json', nullable: true })
  advancePayments: AdvancePaymentSnapshot[] = []

  // ROZ prior-advance references → `FakturaZaliczkowa`.
  @Property({ name: 'advance_refs', type: 'json', nullable: true })
  advanceRefs: AdvanceInvoiceRef[] = []

  // ZAL/KOR_ZAL order data → `Zamowienie`.
  @Property({ name: 'order_snapshot', type: 'json', nullable: true })
  orderSnapshot?: OrderSnapshot | null

  // Pure-JPK: array of `GTU_01..GTU_13`.
  @Property({ name: 'gtu_codes', type: 'json', nullable: true })
  gtuCodes: string[] = []

  // Pure-JPK procedure markings (one boolean per code).
  @Property({ name: 'wsto_ee', type: 'boolean', default: false })
  wstoEe = false

  @Property({ name: 'ied', type: 'boolean', default: false })
  ied = false

  @Property({ name: 'tp', type: 'boolean', default: false })
  tp = false

  @Property({ name: 'tt_wnt', type: 'boolean', default: false })
  ttWnt = false

  @Property({ name: 'tt_d', type: 'boolean', default: false })
  ttD = false

  @Property({ name: 'mr_t', type: 'boolean', default: false })
  mrT = false

  @Property({ name: 'mr_uz', type: 'boolean', default: false })
  mrUz = false

  @Property({ name: 'i_42', type: 'boolean', default: false })
  i42 = false

  @Property({ name: 'i_63', type: 'boolean', default: false })
  i63 = false

  @Property({ name: 'b_spv', type: 'boolean', default: false })
  bSpv = false

  @Property({ name: 'b_spv_dostawa', type: 'boolean', default: false })
  bSpvDostawa = false

  @Property({ name: 'b_mpv_prowizja', type: 'boolean', default: false })
  bMpvProwizja = false

  // Pure-JPK `TypDokumentu` (`RO|WEW|FP`).
  @Property({ name: 'doc_type', type: 'text', nullable: true })
  docType?: JpkTypDokumentuColumn | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date | null

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/** Purchase-side JPK document classification (FA(3) `DokumentZakupu`): MK/VAT_RR/WEW. */
export type JpkDokumentZakupuColumn = 'MK' | 'VAT_RR' | 'WEW'

/** How the purchase line is accounted for in the JPK_VAT register (drives net/vat field placement). */
export type JpkTransactionClassColumn =
  | 'domestic'
  | 'wnt'
  | 'import_goods'
  | 'import_services'
  | 'import_services_28b'
  | 'reverse_charge_domestic'

/** JPK_VAT purchase marking — the buyer-side twin of the sales `NrKSeF`/`OFF`/`BFK`/`DI` node. */
export type JpkPurchaseMarkingColumn = 'NrKSeF' | 'OFF' | 'BFK' | 'DI'

/**
 * A purchase-register (`ZakupWiersz`) row captured for JPK_VAT (V7M/V7K). Kept out of the
 * country-agnostic core; there is no purchases module here, so this is the source of truth for
 * the buyer-side evidence. Linked by FK-id only (no cross-module ORM relation, §4). The numeric
 * amounts are stored as `text` to preserve the exact decimal strings the JPK builder emits.
 */
@Entity({ tableName: 'financial_pl_jpk_purchase_record' })
@Index({ name: 'financial_pl_jpk_purchase_record_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'financial_pl_jpk_purchase_record_period_idx', properties: ['organizationId', 'tenantId', 'year', 'month'] })
export class PurchaseVatRecord {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'context_nip', type: 'text', nullable: true })
  contextNip?: string | null

  @Property({ name: 'year', type: 'integer' })
  year!: number

  @Property({ name: 'month', type: 'integer' })
  month!: number

  @Property({ name: 'supplier_nip', type: 'text', nullable: true })
  supplierNip?: string | null

  @Property({ name: 'supplier_country_code', type: 'text', nullable: true })
  supplierCountryCode?: string | null

  @Property({ name: 'supplier_name', type: 'text', nullable: true })
  supplierName?: string | null

  @Property({ name: 'document_number', type: 'text' })
  documentNumber!: string

  @Property({ name: 'purchase_date', type: 'date' })
  purchaseDate!: string

  @Property({ name: 'receipt_date', type: 'date', nullable: true })
  receiptDate?: string | null

  @Property({ name: 'document_type', type: 'text', nullable: true })
  documentType?: JpkDokumentZakupuColumn | null

  @Property({ name: 'imp', type: 'boolean', default: false })
  imp = false

  @Property({ name: 'ksef_marking', type: 'text', nullable: true })
  ksefMarking?: JpkPurchaseMarkingColumn | null

  @Property({ name: 'nr_ksef', type: 'text', nullable: true })
  nrKsef?: string | null

  @Property({ name: 'transaction_class', type: 'text', default: 'domestic' })
  transactionClass: JpkTransactionClassColumn = 'domestic'

  @Property({ name: 'net_fixed_assets', type: 'text', nullable: true })
  netFixedAssets?: string | null

  @Property({ name: 'vat_fixed_assets', type: 'text', nullable: true })
  vatFixedAssets?: string | null

  @Property({ name: 'net_other', type: 'text', nullable: true })
  netOther?: string | null

  @Property({ name: 'vat_other', type: 'text', nullable: true })
  vatOther?: string | null

  @Property({ name: 'corr_fixed_assets', type: 'text', nullable: true })
  corrFixedAssets?: string | null

  @Property({ name: 'corr_other', type: 'text', nullable: true })
  corrOther?: string | null

  @Property({ name: 'corr_89b_1', type: 'text', nullable: true })
  corr89b1?: string | null

  @Property({ name: 'corr_89b_4', type: 'text', nullable: true })
  corr89b4?: string | null

  @Property({ name: 'margin_gross', type: 'text', nullable: true })
  marginGross?: string | null

  @Property({ name: 'self_assessed_net', type: 'text', nullable: true })
  selfAssessedNet?: string | null

  @Property({ name: 'self_assessed_vat', type: 'text', nullable: true })
  selfAssessedVat?: string | null

  @Property({ name: 'self_assessed_rate', type: 'text', nullable: true })
  selfAssessedRate?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date | null

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/** JPK_VAT filing variant: monthly V7M or quarterly V7K. */
export type JpkVariantColumn = 'V7M' | 'V7K'

/** Filing lifecycle: drafted, generated XML produced, submitted to the tax authority. */
export type JpkFilingStatusColumn = 'draft' | 'generated' | 'submitted'

/** Correction scope for `celZlozenia=2`: the declaration part, the evidence part, or both. */
export type JpkCorrectionScopeColumn = 'both' | 'declaration' | 'evidence'

/**
 * A single JPK_VAT filing (one period × variant × purpose). `generated_xml` is the built
 * JPK XML document — compliance-sensitive, declared in encryption.ts. `declaration_inputs`
 * carries the optional `JpkDeclarationInputs` overrides (prior surplus, manual P_49..P_660).
 * At most one ACTIVE (non-deleted) filing per period/variant/purpose, enforced via a partial
 * unique index (declared in the migration).
 */
@Entity({ tableName: 'financial_pl_jpk_filing' })
@Index({ name: 'financial_pl_jpk_filing_scope_idx', properties: ['organizationId', 'tenantId'] })
// At most one ACTIVE (non-deleted) filing per (org, tenant, context_nip, variant, year, month,
// purpose). `coalesce(context_nip, '')` keeps the uniqueness firm for a single-NIP (null) org while
// still permitting one filing per NIP in a multi-NIP org. Declared on the entity (not only the
// migration) so the ORM tracks it and `db:generate` keeps the snapshot in sync.
@Index({
  name: 'financial_pl_jpk_filing_active_unique',
  expression:
    `create unique index "financial_pl_jpk_filing_active_unique" on "financial_pl_jpk_filing" ("organization_id", "tenant_id", coalesce("context_nip", ''), "variant", "year", "month", "cel_zlozenia") where "deleted_at" is null`,
})
export class JpkVatFiling {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'context_nip', type: 'text', nullable: true })
  contextNip?: string | null

  @Property({ name: 'variant', type: 'text' })
  variant: JpkVariantColumn = 'V7M'

  @Property({ name: 'year', type: 'integer' })
  year!: number

  @Property({ name: 'month', type: 'integer' })
  month!: number

  @Property({ name: 'quarter', type: 'integer', nullable: true })
  quarter?: number | null

  @Property({ name: 'cel_zlozenia', type: 'integer', default: 1 })
  celZlozenia = 1

  @Property({ name: 'correction_scope', type: 'text', default: 'both' })
  correctionScope: JpkCorrectionScopeColumn = 'both'

  @Property({ name: 'kod_urzedu', type: 'text', nullable: true })
  kodUrzedu?: string | null

  @Property({ name: 'declaration_inputs', type: 'json', nullable: true })
  declarationInputs?: Record<string, unknown> | null

  @Property({ name: 'status', type: 'text', default: 'draft' })
  status: JpkFilingStatusColumn = 'draft'

  @Property({ name: 'generated_xml', type: 'text', nullable: true })
  generatedXml?: string | null

  @Property({ name: 'generated_at', type: Date, nullable: true })
  generatedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date | null

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
