import { Migration } from '@mikro-orm/migrations'

export class Migration20260630000000_financial_pl_spec015 extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "financial_pl_received_invoice" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "context_nip" text null, "ksef_number" text not null, "issuer_nip" text null, "issuer_name" text null, "buyer_identifier_type" text null, "buyer_identifier_value" text null, "issue_date" date null, "acquisition_date" date null, "invoice_type" text null, "currency" text null, "net_amount" text null, "gross_amount" text null, "vat_amount" text null, "invoice_hash" text null, "corrected_ksef_number" text null, "fa3_xml" text null, "linked_purchase_record_id" uuid null, "fetched_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "financial_pl_received_invoice_scope_idx" on "financial_pl_received_invoice" ("organization_id", "tenant_id");`);
    this.addSql(`create unique index "financial_pl_received_invoice_active_unique" on "financial_pl_received_invoice" ("organization_id", "tenant_id", coalesce("context_nip", ''), "ksef_number") where "deleted_at" is null;`);

    this.addSql(`create table "financial_pl_receive_cursor" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "context_nip" text null, "subject_type" text not null, "permanent_storage_hwm_date" text null, "last_synced_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "financial_pl_receive_cursor_active_unique" on "financial_pl_receive_cursor" ("organization_id", "tenant_id", coalesce("context_nip", ''), "subject_type") where "deleted_at" is null;`);

    this.addSql(`alter table "financial_pl_jpk_filing" add column "submission_reference" text null, add column "submitted_at" timestamptz null, add column "upo_xml" text null, add column "submission_error" text null;`);
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "batch_reference" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_ksef_submissions" drop column if exists "batch_reference";`);
    this.addSql(`alter table "financial_pl_jpk_filing" drop column if exists "submission_reference", drop column if exists "submitted_at", drop column if exists "upo_xml", drop column if exists "submission_error";`);

    this.addSql(`drop table if exists "financial_pl_receive_cursor" cascade;`);
    this.addSql(`drop table if exists "financial_pl_received_invoice" cascade;`);
  }

}
