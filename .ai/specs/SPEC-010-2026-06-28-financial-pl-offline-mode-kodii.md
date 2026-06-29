# SPEC-010 — `financial_pl`: KSeF offline mode (Offline certificate, KOD II QR, offline24/awaryjny lifecycle + deadline tracking)

- **Date:** 2026-06-28
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md) (send-only connector), [SPEC-006](./SPEC-006-2026-06-27-financial-pl-ksef-corrections-jpk.md) (corrections + JPK markings, incl. the `NrKSeF/OFF/BFK/DI` JPK marking), [SPEC-007](./SPEC-007-2026-06-27-financial-pl-ksef-cert-auth-reliability.md) (KSeF Certificate **Authentication** type + enrollment client + reliability), [SPEC-008](./SPEC-008-2026-06-28-financial-pl-invoice-pdf.md) (invoice PDF + KOD I QR)
- **Status:** Draft → for implementation. Pure-logic verification (jest: KOD II signing, deadline calculator, offline submission flow) runs in this checkout; the live offline round-trip (offline-issue → late send with `offlineMode:true` → retroactive KSeF number) and the KOD II signature acceptance by KSeF verification are pending the user's environment (an enrolled **Offline** certificate is required, which itself presupposes an existing Authentication credential — same regulatory precondition as SPEC-007).

## TLDR

**Key Points:**
- **This completes the "second certificate".** SPEC-007 built the KSeF Certificate **Authentication** type end-to-end. The other `certificateType` value, **`Offline`**, exists solely to sign the **KOD II** verification QR on invoices issued outside KSeF. The KSeF client already types `KsefCertificateType = 'Authentication' | 'Offline'` (`lib/ksef-client.ts:105`) and `enrollCertificate` already POSTs `certificateType` verbatim — so enrolling an Offline cert is the **same** enrollment runbook with a different `certificateType` and a **separate** persistence target (it must NOT clobber the Authentication credential).
- **Offline issuance is a real lifecycle, not a flag.** A taxpayer may issue in **offline24** (own initiative, any time, no outage required — art. 106nda) or **tryb awaryjny** (an MF-announced KSeF failure — art. 106nf). The invoice is built and given to the buyer **now** (with KOD I labelled "OFFLINE" + the cert-signed KOD II), persisted as `status='offline_issued'` with **no** KSeF number yet, and **must** be sent to KSeF by a statutory deadline (offline24: next business day; awaryjny: 7 business days from the end of the announced failure). On acceptance the invoice gets its KSeF number **retroactively**. The connector tracks the deadline, prioritizes the late send, and surfaces an overdue alert.
- **The send path is the existing one with one flag.** `submitInvoiceToKsef` is reused almost verbatim; the only protocol difference is passing `offlineMode: true` to `sendOnlineInvoice` (the param already exists at `lib/ksef-client.ts:436`, currently always `false`). The existing reconcile worker is extended to also pick up `offline_issued` rows whose deadline approaches and run the **initial** send (not a re-poll). KSeF's content-hash 440 de-duplication + byte-stable XML keep this duplicate-safe, exactly as the online path.
- **KOD II is a new, different signature.** KOD II is `…/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}/{signature}` where the signature is over the URL fragment up to and including the hash (NOT over the raw XML), made with the **Offline cert's private key** using **RSASSA-PSS** (SHA-256, MGF1-SHA-256, 32-byte salt) for RSA or **ECDSA P-256/SHA-256** (IEEE P1363 64-byte raw) for EC. This is a *different padding* from the Authentication/XAdES path (which uses RSA-PKCS1-v1_5), so KOD II gets its own pure signer module `lib/ksef-qr-cert.ts` reusing the existing `sha256` + `toBase64Url` helpers — no hand-rolled crypto beyond the WebCrypto call.

**Scope (this spec):**
- **Offline certificate enrollment** — parameterize the existing enrollment by `certificateType` (default `Authentication`), add an `Offline` path, persist into separate `offlineCertificate*` credential fields.
- **KOD II** cert-signed QR builder + signer (`lib/ksef-qr-cert.ts`).
- **Offline issuance** command + flow: build XML now, compute KOD I (label OFFLINE) + KOD II, persist `offline_issued` with the deadline, render both QRs on the PDF.
- **Statutory deadline tracking** — a pure business-day deadline calculator (offline24 next-business-day; awaryjny failure-end + 7 business days; recompute when a failure is announced) + worker prioritization + overdue surfacing.
- **The offline send path** — extend the reconcile worker + a send subscriber to send `offline_issued` rows with `offlineMode:true` and reconcile the retroactive KSeF number.

**Concerns:**
- KOD II signature correctness (RSA-PSS vs the auth path's PKCS1) is only fully provable against KSeF's verification; mitigated with unit tests (the signature verifies against the cert; the canonical signed string matches the documented template) + an env-gated live block.
- Business-day arithmetic must skip Polish public holidays + weekends; the holiday-calendar source is a genuine open question.
- The first Offline cert (like the first Authentication cert) presupposes an existing Authentication/qualified credential — a KSeF regulatory constraint, not one we can engineer away.

## Overview

> **Market reference**: wFirma, inFakt, Comarch, Fakturownia all support offline24/awaryjny issuance with the dual QR (KOD I + the cert-signed KOD II) and track the statutory send-to-KSeF deadline. SPEC-007 already established the certificate model; this spec adds the Offline type and the offline lifecycle, staying additive to the proven online send + Authentication paths.

KSeF defines special issuance modes for when an invoice cannot (or need not) be registered online at issue time. The two in scope:

| Mode | Trigger | Send-to-KSeF deadline | Legal basis |
|---|---|---|---|
| **offline24** | Taxpayer's own initiative, any time — **no KSeF outage required** ("każdy podatnik może wystawiać faktury w trybie offline24"). | **Next business day** after issuance ("niezwłocznie, nie później niż w następnym dniu roboczym"). | art. 106nda |
| **tryb awaryjny** (emergency) | An unforeseen KSeF failure **officially announced** in the MF BIP. | **7 business days** from the **end** of the announced failure. | art. 106nf |

(Two further modes — planned `niedostępność`, art. 106nh; total failure / awaria całkowita — are **out of scope**; the `KsefSubmissionMode` enum already includes `offline24`/`awaryjny`, so no enum change is needed for the in-scope modes.)

A subtle deadline rule the calculator must encode: if an invoice was issued in **offline24** and, before it is sent, a KSeF failure is announced, the deadline switches to the **awaryjny** rule (7 business days from the failure end). The deadline is therefore a function of (issue timestamp, mode, and any announced-failure window) and is **recomputed** if a failure is announced.

The offline issuance lifecycle end-to-end:
1. **Issue offline now** — assign the local FA(3) `P_2` number (already resolved from `sales`), build the byte-stable FA(3) XML, record the **offline issue timestamp**, compute **KOD I** (`buildKodIUrl`, label "OFFLINE") and **KOD II** (cert-signed), render both QRs on the buyer's PDF, and persist a `KsefSubmission` with `mode = offline24|awaryjny`, `status = 'offline_issued'` (both enum values already exist), `invoice_xml` = the issued XML, the KOD I/II URLs, the Offline cert serial, the issue timestamp, and the computed deadline. **No** session / KSeF number yet.
2. **Send late** — within the deadline (connectivity restored), a worker sends the **stored** XML to KSeF with `offlineMode: true` (this is an *initial* send, not a re-poll).
3. **Reconcile retroactively** — on acceptance, write `ksef_number`/`upo_xml`, flip to `accepted`, set `accepted_at` to the KSeF-assigned timestamp (the legal "received" date for offline24 per the MF page).

**Distinct from `issuedOutsideKsef` (BFK).** SPEC-006's `SalesInvoicePlMeta.issuedOutsideKsef` is the *permanent* exemption (consumer/legacy/pre-obligation → JPK `BFK`). An offline24/awaryjny invoice is the **opposite** — it WILL get a KSeF number, it just hasn't been sent yet. The two concepts stay separate; offline issuance MUST NOT set `issuedOutsideKsef`. The JPK marking for an offline invoice is `DI` (offline24/niedostępność without a number yet, later → `NrKSeF`) or `OFF` (awaryjny without a number) per the already-implemented `lib/jpk-vat-marking.ts`.

## Problem Statement

1. **No Offline certificate.** SPEC-007 hardcodes `certificateType: 'Authentication'` in `cert-enrollment.ts:142`; an Offline cert (needed to sign KOD II) cannot be enrolled or stored.
2. **No KOD II.** Only KOD I exists (`lib/ksef-qr.ts`); the cert-signed KOD II QR for offline invoices is unimplemented, and KOD II needs RSA-PSS (a different padding than the auth path).
3. **No offline issuance.** There is no flow to issue an invoice outside KSeF (build XML + dual QR now, persist `offline_issued`, defer the send) — `sendOnlineInvoice`'s `offlineMode` is always `false`.
4. **No deadline tracking.** The statutory send-to-KSeF deadline (next business day / failure-end + 7 business days) is neither computed, stored, prioritized, nor surfaced when overdue.
5. **No offline send path.** The reconcile worker only handles `queued`/`processing`; it never picks up `offline_issued` rows to perform the deferred initial send with `offlineMode:true`.

## Proposed Solution

Extend the existing enrollment, client, QR, submission-flow, worker, and entity surfaces **additively** — no core change, no `sales` change, no new entity (only new columns on `KsefSubmission` + new `ksef_pl` credential fields). Offline-certificate enrollment is the SPEC-007 runbook parameterized by `certificateType` with a separate persistence target. KOD II is a new pure signer module. Offline issuance is a new command that reuses the existing FA(3) build + KOD I helpers and persists an `offline_issued` row with the deadline. The deadline is a pure business-day calculator. The deferred send reuses `submitInvoiceToKsef` with `offlineMode:true`, driven by the existing reconcile worker extended to route `offline_issued` rows.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Offline cert enrolled by the **same** runbook, persisted into **separate** `offlineCertificate*` credential fields | `enrollCertificate` already accepts `certificateType`; only `cert-enrollment.ts`'s hardcoded type changes. The Offline cert must NOT overwrite the Authentication credential (different purpose, different lifetime) — distinct fields keep both usable. |
| KOD II in its own `lib/ksef-qr-cert.ts`, beside KOD I | KOD II signs the **URL fragment** (not the XML) with **RSA-PSS** / ECDSA-P1363 — a different padding from the XAdES auth path. Isolating it keeps KOD I a pure URL builder and avoids contaminating the auth signer. Reuses `sha256` + `toBase64Url` (no new hand-rolled crypto, §16). |
| KOD II signs `qr-{env}.ksef.mf.gov.pl/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}` (no scheme, no trailing slash), signature appended as the last segment | Verbatim from the official `kody-qr` template; the hash already commits to the invoice, so signing the fragment is sufficient and matches KSeF verification. |
| Offline issuance persists `offline_issued` with the deadline; the send is deferred to the worker | Mirrors the online queued→processing→terminal spine; the buyer gets the PDF immediately while the legal send happens within the deadline. Keeps the proven idempotency/CAS-claim invariants. |
| Deferred send reuses `submitInvoiceToKsef` with `offlineMode:true` | The XML is built identically; offline-ness is conveyed by the send flag + the KOD II QR, not a separate document body. Maximizes reuse, minimizes new protocol surface. |
| Deadline is a **pure** business-day calculator (issue timestamp, mode, optional failure window) | Deterministic + fully unit-testable; recomputable when a failure is announced; weekends + Polish public holidays skipped. |
| The reconcile worker routes `offline_issued` rows whose deadline approaches to an **initial send** (not a re-poll) | The offline row never reached KSeF, so it needs a first send, not the SPEC-007 re-poll. The existing duplicate-safe re-send machinery (CAS claim, 440 content-hash heal) applies unchanged. |
| Offline issuance does NOT set `issuedOutsideKsef` | That field is the permanent BFK exemption; an offline invoice WILL get a number. Conflating them would mis-mark the JPK. |
| Private Offline key stored as an encrypted integration `secret`, never returned/logged | A signing key is the most sensitive credential; same handling as the Authentication key (added to the encryption secret list). |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Reuse the Authentication cert/key to sign KOD II | KSeF requires the **Offline** cert type for KOD II; an Authentication cert is the wrong type and would fail verification. |
| Sign the raw FA(3) XML for KOD II | The template signs the URL fragment (which embeds the hash); signing the XML produces a non-conforming QR. |
| Reuse the XAdES RSA-PKCS1 signer for KOD II | KOD II mandates RSA-PSS; wrong padding → verification failure. Separate signer. |
| A new offline worker | The existing reconcile worker already iterates stale rows with the CAS/breaker machinery; extending its routing is less surface than a parallel worker. |
| Store the deadline only, recompute on read | Storing `offline_send_deadline_at` lets the worker prioritize + the UI alert without recomputation; recompute only when a failure is announced. |

## User Stories / Use Cases
- **An operator** wants to **enroll an Offline KSeF certificate** so that **offline-issued invoices can carry a valid cert-signed KOD II QR**.
- **An operator** (offline / by choice) wants to **issue an invoice in offline24** so that **the buyer gets a compliant PDF immediately and the invoice is sent to KSeF by the next business day**.
- **An operator** (KSeF failure announced) wants to **issue in tryb awaryjny** so that **invoicing continues and the document is sent within 7 business days of the failure end**.
- **The platform** wants to **track the statutory send deadline and auto-send offline-issued invoices** so that **no invoice misses its deadline and each gets its retroactive KSeF number**.
- **An operator** wants to **see which offline invoices are approaching/over their deadline** so that **a connectivity problem doesn't cause a statutory breach**.

## Architecture

### Offline certificate enrollment (`lib/cert-enrollment.ts`, `commands/ksef-certificate.ts` — modify)
- `CertificateEnrollmentParams` (cert-enrollment.ts:26): add `certificateType?: KsefCertificateType` (default `'Authentication'`); pass it through to `client.enrollCertificate` (currently hardcoded at line 142). No `ksef-client.ts` change (the method already POSTs `certificateType`).
- `enrollInputSchema` (ksef-certificate.ts:31): add `certificateType: z.enum(['Authentication','Offline']).optional()`. When `Offline`, persist the issued cert into **separate** credential fields — `offlineCertificatePem`, `offlineCertificatePrivateKeyPem` (secret, encrypted), `offlineCertificateSerialNumber` — preserving the Authentication credential. (The `enrollCommand` currently writes `certificatePem`/`certificatePrivateKeyPem`/`certificateSerialNumber`; branch on type.)
- Precondition unchanged: enrollment requires an existing XAdES-capable (Authentication/qualified) credential (`GET /certificates/enrollments/data` is XAdES-only) → the existing `409 certificate_auth_required_for_enrollment`.

### KOD II signer + URL builder (`lib/ksef-qr-cert.ts` — new; pure, WebCrypto)
```ts
export type KsefContextType = 'Nip' | 'InternalId' | 'NipVatUe' | 'PeppolId'
export async function buildKodIIUrl(params: {
  environment: KsefEnvironment
  contextType: KsefContextType        // default 'Nip'
  contextValue: string                // org/seller NIP for a standard NIP context
  sellerNip: string
  certSerial: string                  // the Offline cert serial (hex)
  invoiceXml: string                  // hash reuses ksefInvoiceHashBase64Url (same as KOD I)
  offlineCertificatePrivateKeyPem: string
  algorithm: 'RSA' | 'EC'
}): Promise<string>
```
- Builds segments 1–5, forms the canonical string `qr-{env}.ksef.mf.gov.pl/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}` (no `https://`, no trailing slash), signs it with the Offline private key, base64url-encodes the signature, appends it as segment 6.
- **RSA:** import the key as `{ name: 'RSA-PSS', hash: 'SHA-256', saltLength: 32 }` (different from the auth path's PKCS1). **EC:** `{ name: 'ECDSA', hash: 'SHA-256' }` (WebCrypto already yields the IEEE P1363 64-byte raw form). Reuses `ksefInvoiceHashBase64Url` (KOD I hash) + `toBase64Url` from `lib/ksef-qr.ts` and `sha256` from `crypto.ts`. Host via `resolveKsefQrHost`.

### Deadline calculator (`lib/offline-deadline.ts` — new; pure)
```ts
export function computeOfflineSendDeadline(params: {
  issuedAt: Date
  mode: 'offline24' | 'awaryjny'
  failureEndsAt?: Date | null          // set for awaryjny (or when a failure is announced over an offline24 invoice)
  holidays: ReadonlyArray<string>      // ISO YYYY-MM-DD Polish public holidays
}): Date
```
- offline24: next business day after `issuedAt`. awaryjny (or offline24 overtaken by an announced failure): `failureEndsAt` + 7 business days. Skips weekends + the supplied Polish public holidays. Pure → fully unit-testable; recomputed when a failure window is supplied.

### Offline issuance (`commands/ksef-submission.ts` — modify, add an offline command; `lib/submission-flow.ts` / a new `lib/offline-issue.ts`)
- New command `financial_pl.ksef_submission.issue_offline` (org+tenant-scoped, mutation-guarded, zod-validated): resolve the FA(3) XML (existing resolver/builder), require an Offline cert credential (else `409 offline_certificate_required`), compute KOD I (label OFFLINE) + KOD II, compute the deadline, and persist a `KsefSubmission` with `mode`, `status='offline_issued'`, `invoice_xml`, `kod_i_url`, `kod_ii_url`, `offline_certificate_serial`, `offline_issued_at`, `offline_send_deadline_at`. The active-unique index already prevents a duplicate active submission per invoice.
- The PDF (SPEC-008) renders both QRs: KOD I labelled "OFFLINE", KOD II labelled "CERTYFIKAT". `invoice-pdf-model.ts` already does `label: number ?? 'OFFLINE'`; the model gains an optional second QR (KOD II) and `invoice-pdf.ts`/`invoice-qr.ts` render it.

### Deferred send + reconcile (`lib/submission-flow.ts`, `subscribers/ksef-submit.ts`, `workers/ksef-reconcile.worker.ts` — modify)
- `KsefSubmissionInput` gains an `offlineMode?: boolean`; `submitInvoiceToKsef` threads it to `sendOnlineInvoice({ offlineMode })`. For an offline-issued row the deferred send passes `true`.
- `subscribers/ksef-submit.ts`: when claiming a row, if the source row was `offline_issued` (or a new `financial_pl.ksef_submission.send_offline` event), build the auth config and call `submitInvoiceToKsef` with `offlineMode:true` against the **stored** `invoice_xml` (no rebuild — byte-stable), then reconcile the retroactive number/UPO exactly as the online path; on acceptance set `accepted_at` to the KSeF timestamp.
- `workers/ksef-reconcile.worker.ts`: add an `offline_issued` candidate query keyed on `offline_send_deadline_at` (prioritize rows approaching/over the deadline). Route them to the **initial send** (CAS-claim `offline_issued → processing`, emit the send event) — distinct from the SPEC-007 re-poll (which is for `processing` rows that already reached KSeF). The CAS claim + 440 content-hash heal keep it duplicate-safe.
- New event `financial_pl.ksef_submission.send_offline` declared in `events.ts` (the existing `.queued`/`.repoll`/`.accepted`/`.rejected` set is auto-discovered; the handler `metadata.event` matches).

## Data Models

**No new entity. `sales` untouched.** New columns on `KsefSubmission` (`data/entities.ts`, table `financial_pl_ksef_submissions`), all nullable (additive, §27):

| Column | Type | Purpose |
|---|---|---|
| `offline_issued_at` | timestamptz, nullable | When the invoice was issued offline (start of the deadline clock). |
| `offline_send_deadline_at` | timestamptz, nullable | Computed statutory deadline; drives worker prioritization + the overdue alert. |
| `kod_i_url` | text, nullable | The KOD I verification URL (reproducible reprint without re-deriving). |
| `kod_ii_url` | text, nullable | The full signed KOD II URL. |
| `offline_certificate_serial` | text, nullable | Which Offline cert serial signed KOD II (audit / multi-cert). |

`ksef_pl` credentials (integration config, encrypted — not DB columns): add `offlineCertificatePem`, `offlineCertificatePrivateKeyPem` (secret), `offlineCertificateSerialNumber`, mirroring the Authentication triple. `offlineCertificatePrivateKeyPem` is added to the `encryption.ts` secret list.

`KsefSubmission.mode` (`offline24`/`awaryjny`) and `status` (`offline_issued`) already exist. `KsefCredentials` (`lib/credentials.ts`) gains the three `offlineCertificate*` reads.

Migration: one additive MikroORM migration generated via `yarn db:generate` (SQL + snapshot), never hand-written; no index change.

## API Contracts

External (KSeF v2, consumed): unchanged endpoints. `POST /certificates/enrollments` is now also called with `certificateType: 'Offline'`. `POST /sessions/online/.../invoices` is called with `offlineMode: true` for offline-issued rows. KOD II uses the public QR host (`qr-{env}.ksef.mf.gov.pl`), not the API base.

Internal (this module — additive):
| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/ksef/certificates/enroll` | `POST` | `financial_pl.manage` | Extended with `certificateType` (`Authentication`\|`Offline`); Offline persists into the separate offline credential fields. |
| `…/ksef/submissions/issue-offline` | `POST` | `financial_pl.manage` | Issue an invoice offline (mode `offline24`\|`awaryjny`): build XML + KOD I/II, persist `offline_issued` + deadline. Org/tenant-scoped, zod-validated. |

The existing send/retry/upo routes are unchanged; the offline late-send is worker-driven.

## Internationalization (i18n)
New keys (en + pl + de + es, sorted per `i18n:check-sync`):
- Errors: `financial_pl.errors.offline_certificate_required`, `financial_pl.errors.offline_send_overdue`, `financial_pl.errors.offline_mode_invalid`.
- Actions/labels: `financial_pl.actions.invoiceIssuedOffline`, `financial_pl.actions.offlineInvoiceSent`, `financial_pl.fields.kodII`, `financial_pl.fields.offlineDeadline`, `financial_pl.labels.qrOffline`, `financial_pl.labels.qrCertyfikat`.

## UI/UX
No new pages. The certificate-management surface (command/route-driven, SPEC-007) gains the `certificateType` choice for enrollment. The KSeF status column/widget (SPEC-005/006) surfaces `offline_issued` + the deadline (with an overdue indicator when `offline_send_deadline_at` is past and the row is not yet `accepted`). The invoice PDF (SPEC-008) renders the dual QR (KOD I "OFFLINE" + KOD II "CERTYFIKAT"). An operator-facing "issue offline" action invokes `…/submissions/issue-offline`.

## Configuration
No new required env vars. `OM_KSEF_QR_HOST` already overrides the QR host (used by both KOD I and KOD II). New optional `OM_KSEF_PL_HOLIDAYS` (or a small bundled Polish-holiday table with a yearly-maintenance note) feeds the deadline calculator — the holiday-calendar source is an Open Question. The Offline cert reuses the same `environment`/`OM_KSEF_ENVIRONMENT` resolution.

## Migration & Compatibility
One additive, nullable-column migration on `financial_pl_ksef_submissions` (generated). Backward-compatible: all new columns are nullable and only populated for offline-issued rows; online submissions are byte-for-byte unchanged (`offlineMode` defaults to `false`, the existing `sendOnlineInvoice` behavior). Offline enrollment is opt-in via `certificateType:'Offline'`; existing Authentication enrollment is unchanged (default). The new credential fields default absent → existing orgs unaffected until they enroll an Offline cert. `KsefSubmissionInput.offlineMode` is an internal type addition (no public surface change).

## Implementation Plan

### Phase 1 — Offline certificate enrollment
1. `cert-enrollment.ts`: `certificateType` param (default Authentication) threaded to `enrollCertificate`.
2. `commands/ksef-certificate.ts`: `certificateType` input; Offline → persist `offlineCertificate*` fields (preserve Authentication); `credentials.ts` reads them; `encryption.ts` secret-list adds `offlineCertificatePrivateKeyPem`.
3. Unit tests: enroll Offline persists the separate fields; Authentication path unchanged.

### Phase 2 — KOD II
1. `lib/ksef-qr-cert.ts`: `buildKodIIUrl` + the RSA-PSS / ECDSA-P1363 signer (WebCrypto), reusing `ksefInvoiceHashBase64Url`/`toBase64Url`/`sha256`/`resolveKsefQrHost`.
2. Unit tests: canonical signed-string template; the produced signature verifies against the cert public key (RSA-PSS + EC); base64url segment shape.

### Phase 3 — Deadline calculator
1. `lib/offline-deadline.ts`: `computeOfflineSendDeadline` (offline24 next-business-day; awaryjny failure-end + 7bd; weekends + holidays skipped; recompute on failure window).
2. Unit tests: next-business-day across a weekend + a holiday; 7-business-day awaryjny; offline24-overtaken-by-failure recompute.

### Phase 4 — Offline issuance + PDF
1. `KsefSubmission` columns; `yarn db:generate` (migration + snapshot, reviewed).
2. `commands/ksef-submission.ts` `issue_offline` command (build XML + KOD I/II + deadline; persist `offline_issued`); `api/ksef/submissions/issue-offline/route.ts`.
3. PDF: dual-QR model + render (KOD I "OFFLINE", KOD II "CERTYFIKAT").
4. Unit + the status column/widget showing the deadline.

### Phase 5 — Deferred send + reconcile
1. `KsefSubmissionInput.offlineMode` threaded through `submitInvoiceToKsef` → `sendOnlineInvoice`.
2. `subscribers/ksef-submit.ts` (or a `ksef-send-offline.ts` subscriber) sends `offline_issued` rows with `offlineMode:true` against the stored XML; reconcile the retroactive number/UPO; set `accepted_at` to the KSeF timestamp; `events.ts` `send_offline` event.
3. `workers/ksef-reconcile.worker.ts`: `offline_issued` candidate query keyed on the deadline; CAS-claim `offline_issued → processing`; route to the initial send.
4. Unit tests: deferred send (`offlineMode:true`), retroactive-number reconcile, deadline-prioritized pickup, duplicate-safe re-send (440 heal).

### Phase 6 — Live verification
Extend `lib/__tests__/ksef-live.test.ts` (env-gated, `OM_KSEF_TEST_OFFLINE_CERT_PEM`/`KEY`): enroll/verify an Offline cert; issue offline; verify KOD II against the Offline cert; late-send with `offlineMode:true`; confirm the retroactive KSeF number + UPO.

### File Manifest
| File | Action | Purpose |
|------|--------|---------|
| `lib/cert-enrollment.ts` | Modify | `certificateType` param (default Authentication) → `enrollCertificate`. |
| `commands/ksef-certificate.ts` | Modify | `certificateType` input; Offline → separate `offlineCertificate*` persistence. |
| `lib/credentials.ts` | Modify | Read `offlineCertificate*` fields. |
| `lib/encryption.ts` | Modify | Add `offlineCertificatePrivateKeyPem` to the secret list. |
| `lib/ksef-qr-cert.ts` | Create | KOD II URL builder + RSA-PSS/ECDSA-P1363 signer (pure). |
| `lib/offline-deadline.ts` | Create | Statutory business-day deadline calculator (pure). |
| `lib/offline-issue.ts` (or in `submission-flow.ts`) | Create/Modify | Offline issuance orchestration (XML + KOD I/II + deadline + persist). |
| `commands/ksef-submission.ts` | Modify | `issue_offline` command. |
| `api/ksef/submissions/issue-offline/route.ts` | Create | Offline-issue route. |
| `data/entities.ts` | Modify | `KsefSubmission` offline columns (issued_at, deadline, kod_i/ii_url, cert serial). |
| `migrations/*` + `migrations/.snapshot-open-mercato.json` | Create (generated) | Additive migration via `yarn db:generate`. |
| `lib/submission-flow.ts` | Modify | `KsefSubmissionInput.offlineMode` → `sendOnlineInvoice`. |
| `subscribers/ksef-submit.ts` (or `subscribers/ksef-send-offline.ts`) | Modify/Create | Deferred offline send + retroactive reconcile. |
| `workers/ksef-reconcile.worker.ts` | Modify | Route `offline_issued` rows by deadline to the initial send. |
| `events.ts` | Modify | `financial_pl.ksef_submission.send_offline` event. |
| `lib/invoice-pdf-model.ts`, `lib/invoice-pdf.ts`, `lib/invoice-qr.ts` | Modify | Dual-QR (KOD I "OFFLINE" + KOD II "CERTYFIKAT"). |
| `widgets/injection/ksef-status-column/*` | Modify | Surface `offline_issued` + deadline/overdue. |
| `data/validators.ts` | Modify | `issue_offline` input zod schema. |
| `i18n/{en,pl,de,es}.json` | Modify | Offline error/action/label keys (4 locales). |
| `__integration__/TC-KSEF-008.spec.ts` | Create | Offline enrollment + issue-offline + KOD II HTTP contract. |
| `lib/__tests__/*` | Create/Modify | KOD II signer, deadline calculator, offline send unit coverage. |
| `lib/__tests__/ksef-live.test.ts` | Modify | Live offline round-trip (env-gated). |

## Risks & Impact Review

### Data Integrity Failures
- **KOD II signature invalid** (wrong padding / wrong key / wrong canonical string) → the buyer's QR fails KSeF verification. **Severity: High → mitigated** by unit tests (signature verifies against the Offline cert public key for RSA-PSS + EC; canonical string matches the template) + the env-gated live verification. Residual: full proof requires KSeF's verifier (handoff).
- **Wrong retroactive reconcile** (number/UPO/`accepted_at`) → mis-dated legal receipt. **Severity: High → mitigated** by reusing the proven online reconcile (UPO-gated acceptance) and setting `accepted_at` to the KSeF timestamp; byte-stable stored XML.
- **Offline key exposure** → impersonation / forged KOD II. **Severity: Critical → mitigated** by storing the key as an encrypted integration `secret`, never returned/logged.

### Cascading Failures & Side Effects
- **Missed statutory deadline** (connectivity outage past the deadline) → legal breach. **Severity: High → mitigated** by storing + prioritizing `offline_send_deadline_at`, an overdue alert, and the reconcile breaker surfacing a stuck row as gave-up rather than silently dropping it. Residual: a prolonged outage past the deadline is a real-world risk the operator must monitor.
- **Duplicate send** (offline row sent twice) → mitigated: the CAS claim (`offline_issued → processing`) + KSeF 440 content-hash de-duplication recover the original registration; byte-stable XML.
- **Offline-cert enrollment clobbering the Authentication credential** → auth breaks. **Severity: High → eliminated** by persisting the Offline cert into separate fields.

### Tenant & Data Isolation Risks
- All offline reads/writes/commands are `(tenantId, organizationId)`-scoped; the Offline cert + key are per-org integration secrets; KOD II is built per submission row. No cross-org surface.

### Migration & Deployment Risks
- Additive nullable columns only; online behavior unchanged (`offlineMode` default `false`). No narrowing.

### Operational Risks
- The KOD II signer adds an RSA-PSS WebCrypto path; vetted Node `webcrypto.subtle`, no new dependency. The Polish-holiday calendar must be maintained yearly (Open Question).

### Risk Register

#### KOD II signature rejected by KSeF
- **Severity**: High → mitigated.
- **Mitigation**: unit tests verify the signature against the cert (RSA-PSS saltLength 32 + ECDSA P1363) and the canonical signed string; env-gated live verification against the Offline cert.
- **Residual**: KSeF's verifier is the final authority (handoff). RSA-PSS saltLength acceptance is confirmed live.

#### Missed send-to-KSeF deadline
- **Severity**: High → mitigated.
- **Mitigation**: `offline_send_deadline_at` stored + worker-prioritized; overdue alert; reconcile breaker surfaces stuck rows.
- **Residual**: a prolonged outage past the statutory window is an operational risk the operator monitors.

#### Offline cert clobbers Authentication credential
- **Severity**: High → eliminated.
- **Mitigation**: separate `offlineCertificate*` credential fields; enrollment branches on `certificateType`.

#### Duplicate offline send
- **Severity**: Medium → eliminated by construction.
- **Mitigation**: CAS claim + KSeF 440 content-hash heal + byte-stable stored XML; recovers the original registration.

#### `issuedOutsideKsef`/offline confusion (JPK mis-mark)
- **Severity**: Medium → mitigated.
- **Mitigation**: offline issuance never sets `issuedOutsideKsef`; the JPK marking is `DI`/`OFF` until the number is assigned, then `NrKSeF` (existing `jpk-vat-marking.ts`).

#### Offline private-key handling
- **Severity**: Critical → mitigated.
- **Mitigation**: encrypted integration `secret`, never returned/logged; enrollment writes it back encrypted.

## Final Compliance Report — 2026-06-28

### AGENTS.md Files Reviewed
- `AGENTS.md` (root, official-modules) · `.ai/specs/AGENTS.md` · `ARCHITECTURE.md` (§11 UMES, §16 crypto, §27 BC, §31 checklist) · core `packages/core/.../integrations` (read-only, credentials service contract).

### Compliance Matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | Submissions FK-id only; creds via `IntegrationCredentialsService`. |
| root AGENTS.md | Filter by organization_id (+ tenant) | Compliant | All offline reads/writes/commands org+tenant-scoped. |
| root AGENTS.md | Never modify core packages | Compliant | `sales`/core read-only; all changes in `financial_pl`. |
| root AGENTS.md | Never hand-write migrations | Compliant | One generated migration (`yarn db:generate`). |
| root AGENTS.md | zod-validate all API inputs | Compliant | Enroll + issue-offline routes use zod. |
| root AGENTS.md | No `any` / no hardcoded user strings | Compliant | `z.infer` types; i18n keys in 4 locales. |
| ARCHITECTURE §16 | Hand-written crypto only where protocol-mandated | Compliant | KOD II uses WebCrypto (RSA-PSS/ECDSA); reuses `sha256`/`toBase64Url`. |
| ARCHITECTURE §27 | Backward-compatibility (additive only) | Compliant | Nullable columns; `offlineMode` default false; separate cert fields. |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | Offline columns + credential fields back the issuance/send/reconcile flow. |
| API contracts match UI/UX | Pass | issue-offline route + dual-QR PDF + status-column deadline. |
| Risks cover all write operations | Pass | Enrollment, issuance, deferred send, reconcile, deadline covered. |
| Commands defined for all mutations | Pass | `ksef_certificate.enroll` (Offline) + `ksef_submission.issue_offline`. |

### Verdict
- **Compliant** — approved for implementation pending the spec-stage cross-model jury.

## Integration Test Coverage
- **TC-KSEF-008** (new, Playwright): `…/ksef/certificates/enroll` with `certificateType:'Offline'` (401 anon, 403 without `manage`, 400 invalid, 409 no auth credential); `…/ksef/submissions/issue-offline` (401, 400 invalid mode/payload, 409 no Offline cert, 200/202 offline_issued shape with the deadline + KOD I/II URLs echoed). Self-contained HTTP contract only (no live KSeF); the KOD II signature + deferred send are proven by unit + the env-gated live block.
- **Unit:** `ksef-qr-cert.test.ts` (canonical signed string; signature verifies RSA-PSS + EC; segment shape), `offline-deadline.test.ts` (next-business-day across weekend/holiday; awaryjny 7bd; offline24-overtaken recompute), `cert-enrollment.test.ts` (+Offline type → separate fields), `submission-flow.test.ts` (+`offlineMode:true` threading + retroactive reconcile), `ksef-reconcile.test.ts` (+offline_issued deadline routing), offline-issue command test.
- **Live (`ksef-live.test.ts`, env-gated):** enroll Offline cert → issue offline → verify KOD II → late-send `offlineMode:true` → retroactive KSeF number + UPO (`OM_KSEF_TEST_OFFLINE_CERT_PEM`/`KEY`).

## Open Questions
1. **Polish public-holiday calendar source.** The deadline calculator needs an authoritative, yearly-maintained list of Polish public holidays (movable feasts included). Bundle a table (with a maintenance note), read `OM_KSEF_PL_HOLIDAYS`, or fetch from a service? Without it the business-day arithmetic can mis-compute a deadline.
2. **KSeF context-type casing for the KOD II segment.** `kody-qr.md` shows `Nip`; confirm the exact casing (`Nip` vs `NIP`) and the non-NIP context types (`InternalId`/`NipVatUe`/`PeppolId`) against a live sample/the API doc.
3. **`validFrom` on the Offline cert enrollment.** The client supports `validFrom`; does MF require the Offline cert to be valid at issue time (set it) or is it optional?
4. **RSA-PSS saltLength accepted by KSeF.** Docs say 32 bytes (SHA-256 digest length); confirm WebCrypto `saltLength:32` is accepted by KSeF verification.
5. **Does FA(3) carry an offline marker element?** Current understanding: no — offline-ness is conveyed by `offlineMode` at send time + the KOD II QR. Confirm against the XSD that no annotation element must be set.
6. **Auto-issue-offline trigger.** Should the connector auto-detect an outage / no-connectivity and issue offline automatically, or is offline issuance always an explicit operator action? (Affects whether the worker can *initiate* offline issuance vs only the deferred send.)
7. **Awaryjny failure-window source.** Where does `failureEndsAt` come from — manual operator entry of the MF-BIP-announced window, or an automated MF status feed?

## Spec-stage cross-model review — 2026-06-28
Jury run on this spec (artifact mode, spec-review rubric). **DeepSeek V4 Pro (max): fail — 1 Critical + 3 High**, all reconciled into binding design deltas; **Codex (gpt-5.5) & Kimi K2.7: skipped** (CLI not installed). `cross-model (spec): confirmed (deepseek); codex + kimi skipped (CLI absent)`.

1. **(Critical) `failureEndsAt` source undefined → RESOLVED (explicit operator entry).** The `…/submissions/issue-offline` route + the `issue_offline` command accept `mode` (`offline24|awaryjny`) and, for `awaryjny`, a required `failureEndsAt` (the MF-BIP-announced failure-end timestamp the operator enters); `offline24` needs none (next-business-day). The deadline is computed at issue time from `(issuedAt, mode, failureEndsAt)`. An offline24 invoice later overtaken by an announced failure is handled by a separate `financial_pl.ksef_submission.recompute_offline_deadline` command (operator supplies the window; it recomputes `offline_send_deadline_at` for the affected rows) — the route validates `failureEndsAt` is required-and-present for `awaryjny` and absent/ignored for `offline24` (`offline_mode_invalid` otherwise).
2. **(High) `offline_issued` not in the active-unique index → RESOLVED.** The current `financial_pl_ksef_submissions_active_unique` and `…_credit_memo_active_unique` cover `status in ('queued','processing','accepted')` only. Both indexes are extended to **`('queued','processing','accepted','offline_issued')`** so an offline-issued row blocks a second offline-issue **and** an online submit for the same source document (regenerated via `yarn db:generate`). Without this, a duplicate active row could be created for an offline invoice.
3. **(High) No Offline-cert validity check before KOD II → RESOLVED.** The `issue_offline` command validates the Offline certificate's `validFrom`/`validTo` (parsed from the stored PEM) before signing KOD II and **refuses issuance** with `offline_certificate_invalid` (i18n, 4 locales) when the cert is expired or not-yet-valid — an invalid signature would fail KSeF verification and be legally non-compliant.
4. **(High) Holiday-calendar source unresolved → RESOLVED (bundled + override).** `lib/offline-deadline.ts` ships a pure `polishPublicHolidays(year)` that computes the fixed Polish public holidays + the Easter-derived movable feasts (Easter Monday, Pentecost Sunday, Corpus Christi) via the Anonymous Gregorian (Meeus/Computus) algorithm — no external data, valid for any year. `OM_KSEF_PL_HOLIDAYS` (CSV of ISO `YYYY-MM-DD`) **adds** extra non-working days (e.g. an ad-hoc statutory day). The calculator unit tests pin the 2026/2027 holiday sets.

Notes folded in: a bulk `recompute_offline_deadline` covers existing offline24 rows when a failure is announced (delta #1); KOD II `ContextType` casing (`Nip`) + RSA-PSS `saltLength:32` are confirmed in the env-gated live block (handoff, not a design blocker); auto-issue-offline stays an **explicit operator action** (no outage auto-detection) per the SPEC-009/owner default.

## Changelog
### 2026-06-28 — SPEC-010 initial
- Added KSeF offline mode: Offline certificate-type enrollment (separate credential fields), the cert-signed KOD II QR (`lib/ksef-qr-cert.ts`, RSA-PSS/ECDSA-P1363), the offline24/awaryjny issuance lifecycle with a statutory business-day deadline calculator (`lib/offline-deadline.ts`), and the deferred offline send path (`offlineMode:true`, reconcile worker routing of `offline_issued` rows by deadline, retroactive KSeF number). One additive nullable-column migration on `financial_pl_ksef_submissions`; new `offlineCertificate*` credential fields; no core change, no `sales` change, online behavior byte-for-byte unchanged.
