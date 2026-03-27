# SPEC-004: DHL Parcel Carrier Module

## TLDR

**Key Points:**
- `@open-mercato/carrier-dhl-parcel` — a shipping carrier module that integrates DHL Parcel eCommerce (Benelux / international) into Open Mercato via the `api-gw.dhlparcel.nl` Gateway API.
- Follows the exact same shape as `@open-mercato/carrier-inpost`: implements the `ShippingAdapter` contract, registers via `registerShippingAdapter`, surfaces a configuration widget in the Integrations hub, and injects a tracking widget into the order shipping detail panel.

**Scope:**
- JWT authentication with automatic token refresh: `userId` + `key` (pre-shared secret from My DHL Portal) → short-lived `accessToken` + rotating `refreshToken`, cached in-memory by `TokenManager`
- Create shipment (label generation) — domestic NL and EU cross-border
- Rate calculation via `GET /capabilities/business` + `GET /parcel-types/business/{fromCountry}`
- Shipment tracking via `GET /track-trace`
- Label download as base64 PDF/ZPL via `GET /labels/{id}`
- Shipment cancellation (not supported by DHL API — adapter returns a `not_supported` error)
- Push-based webhook tracking via DHL Track-Trace Pusher (Phase 2)
- Parcel shop / service-point lookup via `GET /parcel-shop-locations/{countryCode}`
- Integration credentials UI widget (config tab in Integration detail page)
- Tracking injection widget in Order → Shipping detail panel

**Concerns:**
- DHL JWT tokens are short-lived (expiration timestamp returned). The `TokenManager` caches them in-memory only — they are never persisted. Cache is lost on process restart; first request after restart triggers a full re-auth (~200ms).
- DHL `userId` + `key` are generated once in My DHL Portal and shown only once — operators must copy them immediately and paste them into the config UI.
- DHL does not support cancellation via API — calls to `cancelShipment` must degrade gracefully.
- Shipment creation requires a client-generated UUID (`shipmentId`) — the adapter supplies this and uses it as the external shipment identifier.

---

## Overview

DHL Parcel eCommerce (formerly DHL Parcel Benelux) is the dominant parcel carrier in the Netherlands, Belgium, and Luxembourg, with strong EU cross-border coverage. Merchants shipping from NL/BE lack a native DHL carrier module in Open Mercato; they currently have to manage labels outside the platform.

This module closes that gap by wrapping the `api-gw.dhlparcel.nl` Gateway API (OpenAPI spec at `/docs/combined.json`) in a `ShippingAdapter` implementation, identical in contract to `carrier-inpost`. Once installed and configured, the module appears as a selectable carrier in any Shipping Carrier–aware workflow (order fulfilment, rate-shopping, return labels).

> **Market Reference**: Shopify Shipping and Sendcloud both treat DHL Parcel NL as a first-class carrier. Key adopter: they cache available parcel types per account on first auth rather than at shipment time. We adopt the same lazy-cache approach (Phase 2 enhancement); MVP fetches parcel types inline. We reject Sendcloud's approach of storing tokens permanently — tokens refresh per-request when near expiry.

---

## Problem Statement

Open Mercato ships with a `shipping_carriers` core module that exposes a `ShippingAdapter` abstraction. `carrier-inpost` demonstrates how to fill that abstraction for a Polish carrier. There is no equivalent for DHL Parcel, which is the primary carrier for NL/BE-origin merchants. Without this module:

- Operators must generate DHL labels out-of-band and paste tracking numbers manually.
- Rate-shopping across carriers is impossible inside the platform.
- Shipment status is not reflected in the order timeline.

---

## Proposed Solution

Implement `carrier-dhl-parcel` as a pure external module — no core package modifications. The module:

1. Registers a `ShippingAdapter` (`providerKey: 'dhl_parcel'`) at boot via `registerShippingAdapter`.
2. Stores DHL credentials (userId, apiKey, accountNumber) encrypted via the core Integration Credentials store.
3. Obtains a short-lived JWT on first use per request by calling `POST /authenticate/api-key`, caches the token in memory with its expiration, and refreshes via `POST /authenticate/refresh-token` when within 60 seconds of expiry.
4. Translates the unified `ShippingAdapter` interface calls to DHL Gateway API requests.
5. Maps DHL event `category` codes to the `UnifiedShipmentStatus` enum.
6. Surfaces configuration and tracking UX via widget injection, identical in structure to `carrier-inpost`.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| In-memory token cache (per adapter instance) | DHL tokens are short-lived; re-authenticating on every request adds ~200ms latency. Per-instance cache is safe — adapter is registered once at boot. |
| Client-generated UUID for `shipmentId` | DHL requires the caller to supply a UUID. Use `uuid` package, same pattern already in use for entities. |
| No cancellation support | DHL Gateway API has no DELETE /shipments endpoint. Adapter throws `dhlErrors.cancellationNotSupported()` — a typed error with a human-readable message that the caller surfaces in the UI. Undo of a created shipment is a manual operator action via DHL Manager; the adapter cannot reverse it. |
| Parcel type resolution at shipment time | MVP calls `GET /parcel-types/business/{fromCountry}` inline. This is one extra HTTP call but avoids stale cache. Phase 2 adds a cached lookup. |
| `accountNumber` as mandatory credential | DHL requires `accountId` on every shipment. The module exposes this as a required credential field. |
| Webhook via Track-Trace Pusher | DHL pushes `TrackTracePiece` payloads to a merchant-configured URL. The module registers a webhook receiver route and maps incoming events to `ShippingWebhookEvent`. This is Phase 2. |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Store JWT in integration credentials store | Tokens expire in ~1 hour; writing an encrypted update on every refresh adds DB round-trips. In-memory is simpler and sufficient. |
| Separate `carrier-dhl-express` package | DHL Express uses a different API (api.dhl.com, not api-gw.dhlparcel.nl) with a separate auth scheme. Out of scope for this spec — would be SPEC-005. |

---

## User Stories / Use Cases

- **Operator** wants to configure DHL Parcel credentials once so that all merchants on their tenant can ship DHL without leaving the platform.
- **Fulfilment staff** wants to create a DHL shipping label from the order detail page and have the tracking number appear automatically in the order timeline.
- **Fulfilment staff** wants to compare DHL Parcel rates against InPost rates on a single order before choosing a carrier.
- **Customer support** wants to see live DHL tracking events on the order shipping panel without leaving Open Mercato.
- **Developer** wants to receive DHL tracking webhooks and have them automatically update the order shipment status (Phase 2).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Open Mercato Core — shipping_carriers module               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ShippingAdapter registry                            │   │
│  │  registerShippingAdapter(dhlParcelAdapterV1)  ←──────┼───┤
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
          │ calculateRates / createShipment / getTracking
          ▼
┌────────────────────────────────────┐
│  carrier-dhl-parcel                │
│  ┌──────────────────────────────┐  │
│  │  dhlParcelAdapterV1          │  │
│  │  ├─ tokenManager (in-memory) │  │
│  │  ├─ client.ts                │  │
│  │  ├─ status-map.ts            │  │
│  │  └─ rate-resolver.ts         │  │
│  └──────────────────────────────┘  │
│  Widgets:                          │
│  ├─ dhl-config (tab injection)     │
│  └─ dhl-tracking (order injection) │
└────────────────────────────────────┘
          │ HTTPS / JWT Bearer
          ▼
┌────────────────────────────────────┐
│  api-gw.dhlparcel.nl               │
│  POST /authenticate/api-key        │
│  POST /authenticate/refresh-token  │
│  GET  /capabilities/business       │
│  GET  /parcel-types/business/{cc}  │
│  POST /shipments                   │
│  GET  /labels/{id}                 │
│  GET  /track-trace                 │
│  GET  /parcel-shop-locations/{cc}  │
└────────────────────────────────────┘
```

### Commands & Events

Phase 1 has no custom commands or events — the module delegates entirely to core `shipping_carriers` events. The core module emits:

- **Event**: `shipping_carriers.shipment.created` — emitted by core after `createShipment` returns successfully
- **Event**: `shipping_carriers.shipment.status_changed` — emitted by core after webhook processing

Phase 2 (webhook receiver):

- **Command**: `carrier_dhl_parcel.webhook.receive` — process incoming Track-Trace Pusher push
- **Event**: `carrier_dhl_parcel.shipment.status_updated` — fired after mapping DHL push payload to unified status

---

## Data Models

This module stores **no custom entities**. All shipment and credential data is managed by core's `shipping_carriers` and `integrations` modules.

The following types are internal to the adapter (not persisted):

### `DhlParcelCredentials` (internal, not persisted)
- `userId`: string — DHL user UUID
- `apiKey`: string (secret) — DHL API key secret
- `accountNumber`: string — DHL account ID (e.g. `"01234567"`)
- `apiBaseUrl?`: string — override for sandbox testing (default: `https://api-gw.dhlparcel.nl`)
- `webhookConfigurationId?`: string — Track-Trace Pusher configuration UUID (Phase 2)
- `webhookSubscriptionKey?`: string (secret) — subscription key for push auth (Phase 2)

### `DhlTokenCache` (in-memory, per adapter instance)

Stored as `Map<string, DhlTokenCacheEntry>` where the key is `${userId}:${accountNumber}`. Each entry contains:
- `accessToken`: string
- `accessTokenExpiration`: number (Unix timestamp seconds)
- `refreshToken`: string
- `refreshTokenExpiration`: number

### `UnifiedShipmentStatus` mapping (from DHL event category)

| DHL `events[].category` | `UnifiedShipmentStatus` |
|--------------------------|------------------------|
| `DATA_RECEIVED` | `label_created` |
| `UNDERWAY` | `in_transit` |
| `LEG` | `in_transit` |
| `IN_DELIVERY` | `out_for_delivery` |
| `DELIVERED` | `delivered` |
| `EXCEPTION` | `failed_delivery` |
| `PROBLEM` | `failed_delivery` |
| `INTERVENTION` | `failed_delivery` |
| `CUSTOMS` | `in_transit` |
| `UNKNOWN` | `unknown` |
| _(no events yet)_ | `label_created` |

---

## API Contracts

These are the **DHL Gateway API** calls made by the adapter — not Open Mercato API routes exposed to the frontend. The module exposes no new `/api/*` routes; all access is via the `ShippingAdapter` interface called by core.

### Authentication — `POST /authenticate/api-key`

Request:
```json
{ "userId": "<uuid>", "key": "<string>", "accountNumbers": ["<accountNumber>"] }
```
Response:
```json
{
  "accessToken": "...",
  "accessTokenExpiration": 1234567890,
  "refreshToken": "...",
  "refreshTokenExpiration": 1234567890
}
```
Errors: `400` (missing params), `401` (invalid key). Module throws `dhlErrors.authFailed()`.

### Token Refresh — `POST /authenticate/refresh-token`

Request:
```json
{ "refreshToken": "<string>" }
```
Response: Same shape as above. Errors: `401` → module falls back to full re-auth.

### Rate Calculation — `GET /capabilities/business` + `GET /parcel-types/business/{fromCountry}`

1. `GET /capabilities/business?fromCountry=NL&toCountry=DE&parcelType=SMALL&carrier=DHL-PARCEL`
   Returns array of capability objects with `product.key`, `parcelType`, `options`, `deliveryArea`.

2. `GET /parcel-types/business/{fromCountry}?toCountry={toCountry}&carrier=DHL-PARCEL`
   Returns array of parcel type objects with `key`, `minWeightKg`, `maxWeightKg`, `dimensions`, optionally `price`.

**Rate resolution algorithm**: The `rate-resolver.ts` fetches both endpoints in parallel (`Promise.all`). It then filters parcel type entries where `requestedWeightKg` is within `[minWeightKg, maxWeightKg]` and requested dimensions fit within the parcel type's `dimensions` (each axis ≤ the parcel type max). For each passing parcel type `key`, it finds the matching capability entry (same `parcelType` key). It emits one `ShippingRate` per matched `(parcelType, product.key)` pair, using the parcel type's `price` if present, otherwise `null` (indicating DHL will quote at shipment time). Unmatched parcel types are silently dropped.

### Create Shipment — `POST /shipments`

Request:
```json
{
  "shipmentId": "<uuid>",
  "accountId": "<accountNumber>",
  "shipper": {
    "name": { "firstName": "...", "lastName": "...", "companyName": "..." },
    "address": { "countryCode": "NL", "postalCode": "3542AD", "city": "Utrecht", "street": "Reactorweg", "number": "25" }
  },
  "receiver": {
    "name": { "firstName": "...", "lastName": "...", "companyName": "..." },
    "address": { "countryCode": "DE", "postalCode": "10115", "city": "Berlin", "street": "Unter den Linden", "number": "1" },
    "email": "customer@example.com",
    "phoneNumber": "+49123456789"
  },
  "pieces": [
    {
      "parcelType": "SMALL",
      "quantity": 1,
      "weight": 1.5,
      "dimensions": { "length": 30, "width": 20, "height": 10 }
    }
  ],
  "options": [],
  "orderReference": "<orderId>"
}
```
Response (201):
```json
{
  "shipmentId": "<uuid>",
  "shipmentTrackerCode": "JVGLOTC0123456789",
  "pieces": [{ "labelId": "<uuid>", "trackerCode": "JVGLOTC0123456789", "parcelType": "SMALL" }],
  "orderReference": "<orderId>"
}
```
The `shipmentId` (UUID) is used as the external `shipmentId` in core. The `pieces[0].trackerCode` is used as the `trackingNumber`. The `pieces[0].labelId` is used to fetch the label binary.

**Undo contract**: `createShipment` is not reversible via API. Once `POST /shipments` succeeds, the shipment exists in DHL's system. Since DHL does not expose a cancellation endpoint, the only recourse is a manual operator action via DHL Manager. The spec documents this in Risks & Impact Review and in `cancelShipment`'s typed error.

### Label Download — `GET /labels/{id}`

```
GET /labels/{labelId}
Accept: application/pdf   (or application/zpl for ZPL)
```
Returns binary. The adapter base64-encodes the response and returns it as `labelData` in `CreateShipmentResult`.

### Track and Trace — `GET /track-trace`

```
GET /track-trace?key={trackerCode}+{postalCode}
```
Returns array of piece objects. The adapter reads `events[]`, maps `category` → `UnifiedShipmentStatus`, and returns the latest status plus event history.

### Parcel Shop Lookup — `GET /parcel-shop-locations/{countryCode}`

```
GET /parcel-shop-locations/NL?limit=20&q={postalCode or name}
```
Returns array of `{ id, name, shopType, keyword, address, openingHours, distance }`. Mapped to `DropOffPoint[]` for the `searchDropOffPoints` adapter method.

---

## Internationalization (i18n)

Keys follow the `carrier_dhl_parcel.<context>.<key>` convention.

| Key | Default (EN) |
|-----|-------------|
| `carrier_dhl_parcel.page.title` | DHL Parcel |
| `carrier_dhl_parcel.page.group` | Shipping |
| `carrier_dhl_parcel.tabs.settings` | Settings |
| `carrier_dhl_parcel.config.userId` | User ID |
| `carrier_dhl_parcel.config.userId.helpText` | UUID from My DHL Portal → Settings → API KEYS |
| `carrier_dhl_parcel.config.apiKey` | API Key |
| `carrier_dhl_parcel.config.apiKey.helpText` | Secret string from My DHL Portal → Settings → API KEYS. Shown only once — copy immediately. |
| `carrier_dhl_parcel.config.accountNumber` | Account Number |
| `carrier_dhl_parcel.config.accountNumber.helpText` | e.g. 01234567 — visible in My DHL Portal account section |
| `carrier_dhl_parcel.config.apiBaseUrl` | API Base URL |
| `carrier_dhl_parcel.config.apiBaseUrl.helpText` | Leave empty for production. DHL has no separate sandbox host — use test account numbers for sandbox mode. |
| `carrier_dhl_parcel.config.senderCompanyName` | Sender Company Name |
| `carrier_dhl_parcel.config.senderFirstName` | Sender First Name |
| `carrier_dhl_parcel.config.senderLastName` | Sender Last Name |
| `carrier_dhl_parcel.config.senderEmail` | Sender Email |
| `carrier_dhl_parcel.config.senderPhone` | Sender Phone |
| `carrier_dhl_parcel.tracking.title` | DHL Parcel Tracking |
| `carrier_dhl_parcel.tracking.noData` | No tracking information available |
| `carrier_dhl_parcel.error.auth_failed` | DHL authentication failed. Check credentials. |
| `carrier_dhl_parcel.error.cancellation_not_supported` | DHL Parcel does not support shipment cancellation via API. |

---

## UI/UX

### Integration Detail — Config Tab

Injected into the DHL Parcel integration detail page (`carrierDhlParcelDetailWidgetSpotId`) as a `kind: 'tab'` widget, mirroring `carrier_inpost.injection.config`.

Fields:
- **User ID** (required, text)
- **API Key** (required, secret)
- **Account Number** (required, text, help: "e.g. 01234567")
- **API Base URL** (optional, url, help: "Leave empty for production. Sandbox: https://api-gw.dhlparcel.nl (no separate sandbox URL — DHL uses test account numbers)")
- **Sender Company Name / First Name / Last Name / Email / Phone** (optional, used as shipper defaults)

Behaviour: Save calls core credential update API. Health check ping hits `/authenticate/api-key` to validate.

### Order Shipping Panel — Tracking Widget

Injected at `detail:sales.order:shipping` slot (same as InPost). Shows:
- DHL Parcel logo + tracking number (links to DHL track-and-trace page)
- Status badge (mapped unified status)
- Timeline of events (timestamp, DHL `category`, DHL `status` text)

> **XSS note**: DHL `status` text fields are free-form strings returned by the DHL API. They MUST be rendered as escaped text content — never via `dangerouslySetInnerHTML` or equivalent. React's default JSX text rendering (plain string children) is sufficient.

---

## Configuration

### Credential Provisioning — My DHL Portal

DHL credentials are provisioned **once per merchant account** through the My DHL Portal web interface. There is no key generation on the Open Mercato side — the `userId` and `key` are an opaque UUID + secret pair generated by DHL.

**Steps for the operator:**

1. Log in to [My DHL Portal](https://my.dhlparcel.nl/#/) with a business account.
   > A business account is provided by DHL's sales department. New accounts can be requested by email to DHL eCommerce BNL.
2. Open the user dropdown (top-right), click **Settings**.
3. Navigate to the **API KEYS** tab.
4. Click **CREATE API KEY**. The portal generates and displays two values:
   - **User ID** — a UUID (e.g. `f36abdfa-9894-4d1f-bb6e-e471a953c04d`)
   - **Key** — an opaque secret string (e.g. `1c8545e1-767f-4531-9c6b-5f5f80737562`)
5. Copy both values immediately — they are shown **only once**. Clicking "CREATE API KEY" again generates a new pair and **invalidates the previous one**.
6. Paste the User ID and Key into the DHL Parcel integration config tab in Open Mercato.
7. Find the **Account Number** in My DHL Portal under the Account section (e.g. `01234567`) and enter it as well.

> The `userId` is a UUID. The `key` is a plain pre-shared secret string — not RSA, not HMAC, not PEM. DHL uses it only at the `/authenticate/api-key` endpoint to issue a short-lived JWT. Open Mercato stores it encrypted via the core credentials store and never logs it.

### Runtime Token Flow

At runtime, credentials stored in Open Mercato are **never sent to DHL** for individual API calls. Instead, the `TokenManager` obtains a JWT once and reuses it:

```
Stored: { userId, key, accountNumber }
    │
    ▼  POST /authenticate/api-key  { userId, key, accountNumbers: [accountNumber] }
  { accessToken (JWT ~15 min), accessTokenExpiration (unix ts),
    refreshToken (JWT ~7 days), refreshTokenExpiration (unix ts) }
    │
    ├─ All API calls → Authorization: Bearer <accessToken>
    │
    ├─ accessToken near expiry (< 60s remaining):
    │    POST /authenticate/refresh-token { refreshToken }
    │    → new accessToken + new refreshToken (rotating)
    │
    └─ refreshToken also expired or invalid:
         full re-auth with stored userId + key
```

`TokenManager` caches the token pair in memory (keyed by `userId:accountNumber`). Cache is lost on process restart — first request after restart triggers a full re-auth (~200ms overhead, acceptable).

### Credential Fields

| Credential Field | Type | Required | Notes |
|-----------------|------|----------|-------|
| `userId` | text | Yes | UUID from My DHL Portal → Settings → API KEYS |
| `apiKey` | secret | Yes | Opaque secret string from My DHL Portal → Settings → API KEYS |
| `accountNumber` | text | Yes | DHL account ID, e.g. `01234567` — visible in My DHL Portal account section |
| `apiBaseUrl` | url | No | Default: `https://api-gw.dhlparcel.nl`. No separate sandbox host — DHL uses test account numbers for sandbox mode. |
| `senderCompanyName` | text | No | Shipper default (used as `shipper.name.companyName`) |
| `senderFirstName` | text | No | Shipper default (used as `shipper.name.firstName`) |
| `senderLastName` | text | No | Shipper default (used as `shipper.name.lastName`) |
| `senderEmail` | text | No | Shipper default |
| `senderPhone` | text | No | Shipper default |

Phase 2 additional fields:

| Credential Field | Type | Required | Notes |
|-----------------|------|----------|-------|
| `webhookConfigurationId` | text | No (Phase 2) | Track-Trace Pusher config UUID |
| `webhookSubscriptionKey` | secret | No (Phase 2) | Subscription key for inbound push auth |

---

## Migration & Compatibility

No database migrations required — this module adds no custom entities. All state lives in core integration credentials (encrypted) and core shipment tables.

---

## Implementation Plan

### Phase 1: Core Adapter + Integration Registration

**Goal**: A fully functional shipping adapter that can authenticate, calculate rates, create shipments (with label), and track — wired into the Integration hub with a config UI.

1. Scaffold `packages/carrier-dhl-parcel/` — `package.json`, `tsconfig.json`, `build.mjs`, `jest.config.cjs`, `src/index.ts`.
2. Create `src/modules/carrier_dhl_parcel/index.ts` with `ModuleInfo` metadata.
3. Create `src/modules/carrier_dhl_parcel/acl.ts` — features: `carrier_dhl_parcel.view`, `carrier_dhl_parcel.configure`.
4. Create `src/modules/carrier_dhl_parcel/setup.ts` — `defaultRoleFeatures` for `superadmin`/`admin`; `onTenantCreated` calls `applyDhlParcelEnvPreset` from `lib/preset.ts` if any `OM_INTEGRATION_DHL_PARCEL_*` env vars are set.
5. Create `src/modules/carrier_dhl_parcel/lib/client.ts`:
   - `resolveBaseUrl(credentials)` → default `https://api-gw.dhlparcel.nl`
   - `TokenManager` class with `getToken(credentials)` — fetches/refreshes JWT, caches in memory
   - `dhlRequest<T>(credentials, path, options)` — resolves token, adds `Authorization: Bearer`, handles 401 with one retry after re-auth
6. Create `src/modules/carrier_dhl_parcel/lib/errors.ts` — typed errors: `authFailed`, `apiError`, `cancellationNotSupported`, `missingCredential`.
7. Create `src/modules/carrier_dhl_parcel/lib/status-map.ts` — DHL event category → `UnifiedShipmentStatus` map.
8. Create `src/modules/carrier_dhl_parcel/lib/rate-resolver.ts` — fetches `/capabilities/business` and `/parcel-types/business/{fromCountry}` in parallel (`Promise.all`); filters parcel types where requested weight is within `[minWeightKg, maxWeightKg]` and requested dimensions fit within the parcel type limits (each axis ≤ max); joins with capability entries by matching `parcelType` key; returns one `ShippingRate` per matched pair. Unmatched parcel types are silently dropped. Returns empty array if either endpoint returns empty.
9. Create `src/modules/carrier_dhl_parcel/lib/adapters/v1.ts` — implements `ShippingAdapter`:
   - `calculateRates`: calls `rate-resolver.ts`
   - `createShipment`: generates UUID, builds request, calls `POST /shipments`, fetches label via `GET /labels/{labelId}`
   - `getTracking`: calls `GET /track-trace`, maps events
   - `cancelShipment`: throws `dhlErrors.cancellationNotSupported()`
   - `verifyWebhook`: stub returning `unknown` status (Phase 2)
   - `mapStatus`: uses status-map
   - `searchDropOffPoints`: calls `GET /parcel-shop-locations/{countryCode}`
10. Create `src/modules/carrier_dhl_parcel/integration.ts` — `IntegrationDefinition` for the Integration hub (category: `shipping`, hub: `shipping_carriers`, providerKey: `dhl_parcel`).
11. Create `src/modules/carrier_dhl_parcel/di.ts` — `register(container)` calls `registerShippingAdapter(dhlParcelAdapterV1)` and registers `dhlParcelHealthCheck`.
12. Create config injection widget (`widgets/injection/dhl-config/widget.ts` + `widget.client.tsx`).
13. Create tracking injection widget (`widgets/injection/dhl-tracking/widget.ts` + `widget.client.tsx`).
14. Create `widgets/injection-table.ts` — wire config to integration detail spot, tracking to `detail:sales.order:shipping`.
15. Write unit tests for `status-map.ts`, `client.ts` (token refresh logic), and `adapters/v1.ts` (rate calc, createShipment, getTracking mocked).
16. Build and typecheck: `yarn workspace @open-mercato/carrier-dhl-parcel build && yarn workspace @open-mercato/carrier-dhl-parcel typecheck`.
17. Install in sandbox, configure with test credentials, create a test shipment end-to-end.

### Phase 2: Webhook / Push-Based Tracking

**Goal**: Real-time shipment status updates via DHL Track-Trace Pusher.

1. Add `verifyWebhook` implementation in adapter — validates inbound DHL push payload (no HMAC signing from DHL; auth is via API key header or OAuth2 configured by the merchant).
2. Add `src/modules/carrier_dhl_parcel/lib/webhook-handler.ts` — parse `TrackTracePiece` push payload, map `events[]` category to `UnifiedShipmentStatus`, emit `carrier_dhl_parcel.shipment.status_updated`.
3. Add `src/modules/carrier_dhl_parcel/events.ts` — declare `carrier_dhl_parcel.shipment.status_updated` event.
4. Document webhook setup guide (markdown, surfaced in credential UI as `helpDetails`).
5. Update config widget: add `webhookConfigurationId` + `webhookSubscriptionKey` fields with link to guide.
6. Add integration tests for webhook handler parsing `TrackTracePiece` payload.

### File Manifest (Phase 1)

| File | Action | Purpose |
|------|--------|---------|
| `packages/carrier-dhl-parcel/package.json` | Create | Package manifest `@open-mercato/carrier-dhl-parcel` |
| `packages/carrier-dhl-parcel/tsconfig.json` | Create | Extends `../../tsconfig.base.json` |
| `packages/carrier-dhl-parcel/build.mjs` | Create | esbuild script (copy from carrier-inpost) |
| `packages/carrier-dhl-parcel/jest.config.cjs` | Create | jest + ts-jest (copy from carrier-inpost) |
| `packages/carrier-dhl-parcel/src/index.ts` | Create | Barrel export |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/index.ts` | Create | `ModuleInfo` metadata |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/acl.ts` | Create | Feature definitions |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/setup.ts` | Create | Tenant init + env preset |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/di.ts` | Create | Awilix registrar |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/integration.ts` | Create | `IntegrationDefinition` |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/lib/client.ts` | Create | HTTP client + token manager |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/lib/errors.ts` | Create | Typed error factory |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/lib/health.ts` | Create | Health check service (registered in `di.ts` as `dhlParcelHealthCheck`) |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/lib/status-map.ts` | Create | DHL category → `UnifiedShipmentStatus` |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/lib/rate-resolver.ts` | Create | Rate calculation logic |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/lib/preset.ts` | Create | Env var → credentials preset. Reads `OM_INTEGRATION_DHL_PARCEL_USER_ID`, `OM_INTEGRATION_DHL_PARCEL_API_KEY`, `OM_INTEGRATION_DHL_PARCEL_ACCOUNT_NUMBER`, optionally `OM_INTEGRATION_DHL_PARCEL_API_BASE_URL`, `OM_INTEGRATION_DHL_PARCEL_ENABLED`, `OM_INTEGRATION_DHL_PARCEL_FORCE_PRECONFIGURE` |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/lib/adapters/v1.ts` | Create | `ShippingAdapter` implementation |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/widgets/injection/dhl-config/widget.ts` | Create | Config widget definition |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/widgets/injection/dhl-config/widget.client.tsx` | Create | Config widget React component |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/widgets/injection/dhl-tracking/widget.ts` | Create | Tracking widget definition |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/widgets/injection/dhl-tracking/widget.client.tsx` | Create | Tracking widget React component |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/widgets/injection-table.ts` | Create | Slot mappings |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/__tests__/status-map.test.ts` | Create | Unit tests — status mapping |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/__tests__/client.test.ts` | Create | Unit tests — token refresh |
| `packages/carrier-dhl-parcel/src/modules/carrier_dhl_parcel/__tests__/adapter-v1.test.ts` | Create | Unit tests — adapter methods |

### Testing Strategy

- **Unit tests** — `status-map.ts`: every DHL category maps to a known `UnifiedShipmentStatus`; unmapped categories → `unknown`.
- **Unit tests** — `client.ts`: `TokenManager` caches token; re-authenticates when within 60s of expiry; falls back to full re-auth when refresh fails.
- **Unit tests** — `adapters/v1.ts`: `calculateRates` returns empty array when capabilities returns empty; `createShipment` correctly assembles request body including UUID generation; `getTracking` maps last event category to status; `cancelShipment` throws typed error.
- **Integration tests** (Phase 1, skipped in CI unless `DHL_PARCEL_TEST_*` env vars present): full round-trip create → track against DHL sandbox/test account.

---

## Risks & Impact Review

### Data Integrity Failures

**JWT token expiry during shipment creation**
- Scenario: Token expires between rate calculation and `POST /shipments` call.
- Mitigation: `TokenManager.getToken()` checks expiry before every request with a 60-second buffer. If expired, refreshes. Retry on 401.
- Residual risk: If DHL revokes a token server-side (e.g. account suspension), the module surfaces the auth error to the caller.

**UUID collision on `shipmentId`**
- Scenario: `uuid()` generates a duplicate UUID used in a previous shipment call (astronomically unlikely but theoretically possible).
- Severity: Low
- Mitigation: DHL returns a `409 Conflict` on duplicate `shipmentId`. The adapter wraps this as `dhlErrors.apiError(409, ...)`, surfaced to the caller.
- Residual risk: No auto-retry with a new UUID — caller retries the whole operation.

**Label fetch fails after shipment created**
- Scenario: `POST /shipments` succeeds but `GET /labels/{id}` times out or returns 404.
- Severity: Medium
- Affected area: Label data absent from `CreateShipmentResult`; shipment is created in DHL but no label in Open Mercato.
- Mitigation: Adapter returns `CreateShipmentResult` without `labelData` rather than throwing. Core handles absent label gracefully (operator can re-fetch manually). Label ID is stored in `pieces[0].labelId` on the response — core should persist it.
- Residual risk: No automatic re-fetch mechanism in MVP. Phase 2 could add a background worker to retry failed label fetches.

### Cascading Failures & Side Effects

**DHL API downtime**
- Scenario: `api-gw.dhlparcel.nl` is unreachable; all rate calculation and shipment creation fails.
- Severity: High
- Affected area: All shipments using DHL Parcel as the selected carrier.
- Mitigation: Errors propagate through the `ShippingAdapter` interface and are surfaced as operator-facing error messages. No silent failure. DHL publishes a status page (https://dhlecommercebnl.statuspage.io) — operators can monitor it.
- Residual risk: No circuit breaker or fallback in MVP.

**Token store invalidated**
- Scenario: In-memory token lost after process restart (e.g. worker crash). Every request triggers a full re-auth.
- Severity: Low
- Mitigation: Re-auth adds one round-trip (~200ms). Acceptable — no state is lost.

### Tenant & Data Isolation Risks

- Module stores no entities of its own. Credentials are scoped per `(organizationId, tenantId)` in the core credentials store.
- `TokenManager` caches tokens by `userId` — if two tenants share the same `userId` (misconfiguration), they share a token. Mitigation: cache key should be `${userId}:${accountNumber}` or use the full credentials object reference.
- Blast radius: scoped to the tenant whose DHL credentials are misconfigured.

### Migration & Deployment Risks

- No schema migrations — module is entirely additive.
- Safe to deploy and remove without data loss.
- Breaking change risk: none — module only adds a new `providerKey` to the adapter registry.

### Operational Risks

**Rate-limit on DHL capabilities endpoint**
- Scenario: High-volume rate-shopping (e.g. 100 simultaneous order drafts) hammers `GET /capabilities/business`.
- Severity: Medium
- Mitigation: Phase 2 adds a short-lived (5 minute) in-memory cache per `(fromCountry, toCountry, parcelType)` tuple.
- Residual risk: MVP has no cache — operators with high order volumes should be aware.

**Unexpected DHL API schema changes**
- Scenario: DHL changes the shape of `/track-trace` response, breaking status mapping.
- Mitigation: Status map uses `category` enum values which are stable. Unknown categories map to `'unknown'` rather than throwing. Alerts via standard error monitoring.
- Residual risk: New statuses silently map to `'unknown'` until the map is updated.

#### Risk Register

#### Shared `TokenManager` key collision
- **Scenario**: Two tenants configured with the same DHL `userId` share a cached JWT, potentially exposing one tenant's shipments to the other's rate calculations.
- **Severity**: Medium
- **Affected area**: `TokenManager` cache, rate calculation, tracking
- **Mitigation**: Cache key is `${userId}:${accountNumber}` — same userId with different account numbers get separate cache entries. If both fields match (true misconfiguration), they share the same DHL account anyway.
- **Residual risk**: Misconfigured tenants sharing credentials is an operator error, not a platform bug. Document clearly.

#### Label download failure after shipment creation
- **Scenario**: Network timeout after `POST /shipments` succeeds, `GET /labels/{id}` never returns.
- **Severity**: Medium
- **Affected area**: `labelData` absent in `CreateShipmentResult`; operator must re-fetch manually.
- **Mitigation**: Return partial result without `labelData`. Persist `labelId` (`pieces[0].labelId`) in core for later retry.
- **Residual risk**: No automated retry in Phase 1.

#### DHL `cancelShipment` not supported
- **Scenario**: Operator attempts to cancel a DHL shipment via Open Mercato.
- **Severity**: Low
- **Affected area**: Cancellation UI flow
- **Mitigation**: Adapter throws `dhlErrors.cancellationNotSupported()` with a human-readable message. Core surfaces it as a dismissible error.
- **Residual risk**: Operators must cancel via DHL Manager manually.

---

## Final Compliance Report — 2026-03-25 (rev 3)

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)
- `.ai/specs/AGENTS.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | Module has no custom entities; no cross-module ORM links |
| root AGENTS.md | Filter by `organization_id` on all queries | Compliant | No custom DB queries; credential store scoped by core |
| root AGENTS.md | No `any` types — use zod schemas | Compliant | All DHL API types declared explicitly; zod for credential validation |
| root AGENTS.md | No raw `fetch` in UI — use `apiCall` | Compliant | Only `lib/client.ts` uses `fetch`; UI widgets use `apiCall` |
| root AGENTS.md | No `alert()` — use `flash()` | Compliant | Widgets use platform flash utilities |
| root AGENTS.md | MUST export `openApi` on API routes | N/A | Module exposes no `/api/*` routes |
| root AGENTS.md | MUST use `requireAuth` and `requireFeatures` in page/route metadata | Compliant | Both widget definitions declare `features: ['carrier_dhl_parcel.view']` / `configure` |
| root AGENTS.md | Package placement: `packages/<name>/` | Compliant | `packages/carrier-dhl-parcel/` |
| root AGENTS.md | Module ID snake_case | Compliant | `carrier_dhl_parcel` |
| root AGENTS.md | Feature ID singular: `<moduleId>.<action>` | Compliant | `carrier_dhl_parcel.view`, `carrier_dhl_parcel.configure` |
| root AGENTS.md | Event ID singular dot-separated | Compliant | `carrier_dhl_parcel.shipment.status_updated` |
| root AGENTS.md | MUST hash passwords with bcryptjs | N/A | No passwords stored; DHL API key stored via core encrypted credentials |
| root AGENTS.md | Validate all inputs with zod | Compliant | Credential fields validated; adapter inputs come pre-validated from core |
| root AGENTS.md | Cross-module links: FK IDs only | Compliant | No cross-module ORM relationships |
| root AGENTS.md | `setup.ts` MUST declare `defaultRoleFeatures` for every feature | Compliant | Both `view` and `configure` declared for `superadmin`/`admin` |
| root AGENTS.md | NEVER hand-write migrations | Compliant | No custom entities → no migrations |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | No custom entities; adapter types match DHL OpenAPI schema |
| API contracts match UI/UX section | Pass | Config widget fields match `DhlParcelCredentials`; tracking widget matches `TrackingResult` |
| Risks cover all write operations | Pass | `createShipment`, `POST /authenticate/api-key`, `POST /authenticate/refresh-token` all covered |
| Commands defined for all mutations | Pass | No custom commands in Phase 1; Phase 2 webhook command documented |
| Status map covers all known DHL categories | Pass | All 10 DHL event categories mapped |
| `cancelShipment` degradation documented | Pass | Throws `dhlErrors.cancellationNotSupported()`; undo contract explicit |
| `createShipment` undo contract explicit | Pass | Documented in API Contracts section — not reversible; manual operator action |
| File manifest complete and path-correct | Pass | All paths include `packages/carrier-dhl-parcel/` prefix; `lib/health.ts` added |
| Env var names fully specified | Pass | `OM_INTEGRATION_DHL_PARCEL_*` names listed in file manifest and setup step |
| i18n covers all user-facing strings incl. helpText | Pass | helpText keys added to i18n table |
| Rate resolution algorithm specified | Pass | Matching algorithm described in API Contracts and implementation plan |
| XSS rendering note for DHL status text | Pass | Explicit note added to tracking widget UI section |
| Architecture diagram matches implemented API calls | Pass | `GET /shipments/{id}` removed (not used — `POST /shipments` returns data synchronously) |
| `DhlTokenCache` storage structure explicit | Pass | Documented as `Map<string, DhlTokenCacheEntry>` keyed by `userId:accountNumber` |

### Non-Compliant Items

None.

### Verdict

**Fully compliant** — Approved, ready for implementation.

---

## Changelog

### 2026-03-25
- Initial specification

### 2026-03-25 (rev 2)
- Expanded Configuration section: added "Credential Provisioning — My DHL Portal" walkthrough (how `userId` + `key` are generated, one-time visibility caveat), "Runtime Token Flow" diagram, and renamed flat table to "Credential Fields"
- Corrected TLDR: removed incorrect "OAuth2" label — DHL auth is a proprietary JWT flow, not OAuth2
- Corrected TLDR concern: tokens are in-memory only, never persisted to credentials store

### Review — 2026-03-25
- **Reviewer**: Agent (Martin Fowler persona)
- **Security**: Passed — credentials stored encrypted via core; no secrets logged; JWT not exposed in error messages; auth error messages are generic
- **Performance**: Passed — token cache with 60s buffer prevents per-request re-auth; rate-limit risk documented and deferred to Phase 2 cache
- **Cache**: N/A for Phase 1 — no custom caches; Phase 2 cache planned for `/capabilities/business`
- **Commands**: Passed — Phase 1 has no custom commands; Phase 2 webhook command documented
- **Risks**: Passed — all write operations covered; blast radius bounded; DHL cancellation gap explicitly documented
- **Verdict**: Approved

### 2026-03-25 (rev 3) — Adversarial checklist review
- **Reviewer**: Agent (full adversarial checklist pass)
- Removed spurious `GET /shipments/{id}` from architecture diagram — DHL returns all shipment data synchronously in `POST /shipments` response; no separate fetch needed
- Fixed `cancelShipment` contradiction: Design Decisions table now consistently states "throws `dhlErrors.cancellationNotSupported()`"; removed incorrect "return status: cancelled with flag" description
- Added explicit undo contract for `createShipment` in API Contracts section: not reversible via API; manual operator action via DHL Manager
- Expanded `DhlTokenCache` data model: now shows `Map<string, DhlTokenCacheEntry>` storage structure keyed by `userId:accountNumber`
- Expanded rate resolution algorithm in API Contracts and implementation plan step 8: `Promise.all` on both endpoints; filter by weight range + dimension fit; join by `parcelType` key; one `ShippingRate` per matched pair
- Fixed file manifest: all paths now include `packages/carrier-dhl-parcel/` prefix; added missing `lib/health.ts` row
- Added i18n `helpText` keys for all credential fields
- Added explicit env var names to `setup.ts` step and `lib/preset.ts` manifest entry: `OM_INTEGRATION_DHL_PARCEL_USER_ID`, `OM_INTEGRATION_DHL_PARCEL_API_KEY`, `OM_INTEGRATION_DHL_PARCEL_ACCOUNT_NUMBER`, `OM_INTEGRATION_DHL_PARCEL_API_BASE_URL`, `OM_INTEGRATION_DHL_PARCEL_ENABLED`, `OM_INTEGRATION_DHL_PARCEL_FORCE_PRECONFIGURE`
- Added XSS note to tracking widget UI section: DHL `status` text must be rendered as escaped text, not `dangerouslySetInnerHTML`
- **Verdict**: Approved — all checklist items resolved
