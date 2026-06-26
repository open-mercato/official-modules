# SPEC-005: Magento 2 Data Sync Adapters

## TLDR
**Key Points:**
- Phase 1 (shipped, commit `c222f1c`) scaffolded `@open-mercato/sync-magento`: credentials, `MagentoSyncSettings` entity + settings UI, health check, REST client, and 4 `IntegrationDefinition`s (`magento_products`, `magento_prices`, `magento_inventory`, `magento_orders`) under the `data_sync` hub — but **no `DataSyncAdapter` is registered**, so `/api/data_sync/options` drops all four integrations and the Sync Schedule tab shows *"This integration is not registered as a data sync provider."*
- This spec defines `DataSyncAdapter` implementations for all four providers, registered via `registerDataSyncAdapter` in `sync_magento/di.ts`, making the Sync Schedule tabs functional and enabling real data flow with Magento 2.4 (issue #606).

**Scope:**
- Shared adapter infrastructure: settings loader, scoped Magento client factory, attribute/category/attribute-set provisioning (reusing `ExternalIdMappingService` — no new tables).
- **`magento_products`** (export, `catalog.product`): simple OM products → Magento simple products, with dynamic EAV attribute + category provisioning. **Fully specified (deep dive).**
- **`magento_prices`** (export, `catalog.product_price`): base + special prices → Magento price endpoints. *Architecture-level sketch — addendum spec recommended before implementation.*
- **`magento_inventory`** (export, `catalog.product_stock`): per-channel stock quantities (sourced from a configurable custom field) → Magento MSI source items. *Architecture-level sketch.*
- **`magento_orders`** (import, `sales.order`): Magento orders + customer/address data → `sales_orders` (+ `customer_entities` via command). *Architecture-level sketch.*

**Concerns:**
- No live Magento sandbox / detailed endpoint docs in this session. Every REST payload shape below is based on the public Magento 2.4 REST API and **must be validated against a real Magento instance before that phase's implementation is merged** (explicit per-phase review gate).
- OM core has no inventory/stock entity. Resolved (Open Questions, answered): Phase 4 sources stock from a configurable custom field per channel (`stock_qty_<channelCode>` convention), not a dedicated stock table.
- Magento EAV attributes/attribute sets are **global to the Magento instance**, not per-tenant. If two OM organizations share one Magento instance with an empty `attributeSetPrefix`, attribute codes can collide — documented as a risk with existing mitigation (non-empty prefix is the default).

---

## Overview

`@open-mercato/sync-magento` lets an OM tenant connect a Magento 2.4 store and synchronize catalog, pricing, inventory, and orders through the core `data_sync` hub. The hub already provides scheduling, run history, progress reporting, cursor persistence, and a generic admin UI (Sync Schedule tab) — all driven by `DataSyncAdapter` implementations registered per `providerKey`. This spec is the adapter layer that plugs Magento into that hub.

> **Market Reference**: Studied the Magento "M2E Pro"/"Mirakl" style connectors and the official Adobe Commerce REST integration patterns. Adopted: SKU-based product matching (Magento's natural key), MSI (`source-items`) for stock over legacy `stockItem` where available, and bulk price endpoints for the "fast price sync" path independent of full product sync. Rejected: full bidirectional two-way sync for products (Magento stays the "selling" system of record for price/stock display, OM stays the system of record for catalog content) — this avoids conflict-resolution complexity that even mature connectors struggle with.

## Problem Statement

1. **Immediate bug**: the Sync Schedule tab for all four Magento integrations is non-functional because no adapter is registered for `magento_products`, `magento_prices`, `magento_inventory`, `magento_orders`.
2. **Missing functionality**: even once registered, there is no code that actually talks to Magento's catalog/price/inventory/order REST endpoints using the settings already captured in `MagentoSyncSettings` (`channelStockMappings`, `channelStoreMappings`, `attributeCodeOverrides`, `attributeSetPrefix`, `customerStrategy`, image sync options, concurrency settings).
3. **No attribute/category provisioning**: OM custom fields and categories have no Magento counterpart; without provisioning, product export would fail for any product using custom attributes or assigned to categories.

## Proposed Solution

Implement four `DataSyncAdapter`s under `packages/sync-magento/src/modules/sync_magento/lib/adapters/`, plus shared helpers under `lib/`, registered from `di.ts`. Each adapter:
- Loads `MagentoSyncSettings` for the request scope (`createRequestContainer()` + `findOneWithDecryption`, mirroring the existing `api/settings/route.ts` pattern).
- Builds a `MagentoClient` from the resolved integration credentials (`createMagentoClient`, already implemented).
- Implements `getMapping`, `validateConnection`, and either `streamExport` or `streamImport` per the `DataSyncAdapter` contract (`@open-mercato/core/modules/data_sync/lib/adapter.ts`).
- Uses `ExternalIdMappingService` (already used by `sync_excel`) for **all** local↔external identity tracking — including non-entity mappings like "OM custom field key → Magento attribute code" and "OM category id → Magento category id" — so **no new database tables are introduced**.
- Emits the pre-declared `sync_magento.*` events (`events.ts`, already shipped in Phase 1) at the appropriate points.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Reuse `ExternalIdMappingService` for attribute/category/attribute-set ID caches instead of new tables | Avoids new migrations/entities for what is conceptually identical to existing external-id mapping; keeps the package's data model minimal (Singularity/no-bloat). |
| Phase 2 (`magento_products`) scopes to `productType: 'simple'` only | Magento SKU = 1 product; OM `catalog_products` already carries its own `sku` for simple products, so this is a clean 1:1 mapping without touching variant/configurable logic. Configurable products are a clearly-bounded follow-up. |
| Magento product matching key = SKU (`matchStrategy: 'sku'`) | Magento's REST API natively addresses products by SKU (`/rest/V1/products/{sku}`); no separate "Magento product ID" needs to be tracked for products themselves. |
| Attribute/category/attribute-set provisioning happens inline during `streamExport`, cached via id-mapping | First export run pays a one-time provisioning cost per attribute/category; subsequent runs hit the cache. Matches `attributeSetPrefix`/`attributeCodeOverrides` settings already exposed in the UI. |
| Phase 4 stock source = custom field per channel (`stock_qty_<channelCode>`) | OM core has no stock entity (confirmed via code search). A custom field is the only mechanism that fits the existing `custom_field_defs`/`custom_field_values` EAV system without a core schema change. |
| Phases 3–5 documented at architecture level only | Explicit user decision: deep-dive Phase 2 now, ship sketches for 3–5 with a short addendum spec before each phase's `implement-spec` pass. |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|---------------|
| New `sync_magento_id_map` entity for attribute/category caches | `ExternalIdMappingService` already provides exactly this (local id ↔ external id, scoped by `integrationId` + `entityType`); a parallel table would duplicate it. |
| Bidirectional product sync (Magento → OM catalog updates) | Out of scope for issue #606's stated goals; OM is the catalog system of record. Adding import direction for products would require conflict resolution not justified by current requirements. |
| Dedicated OM "inventory" entity as part of this package | Would violate "external extension, don't modify core for unrelated concerns" — and is a much larger cross-cutting change better suited to a core RFC. Custom-field-based stock is a pragmatic interim. |

## User Stories / Use Cases
- **Store admin** wants to **schedule a recurring export of OM catalog products to Magento** so that the storefront reflects current product data without manual CSV exports.
- **Store admin** wants to **push price changes (including promotional/special prices) to Magento independently of full catalog sync** so that price updates propagate quickly.
- **Warehouse manager** wants to **export per-channel stock levels to the correct Magento stock source (MSI)** so that storefront availability matches OM inventory.
- **Sales ops** wants to **import Magento orders (with customer + address data) into OM** so that all sales channels are visible in one place.

## Architecture

```
sync_magento/
├── di.ts                          # registers all 4 adapters via registerDataSyncAdapter
├── lib/
│   ├── client.ts                  # (existing) createMagentoClient
│   ├── health.ts                  # (existing) magentoHealthCheck
│   ├── preset.ts                  # (existing) env preset
│   ├── settings.ts                # NEW: loadMagentoSettings(em, scope) -> typed settings w/ defaults
│   ├── store-views.ts             # NEW: resolve store view code <-> store_id, MSI detection
│   └── adapters/
│       ├── shared.ts              # NEW: scope/container helpers, ExternalIdMapping helpers
│       ├── attributes.ts          # NEW: ensureAttribute / ensureAttributeSet (Phase 2)
│       ├── categories.ts          # NEW: ensureCategory (Phase 2)
│       ├── products.ts            # NEW: magento_products adapter (Phase 2 — deep dive)
│       ├── prices.ts              # NEW: magento_prices adapter (Phase 3 — sketch)
│       ├── inventory.ts           # NEW: magento_inventory adapter (Phase 4 — sketch)
│       └── orders.ts              # NEW: magento_orders adapter (Phase 5 — sketch)
```

### Data Flow (Phase 2 — products export)

```
SyncSchedule (data_sync hub)
  -> sync-engine.runExport(adapter=magento_products, entityType='catalog.product')
       -> adapter.getMapping()                # static field contract for UI
       -> adapter.streamExport({cursor, batchSize, credentials, mapping, scope})
            for each CatalogProduct (productType='simple', org/tenant scoped):
              -> ensureAttribute() per custom field   -> Magento /products/attributes
              -> ensureAttributeSet()                  -> Magento /products/attribute-sets
              -> ensureCategory() per category          -> Magento /categories
              -> PUT /rest/V1/products/{sku}            (create or update)
              -> POST /rest/V1/products/{sku}/media     (if imageSyncEnabled)
            yield ExportBatch{ results, cursor, hasMore, batchIndex }
       -> persists cursor, counters; emits sync_magento.product.exported per item
```

### Commands & Events
- **Event** (existing, Phase 1): `sync_magento.product.exported` — emitted per successfully exported product (Phase 2).
- **Event** (existing, Phase 1): `sync_magento.attribute_set.provisioned` — emitted the first time an attribute set is created for a tenant (Phase 2).
- **Event** (existing, Phase 1): `sync_magento.inventory.pushed` — emitted per export batch (Phase 4).
- **Event** (existing, Phase 1): `sync_magento.order.imported` — emitted per imported order (Phase 5).
- **Command** (cross-module, Phase 5): `sales.orders.create` via `CommandBus` — creates the OM order from a Magento order payload.
- **Command** (cross-module, Phase 5): `customers.people.create` via `CommandBus` — creates an OM customer when `customerStrategy: 'create_or_link'|'create_only'` and no match exists.

## Data Models

**No new entities or migrations.** This spec reuses:
- `MagentoSyncSettings` (existing, Phase 1) — read-only for adapters except `msiModeDetected` (Phase 4 writes this cache flag back).
- `SyncExternalIdMapping` (core `data_sync`, via `ExternalIdMappingService`) — used with the following `entityType` conventions, all scoped by `integrationId` (`sync_magento_products` / `sync_magento_orders` etc.) + `organizationId` + `tenantId`:

| `entityType` | `localId` | `externalId` | Set by |
|---|---|---|---|
| `catalog.product` | `CatalogProduct.id` | `sku` (Magento SKU, == OM sku) | Phase 2 (informational; matching is by SKU directly) |
| `magento_products.attribute` | custom field key (`<customFieldsetCode>:<key>`) | Magento `attribute_code` | Phase 2 |
| `magento_products.attribute_set` | `'default'` (one set per tenant scope for MVP) | Magento `attribute_set_id` | Phase 2 |
| `magento_products.category` | `CatalogProductCategory.id` | Magento `category_id` | Phase 2 |
| `sales.order` | `SalesOrder.id` | Magento order `entity_id` | Phase 5 |
| `customers.person` | `CustomerEntity.id` | Magento `customer_id` | Phase 5 |

## API Contracts

No new OM HTTP endpoints. Existing core `data_sync` endpoints (`/api/data_sync/options`, `/api/data_sync/run`, `/api/data_sync/runs`, `/api/data_sync/schedules`) become functional for the four `magento_*` providers once adapters are registered. `sync_magento`'s existing `/api/sync-magento/settings` and `/api/sync-magento/validate` are unchanged.

---

## Phase 2: `magento_products` (export, `catalog.product`) — Deep Dive

### Adapter shape

```ts
export const magentoProductsAdapter: DataSyncAdapter = {
  providerKey: 'magento_products',
  direction: 'export',
  supportedEntities: ['catalog.product'],
  runMode: 'generic',
  operationalTelemetry: true,
  getMapping,
  validateConnection,
  getInitialCursor: async () => null, // full export on first run
  streamExport,
}
```

### `getMapping`

Returns a static `DataMapping` describing the field contract shown in the Sync Schedule UI. Custom-field-derived attributes are **not** enumerated here individually (they vary per tenant and are resolved at export time) — instead a single `mappingKind: 'custom_field'` catch-all entry documents the behavior.

```ts
{
  entityType: 'catalog.product',
  matchStrategy: 'sku',
  matchField: 'sku',
  fields: [
    { externalField: 'sku',             localField: 'sku',            mappingKind: 'core', required: true, dedupeRole: 'primary' },
    { externalField: 'name',            localField: 'title',          mappingKind: 'core', required: true },
    { externalField: 'description',     localField: 'description',    mappingKind: 'core' },
    { externalField: 'status',          localField: 'isActive',        mappingKind: 'core', transform: 'isActive ? 1 : 2' },
    { externalField: 'weight',          localField: 'weightValue',     mappingKind: 'core' },
    { externalField: 'price',           localField: 'price',           mappingKind: 'relation', transform: 'defaultVariant.regularPrice' },
    { externalField: 'category_links',  localField: 'categoryAssignments', mappingKind: 'relation' },
    { externalField: 'media_gallery_entries', localField: 'defaultMediaUrl', mappingKind: 'relation' },
    { externalField: 'custom_attributes', localField: '*',            mappingKind: 'custom_field' },
  ],
}
```

### Settings usage (`loadMagentoSettings`)

| Setting | Used for |
|---|---|
| `attributeSetPrefix` | Naming auto-provisioned attribute codes (`<prefix>_<fieldKey>`) and the attribute set (`<prefix>_default`, or Magento's `Default` set if prefix is empty and no custom fields exist). |
| `attributeCodeOverrides` | Skip provisioning for listed `omFieldName`s; use the given `magentoAttributeCode` directly (assumed to pre-exist in Magento, e.g. native `color`/`size`). |
| `imageSyncEnabled` | If `false`, skip the media-gallery upload step entirely. |
| `imageUploadConcurrency`, `imageMaxDimension` | Bound the image-upload step (resize before upload if `imageMaxDimension > 0` and image exceeds it). |
| `productExportConcurrency` | Max products processed concurrently within a batch (`Promise.all` over chunks of this size). |
| `channelStoreMappings` | Resolves which OM `CatalogOffer`/price `channelId` corresponds to the "global"/default price written to `price` (first mapping, or null-channel price if no mapping exists). |

### Per-product export algorithm

For each `CatalogProduct` where `productType = 'simple'`, `deletedAt IS NULL`, `organizationId`/`tenantId` match scope, ordered by `(updatedAt, id)`:

1. **Skip guard**: if `sku` is empty, yield `ExportItemResult{ status: 'skipped', error: 'Missing SKU' }` and continue (Magento requires SKU).
2. **Resolve price**: load the product's default variant (`CatalogProductVariant.isDefault = true`) and its `CatalogProductVariantPrice` for the "regular" `CatalogPriceKind` (`isPromotion: false`), preferring the channel from the first `channelStoreMappings` entry, falling back to a global/no-channel price. *(Exact relation/field names to be confirmed against `packages/core/.../catalog/data/entities.ts` at implementation time — flagged as part of the per-phase review gate below.)*
3. **Resolve category links**: for each `CatalogProductCategoryAssignment` on the product, call `ensureCategory(category, ctx)` → Magento `category_id`. Build `category_links: [{ position, category_id }]`.
4. **Resolve custom attributes**: for each `CustomFieldValue` where `entityId = 'catalog:catalog_product'` and `recordId = product.id`:
   - If an `attributeCodeOverrides` entry matches the field's `key`, use its `magentoAttributeCode` directly.
   - Else call `ensureAttribute(fieldDef, ctx)` (provisions the attribute + adds it to the tenant's attribute set, caches via `magento_products.attribute` id-mapping) → `magentoAttributeCode`.
   - Append `{ attribute_code, value }` to `custom_attributes` (coercing per `CustomFieldDef.kind`: text/multiline → string, integer/float → number stringified per Magento convention, boolean → `'1'`/`'0'`, select → option value).
5. **Build Magento payload**:
   ```json
   {
     "product": {
       "sku": "...",
       "name": "...",
       "price": 0,
       "status": 1,
       "visibility": 4,
       "type_id": "simple",
       "weight": 0,
       "attribute_set_id": <from ensureAttributeSet>,
       "custom_attributes": [ { "attribute_code": "description", "value": "..." }, ... ],
       "extension_attributes": { "category_links": [ ... ] }
     }
   }
   ```
6. **Create or update**: `PUT /rest/V1/products/{sku}` with `saveOptions: true` query param — Magento's `PUT` is upsert (creates if SKU doesn't exist, updates otherwise), avoiding a separate existence check.
7. **Images** (if `imageSyncEnabled`): for `defaultMediaUrl` (and any gallery `Attachment`s for `entityId: 'catalog:catalog_product'`, `recordId: product.id`), fetch the binary, optionally resize to `imageMaxDimension`, base64-encode, and `POST /rest/V1/products/{sku}/media` with `{ entry: { media_type: 'image', content: { base64_encoded_data, type, name } } }`. Bound concurrency by `imageUploadConcurrency`. Skip images whose source URL is unchanged since last sync (track via `magento_products.product_image` id-mapping entry storing a content hash — *if this adds material complexity, defer dedup to Phase 2b and always re-upload for MVP*).
8. **Result**: on success, emit `sync_magento.product.exported` and yield `ExportItemResult{ localId: product.id, externalId: sku, status: 'success' }`. On per-item failure (any step above throws `MagentoApiError` or similar), yield `ExportItemResult{ status: 'error', error: message }` and continue with the next product — **never abort the whole batch for one item** (per `data_sync` MUST rules).

### Attribute / Attribute-Set / Category Provisioning (`lib/adapters/attributes.ts`, `categories.ts`)

**`ensureAttributeSet(ctx)`**:
1. Look up `magento_products.attribute_set` / `'default'` via `ExternalIdMappingService.lookupExternalId`. If found, return the cached `attribute_set_id`.
2. Else, `GET /rest/V1/products/attribute-sets/sets/list?searchCriteria[filterGroups][0][filters][0][field]=attribute_set_name&...[value]=<prefix>_default`. If found, cache and return its id.
3. Else, `POST /rest/V1/products/attribute-sets` with `{ attributeSet: { attribute_set_name: '<prefix>_default' }, skeletonId: 4 }` (4 = Magento's built-in `Default` set id, used as the skeleton to clone groups from). Cache and return the new id. Emit `sync_magento.attribute_set.provisioned`.
4. If `attributeSetPrefix` is `''` (empty), skip steps 2–3 entirely and use Magento's `Default` set (id `4`) directly — per the entity comment's documented collision-risk tradeoff.

**`ensureAttribute(fieldDef, ctx)`**:
1. Compute candidate code: `attributeSetPrefix ? `${attributeSetPrefix}_${slugify(fieldDef.key)}` : slugify(fieldDef.key)` (max 60 chars per Magento's attribute code constraint, regex `^[a-z][a-z0-9_]*$` — matches the existing `attributeCodeOverrideSchema` validator).
2. Look up `magento_products.attribute` / `<customFieldsetCode>:<fieldDef.key>` via id-mapping. If found, return cached code.
3. Else, `GET /rest/V1/products/attributes/{code}`. If `200`, the attribute already exists (created by a previous run or manually) — cache the mapping and return.
4. Else, `POST /rest/V1/products/attributes` with `{ attribute: { attribute_code: code, frontend_input: <mapped from fieldDef.kind>, default_frontend_label: fieldDef.label ?? fieldDef.key, is_required: false, is_user_defined: true } }`. `frontend_input` mapping: `text`→`text`, `multiline`→`textarea`, `integer`/`float`→`text`, `boolean`→`boolean`, `select`→`select` (with `options` built from `configJson.options`).
5. `POST /rest/V1/products/attribute-sets/{attributeSetId}/attributes` with `{ attributeSetId, attributeGroupId: <General/Product Details group id>, attributeCode: code, sortOrder: 0 }` to assign the new attribute into the tenant's set.
6. Cache `(customFieldsetCode:key) -> code` via `ExternalIdMappingService.storeExternalIdMapping`. Return `code`.
7. **Concurrency note**: if a parallel export run hits a `409`/"already exists" on step 4, treat as success and proceed to step 3's lookup (idempotent retry).

**`ensureCategory(category, ctx)`**:
1. Look up `magento_products.category` / `category.id` via id-mapping. If found, return cached `category_id`.
2. Recursively ensure the parent category first (if `category.parentId` set and not yet mapped), else use Magento's root category (id `2`, the default "Default Category", or a tenant-configurable root — MVP uses `2`).
3. `GET /rest/V1/categories?searchCriteria...` filtered by `name` under the resolved parent, or `POST /rest/V1/categories` with `{ category: { parent_id, name: category.name, is_active: category.isActive, include_in_menu: true } }` if not found.
4. Cache `category.id -> category_id` and return.

### Error Handling

- All Magento REST calls already throw `MagentoApiError(status, body)` (existing `client.ts`). Adapters catch this **per item**, log via `console.error`/operational log, and yield `status: 'error'` for that item only.
- `validateConnection` reuses `magentoHealthCheck.check(credentials)` logic (already implemented in `lib/health.ts`) — returns `{ ok: true }` if `status === 'healthy'`, else `{ ok: false, message }`.
- Provisioning failures (attribute/category/attribute-set) for one product fail only that product's export item — provisioning is retried on the next item/run (idempotent via id-mapping cache + existence checks).

### Registration (`di.ts`)

```ts
import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { magentoHealthCheck } from './lib/health'
import { registerDataSyncAdapter } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'
import { magentoProductsAdapter } from './lib/adapters/products'
import { magentoPricesAdapter } from './lib/adapters/prices'
import { magentoInventoryAdapter } from './lib/adapters/inventory'
import { magentoOrdersAdapter } from './lib/adapters/orders'

export function register(container: AppContainer) {
  container.register({
    magentoHealthCheck: asValue(magentoHealthCheck),
  })
  registerDataSyncAdapter(magentoProductsAdapter)
  registerDataSyncAdapter(magentoPricesAdapter)
  registerDataSyncAdapter(magentoInventoryAdapter)
  registerDataSyncAdapter(magentoOrdersAdapter)
}
```

### Phase 2 Review Gate (must pass before merge)

- [ ] Confirm exact relation path from `CatalogProduct` → default variant → `CatalogProductVariantPrice` (entity/field names) against current `packages/core/src/modules/catalog/data/entities.ts`.
- [ ] Confirm `PUT /rest/V1/products/{sku}` upsert behavior and `custom_attributes`/`extension_attributes.category_links` payload shape against Magento 2.4 REST docs / a real instance.
- [ ] Confirm `POST /rest/V1/products/attributes`, `attribute-sets/sets/list`, `attribute-sets/{id}/attributes`, and media-gallery (`/products/{sku}/media`) payload shapes against Magento 2.4 REST docs / a real instance.
- [ ] Confirm `CustomFieldDef`/`CustomFieldValue` query API (module path, method names) against current `entities`/`custom_fields` module.

---

## Phase 3: `magento_prices` (export, `catalog.product_price`) — Sketch

**Purpose**: "fast path" price-only sync, independent of full product export (per `integration.ts` description).

- `supportedEntities: ['catalog.product_price']`, `matchStrategy: 'sku'`.
- **Base prices**: for each `CatalogProduct`(simple) + its default variant's regular `CatalogProductVariantPrice`, batch into `POST /rest/V1/products/base-prices` with `{ prices: [{ sku, price }] }` (Magento bulk endpoint, returns per-item error array — map to `ExportItemResult[]`).
- **Special/promotional prices**: for `CatalogProductVariantPrice` rows where `priceKind.isPromotion = true` and `startsAt`/`endsAt` define a window, resolve the target Magento store view via `channelStoreMappings` (OM `channelId` → `storeViewCode` → numeric `store_id` via `lib/store-views.ts`), then `POST /rest/V1/products/special-price` with `{ prices: [{ price, store_id, sku, price_from, price_to }] }`.
- **Tier prices** (if `minQuantity`/`maxQuantity` populated on a non-promotional price kind): `POST /rest/V1/products/tier-prices` with `{ prices: [{ price, price_type: 'fixed', website_id, sku, customer_group, quantity }] }`.
- `getMapping`: fields `sku` (core, matchField), `price` (core), `special_price`/`special_from_date`/`special_to_date` (relation, from promotional price kind), `tier_prices` (relation).
- Cursor: same `(updatedAt, id)` pagination as Phase 2, but filtered to products whose price-related rows changed since `cursor` (requires `CatalogProductVariantPrice.updatedAt` if present, else fall back to product `updatedAt`).
- **Addendum spec needed before implementation**: confirm Magento bulk price endpoint exact paths/payloads (sync vs. async-bulk `/rest/V1/async.bulk/...` variants) and confirm `CatalogProductVariantPrice` field names for tier/promo detection.

## Phase 4: `magento_inventory` (export, `catalog.product_stock`) — Sketch

**Data source** (per Open Question Q1 resolution): a custom field per channel, named `stock_qty_<channelCode>`, defined on `entityId: 'catalog:catalog_product'`, where `<channelCode>` is `sales_channels.code` for the `channelId` in each `channelStockMappings` entry. Document this convention in the settings UI help text (`widget.client.tsx`, `channelStockMappings` section description) as part of this phase.

- `supportedEntities: ['catalog.product_stock']`, `matchStrategy: 'sku'`.
- **MSI detection** (`lib/store-views.ts`, cached in `MagentoSyncSettings.msiModeDetected`): on first run, `GET /rest/V1/inventory/sources` — `200` → MSI mode (`true`); `404`/error → legacy single-source mode (`false`). Cache the result; allow re-detection if a later run hits a `404` unexpectedly (self-healing).
- **MSI path**: for each `channelStockMappings` entry `{channelId, stockSource}`, for each simple product, read `CustomFieldValue` for `stock_qty_<channelCode>`, and batch into `POST /rest/V1/inventory/source-items` with `{ sourceItems: [{ sku, source_code: stockSource, quantity, status: quantity > 0 ? 1 : 0 }] }`.
- **Legacy path**: `PUT /rest/V1/products/{sku}` with `{ product: { extension_attributes: { stock_item: { qty, is_in_stock: qty > 0 } } } }`, using the *first* `channelStockMappings` entry as the single global stock value (legacy Magento has no per-source stock).
- `getMapping`: fields `sku` (core, matchField), `quantity` (custom_field, sourced per the `stock_qty_<channelCode>` convention — one logical field per configured channel mapping), `status`/`is_in_stock` (derived).
- Emits `sync_magento.inventory.pushed` per batch.
- **Addendum spec needed before implementation**: confirm `source-items` payload shape and `stock_item` extension_attributes shape against Magento 2.4 REST docs / a real instance; decide whether the `stock_qty_<channelCode>` custom fields are auto-created by this package's `setup.ts` or must be created manually by the tenant admin.

## Phase 5: `magento_orders` (import, `sales.order`) — Sketch

- `supportedEntities: ['sales.order']`, `matchStrategy: 'externalId'`, `matchField: 'entity_id'`.
- **Fetch**: `GET /rest/V1/orders?searchCriteria[filterGroups][0][filters][0][field]=updated_at&...[conditionType]=gt&...[value]=<cursor>` (+ a second filter group ANDing `status` `in` `orderImportStatuses` if non-empty), `sortOrders=[{field: updated_at, direction: ASC}]`, paginated via `currentPage`/`pageSize`.
- **Per order**:
  1. Resolve `channelId`: map Magento `store_id` → `storeViewCode` (via `lib/store-views.ts`) → `channelStoreMappings` entry → `channelId`; if no mapping, use `defaultOrderChannelId`; if neither, `status: 'skipped'` with an explanatory error (no channel to assign).
  2. Resolve customer per `customerStrategy`:
     - `skip`: no customer entity link; store `customer_email`/name in `customerSnapshot` jsonb only.
     - `create_or_link`: `ExternalIdMappingService.lookupLocalId('sync_magento_orders', 'customers.person', order.customer_id, scope)`; if absent, search `customer_entities` by `primaryEmail = order.customer_email`; if still absent, dispatch `customers.people.create` via `CommandBus`, then store the mapping.
     - `create_only`: always dispatch `customers.people.create` (no lookup/dedup), store mapping.
  3. Build `OrderCreateInput` for `sales.orders.create`: `orderNumber` = Magento `increment_id`, `externalReference` = Magento `entity_id`, `currencyCode` = `order_currency_code`, totals mapped from Magento `base_*`/`*` total fields, `placedAt` = `created_at`, line items from `order.items[]` (each → `sales_order_lines` with `catalog_snapshot` = `{sku, name, price}`, `product_id` left `null` if no local product match — per existing nullable schema), addresses from `order.billing_address`/`extension_attributes.shipping_assignments[0].shipping.address` into snapshot jsonb fields.
  4. Dispatch `sales.orders.create` via `CommandBus`; on success, `ExternalIdMappingService.storeExternalIdMapping('sync_magento_orders', 'sales.order', order.id, magentoOrder.entity_id, scope)`, emit `sync_magento.order.imported`, yield `ImportItem{ action: 'create', ... }`.
  5. If a mapping already exists for `entity_id`, yield `action: 'skip'` (status-update-on-reimport is out of scope for MVP; flag as Phase 5b).
- `getMapping`: fields for `entity_id` (external_id, matchField), `increment_id`→`orderNumber`, `order_currency_code`→`currencyCode`, `grand_total`→`grandTotalGrossAmount`, `customer_email`→ (relation to customer resolution), `items`→ (relation to order lines).
- **Addendum spec needed before implementation**: confirm `sales.orders.create` / `customers.people.create` command input shapes (exact field names) against current `packages/core/src/modules/sales` and `packages/core/src/modules/customers` command definitions; confirm Magento order search-criteria query construction helper (reuse if `lib/client.ts` or core already has a search-criteria builder, else add one to `lib/client.ts`).

---

## Internationalization (i18n)
- New settings UI copy for the `stock_qty_<channelCode>` custom-field convention (Phase 4) — add to `sync_magento/i18n/en.json` under `sync_magento.settings.fields.channelStockMappings.*`.
- No new user-facing strings required for Phase 2 (adapters are backend-only; existing Sync Schedule UI is generic).

## UI/UX
- No new pages/widgets. The existing generic `IntegrationScheduleTab` (core `data_sync`) renders once `/api/data_sync/options` returns these providers — this is the symptom fix.
- **Per-provider settings sections** (added post-implementation): all four `magento_*` integrations render the same `sync_magento.injection.settings` widget at the shared `syncMagentoDetailWidgetSpotId` and edit the same `MagentoSyncSettings` record, but the widget filters which `CrudFormGroup` sections are visible based on `data.integration.providerKey` (passed by the core integration detail page), so each integration only shows the settings it actually consumes:
  - `magento_products`: "Export performance & images", "Channel → store view mapping", "Attribute provisioning" (incl. `attributeSetPrefix`, moved out of the order/customer group).
  - `magento_prices`: "Channel → store view mapping".
  - `magento_inventory`: "Channel → stock source mapping".
  - `magento_orders`: "Order & customer sync", "Channel → store view mapping".
  - Unrecognized/missing `providerKey` falls back to showing all sections (defensive default, also preserves the original test that renders the widget without integration context).

## Configuration
- No new env vars. Existing `OM_INTEGRATION_MAGENTO_*` preset (Phase 1) remains the bootstrap path.

## Migration & Compatibility
- No schema changes. `MagentoSyncSettings.msiModeDetected` (already nullable, Phase 1) is written by Phase 4 on first run.

## Implementation Plan

### Phase 2: `magento_products` export adapter (deep-dive, this spec)
1. `lib/settings.ts` — `loadMagentoSettings(em, scope)` with typed defaults matching `serializeSettings` in `api/settings/route.ts`.
2. `lib/adapters/shared.ts` — scope/container helpers, `ExternalIdMappingService` wrapper.
3. `lib/adapters/attributes.ts` — `ensureAttributeSet`, `ensureAttribute`.
4. `lib/adapters/categories.ts` — `ensureCategory`.
5. `lib/adapters/products.ts` — `getMapping`, `validateConnection`, `streamExport` (core fields → price → categories → custom attributes → images).
6. `di.ts` — register `magentoProductsAdapter` (and shell-register Phases 3–5, see below).
7. Tests: unit tests for `ensureAttribute`/`ensureAttributeSet`/`ensureCategory` (mocked `MagentoClient`), and `streamExport` happy-path + per-item-error path (mocked EM + client).
8. Manual verification: confirm Sync Schedule tab for `sync_magento_products` no longer shows the "not registered" warning and shows the `catalog.product` mapping.

### Phase 3: `magento_prices` export adapter
1. Addendum spec: confirm bulk price endpoint shapes + `CatalogProductVariantPrice` tier/promo fields.
2. `lib/store-views.ts` — `storeViewCodeToStoreId`, `resolveChannelStoreMapping`.
3. `lib/adapters/prices.ts` — `getMapping`, `streamExport` (base/special/tier).
4. `di.ts` — register `magentoPricesAdapter`.
5. Tests + manual verification (Sync Schedule tab for `sync_magento_prices`).

### Phase 4: `magento_inventory` export adapter
1. Addendum spec: confirm `source-items`/`stock_item` payloads; decide custom-field auto-provisioning.
2. `lib/adapters/inventory.ts` — MSI detection, `getMapping`, `streamExport` (MSI + legacy paths).
3. `di.ts` — register `magentoInventoryAdapter`.
4. Tests + manual verification.

### Phase 5: `magento_orders` import adapter
1. Addendum spec: confirm `sales.orders.create`/`customers.people.create` command shapes; search-criteria builder.
2. `lib/adapters/orders.ts` — `getMapping`, `streamImport` (channel resolution, customer resolution, order creation).
3. `di.ts` — register `magentoOrdersAdapter`.
4. Tests + manual verification.

### File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `lib/settings.ts` | Create | Typed settings loader with defaults |
| `lib/store-views.ts` | Create | Store view / MSI helpers (Phases 3–4) |
| `lib/adapters/shared.ts` | Create | Shared scope/container/id-mapping helpers |
| `lib/adapters/attributes.ts` | Create | Attribute + attribute-set provisioning (Phase 2) |
| `lib/adapters/categories.ts` | Create | Category provisioning (Phase 2) |
| `lib/adapters/products.ts` | Create | `magento_products` adapter (Phase 2) |
| `lib/adapters/prices.ts` | Create | `magento_prices` adapter (Phase 3) |
| `lib/adapters/inventory.ts` | Create | `magento_inventory` adapter (Phase 4) |
| `lib/adapters/orders.ts` | Create | `magento_orders` adapter (Phase 5) |
| `di.ts` | Modify | `registerDataSyncAdapter` for all 4 |
| `i18n/en.json` | Modify | Stock-per-channel custom-field convention copy (Phase 4) |

### Testing Strategy
- Unit tests per adapter with a mocked `MagentoClient` (jest mock implementing `get/post/put/delete`) and a mocked `EntityManager`/`createRequestContainer`, following `__tests__/health.test.ts` and `__tests__/preset.test.ts` conventions already in this package.
- No integration tests against a live Magento instance in this repo (none available) — each phase's review gate substitutes for that validation before merge.

---

## Risks & Impact Review

### Data Integrity Failures
- Export is per-item: a crash mid-batch leaves some products exported and others not, but the **cursor is only persisted after a full batch completes** (per `sync-engine.ts`), so a retry re-processes the whole batch — `PUT /products/{sku}` upserts are idempotent, so re-processing is safe (no duplicates).
- Attribute/category provisioning writes to Magento (global resource) but caches via `ExternalIdMappingService` *after* the Magento call succeeds — if the process crashes between the Magento call and the cache write, the next run's existence-check (`GET /products/attributes/{code}` / category search) recovers the mapping without re-creating.
- Concurrent export runs for the same tenant (e.g. manual "Run now" while a schedule fires) could both attempt to provision the same new attribute — Magento returns `409`/validation error on duplicate `attribute_code`; adapters treat this as "already exists" and proceed to the lookup path (idempotent).

### Cascading Failures & Side Effects
- Phase 5 dispatches `sales.orders.create` and `customers.people.create` commands — if `sales`/`customers` modules reject the input (validation error), that order's import item is marked `status: 'failed'`/`action: 'failed'` and the run continues; no partial order/customer state is left because commands are expected to be transactional (verified in addendum spec).
- `sync_magento.*` events are `clientBroadcast: true` for product/order/inventory — a slow or failing subscriber must not block the export/import loop; events are fire-and-forget (`emitSyncMagentoEvent` is not awaited in a blocking way within the per-item loop).

### Tenant & Data Isolation Risks
- All OM-side queries (`CatalogProduct`, `CustomFieldValue`, `CustomerEntity`, etc.) are scoped by `organizationId`/`tenantId` from `TenantScope`, per `data_sync` MUST rules.
- **Magento-side risk**: attributes/attribute sets/categories are global within a Magento instance. If two OM tenants point at the **same** Magento instance with the **same** `attributeSetPrefix` (including both empty), their custom-field-derived attribute codes can collide, causing one tenant's attribute definition (e.g. `select` options) to be silently reused/overwritten by the other. Mitigation: default non-empty prefix (`'om'`) + documented warning on empty prefix (already present in entity comment); no automatic per-tenant namespacing is added because Magento attribute codes have a 60-char limit and typical setups use one Magento instance per tenant.

### Migration & Deployment Risks
- No DB migrations in this spec — zero-downtime by construction.
- First export run for a tenant with many custom fields/categories pays a one-time provisioning cost (N attribute + category API calls); subsequent runs are O(products) only. For tenants with very large catalogs, `productExportConcurrency` bounds Magento API load.

### Operational Risks
- `operationalTelemetry: true` on all adapters means run status feeds the existing integration health/operational-log UI (Phase 1 infra) — no new monitoring surface needed.
- Bulk endpoints (Phase 3/4) and per-item REST calls (Phase 2/5) are subject to Magento API rate limits; `productExportConcurrency`/`imageUploadConcurrency` settings exist specifically to let tenant admins tune this. No retry/backoff beyond the per-item error handling is implemented in MVP — a `429` is treated as a per-item failure, retried on the next scheduled run.

### Risk Register

#### Attribute code collision across tenants sharing one Magento instance
- **Scenario**: Two OM organizations configure the same Magento credentials with the same (or empty) `attributeSetPrefix`; both export products with a custom field of the same key but different `kind`/options.
- **Severity**: Medium
- **Affected area**: `magento_products` adapter, Magento product attributes globally
- **Mitigation**: Default `attributeSetPrefix: 'om'`; UI warning on empty prefix (already shipped); documented as a configuration responsibility.
- **Residual risk**: Accepted — multi-tenant-to-one-Magento-instance is an edge case not the primary deployment model.

#### Image upload cost/time on large catalogs
- **Scenario**: First full export of a catalog with thousands of products + multiple images each could take a very long time / hit Magento media storage limits.
- **Severity**: Medium
- **Affected area**: `magento_products` adapter image step
- **Mitigation**: `imageSyncEnabled` toggle (can disable entirely), `imageUploadConcurrency`/`imageMaxDimension` bound per-run cost; per-item failure isolation means one bad image doesn't fail the product.
- **Residual risk**: No dedup/skip-unchanged in MVP (Phase 2b candidate) — every run re-uploads images, which is wasteful but not incorrect.

#### Custom-field-based stock convention (`stock_qty_<channelCode>`) is undiscoverable
- **Scenario**: Tenant admin configures `channelStockMappings` but never creates the matching `stock_qty_<channelCode>` custom field, so Phase 4 exports zero/empty quantities silently.
- **Severity**: Medium
- **Affected area**: `magento_inventory` adapter
- **Mitigation**: Document the convention prominently in the settings UI (`channelStockMappings` section description) and in `validateConnection`/per-run operational log (warn if the expected custom field is missing for the configured channel).
- **Residual risk**: Accepted for MVP — full auto-provisioning of the custom field via `setup.ts` is a Phase 4 addendum decision.

#### Magento order import has no update/re-sync path
- **Scenario**: An order is imported, then its status changes in Magento (e.g. `processing` → `complete`); Phase 5 MVP skips already-mapped orders rather than updating OM order status.
- **Severity**: Low
- **Affected area**: `magento_orders` adapter
- **Mitigation**: Documented as Phase 5b follow-up; MVP still provides full visibility of new orders, which is the primary use case.
- **Residual risk**: Accepted — order status sync is a clearly-scoped follow-up, not silently broken (explicitly `action: 'skip'`, not an error).

---

## Final Compliance Report — 2026-06-12

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)
- `packages/sync-magento/` (no package-level AGENTS.md found; root conventions apply)
- `data_sync/AGENTS.md` (core, read via `/home/al/work/spyro/open-mercato/packages/core/src/modules/data_sync/AGENTS.md`)

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules (FK IDs only) | Compliant | Adapters read core entities via EntityManager queries (read-only) and call other modules only via `CommandBus` (Phase 5) — no cross-module `@ManyToOne`. |
| root AGENTS.md | `organization_id`/`tenant_id` scoping on all queries | Compliant | All entity queries use `TenantScope` from `StreamExportInput`/`StreamImportInput`. |
| root AGENTS.md | Package placement under `packages/<name>/` | Compliant | All new files under `packages/sync-magento/src/modules/sync_magento/`. |
| data_sync/AGENTS.md | Always scope by organizationId + tenantId | Compliant | See above. |
| data_sync/AGENTS.md | Never run syncs inline; use queue system | Compliant | Adapters only implement `streamExport`/`streamImport`; orchestration/queueing is core `data_sync`'s responsibility (unchanged). |
| data_sync/AGENTS.md | Persist cursor after each batch | Compliant | Handled by `sync-engine.ts` (unchanged); adapters return `cursor`/`hasMore` per `ExportBatch`/`ImportBatch`. |
| data_sync/AGENTS.md | Log item-level errors, don't stop sync for individual failures | Compliant | Every phase's algorithm specifies per-item try/catch → `status: 'error'`/`action: 'failed'`, loop continues. |
| data_sync/AGENTS.md | New providers MUST support env preconfiguration | Compliant | Already shipped in Phase 1 (`lib/preset.ts`, `cli.ts`); no change needed. |
| data_sync/AGENTS.md | API routes must export `openApi` | N/A | No new HTTP routes added by this spec. |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | No new data models/API contracts — explicitly stated. |
| API contracts match UI/UX section | Pass | UI/UX explicitly states no new pages; relies on existing generic Sync Schedule tab. |
| Risks cover all write operations | Pass | Magento writes (Phase 2/3/4) and OM writes via commands (Phase 5) both covered in Risk Register. |
| Commands defined for all mutations | Pass | Phase 5 mutations go through `sales.orders.create`/`customers.people.create`; Phases 2–4 mutate only the *external* Magento system (no OM entity mutations, so no OM commands needed). |
| Cache strategy covers all read APIs | N/A | No new OM read APIs introduced. |

### Non-Compliant Items
None.

### Verdict
- **Fully compliant for Phase 2 (deep-dive)**: Approved — ready for `implement-spec`, subject to the Phase 2 Review Gate checklist above being completed during implementation (Magento payload shapes + exact core entity relation names).
- **Phases 3–5 (sketches)**: Each requires a short addendum (architecture already approved here; addendum confirms the specific REST/command payload shapes per its own review-gate checklist) before its `implement-spec` pass.

## Implementation Status

### Phase 2: `magento_products` (export) — Implemented
- `lib/settings.ts`, `lib/adapters/shared.ts`, `lib/adapters/attributes.ts`, `lib/adapters/categories.ts`, `lib/adapters/products.ts` created; `magentoProductsAdapter` registered via `registerDataSyncAdapter` in `di.ts`.
- Unit tests added: `__tests__/attributes.test.ts`, `__tests__/categories.test.ts`, `__tests__/products.test.ts`. `yarn workspace @open-mercato/sync-magento build`/`typecheck`/`test` all pass (8 suites, 95 tests).
- Compliance self-review: no `any`, no raw `em.find`/`em.findOne` (all queries via `findWithDecryption`/`findOneWithDecryption`); the only raw `fetch` is in `uploadProductImage` (downloading external image bytes from `defaultMediaUrl`, not an OM database query — outside the encryption-helper convention).

#### Phase 2 Review Gate — resolved during implementation
- [x] Relation path from `CatalogProduct` → default variant → price: the regular-price entity is **`CatalogProductPrice`** (not `CatalogProductVariantPrice` as sketched) — `resolveProductPrice()` looks up `CatalogProductVariant.isDefault = true`, then `CatalogProductPrice` scoped by `variant`/`product` id + `priceKind.isPromotion: false`, preferring the first `channelStoreMappings` channel then falling back to `channelId: null`.
- [x] `CustomFieldDef`/`CustomFieldValue` query API confirmed against `@open-mercato/core/modules/entities/data/entities` — both queried via `findWithDecryption`, matched by `entityId: 'catalog:catalog_product'` + `recordId`/`key`/`fieldKey`.
- [x] `sync_magento.product.exported` is emitted fire-and-forget (`.catch()`-guarded, not awaited) inside the per-item export loop in `exportProduct`, per the "Risks & Impact" requirement that a slow/failing event subscriber must not block product export throughput.
- [ ] `PUT /rest/V1/products/{sku}` upsert payload (`custom_attributes`, `extension_attributes.category_links`) and the `/products/attributes`, `attribute-sets/sets/list`, `attribute-sets/{id}/attributes`, `/products/{sku}/media` payload shapes are implemented per this spec's sketch but **not validated against a live Magento 2.4 instance** — residual risk, unchanged from the original spec (no sandbox available in this session).

### Adapter registration for Phases 3–5 (shell adapters)
To resolve the original bug ("This integration is not registered as a data sync provider") for all four Sync Schedule tabs, `magentoPricesAdapter`, `magentoInventoryAdapter`, and `magentoOrdersAdapter` were added as **registered shells**: each implements `getMapping`/`validateConnection` (per this spec's Phase 3–5 sketches) but **no `streamExport`/`streamImport`** yet. This makes the Sync Schedule tabs functional (mapping preview, connection validation) without enabling actual data transfer for those three providers. Full `streamExport`/`streamImport` implementations remain pending the addendum specs called out in Phases 3–5.

## Changelog
### 2026-06-12
- Initial specification covering all four Magento data sync adapters; Phase 2 (`magento_products`) deep-dived per user decision, Phases 3–5 sketched at architecture level for addendum specs.

### 2026-06-12 (implementation)
- Implemented Phase 2 (`magento_products` export adapter) plus shared provisioning helpers (`shared.ts`, `settings.ts`, `attributes.ts`, `categories.ts`); added unit tests. Registered all four adapters in `di.ts` (`magentoProductsAdapter` full; `magentoPricesAdapter`/`magentoInventoryAdapter`/`magentoOrdersAdapter` as mapping/validation-only shells), resolving "This integration is not registered as a data sync provider" for all four Sync Schedule tabs.

### 2026-06-15 (settings UI)
- `widgets/injection/settings-tab/widget.client.tsx`: the shared "Magento Sync Settings" widget now filters its `CrudFormGroup` sections by `data.integration.providerKey`, so each of the 4 integration detail pages (`magento_products`/`magento_prices`/`magento_inventory`/`magento_orders`) only shows the settings sections relevant to that adapter (see UI/UX section). Moved `attributeSetPrefix` from the "Order & customer sync" group into the renamed "Attribute provisioning" group (was "Attribute code overrides"). Updated `i18n/en.json` and added widget tests per provider (`__tests__/settings-widget.render.test.tsx`).

### 2026-06-16 (configurable product support)
- `magento_products` adapter now exports `productType: 'configurable'` products in addition to `'simple'` ones.
- `buildProductWhere` changed to `productType: { $in: ['simple', 'configurable'] }`.
- New `exportConfigurableProduct` function: loads variants, exports each as a Magento `simple` child (`visibility: 1`, collects returned `id`), provisions configurable dimensions via new `ensureConfigurableAttribute` (`frontend_input: 'select'`, `scope: 'global'`), resolves per-variant option values to Magento `option_id`s, PATCHes each variant with its option attribute values, then PUTs the configurable parent with `type_id: 'configurable'`, `configurable_product_options`, and `configurable_product_links`.
- `shared.ts`: added `configurableAttributeCache: Map<string, string>` (option code → Magento attribute_code, in-run) and `magentoAttributeIdCache: Map<string, number>` (attribute_code → Magento integer `attribute_id`, in-run).
- `attributes.ts`: refactored `resolveAttributeOptionId` via internal `fetchAndCacheAttribute` helper that also populates `magentoAttributeIdCache`; added `resolveAttributeId` and `ensureConfigurableAttribute` exports.
- 3 new unit tests added (`__tests__/products.test.ts`); all 112 tests pass.
