import { Migration } from '@mikro-orm/migrations';

/**
 * SPEC-012 — art. 89a ust. 1 creditor bad-debt relief. Additive on financial_pl_invoice_meta: the
 * relief period (`YYYY-MM`) in which to claim the output-VAT reduction, and the invoice's payment
 * due date (`TerminPlatnosci`). Both nullable, so the ADD COLUMN is safe on a non-empty table; both
 * null ⇒ no relief. The JPK resolver emits a negated KorektaPodstawyOpodt SprzedazWiersz (→
 * P_68/P_69) for a flagged invoice in that period.
 */
export class Migration20260629130000_financial_pl_bad_debt extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_meta" add column "bad_debt_relief_period" text null;`);
    this.addSql(`alter table "financial_pl_invoice_meta" add column "bad_debt_termin_platnosci" date null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "bad_debt_termin_platnosci";`);
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "bad_debt_relief_period";`);
  }

}
