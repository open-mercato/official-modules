# SPEC-005 — `financial_pl`: Polish KSeF 2.0 e-Invoicing Connector

- **Date:** 2026-06-26
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Integration provider id:** `ksef_pl`
- **Status:** Implemented — send-only KSeF 2.0 connector (FA(3) + token auth + status/UPO + 3-layer idempotency + reconciliation sweep), live-validated against the KSeF TEST environment.

## TLDR

`financial_pl` makes Open Mercato's `sales` invoicing compliant with Poland's mandatory **KSeF** (Krajowy System e-Faktur) national e-invoicing. It serializes an issued Polish **PLN VAT** invoice into the structured **FA(3)** XML schema, authenticates to the Ministry of Finance API with a KSeF authorization token, opens an online session, submits the encrypted document, polls the per-invoice status, and stores the signed **UPO** receipt (the legal proof of filing). Polish statutory data attaches to the core `sales.SalesInvoice` **additively** (an extension entity + UMES widget injection) — the country-agnostic `sales` schema is never modified. The connector is an ordinary official module: activated via `official-modules.json`, configured **per organization** through the encrypted `ksef_pl` integration provider, with no feature flag.

## Overview

KSeF becomes mandatory for Polish VAT payers from **February 2026**. A compliant invoice must be (a) serialized to the FA(3) structured schema, (b) submitted to the KSeF API, and (c) accepted — the assigned **numer KSeF** + **UPO** are the legal evidence of issuance, not the local PDF/XML. This module implements the **send** side of that obligation end-to-end:

- **Country-agnostic core stays clean.** All Polish/KSeF logic lives in this module. It depends on `sales` only by FK-id + the Query Engine (no cross-module ORM relations) and extends `sales.SalesInvoice` through an entity extension + response enricher + widget injection.
- **Per-organization, encrypted credentials.** NIP, KSeF token, environment, and seller identity are stored per `(organization, tenant)` in the encrypted `ksef_pl` integration credential store and edited at `/backend/integrations/ksef_pl`.
- **Off-thread, idempotent, self-healing.** The HTTP route returns `202` and a persistent queue subscriber runs the live KSeF round-trip; three layers of idempotency plus KSeF's own duplicate detection prevent any double-registration; a periodic reconciliation sweep recovers stuck submissions so no invoice silently fails to reach KSeF.

## Architecture

### KSeF 2.0 send flow (`lib/submission-flow.ts`, `lib/ksef-client.ts`)

`submitInvoiceToKsef()` orchestrates the full runbook against one environment:

1. `GET /security/public-key-certificates` — fetch MF public keys; select the **token** and **symmetric** certs by their declared `usage`.
2. `POST /auth/challenge` — anonymous (no body); returns `challenge` + integer `timestampMs`.
3. Encrypt the auth token: RSA-OAEP-SHA256 of `"{ksefToken}|{challengeTimestampMs}"`.
4. `POST /auth/ksef-token` — `contextIdentifier.type = "Nip"` + the encrypted token.
5. **Poll** `GET /auth/{ref}` until in-body `status.code === 200` (≤ 20 × 1.5 s). HTTP **401/403/410** = terminal auth failure (fast-fail, not re-queued).
6. `POST /auth/token/redeem` → Bearer **access token**.
7. `POST /sessions/online` — FA(3) `formCode` + the RSA-OAEP-wrapped AES key + IV.
8. `POST /sessions/online/{ref}/invoices` — SHA-256 hashes/sizes + the AES-encrypted document (`offlineMode: false`).
9. `POST /sessions/online/{ref}/close`.
10. **Poll** `GET /sessions/{ref}/invoices/{ref}` (≤ 30 × 2 s) until a terminal status.
11. `finalizeAccepted` fetches the **UPO** (`GET …/upo`, Accept `application/xml`). **A submission is reported `accepted` only once the UPO is in hand** — otherwise it stays `processing` so a retry heals it (never a phantom accept).

The flow is pure with respect to the platform (it takes a `KsefClient` + an injectable `wait`), so it is deterministically unit-testable and is reused verbatim by both the production subscriber and the live-TEST smoke runner.

### Cryptography (`lib/crypto.ts`)

Protocol-mandated; the only place hand-rolled AES/RSA is used.

- **Document body:** AES-256-CBC + PKCS#7 (random 256-bit key, random 128-bit IV).
- **AES key:** wrapped RSA-OAEP (MGF1-SHA256) with the MF `SymmetricKeyEncryption` key.
- **Auth token:** wrapped RSA-OAEP-SHA256 of `"{token}|{timestampMs}"` with the MF `KsefTokenEncryption` key.
- **Hashes:** SHA-256 plaintext + ciphertext hashes/sizes accompany each send.

### FA(3) serializer (`lib/fa3.ts`)

A pure serializer producing `<Faktura>` — namespace `http://crd.gov.pl/wzor/2025/06/25/13775/`, `kodSystemowy="FA (3)"`, `wersjaSchemy="1-0E"`. Element order verified against the official `schemat_FA(3)_v1-0E.xsd`:

- VAT-summary fields emitted in **ascending schema order**; 0% → `P_13_6_1`; domestic reverse-charge `oo` → `P_13_10`.
- Line rate `P_12` mapped to closed `TStawkaPodatku` members (`0` → `"0 KR"`, `np` → `"np I"`).
- **Podmiot1** (seller) = NIP-only; **Podmiot2** (buyer) supports `NIP | KodUE+NrVatUE | BrakID` and carries the FA(3)-mandatory `JST`/`GV` flags.
- `Adnotacje`: `P_18A` = MPP (split payment), `P_18` = reverse charge, `Zwolnienie/P_19 + P_19C` = VAT-exemption basis.
- `DataWytworzeniaFa` normalized to second-precision `xsd:dateTime`.

Full in-process XSD validation is **not** performed; KSeF surfaces any residual schema gap as a rejection status, which the connector records.

### Status & duplicate handling (`lib/status.ts`, `lib/ksef-number.ts`)

- Invoice scope: `200` = accepted; **`440` = accepted DUPLICATE** — the connector recovers the original numer KSeF + UPO from `status.extensions.originalKsefNumber`/`originalSessionReferenceNumber`, so a retry/redelivery of an already-registered invoice is **never** reported rejected; other `≥ 400` = rejected; else processing.
- The **numer KSeF** (`NIP-YYYYMMDD-<technical>-<crc>`, 35 chars) is parsed/validated structurally (NIP + date digits; technical/CRC as uppercase hex), hyphen-tolerant; the checksum is not recomputed (MF has not published the algorithm).

## Data models

Two entities (both `organization_id` + `tenant_id` scoped, soft-delete, `updated_at`), one migration `Migration20260622203145_financial_pl.ts`:

**`KsefSubmission`** — `financial_pl_ksef_submissions`: `id`, `organization_id`, `tenant_id`, `sales_invoice_id` (FK-id), `environment` (`test`/`demo`/`prod`), `mode` (`online`; the type union also declares `batch`/`offline24`/`awaryjny` for the roadmap), `status` (`queued`/`processing`/`accepted`/`rejected` in practice; default `queued`), `context_nip`, `invoice_xml` (**encrypted**), `session_reference`, `invoice_reference`, `ksef_number`, `upo_ref`, `upo_xml` (**encrypted**), `last_status_code`, `last_error_code`, `last_error_message`, `attempt_count`, `submitted_at`, `accepted_at`, timestamps.
- **Active-unique partial index** `financial_pl_ksef_submissions_active_unique` on `(organization_id, tenant_id, sales_invoice_id) WHERE status IN ('queued','processing','accepted') AND deleted_at IS NULL`.

**`SalesInvoicePlMeta`** — `financial_pl_invoice_meta`: `id`, `organization_id`, `tenant_id`, `sales_invoice_id` (FK-id), `context_nip`, `ksef_status`, `ksef_number`, `mpp_required` (bool), `vat_exemption_basis`, timestamps. **Unique** on `(organization_id, tenant_id, sales_invoice_id)`.

**Encryption** (`encryption.ts`): on `financial_pl:ksef_submission`, only `invoice_xml` and `upo_xml` are encrypted. KSeF credentials are encrypted separately by `IntegrationCredentialsService`.

**Cross-module links** (`data/extensions.ts`): `sales:sales_invoice` → `financial_pl:sales_invoice_pl_meta` (1:1) and → `financial_pl:ksef_submission` (1:N), FK-id only.

**Credential schema** (`integration.ts`): `environment` (required), `contextNip` (required, 10-digit), `ksefToken` (**secret**, required), `sellerName`, `sellerAddressLine1`, `sellerAddressLine2`. Seller name/address are optional on the form but required before a submission succeeds (resolver `422 seller_required`).

## Reliability & idempotency

**No invoice is ever registered twice; no invoice silently fails to reach KSeF.**

Three layers of duplicate prevention plus KSeF's own 440 detection:

1. **Resolve-first guard** — the send command returns an existing `queued|processing|accepted` submission for the same invoice instead of creating a second.
2. **Partial unique index** (above) — DB-level CAS at insert; the loser of a concurrent race catches the `23505` and returns the winner.
3. **Atomic claim CAS** — the subscriber `nativeUpdate`s `status: 'queued' → 'processing'`; exactly one redelivery claims the row. A transient failure after the claim resets to `queued` and rethrows so the queue retries.
4. **KSeF 440-duplicate** is the final safety net — a content-identical re-send resolves to `accepted` with the original number + UPO.

**Reconciliation sweep** (`workers/ksef-reconcile.worker.ts`, queue `financial-pl-ksef-reconcile`, concurrency 1) recovers submissions orphaned in `processing` (a worker crashed after the claim — persistence is terminal-only, so the row has no references to re-poll and must be re-driven) or stuck in `queued` (a lost dispatch event). It re-drives them duplicate-safely (reset → `queued`, re-emit; the CAS + 440 prevent double-registration):

- `processing` candidates keyed on **`submitted_at < cutoff`** (set at the claim, so a freshly-claimed live row is excluded); `queued` candidates on `updated_at`.
- A **circuit breaker** on `attempt_count` (excludes over-ceiling rows from the candidate query; surfaces stuck ids in the log, never silently dropped). The reconciler increments `attempt_count` on each re-drive so the breaker is reliable even across crashes.
- Tunables: `OM_KSEF_RECONCILE_STALE_MINUTES` (default 15 — well above the ≤ ~90 s worst-case happy path), `OM_KSEF_RECONCILE_MAX_ATTEMPTS` (default 6).
- Scheduled per organization (15-min interval) from `setup.ts seedDefaults` via the **optional-peer** `schedulerService` (silent no-op if the scheduler module is absent); the schedule id keys on both tenant and organization.

## Authentication

**Token (current).** The connector authenticates with the KSeF **symmetric authorization token** (`POST /auth/ksef-token`). This is a valid production credential for online sending throughout the mandatory period and **until KSeF tokens are discontinued on 1 January 2027**.

**Certificate (roadmap).** The durable production credential is the **KSeF certificate**. An external SaaS needs two: a **Type-1 Authentication** cert (`keyUsage: Digital Signature` — online send via the `POST /v2/auth/xades-signature` challenge-signing flow) and a **Type-2 Offline** cert (`keyUsage: Non-Repudiation` — signs the QR verification code on invoices issued while KSeF is unreachable; cannot authenticate). Planned additive path: add `authMode: 'token' | 'certificate'` + cert/key material to the per-org credentials (token stays the default); MCU/API enrollment (`GET /v2/certificates/limits` → `…/enrollments/data` → PKCS#10 CSR → `POST /v2/certificates/enrollments` → retrieve); the XAdES auth path; the Type-2 offline cert + offline/awaryjny issuance & QR; renewal (cert validity ≤ 2 years). The KSeF TEST environment accepts self-signed certs, so the whole flow is exercisable before production.

## Multi-tenant configuration

Configuration is **per organization** — NIP/token/environment/seller identity live in the encrypted `ksef_pl` integration credentials keyed to `(organization, tenant)`. There is no process-wide token; `OM_KSEF_ENVIRONMENT` only selects base URLs. An org admin gets an auto-rendered credentials form at `/backend/integrations/ksef_pl` (token masked); the save scope is derived server-side from auth and gated by `integrations.credentials.manage`.

A **shared *secret*** across organizations is an anti-pattern (single point of catastrophic failure, GDPR blast-radius, breaks per-NIP rotation across the 2026→2027 token→certificate transition). The legitimate "shared/agency" model — one accounting office (biuro rachunkowe) serving many client companies — is **per-NIP delegation** (the client grants *uprawnienia* to the office's entity; the office authenticates in each client's NIP context, one level deep). That is a roadmap feature, not a shared credential.

## API contracts

All under `/api/financial_pl/ksef/...`; zod inputs; custom routes guard via the mutation-guard registry; OpenAPI documented.

| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/submissions` | `GET` | `financial_pl.view` | List submissions (org/tenant-scoped; `?ids=`, `?salesInvoiceId=`, `?status=`). |
| `…/submissions` | `POST` | `financial_pl.submit` | Queue from an explicit FA(3) payload; idempotent; `202` + `submissionId`. |
| `…/submissions/from-invoice` | `POST` | `financial_pl.submit` | Resolve FA(3) from an **issued** sales invoice `{salesInvoiceId}`; `202`. 404 unknown / 409 not-issued·proforma·no-credentials / 422 doc-type·currency·VAT-rate·seller·buyer. |
| `…/submissions/retry` | `POST` | `financial_pl.submit` | Re-queue a non-accepted submission; `202`; 409 if already accepted; optimistic-locked. |
| `…/submissions/upo` | `GET` | `financial_pl.view` | Download the decrypted UPO XML for `?id=`; 404 unless `accepted`. |
| `…/invoice-meta` | `GET`/`PUT` | `view`/`manage` | Read/upsert `SalesInvoicePlMeta` (context NIP, MPP flag, VAT-exemption basis); optimistic-locked. |

**Commands:** `financial_pl.ksef_submission.send` / `.retry` / `.send_from_invoice`. **Events:** `financial_pl.ksef_submission.queued` (lifecycle), `.accepted` / `.rejected` (`clientBroadcast: true`). **ACL:** `financial_pl.view`, `financial_pl.submit` (⊃ view), `financial_pl.manage` (⊃ view); default grants `admin: financial_pl.*`, `employee: financial_pl.view`.

## Configuration & activation

```bash
yarn official-modules add financial-pl --local   # activate (package @open-mercato/financial-pl ⇒ module id financial_pl)
yarn install                                      # twice on first submodule fetch
yarn mercato configs cache structural --all-tenants
yarn generate
# existing tenants: register the reconciliation schedule + role grants
yarn mercato seed:defaults --module financial_pl
yarn mercato auth sync-role-acls
```

- **Env:** `OM_KSEF_ENVIRONMENT` (`test`/`demo`/`prod`, default `test`); `OM_KSEF_RECONCILE_STALE_MINUTES` (15); `OM_KSEF_RECONCILE_MAX_ATTEMPTS` (6). Base URLs: TEST `api-test.ksef.mf.gov.pl`, DEMO `api-demo.ksef.mf.gov.pl`, PROD `api.ksef.mf.gov.pl`; API prefix `/v2`.
- **Per-org credentials UI:** `/backend/integrations/ksef_pl`.
- **UI injection** (`widgets/injection-table.ts`): KSeF status badge + numer-KSeF copy + UPO download on the sales-invoices list column; an eligibility-gated two-click "Send to KSeF" / "Retry" row action (blocks proforma + already-active submissions); PL VAT meta fields (context NIP, MPP, VAT-exemption basis) on the invoice CrudForm. A response enricher batch-reads the latest `KsefSubmission` into a namespaced `_financial_pl` payload (status / number / submissionId / upoAvailable), gated by `financial_pl.view`, plaintext-only projection.

## Testing

**Integration** (`__integration__/`, self-contained, no live KSeF):
- **TC-KSEF-001** — `POST /ksef/submissions` → `202` + `submissionId`; the row appears in the org/tenant-scoped list; invalid payload → 400; unauthenticated read → 401.
- **TC-KSEF-002** — `POST /ksef/submissions/from-invoice` → 401 unauthenticated / 400 invalid / 404 unknown invoice.

**Unit** (`lib/__tests__/`): crypto, fa3, ksef-client, ksef-number, status, submission-flow, resolve-fa3-from-invoice + command/subscriber/worker suites — AES+RSA round-trips, FA(3) structure/ordering/annotations, every client request/response shape, 440-duplicate recovery, UPO-failure→processing, idempotency + 23505 race-loser, the subscriber CAS, and the 8 reconciler cases.

**Live TEST** (`lib/__tests__/ksef-live.test.ts`, env-gated):
```bash
OM_KSEF_TEST_NIP=<fictional test NIP> OM_KSEF_TEST_TOKEN=<token> OM_KSEF_TEST_STRICT=1 \
  yarn workspace @open-mercato/financial-pl test ksef-live
```
`OM_KSEF_TEST_STRICT=1` requires `accepted` + a numer KSeF + a non-empty UPO (the full auth→send→status→UPO proof). Live-validated against `api-test.ksef.mf.gov.pl`.

**Manual testing checklist:**
1. Activate the module; log in; confirm the role has `financial_pl.view/.submit/.manage`.
2. Prepare a KSeF **TEST** account: a 10-digit fictional NIP (self-onboard via `POST /v2/testdata/person`); generate an authorization token at `https://ksef-test.mf.gov.pl`.
3. Configure `/backend/integrations/ksef_pl`: environment `test`, `contextNip`, `ksefToken`, **sellerName + sellerAddressLine1** (required before submit); run the health check; enable the integration.
4. Issue a standard **`vat`, PLN** invoice with a real buyer (name + address; NIP optional).
5. From the invoices list, "Send to KSeF" (two-click arm/confirm); watch the KSeF status column `queued → processing → accepted`; copy the numer KSeF; "Download UPO".
6. Error paths (all expected, all guarded): proforma → 409; non-PLN → 422 `currency_unsupported`; correction/advance/final → 422 `document_type_unsupported`; missing buyer → 422 `buyer_required`; missing seller config → 422 `seller_required`; unmapped VAT rate → 422 `vat_rate_unsupported`; duplicate of an accepted invoice → 440 recovered as accepted; rejected/stuck → Retry.

## Roadmap (not built)

JPK_FA / JPK_V7M/V7K exports + accounting-office format bridges · inbound purchase-invoice fetch · GUS / Biała-lista / VIES contractor checks + NIP autofill · offline24/awaryjny issuance + KOD I/II verification QR · batch (wsadowy) sessions · **certificate / XAdES authentication** (the 2027 durable credential) · per-NIP delegation (agency / biuro rachunkowe) · non-PLN currency (`KursWaluty` + PLN VAT) · KOR/ZAL/ROZ correction & advance FA(3) blocks · full in-process XSD validation · per-line GTU / `Procedura` markers · buyer auto-source from the linked order's encrypted snapshot · a reference-based status re-poller · active `Retry-After`/429 pacing.

## Changelog

### 2026-06-26 — Initial release (`@open-mercato/financial-pl` 0.1.0)
Send-only KSeF 2.0 connector: FA(3) `1-0E` serialization, KSeF-token authentication, online session submission, status polling, and UPO retrieval, conformed to the live TEST OpenAPI v2.6.1 and the official FA(3) XSD. Per-organization encrypted credentials (`ksef_pl` provider); three-layer per-invoice idempotency with KSeF 440-duplicate recovery; a reconciliation sweep so no invoice silently fails to reach KSeF; UMES injection on the sales-invoice host (status badge, send/retry actions, PL VAT meta fields); integration tests (TC-KSEF-001/002) + unit suites + an env-gated live TEST round-trip. Live-validated against `api-test.ksef.mf.gov.pl`.
