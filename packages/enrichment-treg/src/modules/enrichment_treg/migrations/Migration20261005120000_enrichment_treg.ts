import { Migration } from '@mikro-orm/migrations';

export class Migration20261005120000_enrichment_treg extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "enrichment_treg_records" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "subject_type" text not null, "subject_id" uuid not null, "status" text not null default 'pending', "failure_reason" text null, "endpoint_id" text not null, "identity" jsonb not null, "served_by" text null, "treg_call_id" text null, "cost_micro" int not null default 0, "proposal" jsonb null, "summary" jsonb null, "raw_payload" jsonb null, "applied_fields" jsonb null, "applied_at" timestamptz null, "applied_by_user_id" uuid null, "requested_by_user_id" uuid null, "fetched_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "enrichment_treg_records_subject_idx" on "enrichment_treg_records" ("tenant_id", "organization_id", "subject_type", "subject_id", "created_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "enrichment_treg_records" cascade;`);
  }

}
