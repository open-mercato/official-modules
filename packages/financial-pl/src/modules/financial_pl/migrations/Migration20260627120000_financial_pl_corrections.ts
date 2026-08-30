import { Migration } from '@mikro-orm/migrations';

/**
 * SPEC-006 — correction (KOR) support + JPK_VAT marking signal. Additive on the live
 * SPEC-005 schema:
 *  - financial_pl_ksef_submissions: +document_kind (default 'invoice'), +credit_memo_id;
 *    the existing active-unique index is re-scoped to document_kind='invoice' and a twin
 *    credit-memo active-unique index is added (a correction is deduped by credit_memo_id,
 *    not the corrected invoice id).
 *  - financial_pl_invoice_meta: +issued_outside_ksef (drives the JPK_VAT `BFK` marking).
 *
 * The active-unique index is dropped + recreated with the tightened predicate; on this
 * module's small submissions table the gap is negligible and the application-level
 * idempotency (resolve-first + the document_kind-scoped lookup) still guards doubles.
 */
export class Migration20260627120000_financial_pl_corrections extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "document_kind" text not null default 'invoice';`);
    this.addSql(`alter table "financial_pl_ksef_submissions" add column "credit_memo_id" uuid null;`);
    this.addSql(`drop index "financial_pl_ksef_submissions_active_unique";`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id") where "status" in ('queued', 'processing', 'accepted') and "deleted_at" is null and "document_kind" = 'invoice';`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_credit_memo_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "credit_memo_id") where "credit_memo_id" is not null and "status" in ('queued', 'processing', 'accepted') and "deleted_at" is null;`);

    this.addSql(`alter table "financial_pl_invoice_meta" add column "issued_outside_ksef" boolean not null default false;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "financial_pl_invoice_meta" drop column "issued_outside_ksef";`);

    this.addSql(`drop index "financial_pl_ksef_submissions_credit_memo_active_unique";`);
    this.addSql(`drop index "financial_pl_ksef_submissions_active_unique";`);
    this.addSql(`create unique index "financial_pl_ksef_submissions_active_unique" on "financial_pl_ksef_submissions" ("organization_id", "tenant_id", "sales_invoice_id") where "status" in ('queued', 'processing', 'accepted') and "deleted_at" is null;`);
    this.addSql(`alter table "financial_pl_ksef_submissions" drop column "credit_memo_id";`);
    this.addSql(`alter table "financial_pl_ksef_submissions" drop column "document_kind";`);
  }

}
