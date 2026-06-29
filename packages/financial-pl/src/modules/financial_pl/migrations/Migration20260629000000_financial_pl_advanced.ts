import { Migration } from '@mikro-orm/migrations';

/**
 * SPEC-009 + SPEC-010 — advanced FA(3) document types (ZAL/ROZ/UPR/KOR_ZAL/KOR_ROZ),
 * self-billing, full OSS/WSTO_EE + FX, GTU/JPK markings, and offline mode (KOD II). Additive
 * on the live SPEC-005/006/007 schema:
 *  - financial_pl_invoice_meta: the explicit `invoice_kind` resolver-dispatch signal (default
 *    'vat' so every existing invoice keeps the VAT path), the self-billing / reverse-charge / OSS
 *    flags, OSS consumption country + FX rate/date, the advance/settlement/order JSON snapshots,
 *    and the pure-JPK GTU codes + 12 procedure markings + TypDokumentu. All nullable or defaulted
 *    so the ADD COLUMN is safe on a non-empty table.
 *  - financial_pl_ksef_submissions: the offline-issuance columns (issued-at, statutory send
 *    deadline, KOD I/II URLs, Offline cert serial) — all nullable, populated only on the offline
 *    path. Both partial active-unique indexes are widened to also cover `offline_issued` so an
 *    offline-issued row blocks a duplicate offline-issue AND an online submit for the same source
 *    document (no double registration).
 *
 * Online VAT/KOR/token/cert behaviour is byte-for-byte unchanged.
 */
export class Migration20260629000000_financial_pl_advanced extends Migration {

  override up(): void | Promise<void> {
    // SPEC-009 — financial_pl_invoice_meta
    this.addSql(`alter table "financial_pl_invoice_meta" add column "invoice_kind" text not null default 'vat';`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "self_billing" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "reverse_charge" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "oss_procedure" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "consumption_country_code" text null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "exchange_rate" text null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "exchange_rate_date" date null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "advance_payments" jsonb null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "advance_refs" jsonb null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "order_snapshot" jsonb null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "gtu_codes" jsonb null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "wsto_ee" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "ied" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "tp" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "tt_wnt" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "tt_d" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "mr_t" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "mr_uz" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "i_42" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "i_63" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "b_spv" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "b_spv_dostawa" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "b_mpv_prowizja" boolean not null default false;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "doc_type" text null;`);

    // SPEC-010 — financial_pl_ksef_submissions offline columns
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "offline_issued_at" timestamptz null;`);
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "offline_send_deadline_at" timestamptz null;`);
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "kod_i_url" text null;`);
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "kod_ii_url" text null;`);
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "offline_certificate_serial" text null;`);

    // SPEC-010 — widen BOTH active-unique indexes to also cover offline_issued
    this.addSql(`drop index "financial_pl_ksef_submissions_active_unique";`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id") where "status" in ('queued', 'processing', 'accepted', 'offline_issued') and "deleted_at" is null and "document_kind" = 'invoice';`);
    this.addSql(`drop index "financial_pl_ksef_submissions_credit_memo_active_unique";`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_credit_memo_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "credit_memo_id") where "credit_memo_id" is not null and "status" in ('queued', 'processing', 'accepted', 'offline_issued') and "deleted_at" is null;`);
  }

  override down(): void | Promise<void> {
    // Restore the SPEC-006 active-unique predicates (without offline_issued)
    this.addSql(`drop index "financial_pl_ksef_submissions_credit_memo_active_unique";`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_credit_memo_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "credit_memo_id") where "credit_memo_id" is not null and "status" in ('queued', 'processing', 'accepted') and "deleted_at" is null;`);
    this.addSql(`drop index "financial_pl_ksef_submissions_active_unique";`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id") where "status" in ('queued', 'processing', 'accepted') and "deleted_at" is null and "document_kind" = 'invoice';`);

    this.addSql(`alter table "financial_pl_ksef_submissions" drop column "offline_certificate_serial";`);
    this.addSql(`alter table "financial_pl_ksef_submissions" drop column "kod_ii_url";`);
    this.addSql(`alter table "financial_pl_ksef_submissions" drop column "kod_i_url";`);
    this.addSql(`alter table "financial_pl_ksef_submissions" drop column "offline_send_deadline_at";`);
    this.addSql(`alter table "financial_pl_ksef_submissions" drop column "offline_issued_at";`);

    this.addSql(`alter table "financial_pl_invoice_meta" drop column "doc_type";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "b_mpv_prowizja";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "b_spv_dostawa";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "b_spv";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "i_63";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "i_42";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "mr_uz";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "mr_t";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "tt_d";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "tt_wnt";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "tp";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "ied";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "wsto_ee";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "gtu_codes";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "order_snapshot";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "advance_refs";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "advance_payments";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "exchange_rate_date";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "exchange_rate";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "consumption_country_code";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "oss_procedure";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "reverse_charge";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "self_billing";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "invoice_kind";`);
  }

}
