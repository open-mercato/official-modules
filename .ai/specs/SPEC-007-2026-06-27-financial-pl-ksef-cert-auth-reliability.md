# SPEC-007 — `financial_pl`: KSeF certificate authentication (XAdES) + reliability hardening

- **Date:** 2026-06-27
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md) (send-only token connector) and [SPEC-006](./SPEC-006-2026-06-27-financial-pl-ksef-corrections-jpk.md) (corrections + JPK markings)
- **Status:** Draft → for implementation. Pure-logic verification (jest + the live unauthenticated contract probe) runs in this checkout; the full typecheck/build/integration gate and the live authenticated round-trip are pending the user's environment (same pre-existing `@open-mercato/shared/lib/pl/validation` dependency gap documented in SPEC-006 — not introduced here).

## TLDR

**Key Points:**
- **Certificate authentication is now the load-bearing credential.** Per the official Ministry of Finance source, KSeF **tokens are usable only through 2026-12-31; from 2027-01-01 only KSeF certificates remain** (*"od 1 stycznia 2027 r. … pozostaną wyłącznie certyfikaty KSeF"*). SPEC-005/006 shipped **token-only** auth (`lib/ksef-client.ts` implements `/auth/challenge` → RSA‑OAEP token → `/auth/ksef-token`). Without certificate auth the connector **stops working in 2027**. This spec adds the **KSeF Certificate (Certyfikat KSeF) authentication path** — XAdES challenge-signing — alongside the existing token path, plus the certificate **enrollment** client (CSR + `/certificates/*`).
- The "two certificates" other systems (wFirma, inFakt) make users create are the two `certificateType` values of the KSeF Certificate: **Authentication** (logging the software in) and **Offline** (offline/awaria QR stamping). This spec builds the **Authentication** type end-to-end. The **Offline** type (offline24/awaryjny issuance + verification QR KOD I/II) remains a separate later phase, unchanged from SPEC-006's roadmap.
- **Reliability hardening (Q3):** the existing spine (3-layer idempotency, atomic `queued→processing` claim, UPO-gated acceptance, 440-duplicate heal, reconcile breaker, byte-stable resend) is sound. This spec adds: (1) **429 / `Retry-After` pacing** so transient KSeF rate-limiting backs off instead of churning the queue; (2) a **status re-poll** recovery for `processing` rows that already reached KSeF (session+invoice reference persisted) — re-poll their status/UPO instead of re-sending, the strongest possible no-duplicate guarantee; (3) a **correctness fix**: a missing invoice issue date is **rejected** instead of silently defaulting to "today"; (4) a **documentation fix** to SPEC-006's risk register (the KSeF 440 dedup key is the **content hash**, not seller NIP + number + RodzajFaktury).
- **Multi-tenant (Q2): confirmed per-organization only.** Credentials stay strictly per `(organizationId, tenantId)` (no shared/agency/biuro-rachunkowe model). The decision and its regulatory basis are recorded here (a token embeds one taxpayer's permissions and is NIP-bound; a lawful "shared" model would require a shared *certificate* + per-client `uprawnienia` delegation + context switching, which is explicitly out of scope).
- **Live integration (Q4):** the v2 TEST API (`https://api-test.ksef.mf.gov.pl`) is reachable; the unauthenticated contract probe runs here, the authenticated round-trip (invoice + correction, NIP 2481632647) is run with the user-supplied TEST token. The live test (`lib/__tests__/ksef-live.test.ts`) is extended to cover the correction round-trip and a certificate-auth path.

**Scope (this spec):**
- KSeF Certificate **authentication** (XAdES-signed `AuthTokenRequest` → `POST /auth/xades-signature`), wired into the submission flow as a second auth method selected per organization.
- KSeF Certificate **enrollment** client (`GET /certificates/limits`, `GET /certificates/enrollments/data`, `POST /certificates/enrollments`, `GET /certificates/enrollments/{ref}`, `POST /certificates/retrieve`, `POST /certificates/query`, `POST /certificates/{serial}/revoke`) + CSR (PKCS#10) generation + an enrollment/management command.
- 429/`Retry-After` pacing; status re-poll recovery; issue-date correctness fix; dedup-key doc fix.
- Live test extension (correction round-trip + cert-auth path) + contract probe.

**Concerns:**
- XAdES signing is regulation-critical and only fully provable against the live API. We mitigate with rigorous unit tests (the signature verifies; the `AuthTokenRequest` structure matches the KSeF schema) **and** an env-gated live cert-auth round-trip — but the **first** KSeF Authentication certificate must be enrolled by the operator using a qualified signature (the `GET /certificates/enrollments/data` endpoint is XAdES-auth-only), so programmatic enrollment presupposes an existing auth credential (an already-issued cert or a qualified signature the operator holds). This is a regulatory constraint of KSeF, not a limitation we can engineer away.
- Offline-mode issuance (the **Offline** certificate type + QR codes + the offline lifecycle/deadlines) stays out of scope (separate large feature, unchanged from SPEC-006's roadmap).

## Overview

> **Market reference**: wFirma, inFakt, Comarch, SaldeoSMART, Fakturownia. All have moved to (or support) **certificate-based** KSeF authentication; tokens are treated as transitional. The "two certificates" users generate are the KSeF Certificate's two `certificateType` values — **Authentication** and **Offline**. We adopt the same model and build the Authentication type now (the credential the connector authenticates with), keeping the token path for the transition period.

KSeF 2.0 supports five authentication methods: **token KSeF**, **Certyfikat KSeF** (KSeF's own internal X.509 certificate), **qualified signature** (XAdES), **qualified seal**, and **Trusted Profile**. For an unattended system integration the two relevant ones are the **token** (a per-NIP secret embedding a fixed permission set, **sunset 2027-01-01**) and the **KSeF Authentication certificate** (a purely-authentication X.509 cert, reusable, the durable credential).

The certificate authentication flow at the API level:
1. `POST /auth/challenge` → `{ challenge, timestamp }` (≈10 min validity) — *already implemented*.
2. Build an `AuthTokenRequest` XML carrying the `Challenge`, the `ContextIdentifier` (`Nip` = the taxpayer NIP), and the `SubjectIdentifierType` (`certificateSubject` or `certificateFingerprint`).
3. **XAdES-sign** that XML (enveloped XAdES-BES) with the KSeF Authentication certificate's private key.
4. `POST /auth/xades-signature` (body = the signed XML) → `{ referenceNumber, authenticationToken }`.
5. Poll `GET /auth/{referenceNumber}` until `status.code === 200` — *already implemented (shared loop)*.
6. `POST /auth/token/redeem` → `{ accessToken, refreshToken }` — *already implemented*.

From step 6 onward (open session → encrypt → send → status → UPO) the existing flow is reused verbatim; the only change is **how the access token is obtained**.

Certificate **enrollment** (issuing a KSeF certificate) is asynchronous: read the exact DN attributes the CSR must carry (`GET /certificates/enrollments/data`, XAdES-auth only), generate a keypair locally (RSA‑2048+ or EC P‑256; the private key never leaves the system), build a PKCS#10 CSR matching that DN, `POST /certificates/enrollments` (→ `referenceNumber`), poll `GET /certificates/enrollments/{ref}` (→ `certificateSerialNumber`), then `POST /certificates/retrieve` to download the issued cert.

## Problem Statement

1. **Token-only auth expires (regulatory).** The connector authenticates exclusively with a KSeF token; tokens stop working **2027-01-01**. The connector must support **certificate authentication** to remain operable.
2. **No certificate enrollment.** Operators cannot request/retrieve/revoke a KSeF certificate from the product; they must use the external Aplikacja Podatnika for everything.
3. **Transient KSeF rate-limiting is not paced.** A `429` is thrown as a generic error and re-queued immediately (no `Retry-After` honor), which can churn under throttling.
4. **`processing` rows that already reached KSeF are recovered by re-sending** (relying on the 440 duplicate heal). That is safe but wasteful; a status **re-poll** (when the session+invoice reference is persisted) is the cleaner, strictly-no-duplicate recovery.
5. **A missing invoice issue date silently becomes "today"** (`resolve-fa3-from-invoice.ts:111`, `resolve-fa3-from-credit-memo.ts:168`) — a data-integrity hazard on a fiscal document.
6. **SPEC-006's risk register misstates the 440 dedup key** (it says seller NIP + RodzajFaktury + number; KSeF actually de-duplicates on the SHA‑256 content hash). The reasoning that protects against duplicates (byte-stable resend) depends on stating this correctly.

## Proposed Solution

Extend the existing client/flow **additively** — no change to the country-agnostic `sales` schema, no core-package change, no new entity. Authentication becomes a per-organization choice (`token` | `certificate`) backed by new fields on the existing `ksef_pl` integration credentials (stored encrypted by the platform `IntegrationCredentialsService`, exactly like `ksefToken`). The submission flow's auth step is refactored into a reusable `authenticate()` that branches on the method; everything after the access token is unchanged. The certificate enrollment client + CSR generation + an enrollment command are added. Reliability hardening is layered onto the existing client/flow/worker without altering the proven idempotency invariants.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Credentials = new fields on the existing `ksef_pl` integration (no new entity) | `ksefToken` already lives there encrypted; the cert (PEM) + private key (PEM, `secret`) follow the same path. No new schema, no new CRUD, consistent with SPEC-005. |
| Auth method is a per-org discriminated config (`token` \| `certificate`) | Both must coexist during the 2026 transition; selection is per organization, resolved at send time. Token path stays byte-for-byte behavior-preserving. |
| XAdES via `@peculiar/xadesjs` (+ `@peculiar/x509` for CSR) | Battle-tested EU XAdES library on WebCrypto (Node 24 has `webcrypto.subtle`); `@peculiar/x509`/`asn1-schema`/`@xmldom/xmldom` are already in the tree. Hand-rolling XML‑C14N for a regulated signature is unacceptable risk. |
| Private key stored as an integration `secret` (encrypted at rest); enrollment writes it back encrypted, never returns it in plaintext | A signing key is the most sensitive credential; it must be encrypted at rest and never transit a response body. |
| **Enrollment stores the cert; it does NOT auto-activate certificate auth** (resolved from the spec-stage jury — DeepSeek) | Auto-flipping `authMethod` to `certificate` on enrollment could break a working org if the cert is invalid or the switch was unintended. Enrollment persists the cert+key encrypted and returns `{ serial, status }`; switching the active method is a **separate explicit operator action** (set `authMethod='certificate'` in the credentials form). |
| **Enrollment requires an XAdES-capable credential** (resolved from the jury — DeepSeek) | `GET /certificates/enrollments/data` is XAdES-auth-only. An org with token-only auth gets an obscure 401/403. The command pre-checks for a certificate (XAdES-capable) credential and returns a clear `409 certificate_auth_required_for_enrollment` otherwise — the very first cert must be obtained by the operator with a qualified signature (external Aplikacja Podatnika). |
| **Re-poll falls back to re-send on not-found/exhaustion** (resolved from the jury — DeepSeek) | A stored reference KSeF can't find (404 / not-found status) or a repoll that stays non-terminal must not strand the row. Repoll that yields not-found, or whose own attempts exhaust, **re-emits `queued`** so the proven duplicate-safe re-send (440-heal) recovers it; transient 5xx rethrows for the queue retry; the breaker still bounds total attempts. |
| Status re-poll only for `processing` rows that have BOTH `session_reference` and `invoice_reference` | Those rows provably reached KSeF; re-polling them recovers status/UPO with **zero** re-send. Rows without refs (true orphans) keep the existing duplicate-safe re-send. |
| 429 handling centralized in the client `request()` chokepoint | One place parses `Retry-After`, raises a typed `KsefRateLimitError`; the flow honors it with a bounded in-flow wait, the worker treats an exhausted pace as a normal retry. |
| Missing issue date → reject (422), never default to today | A fiscal document's issue date is regulation-critical; a silent "today" is a correctness defect. |
| Per-organization config only; no shared/agency model | Confirmed product decision (Q2). A token is NIP-bound; a lawful shared model needs a shared *certificate* + per-client `uprawnienia` + context switching — explicitly out of scope. |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Hand-roll XAdES (xmldom + manual C14N + WebCrypto) | XML canonicalization for a legally-binding signature is error-prone; a subtly-wrong C14N is rejected by KSeF and hard to diagnose. Use a vetted library. |
| A new `KsefCredential` / `KsefCertificate` entity | Duplicates the integration-credentials mechanism that already stores `ksefToken` encrypted; adds CRUD/migration surface for no benefit. |
| Generate the keypair server-side and return the private key to the caller | Leaks the most sensitive material through a response; instead persist it encrypted under the org's integration credentials and return only the serial/status. |
| Replace the re-send reconcile path entirely with a re-poller | The re-send path is the correct recovery for true orphans (no refs). Keep both; route by whether refs exist. |
| Build the agency/biuro shared-config model | Out of scope per the confirmed Q2 decision. |

## User Stories / Use Cases
- **An operator** wants to **authenticate the connector with a KSeF certificate** so that **invoicing keeps working after the 2027 token sunset**.
- **An operator** wants to **enroll/retrieve/revoke a KSeF Authentication certificate from the product** so that **they don't need the external portal for the cert lifecycle** (given they can already authenticate).
- **The platform** wants to **back off on KSeF `429`** so that **transient rate-limiting doesn't churn the submission queue**.
- **The platform** wants to **re-poll a submission that already reached KSeF** so that **its acceptance/UPO is recovered without any risk of a second send**.

## Architecture

### Auth abstraction (`lib/ksef-auth.ts` — new; `lib/submission-flow.ts` — refactor)
The auth block currently inline in `submitInvoiceToKsef` (`submission-flow.ts:86–123`) is extracted into:
```ts
export type KsefAuthConfig =
  | { method: 'token'; ksefToken: string; contextNip: string }
  | { method: 'certificate'; contextNip: string; certificatePem: string; privateKeyPem: string;
      subjectIdentifierType?: 'certificateSubject' | 'certificateFingerprint' /* default 'certificateSubject' */ }
export async function authenticate(
  client: KsefClient, certs: KsefPublicKeyCertificate[], auth: KsefAuthConfig, options: KsefPollOptions,
): Promise<{ accessToken: string; refreshToken?: string }>
```
- **token branch** — identical to today: `requestChallenge` → `encryptAuthToken` (token cert) → `authenticateWithToken` → poll → `redeemToken`.
- **certificate branch** — `requestChallenge` → `buildAuthTokenRequestXml({ challenge, contextNip, subjectIdentifierType })` → `signAuthTokenRequestXades(xml, { certificatePem, privateKeyPem })` → `client.authenticateWithXades(signedXml)` → poll (shared loop, same `TERMINAL_AUTH_HTTP_STATUSES`) → `redeemToken`.

`KsefSubmissionInput` changes from `{ ksefToken, contextNip, invoiceXml }` to `{ auth: KsefAuthConfig; invoiceXml }` (internal type; all callers updated). The poll loop, terminal-status handling, session/send/status/UPO are unchanged.

### Crypto / XAdES (`lib/xades.ts` — new; pure, WebCrypto)
- `generateKsefKeyPair(opts?)` → an EC P‑256 (default) or RSA‑2048 keypair (WebCrypto) returned as PEM.
- `buildCsr({ keyPair, subject })` → PKCS#10 CSR (DER, Base64) via `@peculiar/x509` `Pkcs10CertificateRequestGenerator`, DN attributes taken verbatim from `GET /certificates/enrollments/data`.
- `signAuthTokenRequestXades(xml, { certificatePem, privateKeyPem })` → enveloped XAdES‑BES signature over the `AuthTokenRequest` via `@peculiar/xadesjs` (RSA‑PKCS1/PSS or ECDSA per the key; SHA‑256 digests; the `SigningCertificate` qualifying property carries the signer cert). Returns the signed XML string.
- All functions are pure (no DB/DI/network) → fully unit-testable here; a round-trip test verifies the produced signature validates and the canonical structure matches a KSeF `AuthTokenRequest` fixture.

`lib/auth-token-request.ts` (new) builds the `AuthTokenRequest` XML envelope (namespaces/element order pinned to the KSeF auth schema).

### KSeF client additions (`lib/ksef-client.ts`)
- `authenticateWithXades(signedXml): Promise<KsefAuthInitResult>` → `POST /auth/xades-signature` (Content-Type `application/xml`), parse `{ referenceNumber, authenticationToken }` (same shape as `authenticateWithToken`).
- Enrollment: `getCertificateLimits()`, `getCertificateEnrollmentData()`, `enrollCertificate({ csr, certificateType, certificateName, validFrom? })`, `getCertificateEnrollmentStatus(ref)`, `retrieveCertificates(serialNumbers)`, `queryCertificates(filter)`, `revokeCertificate(serial, reason?)`. Typed, transport-injected, resilient field-picking like the existing methods.
- **429/`Retry-After`:** in the private `request()` chokepoint, a `429` raises `KsefRateLimitError extends KsefApiError` carrying `retryAfterMs` (parsed from `Retry-After`: delta-seconds or HTTP-date; bounded/defaulted when absent). All other ≥400 unchanged.

### Submission flow + reliability (`lib/submission-flow.ts`, `subscribers/ksef-submit.ts`, `workers/ksef-reconcile.worker.ts`)
- **429 honor:** in-flow, a `KsefRateLimitError` triggers a single bounded `wait(retryAfterMs)` + one retry of that call; if still limited, it propagates so the subscriber resets `processing→queued` and the queue retries (existing path). No infinite loops.
- **Status re-poll** — new `repollSubmission(client, auth, { sessionReference, invoiceReference }, options)`: `authenticate()` → `getInvoiceStatus(refs)` → `evaluateInvoiceStatus` → `finalizeAccepted` (UPO) — **no `openOnlineSession`/`sendOnlineInvoice`**. Returns the same `KsefSubmissionResult` shape (terminal accepted/rejected, or stays processing).
  - New persistent subscriber `subscribers/ksef-repoll.ts` (event `financial_pl.ksef_submission.repoll`): reads the row + creds, runs `repollSubmission`, writes the outcome (idempotent: status poll is read-only KSeF-side; finalize writes accepted/UPO; two concurrent repolls converge on the same result).
  - **Repoll fallback (resolved from the jury):** if `getInvoiceStatus` returns a not-found/404 or the status stays non-terminal through the repoll attempts, the handler does **not** strand the row — it re-emits `financial_pl.ksef_submission.queued` so the proven duplicate-safe re-send (440-heal) takes over (KSeF dedups on the content hash, so a re-send of an already-accepted invoice resolves to `accepted`). A transient 5xx/transport error rethrows for the queue retry (same as `ksef-submit`). The reconcile breaker (`attemptCount`/`maxAttempts`) bounds the total recovery attempts across both paths, so an unrecoverable row eventually surfaces as gave-up rather than looping.
  - **Reconcile routing:** a stale `processing` row **with** both `sessionReference` and `invoiceReference` → emit `repoll` (recover by polling); a stale `processing` row **without** refs (true orphan) or a stale `queued` row → emit `queued` (existing duplicate-safe re-send). The cutoff-guarded CAS bump (attemptCount/updatedAt) still gates re-emits and advances the breaker. The worker now projects `sessionReference`/`invoiceReference` in its field set to route.
- **Issue date:** both resolvers reject (`422 issue_date_required`) when the source document has no issue date, instead of `new Date()`.

### Certificate enrollment command (`commands/ksef-certificate.ts` — new)
- `financial_pl.ksef_certificate.enroll` — for a resolved `(org, tenant)`: **pre-check** that the org has an XAdES-capable (certificate) credential — `GET /certificates/enrollments/data` is XAdES-auth-only, so an org with token-only auth is rejected up front with `409 certificate_auth_required_for_enrollment` (the **first** cert must be obtained externally by the operator with a qualified signature). Then `authenticate` → `getCertificateEnrollmentData` → `generateKsefKeyPair` → `buildCsr` → `enrollCertificate` → poll `getCertificateEnrollmentStatus` (bounded; a terminal CSR/enrollment rejection surfaces `certificate_enrollment_failed` with the KSeF reason) → `retrieveCertificates`. **Persists the issued cert PEM + private key PEM (encrypted) into the `ksef_pl` credentials + the serial, but does NOT change `authMethod`** (activation is a separate explicit operator step). Returns `{ serial, status }` (never the private key).
- `financial_pl.ksef_certificate.list` / `revoke` — wrap `queryCertificates` / `revokeCertificate`.
- All org/tenant-scoped; mutation-guarded; zod-validated input.

## Data Models

**No new entity. `sales` untouched.** Reuses existing `KsefSubmission.sessionReference` / `invoiceReference` (entities.ts:84–88) for the re-poll routing — **no migration required** for reliability. The auth credentials are new fields on the `ksef_pl` integration credentials (stored encrypted by `IntegrationCredentialsService`), not DB columns:
- `authMethod`: `'token' | 'certificate'` (default `'token'`).
- `certificatePem`: text — the KSeF Authentication certificate (PEM).
- `certificatePrivateKeyPem`: **secret** — the certificate's private key (PEM), encrypted at rest.
- `certificateSerialNumber`: text — the issued cert serial (for list/revoke/diagnostics).

(`KsefSubmission.mode` already includes `offline24`/`awaryjny`; unused here — offline issuance stays out of scope.)

## API Contracts

External (KSeF v2, consumed — pinned to the live TEST OpenAPI):
- `POST /auth/xades-signature` (XAdES-signed `AuthTokenRequest`) → `{ referenceNumber, authenticationToken }`.
- `GET /certificates/limits`; `GET /certificates/enrollments/data`; `POST /certificates/enrollments` → 202 `{ referenceNumber }`; `GET /certificates/enrollments/{ref}`; `POST /certificates/retrieve`; `POST /certificates/query`; `POST /certificates/{serial}/revoke`.

Internal (this module — additive):
| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/ksef/certificates` | `GET` | `financial_pl.manage` | List the org's KSeF certificates (`queryCertificates`), org/tenant-scoped. |
| `…/ksef/certificates/enroll` | `POST` | `financial_pl.manage` | Drive enrollment for the resolved org; 202 `{ serial, status }`. Requires an auth credential; 409 if none. |
| `…/ksef/certificates/revoke` | `POST` | `financial_pl.manage` | Revoke a serial (`revokeCertificate`). |

The existing submission routes are unchanged (auth method is resolved from credentials, transparent to callers).

## Internationalization (i18n)
New keys (en + pl + de + es, mirroring existing, sorted per the i18n:check-sync gate): `financial_pl.errors.issue_date_required`, `financial_pl.errors.certificate_auth_required_for_enrollment`, `financial_pl.errors.certificate_enrollment_failed`, `financial_pl.actions.certificateEnrolled`, `financial_pl.actions.certificateRevoked`.

## UI/UX
No new pages. The KSeF integration credentials form gains the `authMethod` selector + certificate/private-key fields (rendered from the integration field schema, same mechanism as today). Certificate management is command/route-driven (admin-only).

## Configuration
No new env vars required. New per-org credential fields (above). 429 pacing knobs: `OM_KSEF_RETRY_AFTER_MAX_MS` (default cap, e.g. 60_000) — optional, with a safe built-in default. Cert auth honors the same `environment` / `OM_KSEF_ENVIRONMENT`. Optional new dep: `@peculiar/xadesjs` (+ explicit `@peculiar/x509`).

## Migration & Compatibility
**No DB migration.** Reliability reuses existing columns; credentials are integration-config fields. Backward-compatible for the auth/reliability surfaces: existing token submissions are `authMethod='token'` by default and follow the unchanged token path; the re-poll path only triggers for `processing` rows that already carry references; the `KsefSubmissionInput` type change is internal (no public surface).

**One intentional behavior change (resolved from the jury — not silent):** an invoice/credit-memo with **no issue date** is now **rejected** (`422 issue_date_required`) at resolve time instead of silently defaulting to `new Date()` (today). This narrows acceptance only for documents that previously had no issue date — a data-quality error for a fiscal document, where a silent "today" produced a **mis-dated** KSeF filing. The failure is now an explicit, diagnosable 422 rather than a wrong-but-accepted invoice. We deliberately do **not** add a "default to today" compatibility flag (it would institutionalize the defect); a real invoice always has an issue date, so the practical impact is surfacing previously-hidden bad data.

## Implementation Plan

### Phase 1 — Reliability hardening (no new deps; lands first)
1. `KsefRateLimitError` + `Retry-After` parsing in `ksef-client.ts:request()`; in-flow bounded honor in `submission-flow.ts`; subscriber/worker treat exhausted pace as normal retry.
2. `repollSubmission` in `submission-flow.ts`; `subscribers/ksef-repoll.ts`; reconcile worker routing (processing-with-refs → `repoll`, else `queued`); register the event/subscriber in `setup.ts`/`events.ts`.
3. Issue-date reject in both resolvers (`issue_date_required`); i18n key.
4. SPEC-006 risk-register dedup-key correction + code-comment fix (`ksef-client.ts` 440 note / `crypto.ts`).
5. Unit tests: 429 parse + honor; repoll happy/duplicate/processing/auth-fail; reconcile routing; issue-date reject.

### Phase 2 — Certificate authentication
1. Add `@peculiar/xadesjs` (+ `@peculiar/x509`) to `package.json`; ensure the build bundles/externalizes correctly.
2. `lib/xades.ts` (`generateKsefKeyPair`, `buildCsr`, `signAuthTokenRequestXades`) + `lib/auth-token-request.ts`; unit tests (signature verifies; CSR DN; AuthTokenRequest structure).
3. `lib/ksef-auth.ts` `authenticate()` (token + certificate branches); refactor `submission-flow.ts` to use it (token path behavior-preserving — proven by existing `submission-flow.test.ts`).
4. `ksef-client.ts`: `authenticateWithXades`; unit tests.
5. `integration.ts`: `authMethod` + certificate fields; `subscribers/ksef-submit.ts` reads them and builds the `KsefAuthConfig`.
6. Unit tests for the cert auth branch (mock transport).

### Phase 3 — Certificate enrollment + management
1. `ksef-client.ts`: the 7 `/certificates/*` methods; unit tests.
2. `commands/ksef-certificate.ts` (`enroll`/`list`/`revoke`); routes (`certificates`, `certificates/enroll`, `certificates/revoke`); acl.
3. Unit + integration (TC-KSEF-005) HTTP-contract tests (401/400/409).

### Phase 4 — Live verification (Q4)
1. Extend `lib/__tests__/ksef-live.test.ts`: invoice round-trip (exists) + **correction round-trip** + a **cert-auth** path (gated on `OM_KSEF_TEST_CERT_PEM`/`OM_KSEF_TEST_CERT_KEY`).
2. A contract probe (script/test) diffing the client's endpoint set against the live OpenAPI.
3. Run the token invoice+correction round-trip live with the user-supplied TEST token; capture KSeF numbers + UPO. Hand off the cert-auth round-trip (needs an enrolled cert).

### File Manifest
| File | Action | Purpose |
|------|--------|---------|
| `lib/ksef-client.ts` | Modify | `authenticateWithXades`, 7 `/certificates/*` methods, `KsefRateLimitError` + Retry-After. |
| `lib/xades.ts` | Create | Keypair, CSR, XAdES signing (pure). |
| `lib/auth-token-request.ts` | Create | `AuthTokenRequest` XML builder. |
| `lib/ksef-auth.ts` | Create | `authenticate()` (token \| certificate). |
| `lib/submission-flow.ts` | Modify | Use `authenticate()`; `repollSubmission`; 429 honor; `KsefSubmissionInput` → `{ auth, invoiceXml }`. |
| `subscribers/ksef-submit.ts` | Modify | Build `KsefAuthConfig` (token/cert) from creds. |
| `subscribers/ksef-repoll.ts` | Create | Re-poll handler. |
| `workers/ksef-reconcile.worker.ts` | Modify | Route processing-with-refs → repoll. |
| `lib/resolve-fa3-from-invoice.ts`, `lib/resolve-fa3-from-credit-memo.ts` | Modify | Reject missing issue date. |
| `integration.ts` | Modify | `authMethod` + certificate credential fields. |
| `commands/ksef-certificate.ts` | Create | enroll/list/revoke. |
| `api/ksef/certificates/{,enroll,revoke}/route.ts` | Create | Management routes. |
| `data/validators.ts` | Modify | Cert/enroll zod schemas (isolated from the `pl/validation` import where possible). |
| `events.ts`, `setup.ts`, `acl.ts`, `i18n/*` | Modify | Register repoll event/subscriber; i18n keys; acl for cert mgmt. |
| `__integration__/TC-KSEF-005.spec.ts` | Create | Cert management HTTP contract. |
| `lib/__tests__/*`, `commands/__tests__/*` | Create/Modify | Unit coverage. |
| `lib/__tests__/ksef-live.test.ts` | Modify | Correction + cert-auth live round-trip. |
| `.ai/specs/SPEC-006-*.md` | Modify | Dedup-key risk-register correction. |

## Risks & Impact Review

### Data Integrity Failures
- **Wrong/invalid XAdES signature** → KSeF rejects auth (no invoice is sent; nothing is registered). Severity High → mitigated by a vetted library + unit tests (signature verifies, structure matches the schema) + the env-gated live cert-auth round-trip. Residual: only a live round-trip fully proves acceptance — explicitly part of the handoff.
- **Private key exposure** → impersonation. Severity Critical → mitigated: key stored as an integration `secret` (encrypted at rest), never returned in a response, never logged.

### Cascading Failures & Side Effects
- **Re-poll racing the re-send** → could a row be both re-polled and re-sent? Mitigated: a row is routed to exactly one path by whether refs exist; the reconcile CAS bump + cutoff guard gate re-emits; re-poll never sends, so even a worst-case double-trigger only polls twice (idempotent). A re-poll that finds the row already accepted writes the same terminal result.
- **429 honor looping** → bounded (single in-flow wait + one retry, then propagate to the queue). No unbounded sleep.

### Tenant & Data Isolation Risks
- All new reads/commands are `(tenantId, organizationId)`-scoped (creds via `getRaw('ksef_pl', scope)`; commands enforce `ensureTenantScope`/`ensureOrganizationScope`). No cross-org surface; the per-org-only decision is preserved. Certificates and keys are per-org integration secrets.

### Migration & Deployment Risks
- None — no schema change. New credential fields default to `authMethod='token'`, so existing orgs are unaffected until they opt into certificate auth.

### Operational Risks
- New runtime dep (`@peculiar/xadesjs`) — vetted, MIT, WebCrypto-based; pinned + lockfile-tracked.
- Cert expiry → auth fails. Mitigated: `certificateSerialNumber` + `validTo` surfaced via the list route for monitoring; enrollment command for renewal.

### Risk Register

#### XAdES signature incorrect / KSeF-rejected
- **Severity**: High → mitigated.
- **Mitigation**: `@peculiar/xadesjs` (vetted C14N + signing); unit tests assert the signature verifies and the `AuthTokenRequest`/`SigningCertificate` structure; env-gated live cert-auth round-trip in `ksef-live.test.ts`.
- **Residual**: Full proof requires the live round-trip with an enrolled cert (handoff item).

#### Re-poll introduces a duplicate send
- **Severity**: Medium → eliminated by construction.
- **Mitigation**: `repollSubmission` never calls `openOnlineSession`/`sendOnlineInvoice`; routing sends a row to repoll **or** re-send, never both; repoll writes are idempotent.
- **Residual**: None material.

#### Re-poll strands a row in `processing` (jury — DeepSeek, High)
- **Severity**: High → mitigated.
- **Mitigation**: a not-found/404 status or a repoll that stays non-terminal re-emits `queued` (re-send fallback, 440-safe); transient 5xx rethrows for the queue retry; the `attemptCount`/`maxAttempts` breaker bounds total attempts and surfaces an unrecoverable row as gave-up.
- **Residual**: None material.

#### Enrollment auto-activates an unverified cert (jury — DeepSeek, Critical)
- **Severity**: Critical → eliminated.
- **Mitigation**: enrollment **only stores** the cert+key (encrypted) + serial; switching `authMethod` to `certificate` is a separate explicit operator action, so a bad/unintended cert can never silently take over a working org's auth.

#### 429 pacing mishandled
- **Severity**: Low → mitigated.
- **Mitigation**: bounded single honor + propagate; `Retry-After` parsing covers delta-seconds and HTTP-date, with a capped default when absent/garbage.

#### Private key handling
- **Severity**: Critical → mitigated.
- **Mitigation**: `secret` field (encrypted at rest), never returned/logged; enrollment writes it back encrypted.

## Final Compliance Report — 2026-06-27

### AGENTS.md Files Reviewed
- `AGENTS.md` (root, official-modules) · `.ai/specs/AGENTS.md` · `ARCHITECTURE.md` (borrowed core reference — §11 UMES, §27 BC, §31 checklist) · core `packages/core/src/modules/integrations` (read-only, for the credentials service contract).

### Compliance Matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | Creds via `IntegrationCredentialsService`; submissions FK-id only. |
| root AGENTS.md | Filter by organization_id (+ tenant) | Compliant | All new reads/commands org+tenant-scoped. |
| root AGENTS.md | Never modify core packages | Compliant | `sales`/core read-only; all changes in `financial_pl`. |
| root AGENTS.md | Never hand-write migrations | Compliant | No migration in this spec. |
| root AGENTS.md | zod-validate all API inputs | Compliant | Cert/enroll routes use zod. |
| root AGENTS.md | No `any` / no hardcoded user strings | Compliant | `z.infer` types; i18n keys. |
| ARCHITECTURE §27 | Backward-compatibility (additive only) | Compliant | New auth path alongside token; no removed surface. |
| ARCHITECTURE §16 | Hand-written crypto only where protocol-mandated | Compliant | XAdES via a library; the protocol-mandated AES/RSA stays in `crypto.ts`. |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | Cert fields back the auth/enroll flow; no DB change. |
| API contracts match UI/UX | Pass | Cert mgmt is command/route-driven; creds form extended via field schema. |
| Risks cover all write operations | Pass | Auth, enroll, re-poll, 429 covered. |
| Commands defined for all mutations | Pass | `ksef_certificate.enroll/list/revoke`; submission commands unchanged. |

### Verdict
- **Compliant** — approved for implementation pending the spec-stage cross-model jury.

## Integration Test Coverage
- **TC-KSEF-005** (new, Playwright): `…/ksef/certificates` (401 anon, 403 without `manage`, 200 list shape), `…/certificates/enroll` (401, 400 invalid, 409 no auth credential), `…/certificates/revoke` (401, 400).
- **Unit:** `xades.test.ts` (keypair/CSR/signature verifies + structure), `ksef-auth.test.ts` (token + cert branches), `ksef-client.test.ts` (+`authenticateWithXades`, `/certificates/*`, 429/Retry-After), `submission-flow.test.ts` (+repoll, +429 honor), `ksef-reconcile.test.ts` (+routing), resolver tests (+issue-date reject), `ksef-certificate.test.ts` (command).
- **Live (`ksef-live.test.ts`, env-gated):** token invoice round-trip (exists) + correction round-trip + cert-auth path (`OM_KSEF_TEST_CERT_PEM`/`KEY`). Run with the user-supplied TEST token (NIP 2481632647).

## Spec-stage cross-model review — 2026-06-27
Jury run on this spec (artifact mode, spec-review rubric). **DeepSeek V4 Pro (max): fail** — 4 findings, all reconciled into this spec: (critical) enrollment auto-activating `authMethod` → decoupled storage from activation; (high) re-poll with no fallback → added re-send fallback on not-found/exhaustion; (medium) issue-date reject unacknowledged → documented as an intentional, surfaced 422 behavior change; (medium) enrollment not requiring XAdES-capable auth → added a `409` pre-check. Notes folded in: `subjectIdentifierType` default `certificateSubject`; repoll 5xx rethrow. **Codex (gpt-5.5) & Kimi K2.7: skipped** (CLI not installed in this environment). `cross-model (spec): confirmed (deepseek); codex + kimi skipped (CLI absent)`.

## Code-stage cross-model review — 2026-06-28
Jury run on the staged diff (after the mandatory Claude fresh-reviewer passed with 0 blockers). **Codex (gpt-5.5) & Kimi K2.7: skipped** (CLI not installed). **DeepSeek V4 Pro (max): two passes.**
- **Pass 1 → fail (1 Critical), fixed:** `buildKsefAuthConfig` inferred certificate auth from the mere presence of enrolled cert material when `authMethod` was unset — back-door auto-activation that would silently switch a token org to certificate auth on its next invoice. **Fixed:** certificate auth now requires an explicit `authMethod==='certificate'` (unset/legacy → token); locked by `lib/__tests__/credentials.test.ts` (6 cases). This was a real cross-model catch the in-family reviewer missed.
- **Pass 2 → fail (2 blockers), reconciled:**
  - *(critical) "ksef-repoll subscriber not registered" → **spurious (not chased).*** Open Mercato auto-discovers `subscribers/*.ts` by the `metadata` export at `yarn generate` time (per core AGENTS.md); the existing, working `ksef-submit.ts` is likewise not manually registered. Commands need `commands/index.ts` registration (done); subscribers do not — the asymmetry the voter (without OM-convention knowledge) tripped on. Verified: no manual subscriber registry exists; the event is declared in `events.ts` and the handler's `metadata.event` matches.
  - *(high) "CSR DN order not driven by enrollment-data" → addressed + live-validated.* The DN **values** are already taken verbatim from `GET /certificates/enrollments/data` (never invented); only present fields are emitted. The exact accepted RDN order is confirmed in the live enrollment round-trip (handoff) — not independently reproducible here without live cert-auth. Strengthened with an explicit comment + this risk note.
  - Notes folded in: `OM_KSEF_RETRY_AFTER_MAX_MS` env now honored in the client's 429 path; `getAuthStatus` poll wrapped in `pace` for full Retry-After coverage; verified the enroll route logs the error object (never the credentials/private key — `save` encrypts before any DB call).

`cross-model (code): confirmed (deepseek — 1 real blocker fixed, 1 spurious recorded, 1 live-validation item); codex + kimi skipped (CLI absent)`.

#### CSR DN order accepted by KSeF (jury — DeepSeek, High)
- **Severity**: High → addressed; live-validated.
- **Mitigation**: DN values are verbatim from the enrollment-data endpoint; RDN order follows the KSeF subject convention. The enrollment path is operator-initiated and non-critical (the first cert is obtained externally with a qualified signature; programmatic enrollment is for renewals), and KSeF validates the CSR before issuing, so a wrong order fails the enrollment round-trip loudly rather than corrupting data.
- **Residual**: The exact accepted RDN order is confirmed in the live enrollment round-trip (handoff). The invoice-send path is unaffected.

## Live verification — 2026-06-28 (KSeF TEST, NIP 2481632647, token auth)
Ran end-to-end against the real Ministry of Finance TEST API (`https://api-test.ksef.mf.gov.pl`) with a user-supplied TEST token. **Token auth path: fully proven.**
- **Invoice** → `accepted`, status 200, KSeF number `2481632647-20260628-3E8AD3400000-09`, UPO retrieved (5,463 B, genuine `<Potwierdzenie>` carrying the number). Proves: challenge → RSA-OAEP token → `/auth/ksef-token` → redeem → online session → AES-256-CBC encrypt → send → status 200 → UPO.
- **Duplicate re-send (identical bytes)** → KSeF **440**, recovered as `accepted` with the **same** KSeF number + UPO (`duplicate=true`). **Empirically proves the no-duplicate guarantee** — KSeF de-dups on the content hash and the connector recovers the original registration instead of double-filing.
- **Correction (KOR)** referencing the real accepted number → `accepted`, status 200, own KSeF number `2481632647-20260628-3E8E4E800000-7F`, UPO 5,464 B. Proves the full `faktura korygująca` round-trip. (A placeholder reference was correctly rejected with KSeF 450 `TNumerKSeF` pattern error — the resolver's reference handling matters.)
- **Certificate (XAdES) auth path**: not live-run — needs an enrolled KSeF Authentication cert + key (the first cert is issued externally via the MF taxpayer app with a qualified signature). Unit-proven (signature verifies; structure matches `authv2.xsd`); env-gated live block ready (`OM_KSEF_TEST_CERT_PEM`/`KEY`).

## Changelog
### 2026-06-27 — SPEC-007 initial
- KSeF Certificate authentication (XAdES challenge-signing) added alongside the token path; certificate enrollment client (CSR + `/certificates/*`) + enroll/list/revoke command & routes. Reliability hardening: 429/`Retry-After` pacing, status re-poll recovery for already-sent `processing` rows, issue-date reject, and a SPEC-006 dedup-key documentation correction (440 keys on the content hash). Per-organization-only multi-tenancy confirmed (no shared/agency model). Live test extended (correction + cert-auth). No DB migration; no core change.
