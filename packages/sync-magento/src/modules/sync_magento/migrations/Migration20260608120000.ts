import { Migration } from '@mikro-orm/migrations';

export class Migration20260608120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "sync_magento_settings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "channel_stock_mappings" jsonb null, "channel_store_mappings" jsonb null, "order_import_statuses" jsonb null, "default_order_channel_id" uuid null, "customer_strategy" text not null default 'create_or_link', "attribute_set_prefix" text not null default 'om', "attribute_code_overrides" jsonb null, "image_sync_enabled" boolean not null default true, "product_export_concurrency" int not null default 3, "image_upload_concurrency" int not null default 5, "image_max_dimension" int not null default 2000, "msi_mode_detected" boolean null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "sync_magento_settings_pkey" primary key ("id"), constraint "sync_magento_settings_scope_unique" unique ("tenant_id", "organization_id"));`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "sync_magento_settings" cascade;`);
  }

}
