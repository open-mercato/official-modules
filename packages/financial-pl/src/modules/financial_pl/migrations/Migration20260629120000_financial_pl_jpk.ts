import { Migration } from '@mikro-orm/migrations';

/**
 * JPK_VAT (V7M/V7K) buyer-side evidence + filing storage. Two new tables, additive on the
 * SPEC-005..010 schema (no change to invoice_meta / ksef_submissions):
 *  - financial_pl_jpk_purchase_record: a captured purchase-register (`ZakupWiersz`) row. There is
 *    no purchases module here, so this is the source of truth for the buyer side. Numeric amounts
 *    are `text` to preserve the exact decimal strings the JPK builder emits. Indexed by scope and
 *    by (organization_id, tenant_id, year, month) for per-period register reads.
 *  - financial_pl_jpk_filing: one JPK_VAT filing per period × variant × purpose. `generated_xml`
 *    is the built XML (encrypted at rest, see encryption.ts). A partial unique index keeps at most
 *    one ACTIVE (non-deleted) filing per (organization_id, tenant_id, context_nip, variant, year,
 *    month, cel_zlozenia). `coalesce(context_nip, '')` keeps the uniqueness firm when the NIP is
 *    null (a single-NIP org), while still permitting one filing per NIP in a multi-NIP org/tenant.
 */
export class Migration20260629120000_financial_pl_jpk extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "financial_pl_jpk_purchase_record" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "context_nip" text null, "year" int not null, "month" int not null, "supplier_nip" text null, "supplier_country_code" text null, "supplier_name" text null, "document_number" text not null, "purchase_date" date not null, "receipt_date" date null, "document_type" text null, "imp" boolean not null default false, "ksef_marking" text null, "nr_ksef" text null, "transaction_class" text not null default 'domestic', "net_fixed_assets" text null, "vat_fixed_assets" text null, "net_other" text null, "vat_other" text null, "corr_fixed_assets" text null, "corr_other" text null, "corr_89b_1" text null, "corr_89b_4" text null, "margin_gross" text null, "self_assessed_net" text null, "self_assessed_vat" text null, "self_assessed_rate" text null, "created_at" timestamptz not null, "updated_at" timestamptz null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "financial_pl_jpk_purchase_record_scope_idx" on "financial_pl_jpk_purchase_record" ("organization_id", "tenant_id");`);
    this.addSql(`create index "financial_pl_jpk_purchase_record_period_idx" on "financial_pl_jpk_purchase_record" ("organization_id", "tenant_id", "year", "month");`);

    this.addSql(`create table "financial_pl_jpk_filing" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "context_nip" text null, "variant" text not null default 'V7M', "year" int not null, "month" int not null, "quarter" int null, "cel_zlozenia" int not null default 1, "correction_scope" text not null default 'both', "kod_urzedu" text null, "declaration_inputs" jsonb null, "status" text not null default 'draft', "generated_xml" text null, "generated_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "financial_pl_jpk_filing_scope_idx" on "financial_pl_jpk_filing" ("organization_id", "tenant_id");`);
    this.addSql(`create unique index "financial_pl_jpk_filing_active_unique" on "financial_pl_jpk_filing" ("organization_id", "tenant_id", coalesce("context_nip", ''), "variant", "year", "month", "cel_zlozenia") where "deleted_at" is null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "financial_pl_jpk_filing" cascade;`);
    this.addSql(`drop table if exists "financial_pl_jpk_purchase_record" cascade;`);
  }

}
