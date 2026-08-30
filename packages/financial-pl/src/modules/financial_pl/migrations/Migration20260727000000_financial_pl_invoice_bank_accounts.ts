import { Migration } from '@mikro-orm/migrations';

/**
 * Replace the single default bank account with a list.
 *
 * A seller commonly settles in more than one account — a PLN account and a EUR one, or a separate
 * account per brand — and the account number is printed on the invoice, so the choice belongs to
 * the invoice rather than to a global default. The two scalar columns are backfilled into the first
 * list entry (marked default) so nothing already configured is lost, then dropped.
 */
export class Migration20260727000000_financial_pl_invoice_bank_accounts extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_settings" add column if not exists "bank_accounts" jsonb null;`);
    this.addSql(`update "financial_pl_invoice_settings"
      set "bank_accounts" = jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'label', null,
        'accountNumber', "default_bank_account",
        'bankName', "default_bank_name",
        'swift', null,
        'isDefault', true
      ))
      where "bank_accounts" is null
        and "default_bank_account" is not null
        and length(trim("default_bank_account")) > 0;`);
    this.addSql(`alter table "financial_pl_invoice_settings" drop column if exists "default_bank_account";`);
    this.addSql(`alter table "financial_pl_invoice_settings" drop column if exists "default_bank_name";`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_settings" add column if not exists "default_bank_account" text null;`);
    this.addSql(`alter table "financial_pl_invoice_settings" add column if not exists "default_bank_name" text null;`);
    this.addSql(`update "financial_pl_invoice_settings"
      set "default_bank_account" = "bank_accounts" -> 0 ->> 'accountNumber',
          "default_bank_name" = "bank_accounts" -> 0 ->> 'bankName'
      where "bank_accounts" is not null and jsonb_array_length("bank_accounts") > 0;`);
    this.addSql(`alter table "financial_pl_invoice_settings" drop column if exists "bank_accounts";`);
  }
}
