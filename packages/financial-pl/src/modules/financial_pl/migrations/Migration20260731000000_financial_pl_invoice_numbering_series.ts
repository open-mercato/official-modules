import { Migration } from '@mikro-orm/migrations';

/**
 * Numbering series METADATA (code, name, format) on the invoice settings row.
 *
 * Metadata only by design: each series' counter is core's `sales_document_sequences` row under the
 * namespaced document kind `invoice:<CODE>` (created lazily by core's generator upsert on first
 * claim), so this migration touches no counter state and there is nothing to backfill — an
 * organization without configured series keeps the system-default numbering untouched.
 */
export class Migration20260731000000_financial_pl_invoice_numbering_series extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_settings" add column if not exists "numbering_series" jsonb null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_settings" drop column if exists "numbering_series";`);
  }
}
