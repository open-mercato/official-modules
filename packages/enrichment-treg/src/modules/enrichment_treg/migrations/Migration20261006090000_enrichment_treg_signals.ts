import { Migration } from '@mikro-orm/migrations';

export class Migration20261006090000_enrichment_treg_signals extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "enrichment_treg_signals" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "subject_type" text not null, "subject_id" uuid not null, "record_id" uuid not null, "signal_type" text not null, "title" text not null, "summary" text null, "url" text null, "location" text null, "occurred_at" timestamptz null, "source" text null, "payload" jsonb not null, "dedupe_hash" text not null, "first_seen_at" timestamptz not null, "last_seen_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "enrichment_treg_signals_timeline_idx" on "enrichment_treg_signals" ("tenant_id", "organization_id", "subject_type", "subject_id", "occurred_at");`);
    this.addSql(`alter table "enrichment_treg_signals" add constraint "enrichment_treg_signals_dedupe_uq" unique ("tenant_id", "organization_id", "subject_id", "dedupe_hash");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "enrichment_treg_signals" cascade;`);
  }

}
