import { Migration } from '@mikro-orm/migrations';

/**
 * SPEC-009 — VAT marża metadata. Additive on financial_pl_invoice_meta: the invoice-wide margin
 * procedure subtype, optional purchase cost for JPK margin decomposition, and the VAT rate used
 * for that decomposition. All nullable, so existing invoices keep the standard VAT path.
 */
export class Migration20260702000000_financial_pl_margin extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_meta" add column if not exists "margin_scheme" text null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column if not exists "margin_purchase_cost" text null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column if not exists "margin_vat_rate" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "margin_vat_rate";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "margin_purchase_cost";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "margin_scheme";`);
  }

}
