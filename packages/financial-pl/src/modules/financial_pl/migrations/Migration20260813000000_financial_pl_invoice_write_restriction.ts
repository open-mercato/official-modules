import { Migration } from '@mikro-orm/migrations';

/**
 * Add the opt-in invoice-write restriction flag (QA #35).
 *
 * When `restrict_invoice_write` is true, the module's API interceptor requires the
 * `financial_pl.invoices.manage` feature on core sales-invoice writes; when null/false it is
 * unrestricted, so the change is backward compatible for every existing organization.
 */
export class Migration20260813000000_financial_pl_invoice_write_restriction extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_settings" add column if not exists "restrict_invoice_write" boolean null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_settings" drop column if exists "restrict_invoice_write";`);
  }
}
