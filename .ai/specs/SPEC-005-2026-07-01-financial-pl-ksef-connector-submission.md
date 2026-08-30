# SPEC-005 — `financial_pl`: KSeF 2.0 connector — transport, authentication, submission, reliability, offline, batch & inbound receiving

- **Date:** 2026-07-01
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Integration provider id:** `ksef_pl`
- **Status:** **Implemented** and live-verified on the KSeF **TEST** environment (`https://api-test.ksef.mf.gov.pl/v2`). Send (online/offline/batch), inbound receiving, token + certificate/XAdES authentication, 3-layer idempotency + reconciliation, and credential management are all in production code and gate-passing. Standalone on released `@open-mercato/core`.
- **Sibling specs (do not duplicate — cross-reference):**
  - [SPEC-006](./SPEC-006-2026-07-01-financial-pl-fa3-documents-corrections-jpk.md) — FA(3) serializer, all doctypes (VAT/KOR/ZAL/ROZ/UPR/OSS), self-billing markings, corrections, NBP FX **rate sourcing**, JPK_V7 export **and JPK→MF e-submission**, JPK KSeF markings, `SalesInvoicePlMeta`.
  - [SPEC-007](./SPEC-007-2026-07-01-financial-pl-invoice-pdf.md) — human-readable invoice PDF, QR rendering (KOD I / KOD II dual-QR **on the PDF**), pagination, i18n labels.
  - [SPEC-008](./SPEC-008-2026-07-01-financial-pl-invoice-authoring-ui.md) — the operator backoffice UI (invoice list/create/edit/detail, JPK, certificates, received-invoices page), the tabbed editor, buyer capture + NIP autofill.

## TLDR

`financial_pl` makes Open Mercato's country-agnostic `sales` invoicing compliant with Poland's mandatory **KSeF** (Krajowy System e-Faktur) national e-invoicing. This spec is the **transport & lifecycle layer**: it authenticates to the Ministry of Finance API (KSeF token **or** KSeF Certificate / XAdES), submits an encrypted FA(3) document, polls per-invoice status, and stores the signed **UPO** receipt (the legal proof of filing). It covers every send channel — the interactive **online session**, the deferred **offline** (offline24 / awaryjny / niedostępność) lifecycle with statutory deadline tracking and the cert-signed KOD II QR, and the high-volume **batch (wsadowa)** package session — plus the **inbound receiving** path (mandatory since 2026-02-01: pull invoices addressed to the taxpayer as buyer). Reliability rests on a proven spine: three idempotency layers + KSeF 440 content-hash de-duplication, a reconciliation sweep, 429/`Retry-After` pacing, and a status re-poll for rows that already reached KSeF. Credentials are **per organization**, encrypted in the `ksef_pl` integration provider; there is no process-wide token and no feature flag.

The **document content** (FA(3) XML construction, doctypes, JPK) belongs to SPEC-006; the **PDF** to SPEC-007; the **operator UI** to SPEC-008. This spec owns the wire, the `KsefSubmission` model, the migrations, and the live-TEST harness.

## Overview

KSeF is mandatory for Polish VAT payers from **February 2026**. A compliant invoice must be (a) serialized to the FA(3) structured schema (SPEC-006), (b) submitted to the KSeF API and accepted — the assigned **numer KSeF** + **UPO** are the legal evidence of issuance, not the local PDF/XML — and (c) since 2026-02-01, a taxpayer must also be able to **receive** structured invoices issued *to* them. This module implements that transport obligation end-to-end.

- **Country-agnostic core stays clean.** All Polish/KSeF logic lives in this module. It depends on `sales` only by FK-id + the Query Engine (no cross-module ORM relations) and extends `sales.SalesInvoice` additively (an extension entity + a response enricher). No `sales`/core package is ever modified; migrations are always generated, never hand-written.
- **Per-organization, encrypted credentials.** NIP, environment, seller identity, the KSeF token, and (additively) the Authentication/Offline certificate material + private keys live per `(organization, tenant)` in the encrypted `ksef_pl` integration credential store, edited at `/backend/integrations/ksef_pl`. A shared cross-org secret is an explicit anti-pattern; the lawful agency (biuro-rachunkowe) model is per-NIP delegation, deliberately out of scope.
- **Off-thread, idempotent, self-healing.** An HTTP route returns `202`; a persistent queue subscriber runs the live KSeF round-trip; three idempotency layers plus KSeF's own duplicate detection prevent any double-registration; a periodic reconciliation sweep recovers stuck submissions so no invoice silently fails to reach KSeF.
- **Every send channel is covered.** Online single-invoice sessions, the offline (deferred-send) lifecycle, and batch packages all funnel through the same proven submission spine; inbound receiving is a session-less Bearer-token read path.

> **Market reference.** wFirma, inFakt, Comarch, SaldeoSMART and Fakturownia all: authenticate with a KSeF **certificate** (tokens treated as transitional), issue **offline24/awaryjny** invoices with a dual verification QR (KOD I + the cert-signed KOD II) and track the statutory send deadline, and **receive** inbound invoices via KSeF. This module matches that model.

## Problem Statement

1. **A structured invoice must physically reach and be accepted by KSeF**, and the connector must never double-register or silently drop one — the numer KSeF + UPO are the only legal proof of issuance.
2. **Token-only auth expires (regulatory).** Per the Ministry of Finance, KSeF tokens are usable only through **2026-12-31**; from **2027-01-01 only KSeF certificates remain** (*"od 1 stycznia 2027 r. … pozostaną wyłącznie certyfikaty KSeF"*). Without certificate authentication the connector stops working in 2027.
3. **Invoices must sometimes be issued outside KSeF and sent later.** A taxpayer may issue in **offline24** (own initiative, any time), **tryb awaryjny** (an MF-announced failure), or **niedostępność** (an announced unavailability window) — building and handing the buyer a compliant document now (with a cert-signed KOD II QR), then sending to KSeF by a statutory business-day deadline and receiving the numer KSeF retroactively.
4. **High-volume issuers need to send many invoices in one package** (the batch/wsadowa session), not one HTTP request per invoice.
5. **Receiving is mandatory (2026-02-01) and was missing.** A send-only connector cannot see or pull invoices issued *to* the taxpayer as buyer.
6. **Transient KSeF rate-limiting and orphaned in-flight rows** must be paced and recovered without churning the queue or risking a second send.
7. **Self-billing (samofakturowanie) is structurally un-submittable through this connector** (the connector files every invoice as the authenticated taxpayer) and must be rejected early with a clear error rather than a late KSeF 410.

## Proposed Solution / Architecture

Extend a single, platform-pure submission spine additively — no core change, no `sales` change. Authentication is a per-organization discriminated choice resolved at send time; everything after the access token (open session → encrypt → send → status → UPO) is shared verbatim across the online, offline, and batch channels. Inbound receiving is a separate session-less read path. Reliability is layered onto the client/flow/worker without altering the proven idempotency invariants.

### KSeF 2.0 online send runbook (`lib/submission-flow.ts`, `lib/ksef-client.ts`)

`submitInvoiceToKsef()` orchestrates the full 11-step runbook against one environment. It is **platform-pure** — it takes a `KsefClient` + an injectable `wait` — so it is deterministically unit-testable and is reused verbatim by the production subscriber, the offline deferred send, and the live-TEST smoke runner.

1. `GET /security/public-key-certificates` — fetch MF public keys; select the **token** and **symmetric** certs by their declared `usage`.
2. `POST /auth/challenge` — anonymous (no body); returns `challenge` + integer `timestampMs` (≈10 min validity).
3. Encrypt the auth credential (token or XAdES-sign — see **Authentication** below).
4. `POST /auth/ksef-token` (token) **or** `POST /auth/xades-signature` (certificate) — `contextIdentifier.type = "Nip"`.
5. **Poll** `GET /auth/{ref}` until in-body `status.code === 200` (**≤ 20 × 1.5 s**). HTTP **401/403/410** = terminal auth failure (fast-fail, not re-queued — `TERMINAL_AUTH_HTTP_STATUSES`).
6. `POST /auth/token/redeem` → Bearer **access token** (+ refresh token).
7. `POST /sessions/online` — FA(3) `formCode` + the RSA-OAEP-wrapped AES key + IV.
8. `POST /sessions/online/{ref}/invoices` — SHA-256 hashes/sizes + the AES-encrypted document; `offlineMode` flag (`false` online, `true` for a deferred offline send — the param at `ksef-client.ts:436`).
9. `POST /sessions/online/{ref}/close`.
10. **Poll** `GET /sessions/{ref}/invoices/{ref}` (**≤ 30 × 2 s**) until a terminal status.
11. `finalizeAccepted` fetches the **UPO** (`GET …/upo`, Accept `application/xml`). **A submission is reported `accepted` only once the UPO is in hand** — otherwise it stays `processing` so a retry heals it (never a phantom accept).

### Authentication (`lib/ksef-auth.ts`, `lib/xades.ts`, `lib/auth-token-request.ts`, `lib/credentials.ts`)

Authentication is refactored into a reusable `authenticate()` that branches on a per-organization discriminated config; everything after the access token is unchanged.

```ts
export type KsefAuthConfig =
  | { method: 'token'; ksefToken: string; contextNip: string }
  | { method: 'certificate'; contextNip: string; certificatePem: string; privateKeyPem: string;
      subjectIdentifierType?: 'certificateSubject' | 'certificateFingerprint' /* default 'certificateSubject' */ }
export async function authenticate(
  client: KsefClient, certs: KsefPublicKeyCertificate[], auth: KsefAuthConfig, options: KsefPollOptions,
): Promise<{ accessToken: string; refreshToken?: string }>
```

- **Token branch (current, sunset 2027-01-01).** `requestChallenge` → `encryptAuthToken` (RSA-OAEP-SHA256 of `"{ksefToken}|{challengeTimestampMs}"` with the MF `KsefTokenEncryption` key) → `authenticateWithToken` → poll → `redeemToken`. A valid production credential for online sending throughout the mandatory period and until the 2026-12-31 token sunset.
- **Certificate branch (the durable 2027 credential).** `requestChallenge` → `buildAuthTokenRequestXml({ challenge, contextNip, subjectIdentifierType })` → `signAuthTokenRequestXades(xml, { certificatePem, privateKeyPem })` (enveloped **XAdES-BES**) → `authenticateWithXades(signedXml)` → poll (shared loop) → `redeemToken`. The `AuthTokenRequest` carries the `Challenge`, the `ContextIdentifier` (`Nip`), and the `SubjectIdentifierType` (`certificateSubject | certificateFingerprint`).
- **The "two certificates."** Other systems (wFirma/inFakt) make users create two — these are the two `certificateType` values of **one** KSeF Certificate: **Authentication** (logging the software in — this branch) and **Offline** (signing the offline KOD II QR — see the offline lifecycle). Both are enrolled by the same runbook and persisted into separate credential fields.
- **`auto` cutover (opt-in, F4 of the compliance sweep).** `KsefAuthMethod` has a third **explicit opt-in** value `'auto'` (never default, never retro-applied): when — and only when — the operator selects `auto`, `buildKsefAuthConfig` prefers a configured, **unexpired** Authentication certificate else falls back to token. The never-infer guard stays intact for the legacy `'token'`/`'certificate'` settings, so an org is never silently switched to cert auth by the mere presence of cert material.
- **XAdES via a vetted library.** Signing uses `@peculiar/xadesjs` (+ `@peculiar/x509` for CSR) on WebCrypto — canonicalization of a legally-binding signature is never hand-rolled. `lib/xades.ts`: `generateKsefKeyPair` (EC P-256 default / RSA-2048, PEM), `buildCsr` (PKCS#10 via `Pkcs10CertificateRequestGenerator`, DN verbatim from `GET /certificates/enrollments/data`), `signAuthTokenRequestXades`. (A distinct `signJpkInitUpload` two-reference entry point also lives in `lib/xades.ts` for the JPK gateway — see SPEC-006; the auth signer is untouched by it.)

**KSeF Certificate self-signed seal subject (live-critical).** For a self-signed KSeF Authentication cert, the subject must carry **`2.5.4.97 = VATPL-<NIP>` ONLY** — adding `serialNumber = TINPL-<NIP>` causes KSeF error **21115**. LibreSSL cannot encode OID 2.5.4.97, so certs are generated via Node `@peculiar/x509`.

### Certificate enrollment & management (`lib/cert-enrollment.ts`, `commands/ksef-certificate.ts`)

The full certificate lifecycle is driven from the product (admin-only, `financial_pl.manage`):

- **Client (`lib/ksef-client.ts`), the 7 `/certificates/*` endpoints:** `getCertificateLimits` (`GET /certificates/limits`), `getCertificateEnrollmentData` (`GET /certificates/enrollments/data`, **XAdES-auth-only**), `enrollCertificate({ csr, certificateType, certificateName, validFrom? })` (`POST /certificates/enrollments` → 202 `{ referenceNumber }`), `getCertificateEnrollmentStatus` (`GET /certificates/enrollments/{ref}`), `retrieveCertificates` (`POST /certificates/retrieve`), `queryCertificates` (`POST /certificates/query`), `revokeCertificate` (`POST /certificates/{serial}/revoke`).
- **`financial_pl.ksef_certificate.enroll`** — pre-checks that the org has an XAdES-capable (certificate) credential (enrollment-data is XAdES-auth-only), else `409 certificate_auth_required_for_enrollment` (the **first** cert must be obtained externally by the operator with a qualified signature via Aplikacja Podatnika). Then `authenticate` → `getCertificateEnrollmentData` → `generateKsefKeyPair` → `buildCsr` → `enrollCertificate` (parameterized by `certificateType`, default `Authentication`) → poll `getCertificateEnrollmentStatus` (a terminal CSR/enrollment rejection surfaces `certificate_enrollment_failed`) → `retrieveCertificates`. **Persists the issued cert PEM + private key PEM (encrypted) + serial, but does NOT change `authMethod`** — activation is a separate explicit operator step (spec-jury DeepSeek fix; a back-door where cert-material presence inferred cert auth was also caught and fixed to require an explicit `authMethod==='certificate'`). Returns `{ serial, status }`, never the private key.
- **`financial_pl.ksef_certificate.list` / `.revoke`** wrap `queryCertificates` / `revokeCertificate`. All org/tenant-scoped, mutation-guarded, zod-validated.
- **Credential health (`lib/credential-health.ts`, `lib/health-check.ts`).** A pure report of token presence + the **2026-12-31 sunset** proximity, and the Authentication/Offline cert `notAfter` (parsed from the PEM) vs the 2-year cert cap; surfaced on the credential/health surface + a backoffice badge (warn when a cert expires < 30 days or the token sunset is < 60 days away).

### Cryptography (`lib/crypto.ts`)

Protocol-mandated; the only place hand-rolled AES/RSA is used (ARCHITECTURE §16 — hand-written crypto only where the protocol mandates it).

- **Document body:** AES-256-CBC + PKCS#7 (random 256-bit key, random 128-bit IV).
- **AES key (online + batch):** wrapped **RSA-OAEP (MGF1-SHA256)** with the MF `SymmetricKeyEncryption` key.
- **Auth token:** wrapped **RSA-OAEP-SHA256** of `"{token}|{timestampMs}"` with the MF `KsefTokenEncryption` key.
- **Hashes:** SHA-256 plaintext + ciphertext hashes/sizes accompany each send.
- (The JPK→MF gateway uses a **distinct RSA PKCS#1-v1.5** key-wrap — a separate `rsaPkcs1v15WrapKey` helper — leaving the OAEP path untouched; see SPEC-006.)

### KOD II offline verification QR (`lib/ksef-qr-cert.ts`)

KOD II is a **new, different signature** from the XAdES auth path (which uses RSA-PKCS1-v1.5). It signs the **URL fragment** (not the XML):

- Canonical string (no scheme, no trailing slash): `qr-{env}.ksef.mf.gov.pl/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}`; the base64url signature is appended as segment 6.
- **RSA:** `{ name: 'RSA-PSS', hash: 'SHA-256', mgf: 'MGF1-SHA-256', saltLength: 32 }`. **EC:** `{ name: 'ECDSA', hash: 'SHA-256' }` (WebCrypto yields the IEEE-P1363 64-byte raw form). Reuses `ksefInvoiceHashBase64Url` (the same hash as KOD I) + `toBase64Url` + `sha256` + `resolveKsefQrHost`.
- `ContextType` casing is `Nip` (live-confirmed); RSA-PSS `saltLength:32` is live-confirmed. `buildKodIIUrl` is the public export (`signKodII` is its internal helper). The PDF renders KOD II beside KOD I (SPEC-007).

### Offline issuance lifecycle (`lib/offline-deadline.ts`, `commands/ksef-submission.ts`, `subscribers/ksef-send-offline.ts`, `workers/ksef-reconcile.worker.ts`)

Offline issuance is a **real lifecycle**, not a permanent exemption — the invoice WILL get a numer KSeF, it just hasn't been sent yet. It MUST NOT set `issuedOutsideKsef` (that is the permanent BFK exemption; see SPEC-006). The three in-force modes:

| Mode | Trigger | Send-to-KSeF deadline | Legal basis |
|---|---|---|---|
| **offline24** | Taxpayer's own initiative, any time — no outage required. | **Next business day** after issuance. | art. 106nda |
| **tryb awaryjny** (== `awaria`) | An MF-announced KSeF failure (BIP). | `failureEndsAt` + **7 business days**. | art. 106nf |
| **niedostępność** | An MF-announced unavailability window (BIP). | announced-period-end → **next business day**. | art. 106nh |

- **Terminology fixed on consolidation.** `awaria` == the existing `awaryjny`. `niedostępność` was added by widening the `OfflineSendMode` / `KsefSubmissionMode` TS unions only — the DB `mode` column is free `text` with no CHECK constraint, so **no migration** for the new enum value. Because MF publishes unavailability/awaria via **BIP, not an API**, the mode + failure window are **explicit operator input** on the issue-offline action, never a poll.
- **Total awaria (awaria całkowita) — a DISTINCT state.** A complete-outage path with **no FA(3) to KSeF, no KSeF send, and no QR**; modeled as the `issuedOutsideKsef` meta + the JPK **`BFK`** marking (not an `OfflineSendMode` value — it never sends and has no deadline).
- **The lifecycle.** `financial_pl.ksef_submission.issue_offline` resolves the FA(3) XML (SPEC-006), requires an Offline cert (`409 offline_certificate_required`) and **validates the Offline cert `validFrom`/`validTo`** before signing (`offline_certificate_invalid`), computes KOD I (label "OFFLINE") + KOD II (label "CERTYFIKAT") + the deadline, applies `assertNotSelfBilled`, and persists a `KsefSubmission` with `status='offline_issued'`, the stored `invoice_xml`, the KOD I/II URLs, the Offline cert serial, `offline_issued_at`, and `offline_send_deadline_at`. For `awaryjny` a `failureEndsAt` is required (`offline_mode_invalid` otherwise); `offline24` needs none.
- **Deferred send + reconcile.** The reconcile worker adds an `offline_issued` candidate query keyed on `offline_send_deadline_at` (prioritize rows approaching/over the deadline), CAS-claims `offline_issued → processing`, and emits `financial_pl.ksef_submission.send_offline`. The subscriber sends the **stored** byte-stable XML with `offlineMode:true` (an *initial* send, not a re-poll), then reconciles the retroactive numer KSeF/UPO and sets `accepted_at` to the KSeF-assigned timestamp (the legal received date). The CAS claim + KSeF 440 content-hash heal keep it duplicate-safe.
- **Deadline calculator (pure).** `computeOfflineSendDeadline({ issuedAt, mode, failureEndsAt?, holidays })` skips weekends + Polish public holidays; an offline24 invoice overtaken by an announced failure switches to the awaryjny rule via `financial_pl.ksef_submission.recompute_offline_deadline`. Holidays come from a bundled `polishPublicHolidays(year)` (fixed feasts + Easter-derived movable feasts — Easter Monday, Pentecost, Corpus Christi — via the Anonymous Gregorian/Meeus Computus algorithm, valid for any year); `OM_KSEF_PL_HOLIDAYS` (CSV of ISO `YYYY-MM-DD`) **adds** ad-hoc non-working days. Tests pin the 2026/2027 sets.

### Batch (wsadowa) session (`lib/batch-package.ts`, `lib/ksef-client.ts`, `commands/ksef-submission.ts`)

- **Client:** `openBatchSession({ accessToken, formCode, encryption, batchFile, fileParts })` nests `fileParts` inside `batchFile` and declares `compressionType: 'Zip'`, matching the live KSeF API 2.7.0 contract, then calls `POST /v2/sessions/batch` → `{ referenceNumber, partUploadRequests[] }`; `uploadBatchPart(request, encryptedBytes)` (verb/headers **driven from the API response, never hardcoded**); `closeBatchSession(accessToken, referenceNumber)` → `POST /v2/sessions/batch/{ref}/close`. Status/UPO reuse the **shared** `/sessions/{ref}`, `/sessions/{ref}/invoices`, `/invoices/failed`, and per-invoice + aggregate UPO endpoints.
- **Packaging:** ZIP the FA(3) XMLs, split into **≤ 100 MB** parts, AES-256-CBC-encrypt each part with the **same** session-key handshake as the online session (AES-256 + RSA-OAEP-SHA256 wrap — shared `lib/crypto.ts`), compute SHA-256 of the whole ZIP + each part for the manifest and of each plaintext invoice for result correlation. The **absolute-URL part PUT** uses `lib/http-put.ts` (a small `AbortController`-bounded PUT helper — the `ksef-client` transport is `GET|POST|DELETE` + baseUrl-relative and cannot do it).
- **Command:** `sendBatchCommand(invoiceIds[])` creates **one `KsefSubmission` row per invoice** tagged with a shared `batchReference`, opens/uploads/closes the batch session, then the reconcile worker resolves per-invoice numbers + UPO via the shared status endpoints. `assertNotSelfBilled` applies **per invoice** before packaging.

### Inbound invoice receiving (`lib/received-invoice.ts`, `commands/ksef-receive.ts`)

Session-less, Bearer access token, permission `InvoiceRead`; mandatory since 2026-02-01.

- **Client:** `queryReceivedInvoices(accessToken, filters, page)` → `POST /v2/invoices/query/metadata?pageOffset&pageSize&sortOrder` with `InvoiceQueryFilters` (`subjectType:'Subject2'` for buyer, `dateRange{dateType,from,to}`, optional `sellerNip`/`invoiceTypes`); returns paged `InvoiceMetadata[]` (+ `hasMore`, `permanentStorageHwmDate`). `downloadInvoiceByKsefNumber(accessToken, ksefNumber)` → `GET /v2/invoices/ksef/{ksefNumber}` (`Accept: application/xml`) → raw FA(3) XML. (An async `/invoices/exports` bulk path is present but **deferred behind a disabled feature flag** for large tenants; the synchronous metadata query is the shipped path.)
- **Receive flow (`receiveInvoicesCommand`).** Authenticate (reuse `ksef-auth`), page through `queryReceivedInvoices` for the window as `Subject2`. **`isTruncated` handling:** the metadata query caps a result set at 10,000; when `isTruncated`, the loop **narrows `dateRange`** (advance `from` to the last returned record's date) and resets `pageOffset` rather than trusting `hasMore`/HWM alone. Upsert each into `financial_pl_received_invoice`, **idempotent on `(scope, ksefNumber)`** (mirroring the 23505 race-winner pattern). **No-clobber:** on re-fetch, the legally-significant fields (`ksefNumber`, `acquisitionDate`, `issuerNip`, `fa3Xml`, amounts) are **first-write-wins / immutable**; only volatile sync metadata (`fetchedAt`) updates. Time-bounded, fail-safe (a partial-page error logs + continues, never throws into unrelated flows).
- **`acquisitionDate` = the legal receipt date** (*"data otrzymania faktury = data nadania numeru KSeF"*, per CIRFMF docs). `permanentStorageDate` is only the stable **sync cursor** key — the two must not be conflated.
- **Sync cursor.** `permanentStorageHwmDate` persists **per `(scope, subjectType, contextNip)`** (a small `financial_pl_receive_cursor` row) so incremental receive resumes from the high-water mark and multi-NIP tenants keep isolated cursors.
- **Materialization is EXPLICIT-only.** A `PurchaseVatRecord` (`financial_pl`'s OWN entity `financial_pl_jpk_purchase_record` — NOT a core entity, no cross-module ORM; the JPK ledger shape is defined in SPEC-006) is created only by the explicit `to-purchase-record` action, **idempotent + transactional** (a partial-unique link inside one transaction guarantees repeat clicks / concurrent POSTs cannot duplicate a ledger row). A received KOR/correction (`invoiceType` + `hashOfCorrectedInvoice`) is stored linked to the corrected received invoice; materializing it produces a corrective `PurchaseVatRecord` (signed/delta amounts) with the right `ksefMarking`.

### Status & duplicate handling (`lib/status.ts`, `lib/ksef-number.ts`)

- Invoice scope: `200` = accepted; **`440` = accepted DUPLICATE** — recover the original numer KSeF + UPO from `status.extensions.originalKsefNumber`/`originalSessionReferenceNumber`, so a retry/redelivery of an already-registered invoice is **never** reported rejected; other `≥ 400` = rejected; else processing. **The 440 dedup key is the SHA-256 content hash** (`invoiceHash`), not seller NIP + RodzajFaktury + number — a KOR has a distinct hash so never collides with the corrected invoice.
- The **numer KSeF** (`NIP-YYYYMMDD-<technical>-<crc>`, 35 chars) is parsed/validated structurally (NIP + date digits; technical/CRC as uppercase hex), hyphen-tolerant; the checksum is **not** recomputed (MF has not published the algorithm).

## Reliability & idempotency

**No invoice is ever registered twice; no invoice silently fails to reach KSeF.** Three layers of duplicate prevention plus KSeF's own 440 detection:

1. **Resolve-first guard** — the send command returns an existing `queued|processing|accepted|offline_issued` submission for the same invoice instead of creating a second.
2. **Partial unique index** — DB-level CAS at insert; the loser of a concurrent race catches the `23505` and returns the winner.
3. **Atomic claim CAS** — the subscriber `nativeUpdate`s `status: 'queued' → 'processing'` (and `offline_issued → processing` for the deferred send); exactly one redelivery claims the row. A transient failure after the claim resets to `queued` and rethrows so the queue retries.
4. **KSeF 440-duplicate** is the final safety net — a content-identical re-send resolves to `accepted` with the original number + UPO.

**429 / `Retry-After` pacing.** In the client `request()` chokepoint a `429` raises a typed `KsefRateLimitError extends KsefApiError` carrying `retryAfterMs` (parsed from `Retry-After`: delta-seconds AND HTTP-date; capped by `OM_KSEF_RETRY_AFTER_MAX_MS`, default ~60000, defaulted when absent/garbage). The flow honors it with a **single bounded** in-flow `wait` + one retry, then propagates so the subscriber resets `processing→queued` and the queue retries. `getAuthStatus` poll is also wrapped in the pacer. No unbounded sleep.

**Status re-poll recovery.** `repollSubmission(client, auth, { sessionReference, invoiceReference }, options)` runs `authenticate → getInvoiceStatus → evaluateInvoiceStatus → finalizeAccepted` (UPO) — **no `openOnlineSession`/`sendOnlineInvoice`** — for `processing` rows that already carry **both** references (they provably reached KSeF; recover with zero re-send). The `subscribers/ksef-repoll.ts` handler (event `financial_pl.ksef_submission.repoll`) writes the outcome idempotently. **Fallback:** a not-found/404 status or a repoll that stays non-terminal re-emits `financial_pl.ksef_submission.queued` (the proven 440-safe re-send) so a row never strands; a transient 5xx rethrows for the queue retry; the breaker bounds total attempts.

**Reconciliation sweep** (`workers/ksef-reconcile.worker.ts`, queue `financial-pl-ksef-reconcile`, concurrency 1). Recovers submissions orphaned in `processing` (a worker crashed after the claim — persistence is terminal-only, so the row has no refs and must be re-driven), stuck in `queued` (a lost dispatch), or `offline_issued` (deferred send by deadline), and re-drives batch + JPK-submission rows. Routing:

- A stale `processing` row **with** both `sessionReference` and `invoiceReference` → **repoll**; **without** refs (true orphan) or a stale `queued` row → **queued** (duplicate-safe re-send); an `offline_issued` row by deadline → **initial send** with `offlineMode:true`.
- `processing` candidates keyed on **`submitted_at < cutoff`** (set at the claim, so a freshly-claimed live row is excluded); `queued` on `updated_at`; `offline_issued` on `offline_send_deadline_at`.
- A **circuit breaker** on `attempt_count` excludes over-ceiling rows from the candidate query and surfaces stuck ids in the log (never silently dropped); the reconciler increments `attempt_count` on each re-drive so the breaker is reliable across crashes.
- Tunables: `OM_KSEF_RECONCILE_STALE_MINUTES` (default **15** — well above the ≤ ~90 s worst-case happy path), `OM_KSEF_RECONCILE_MAX_ATTEMPTS` (default **6**).
- Scheduled per organization (15-min interval) from `setup.ts seedDefaults` via the **optional-peer** `schedulerService` (silent no-op if the scheduler module is absent); the schedule id keys on both tenant and organization.

### Self-billing guard

Self-billing is structurally un-submittable: the connector always files as the authenticated taxpayer (invariant `seller.nip === contextNip`), so an art. 106d self-billed invoice (issuer ≠ seller) is always rejected live by KSeF with **HTTP 410** (*"Faktura wystawiania we własnym imieniu nie może posiadać adnotacji 'samofakturowanie'"*). A shared `assertNotSelfBilled(invoice)` guard throws `CrudHttpError(422, code: 'self_billing_unsupported')` when `invoice.selfBilling === true` **or** `invoice.annotations?.selfBilling === true` (both channels feed FA(3) `P_17`). It is applied at **every** submit-to-KSeF creation path: online `sendCommand` (right after `seller_nip_mismatch`), `issueOfflineCommand` (after cert validation, before KOD II is built or an `offline_issued` row is persisted — the offline deferred send bypasses `sendCommand`), and **per invoice** in `sendBatchCommand` (before packaging). `retryCommand` needs no guard (both creation paths are guarded, so no new self-billed row can exist to retry). Storing `self_billing` on PL meta for JPK record-keeping is unaffected — only **submitting** a self-billed invoice as the seller is blocked.

### KSeF immutability guard (fail-closed write interceptors)

A KSeF-`accepted` or locally `offline_issued` invoice is legally immutable (it can only be corrected via a KOR — SPEC-006); an in-flight (`queued`/`processing`) submission must not race a concurrent edit either. A disabled UI button (SPEC-008) is insufficient — a stale tab, another client, or a raw API call can still mutate — so immutability is enforced **server-side at the API boundary** by two additive, fail-closed `before` API interceptors (`api/interceptors.ts`), with **no core code change** (ARCHITECTURE §11.4; conditional `409` only for KSeF-locked invoices, transparent otherwise):

- `financial_pl.ksef-immutability.sales-invoices` — targets the core `sales/invoices` route, methods **`PUT`/`DELETE`**, priority 100, `timeoutMs` 2000.
- `financial_pl.ksef-immutability.invoice-meta` — targets the module's own `financial_pl/ksef/invoice-meta` **`PUT`** (the body carries `salesInvoiceId`).

Both resolve the target invoice id (PUT body `{id}` → query `?id=` → the raw URL's `?id=`, so every core delete/update addressing style is caught — a missed id fails **open**, letting the route do its own validation) and call `isInvoiceKsefLocked(invoiceId)` — an `em.count(KsefSubmission …)` over `status ∈ {queued, processing, accepted, offline_issued}`, **`documentKind = 'invoice'`**, `organizationId`/`tenantId`-scoped, `deletedAt IS NULL`. Locked ⇒ `{ ok: false, statusCode: 409, message: t('financial_pl.errors.invoice_locked_ksef', …) }` ("This invoice is locked … Issue a correction (KOR) instead of editing it."). The `documentKind='invoice'` discriminator is load-bearing: an accepted **correction** stores `sales_invoice_id` = the *corrected original*, so without it an accepted KOR would spuriously lock the original. The interceptors carry **no `features` gate** — the check must run for every caller regardless of feature set (a feature gate would let a more-privileged user bypass immutability). This 409-on-locked behaviour is the module's effective, documented contract on the core write routes (SPEC-008's UI relies on it).

## Data Models

Entities are `organization_id` + `tenant_id` scoped, soft-delete, `updated_at`. All migrations are **generated** (`yarn generate` / `yarn db:generate`), never hand-written; the ORM snapshot is regenerated with them.

### `KsefSubmission` — `financial_pl_ksef_submissions`

`id`, `organization_id`, `tenant_id`, `sales_invoice_id` (FK-id), `document_kind` (`invoice` | `credit_memo`, default `invoice`; see SPEC-006), `credit_memo_id` (uuid, null), `environment` (`test`/`demo`/`prod`), `mode` (`online` | `batch` | `offline24` | `awaryjny` | `niedostepnosc` — free `text`, no CHECK constraint), `status` (`queued`/`processing`/`accepted`/`rejected`/`offline_issued`; default `queued`), `context_nip`, `invoice_xml` (**encrypted**), `session_reference`, `invoice_reference`, `ksef_number`, `upo_ref`, `upo_xml` (**encrypted**), `last_status_code`, `last_error_code`, `last_error_message`, `attempt_count`, `submitted_at`, `accepted_at`, `batch_reference` (groups a batch), `offline_issued_at`, `offline_send_deadline_at`, `kod_i_url`, `kod_ii_url`, `offline_certificate_serial`, timestamps.

- **Active-unique partial index** `financial_pl_ksef_submissions_active_unique` on `(organization_id, tenant_id, sales_invoice_id) WHERE status IN ('queued','processing','accepted','offline_issued') AND document_kind='invoice' AND deleted_at IS NULL`.
- **`financial_pl_ksef_submissions_credit_memo_active_unique`** — the parallel partial index for `document_kind='credit_memo'` keyed on `credit_memo_id`, same status set (defined in SPEC-006; both indexes were extended to include `offline_issued`).

### `financial_pl_received_invoice` (inbound)

`(organization_id, tenant_id, context_nip?)` scope; `ksef_number` (unique per active scope); `issuer_nip`, `issuer_name`, `buyer_identifier_type`, `buyer_identifier_value`, `issue_date`, `acquisition_date` (= receipt date), `invoice_type`, `currency`, `net_amount`/`gross_amount`/`vat_amount` (text), `invoice_hash`, `fa3_xml?` (**encrypted** — declared in `encryption.ts`), `linked_purchase_record_id?`, `fetched_at`, timestamps + `deleted_at`. Partial-unique link mirrors the existing entities' pattern.

### `financial_pl_receive_cursor` (inbound sync)

`(scope, subject_type, context_nip)` → `permanent_storage_hwm_date`, `last_synced_at`.

### `SalesInvoicePlMeta` — `financial_pl_invoice_meta`

The additive PL-VAT extension on `sales.SalesInvoice`; **owned by SPEC-006** (full column list there — `context_nip`, `ksef_status`, `ksef_number`, `mpp_required`, `vat_exemption_basis`, `issued_outside_ksef`, doctype/OSS/FX/GTU signals, etc.). This spec reads/writes only the KSeF status/number fields via the enricher. `PurchaseVatRecord` (`financial_pl_jpk_purchase_record`) and `JpkVatFiling` are likewise **owned by SPEC-006**; inbound receiving materializes into `PurchaseVatRecord` and reads it, but its column definitions live there.

### Credential schema (`integration.ts`)

`ksef_pl` integration credentials (encrypted by `IntegrationCredentialsService`, not DB columns): `environment` (required), `contextNip` (required, 10-digit), `authMethod` (`token`|`certificate`|`auto`, default `token`), `ksefToken` (**secret**), `certificatePem`, `certificatePrivateKeyPem` (**secret**), `certificateSerialNumber`, `offlineCertificatePem`, `offlineCertificatePrivateKeyPem` (**secret**), `offlineCertificateSerialNumber`, a dedicated JPK-signer credential (`jpk_signer_pem`/`_key` or Trusted-Profile/AuthData selector — see SPEC-006), `sellerName`, `sellerAddressLine1`, `sellerAddressLine2`. Seller name/address are required before a submission succeeds (resolver `422 seller_required`).

### Encryption & cross-module links

- `encryption.ts` (module root): on `financial_pl:ksef_submission`, `invoice_xml` + `upo_xml` are encrypted; on `financial_pl:received_invoice`, `fa3_xml`; on `financial_pl:jpk_vat_filing`, `upo_xml` (SPEC-006). Certificate/token/private-key credentials are encrypted separately by `IntegrationCredentialsService`, never returned/logged.
- `data/extensions.ts`: `sales:sales_invoice` → `financial_pl:sales_invoice_pl_meta` (1:1) and → `financial_pl:ksef_submission` (1:N), **FK-id only** (no cross-module ORM relation).

### Migrations

- **`Migration20260622203145_financial_pl`** — the initial `KsefSubmission` + `SalesInvoicePlMeta` tables + the `active_unique` partial index.
- **`Migration20260630000000`** (+ snapshot) — additive: the `received_invoice` + `receive_cursor` tables, the `KsefSubmission.batch_reference` + offline columns, and the `JpkVatFiling` submission columns (SPEC-006). Migrate-from-zero was verified on a fresh DB (both new tables + 5 columns + 2 partial-unique indexes created).

## API Contracts

All internal routes under `/api/financial_pl/ksef/...`; zod inputs; custom routes guard via the mutation-guard registry; OpenAPI documented; tenant-scoped DB reads; external calls time-bounded + structured-error (fail-open where they are conveniences, explicit-error where they are the operation). Feature ids reuse `financial_pl.view` / `.submit` (⊃ view) / `.manage` (⊃ view) — **no new ACL ids**.

| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/submissions` | `GET` | `view` | List submissions (org/tenant-scoped; `?ids=`, `?salesInvoiceId=`, `?status=`). |
| `…/submissions` | `POST` | `submit` | Queue from an explicit FA(3) payload; idempotent; `202` + `submissionId`. |
| `…/submissions/from-invoice` | `POST` | `submit` | Explicitly issue and resolve FA(3) from `{salesInvoiceId}`; blank/draft/pending are eligible and immediately locked by the queued row; `202`. 404 unknown / 409 canceled-or-void·proforma·no-credentials / 422 doc-type·seller·buyer·self-billing·issue-date. |
| `…/submissions/from-credit-memo` | `POST` | `submit` | Queue a KOR correction (SPEC-006); `202`/404/409/422. |
| `…/submissions/retry` | `POST` | `submit` | Re-queue a non-accepted submission; `202`; 409 if already accepted; optimistic-locked. |
| `…/submissions/issue-offline` | `POST` | `submit` | Issue offline (`offline24`\|`awaryjny`\|`niedostepnosc`): build XML + KOD I/II, persist `offline_issued` + deadline. 409 no Offline cert / 422 invalid mode·cert·self-billing. |
| `…/submissions/batch` | `POST` | `submit` | Batch send `{invoiceIds}`; `202` `{ ok, batchReference, count }`; per-invoice self-billing rejected before packaging. |
| `…/submissions/upo` | `GET` | `view` | Download the decrypted UPO XML for `?id=`; 404 unless `accepted`. |
| `…/received-invoices` | `GET` | `view` | List received (inbound) invoices (paged, tenant-scoped). |
| `…/received-invoices/sync` | `POST` | `submit` | Trigger a receive for a date window (`Subject2`). |
| `…/received-invoices/[ksefNumber]/xml` | `GET` | `view` | Download the stored/fresh FA(3) for a received invoice. |
| `…/received-invoices/[ksefNumber]/to-purchase-record` | `POST` | `manage` | Materialize a `PurchaseVatRecord` (idempotent + transactional). |
| `…/certificates` | `GET` | `manage` | List the org's KSeF certificates (`queryCertificates`). |
| `…/certificates/enroll` | `POST` | `manage` | Enroll (`certificateType` `Authentication`\|`Offline`); `202` `{ serial, status }`; 409 if no auth credential. |
| `…/certificates/revoke` | `POST` | `manage` | Revoke a serial. |
| `…/invoice-meta` | `GET`/`PUT` | `view`/`manage` | Read/upsert `SalesInvoicePlMeta` (SPEC-006 owns the field set); optimistic-locked. |

**Commands:** `financial_pl.ksef_submission.send` / `.retry` / `.send_from_invoice` / `.send_from_credit_memo` / `.issue_offline` / `.send_offline` / `.recompute_offline_deadline` / `.send_batch` / `.repoll`; `financial_pl.ksef_certificate.enroll` / `.list` / `.revoke`; `financial_pl.received.receive` / `.materialize_purchase_record`.
**Events:** `financial_pl.ksef_submission.queued` (lifecycle), `.accepted` / `.rejected` (`clientBroadcast: true`), `.repoll`, `.send_offline`, `.recompute_offline_deadline`; `financial_pl.received.synced`; `financial_pl.batch.sent`. Subscribers are auto-discovered by their `metadata.event` export at `yarn generate` time (no manual subscriber registry); commands are registered in `commands/index.ts`.
**ACL:** default grants `admin: financial_pl.*`, `employee: financial_pl.view`.

**External KSeF v2 endpoints consumed** (pinned to the live TEST OpenAPI v2.7.0): `GET /security/public-key-certificates`; `POST /auth/challenge`; `POST /auth/ksef-token`; `POST /auth/xades-signature`; `GET /auth/{ref}`; `POST /auth/token/redeem`; `POST /sessions/online` + `…/{ref}/invoices` + `…/{ref}/close`; `GET /sessions/{ref}/invoices/{ref}` + `…/upo`; `POST /sessions/batch` + `…/{ref}/close`; `POST /invoices/query/metadata`; `GET /invoices/ksef/{ksefNumber}`; the 7 `/certificates/*` endpoints. (The MF **JPK** gateway `e-dokumenty.mf.gov.pl` is a *separate* gateway owned by SPEC-006.)

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

- **Env:** `OM_KSEF_ENVIRONMENT` (`test`/`demo`/`prod`, default `test`, selects base URLs only); `OM_KSEF_RECONCILE_STALE_MINUTES` (15); `OM_KSEF_RECONCILE_MAX_ATTEMPTS` (6); `OM_KSEF_RETRY_AFTER_MAX_MS` (~60000); `OM_KSEF_QR_HOST` (override for KOD I + KOD II hosts); `OM_KSEF_PL_HOLIDAYS` (CSV of extra ISO holidays). Base URLs: TEST `api-test.ksef.mf.gov.pl`, DEMO `api-demo.ksef.mf.gov.pl`, PROD `api.ksef.mf.gov.pl`; API prefix `/v2`. QR hosts: `qr-test`/`qr-demo`/`qr` per environment.
- **Per-org credentials UI:** `/backend/integrations/ksef_pl` (token/keys masked; save scope derived server-side, gated by `integrations.credentials.manage`).
- **Optional dep:** `@peculiar/xadesjs` (+ `@peculiar/x509`) — vetted, MIT, WebCrypto-based, lockfile-pinned.

## Multi-tenant configuration

Configuration is **per organization** — NIP/token/certs/environment/seller identity live in the encrypted `ksef_pl` integration credentials keyed to `(organization, tenant)`. There is no process-wide token. A **shared secret** across organizations is an anti-pattern (single point of catastrophic failure, GDPR blast-radius, breaks per-NIP rotation across the 2026→2027 token→certificate transition). The lawful "shared/agency" model — one biuro rachunkowe serving many clients — is **per-NIP delegation** (the client grants *uprawnienia* to the office's entity; the office authenticates in each client's NIP context, one level deep). That would require a shared *certificate* + per-client `uprawnienia` + context switching, and is **deliberately out of scope**.

## Risks & Impact Review

### Data Integrity
- **Wrong/invalid XAdES signature** → KSeF rejects auth (no invoice is sent; nothing is registered). Severity High → mitigated by a vetted library + unit tests (signature verifies, structure matches the schema) + the env-gated live cert-auth round-trip. Residual: only a live round-trip fully proves acceptance — a handoff item.
- **KOD II signature invalid** (wrong padding/key/canonical string) → the buyer's QR fails KSeF verification. High → mitigated by unit tests (RSA-PSS `saltLength:32` + ECDSA-P1363 verify against the cert; canonical string matches the template) + the env-gated live block. RSA-PSS `saltLength:32` + `Nip` casing are live-confirmed.
- **Wrong retroactive offline reconcile** (number/UPO/`accepted_at`) → mis-dated legal receipt. High → mitigated by reusing the UPO-gated online reconcile and setting `accepted_at` to the KSeF timestamp on byte-stable stored XML.
- **Missing invoice issue date** → previously silently defaulted to "today" (a mis-dated fiscal filing); now **rejected** at resolve time (`422 issue_date_required`, SPEC-006) — an intentional, surfaced narrowing (no compatibility flag).
- **Conflating `acquisitionDate` with `permanentStorageDate`** on inbound → wrong legal receipt date. Mitigated: `acquisitionDate` is the receipt date, `permanentStorageDate` is the cursor key only; no-clobber first-write-wins on legal fields.
- **Private key exposure** → impersonation / forged KOD II. Critical → mitigated: keys stored as encrypted integration `secret`s, never returned in a response, never logged; enrollment writes them back encrypted.

### Cascading Failures & Side Effects
- **Re-poll racing the re-send** → a row is routed to exactly one path by whether refs exist; the reconcile CAS bump + cutoff guard gate re-emits; re-poll never sends, so even a double-trigger only polls twice (idempotent). Medium → eliminated by construction.
- **Duplicate send** (online/offline/batch) → CAS claim + KSeF 440 content-hash heal + byte-stable XML recover the original registration. Medium → eliminated by construction.
- **429 pacing looping** → bounded single in-flow wait + one retry, then propagate to the queue. Low → mitigated.
- **Missed statutory offline deadline** (prolonged outage) → legal breach. High → mitigated by storing + prioritizing `offline_send_deadline_at`, an overdue alert, and the reconcile breaker surfacing a stuck row as gave-up. Residual: a prolonged outage past the window is an operational risk the operator monitors.
- **Offline-cert enrollment clobbering the Authentication credential** → separate `offlineCertificate*` fields eliminate it.
- **`issuedOutsideKsef`/offline confusion (JPK mis-mark)** → offline issuance never sets `issuedOutsideKsef`; the JPK marking is `DI`/`OFF` until the number is assigned, then `NrKSeF` (SPEC-006).

### External gateway/API unavailability (KSeF, NBP, batch upload)
- Medium → every external call is `AbortController`-bounded; conveniences fail open; operations surface a clear retryable error and never corrupt local state (idempotent references + the reconcile worker re-drives). No retry storms. Residual: Low.

### Tenant & Data Isolation
- All reads/writes/commands are `(tenantId, organizationId)`-scoped; certs/keys/tokens are per-org integration secrets; KOD II is built per submission row; received invoices and cursors are per-scope. No cross-org surface.

### Migration & Deployment
- Additive only — new nullable columns + two new tables; online behavior byte-for-byte unchanged (`offlineMode` defaults false; `mode`/`status` widenings are free-text/additive). Migrate-from-zero verified. New credential fields default absent → existing orgs unaffected until they opt in.

### Risk Register (severity → status)
- XAdES signature incorrect / KSeF-rejected — High → mitigated (live handoff for final proof).
- KOD II signature rejected by KSeF — High → mitigated (live-confirmed saltLength/casing).
- Re-poll strands a row in `processing` — High → mitigated (not-found/exhaustion re-emits `queued`; 5xx rethrows; breaker bounds attempts).
- Enrollment auto-activates an unverified cert — Critical → eliminated (storage decoupled from activation; explicit `authMethod`).
- Missed send-to-KSeF offline deadline — High → mitigated (stored + prioritized deadline; overdue alert).
- Offline cert clobbers Authentication credential — High → eliminated (separate fields).
- Duplicate send (online/offline/batch) — Medium → eliminated by construction.
- Batch package crypto / part-upload divergence — Medium → mitigated (reuse the online handshake; response-driven verb/headers; live 2–3-invoice round-trip).
- Self-billing guard blocks a legitimate future flow — Low → the flow is already impossible (KSeF 410); the guard only improves the error and would be relaxed with the external-seller roadmap item.
- Private-key handling — Critical → mitigated (encrypted `secret`, never returned/logged).

## Final Compliance Report — 2026-07-01

### AGENTS.md Files Reviewed
`AGENTS.md` (root, official-modules) · `.ai/specs/AGENTS.md` · `ARCHITECTURE.md` (§11 UMES/own-UI-by-composition, §15 tenancy/auth, §16 crypto, §22 DS/i18n, §26/§28 generated/standalone, §27 BC, §31 checklist) · core `packages/core/.../integrations` (read-only, credentials service contract).

### Compliance Matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | Submissions FK-id only; creds via `IntegrationCredentialsService`; `PurchaseVatRecord` is `financial_pl`'s own entity. |
| root AGENTS.md | Filter by organization_id (+ tenant) | Compliant | All reads/writes/commands org+tenant-scoped; per-`contextNip` receive cursors. |
| root AGENTS.md | Never modify core packages | Compliant | `sales`/core read-only; all changes in `financial_pl`. |
| root AGENTS.md | Never hand-write migrations | Compliant | All migrations generated via `yarn generate`/`db:generate`. |
| root AGENTS.md | zod-validate all API inputs | Compliant | Every new route body/query is zod-validated with `z.infer` types. |
| root AGENTS.md | No `any` / no hardcoded user strings | Compliant | i18n × 4 (en/pl/de/es); internal/log strings prefixed. |
| ARCHITECTURE §16 | Hand-written crypto only where protocol-mandated | Compliant | AES/RSA in `crypto.ts`; XAdES via `@peculiar/xadesjs`; KOD II via WebCrypto. |
| ARCHITECTURE §27 | Backward-compatibility (additive only) | Compliant | New auth/offline/batch/receive paths alongside the online token path; no removed surface. |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | `KsefSubmission`/received/cursor columns back the send/offline/batch/receive routes. |
| API contracts match UI/UX | Pass | Backoffice UI (SPEC-008) consumes these routes; cert mgmt is command/route-driven. |
| Risks cover all write operations | Pass | Auth, enroll, online/offline/batch send, receive/materialize, re-poll, 429 covered. |
| Commands defined for all mutations | Pass | Send/retry/offline/batch/receive/cert commands enumerated. |

### Verdict
**Compliant** — implemented, gate-passing, and live-verified on KSeF TEST for online send (token and certificate/XAdES), KOR, offline issuance + deferred send/KOD II, batch, status/UPO, certificate enrollment/revocation, and inbound-sync empty-state handling. JPK→MF remains a separate gateway owned by SPEC-006 and requires a separate JPK signer credential.

## Testing & live-TEST harness

**Integration** (`__integration__/`, self-contained, API-level `request` fixture, no live KSeF):
- **TC-KSEF-001** — `POST /ksef/submissions` → `202` + `submissionId`; the row appears in the org/tenant-scoped list; invalid payload → 400; unauthenticated read → 401.
- **TC-KSEF-002** — `POST /ksef/submissions/from-invoice` → 401 unauthenticated / 400 invalid / 404 unknown invoice.
- **TC-KSEF-005** — certificate management routes (401 anon / 403 without `manage` / 400 invalid / 409 no auth credential / 200 list shape).
- **TC-KSEF-008** — offline enrollment (`certificateType:'Offline'`) + `issue-offline` + KOD II contract (401/403/400/409, `offline_issued` shape echoing the deadline + KOD I/II URLs).
- **TC-KSEF-RECV-001** — received-invoices routes: 401 unauth; list paged/tenant-scoped; `sync` validates the window; `to-purchase-record` materializes a `PurchaseVatRecord` with the right supplier/amounts/`nrKsef`/`receiptDate`; XML route returns FA(3) or 404.
- **TC-KSEF-BATCH-001** — batch route: 401 unauth; `financial_pl.submit` gate; self-billed invoice rejected (`assertNotSelfBilled`) before packaging; creates `KsefSubmission` rows sharing a `batchReference`.
- Self-billing command tests: `assertNotSelfBilled` rejects both `selfBilling` and `annotations.selfBilling` (`422 self_billing_unsupported`) at `sendCommand` and `issueOfflineCommand` (after cert validation, before any row/KOD II).

**Unit** (`lib/__tests__/`, `commands/__tests__/`): crypto (AES+RSA round-trips), ksef-client (every request/response shape, `authenticateWithXades`, `/certificates/*`, 429/`Retry-After`), ksef-number, status (440-duplicate recovery, UPO-failure→processing), submission-flow (idempotency + 23505 race-loser, subscriber CAS, `offlineMode:true` threading + retroactive reconcile, repoll happy/duplicate/processing/auth-fail/fallback, 429 honor), ksef-reconcile (the reconcile cases + offline/repoll routing), xades (keypair/CSR/signature verifies + structure), ksef-auth (token + cert branches), ksef-qr-cert (canonical string; RSA-PSS + EC verify), offline-deadline (next-business-day across weekend/holiday; awaryjny 7bd; offline24-overtaken recompute; 2026/2027 holiday sets), cert-enrollment (Offline → separate fields), credentials (auth-config resolution incl. the never-infer guard + `auto`), credential-health (token sunset + cert `notAfter`), received-invoice (`InvoiceMetadata` → entity + FA(3) → `PurchaseVatRecord` mappers, `acquisitionDate`→receiptDate), batch-package (ZIP/split/encrypt/manifest hashes).

**Live TEST** (`lib/__tests__/ksef-live.test.ts`, env-gated):
```bash
OM_KSEF_TEST_NIP=<fictional test NIP> OM_KSEF_TEST_TOKEN=<token> OM_KSEF_TEST_STRICT=1 \
  yarn workspace @open-mercato/financial-pl test ksef-live
```
`OM_KSEF_TEST_STRICT=1` requires `accepted` + a numer KSeF + a non-empty UPO. Cert-auth (`OM_KSEF_TEST_CERT_PEM`/`KEY`) and Offline-cert (`OM_KSEF_TEST_OFFLINE_CERT_PEM`/`KEY`) blocks are env-gated.

**Live verification record (KSeF TEST, NIP 2481632647, token auth):**
- **Invoice** → `accepted`, status 200, KSeF# `2481632647-20260628-3E8AD3400000-09`, UPO 5,463 B — proves challenge → RSA-OAEP token → `/auth/ksef-token` → redeem → online session → AES-256-CBC → send → status 200 → UPO.
- **Duplicate re-send (identical bytes)** → KSeF **440**, recovered as `accepted` with the **same** number + UPO (`duplicate=true`) — **empirically proves the no-duplicate guarantee** (KSeF dedups on the content hash; the connector recovers the original registration).
- **Correction (KOR)** → `accepted`, KSeF# `2481632647-20260628-3E8E4E800000-7F`, UPO 5,464 B (SPEC-006); a placeholder reference correctly rejected KSeF **450**.
- **Live-accepted doctypes** (SPEC-006): VAT, ZAL (advance), UPR (simplified), OSS EUR / WSTO_EE, plus the real correction `...3F8DD3400000-57` → KOR `...4011D3400000-63`.
- **Self-billed** → HTTP **410** (expected oracle, *"…nie może posiadać adnotacji 'samofakturowanie'"*).
- **F1 inbound receive** round-trips end-to-end on KSeF TEST (self-addressed seller==buyer invoice accepted → `Subject2` metadata query found it → FA(3) XML downloaded).
- **Not live-exercised** (documented, env-gated recipe ready): only the separate JPK→MF submit round-trip (SPEC-006), because the sandbox has no JPK signer credential. KSeF TEST batch, certificate/XAdES auth, certificate enrollment/revocation, and offline KOD II flows were live-exercised on 2026-08-07.

**Routed to sibling specs (consolidation seam):** the **NBP FX rate sourcing** (`lib/nbp-fx.ts`) and the **JPK→MF e-submission** (the `e-dokumenty.mf.gov.pl` gateway, `lib/jpk/*`, `signJpkInitUpload`, the PKCS#1-v1.5 wrap, the JPK-signer credential, `JpkVatFiling` submission columns, `PurchaseVatRecord`/`JpkVatFiling` model definitions) → **SPEC-006**. The **paginated PDF** and the **dual-QR rendering on the PDF** → **SPEC-007**. The **received-invoices backoffice page**, **certificate/JPK backoffice UI**, and **credential form** UI → **SPEC-008**. This spec keeps only the transport, crypto, `KsefSubmission`/received/cursor models, and the KOD II *URL builder*/*deadline* logic.

## Changelog

### 2026-07-01
- Consolidated from SPEC-005 (2026-06-26 send-only connector), SPEC-007 (2026-06-27 cert/XAdES auth + reliability), SPEC-010 (2026-06-28 offline mode + KOD II), SPEC-011 (2026-06-29 completeness audit + self-billing guard), and SPEC-015 (2026-06-30 compliance sweep — inbound receiving, offline+KOD II wiring, cert cutover, batch) into this thematic transport/lifecycle spec; reflects final implemented state. Routed NBP FX + JPK→MF submission to SPEC-006, the paginated/dual-QR PDF to SPEC-007, and the operator UI (received-invoices page, cert/JPK backoffice, credential form) to SPEC-008.
- Rewrote all prior "roadmap / not-built / draft / pending-gate" framing as implemented: certificate/XAdES auth, the offline24/awaryjny/niedostępność lifecycle + KOD II, batch send, and inbound receiving are shipped and (for online send + receive) live-verified on KSeF TEST. Superseded design decisions dropped from the body: the SPEC-005 UMES **widget-injection** description of KSeF status/send-action/meta-field injection on the sales-invoice CrudForm (the module now owns its backoffice UI — SPEC-008); the SPEC-005 narrow doctype/PLN-only scope (expanded in SPEC-006); the SPEC-006 dedup-key misstatement (corrected here — the 440 key is the SHA-256 content hash); and the SPEC-011 "~95% / not-built" roadmap list (its still-true coverage folded into the implemented statement, its stale "not built" items dropped). The `mode` union's former "for the roadmap" note on batch/offline is gone — both are real modes.
