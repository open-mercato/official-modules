import { Migration } from '@mikro-orm/migrations';

export class Migration20260622203145_financial_pl extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "financial_pl_ksef_submissions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "sales_invoice_id" uuid not null, "environment" text not null default 'test', "mode" text not null default 'online', "status" text not null default 'queued', "context_nip" text not null, "invoice_xml" text null, "session_reference" text null, "invoice_reference" text null, "ksef_number" text null, "upo_ref" text null, "upo_xml" text null, "last_status_code" int null, "last_error_code" text null, "last_error_message" text null, "attempt_count" int not null default 0, "submitted_at" timestamptz null, "accepted_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "financial_pl_ksef_submissions_invoice_idx" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id");`);
    this.addSql(`create index "financial_pl_ksef_submissions_scope_idx" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id");`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id") where "status" in ('queued', 'processing', 'accepted') and "deleted_at" is null;`);

    this.addSql(`create table "financial_pl_invoice_meta" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "sales_invoice_id" uuid not null, "context_nip" text null, "ksef_status" text not null default 'not_applicable', "ksef_number" text null, "mpp_required" boolean not null default false, "vat_exemption_basis" text null, "created_at" timestamptz not null, "updated_at" timestamptz null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "financial_pl_invoice_meta_scope_idx" on "financial_pl_invoice_meta" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "financial_pl_invoice_meta" add constraint "financial_pl_invoice_meta_invoice_unique" unique ("organization_id", "tenant_id", "sales_invoice_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "financial_pl_invoice_meta" cascade;`);
    this.addSql(`drop table if exists "financial_pl_ksef_submissions" cascade;`);
  }

}
