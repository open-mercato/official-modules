import { Migration } from '@mikro-orm/migrations';

/**
 * Per-organization invoice issuing settings: logo + footer note (presentation) and the defaults a
 * new invoice starts from. Seller identity stays on the ksef_pl credential and numbering stays in
 * core sales — this table holds only what neither of them owns.
 */
export class Migration20260726000000_financial_pl_invoice_settings extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table if not exists "financial_pl_invoice_settings" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "logo_data_url" text null, "footer_note" text null, "default_payment_method" text null, "default_term_days" int null, "default_tax_rate" text null, "default_currency_code" text null, "default_price_mode" text null, "default_bank_account" text null, "default_bank_name" text null, "created_at" timestamptz not null, "updated_at" timestamptz null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index if not exists "financial_pl_invoice_settings_active_unique" on "financial_pl_invoice_settings" ("organization_id", "tenant_id") where "deleted_at" is null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "financial_pl_invoice_settings" cascade;`);
  }
}
