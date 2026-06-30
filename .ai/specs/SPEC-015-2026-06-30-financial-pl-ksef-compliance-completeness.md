# SPEC-015 — `financial_pl`: KSeF compliance completeness (inbound receiving, JPK e-submission, full offline + KOD II, cert cutover, NBP FX, batch, PDF pagination)

- **Date:** 2026-06-30
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** SPEC-005…SPEC-014 (KSeF connector, FA(3) doc-types, offline+KOD II libs, invoice PDF, JPK_V7 generation, module-owned backoffice, commercial editor). Standalone on released `@open-mercato/core`.
- **Status:** Draft → for implementation. Branch `feat/financial-pl-ksef-compliance` (off SPEC-014). Grounded by three official-source research passes (CIRFMF/ksef-docs, podatki.gov.pl JPK spec v5.20, gov.pl) + internal recon.

## TLDR

**Key Points:**
- Closes the **remaining KSeF/JPK completeness gaps** the 2026-06-29 audit + SPEC-011 deferred, in one branch (user-directed). Seven features, each **independently live-verifiable on a test environment** (confirmed by research):
  1. 🔴 **Inbound invoice RECEIVING** (mandatory since 2026-02-01) — query/download invoices addressed to the taxpayer as buyer → store + auto-materialize purchase records; receipt date = KSeF-number assignment (`acquisitionDate`).
  2. 🔴 **Direct JPK_V7 e-submission to MF** — transmit the already-generated JPK XML through the MF JPK gateway (`e-dokumenty.mf.gov.pl`, SEPARATE from KSeF) → reference → UPO; flips `JpkVatFiling.status` to `submitted`.
  3. 🟠 **Full offline issuance + KOD II on the PDF** — wire `niedostępność` / total-`awaria` modes (offline24 + awaryjny already wired) + render the existing KOD II QR on offline-issued invoice PDFs.
  4. 🟠 **Token→certificate cutover automation + cert-expiry monitoring** — prefer certificate auth when a valid Authentication cert is configured; surface token/cert expiry (tokens sunset 2026-12-31; certs ≤ 2 yr).
  5. 🟡 **NBP FX auto-sourcing** — fetch the NBP mid-rate (table A, D-1 business day) for a foreign-currency invoice instead of manual entry.
  6. 🟡 **Batch (wsadowa) session** — send many FA(3) invoices in one encrypted ZIP package (parts ≤ 100 MB) → shared session status/UPO.
  7. 🟡 **PDF multi-page pagination** — paginate the invoice line table so > ~45 lines no longer overflow a single A4 page.
- **Verifiability (honest):** receiving (self-addressed TEST invoice), JPK submit (`test-e-dokumenty.mf.gov.pl` + self-signed XAdES + MF test archives), batch (KSeF TEST), offline/KOD II/FX/PDF (unit + structural + live where applicable) are ALL exercisable. The only non-test-exercisable bits are documented limitations: JPK `dane autoryzujące` (prod-only), the MF unavailability/awaria announcement feed (no API → operational input), and a real qualified signature (prod-only authenticity).
- **Cross-module rules preserved:** no direct cross-module ORM; tenant + feature gating on every new route; zod at boundaries; DI; DS tokens + `@open-mercato/ui` only; i18n × 4. KSeF send side (SPEC-005…014) and the `metadata.buyerSnapshot` contract are unchanged.

**Scope (committed):** features 1–7 above, with new entities/migrations, new KSeF/JPK client methods, commands, API routes, module-owned backoffice UI, and per-feature tests.

**Out of scope (documented):** external-seller self-billing (issuer ≠ seller; relaxing the `seller.nip===contextNip` invariant — product decision, SPEC-011); shared/delegated multi-entity `uprawnienia` model; MPP split-payment carrying NrKSeF (future-dated 2027-01-01); a programmatic MF unavailability/awaria announcement poll (no such API exists); JPK `dane autoryzujące` live-verification (prod-only).

**Concerns:** this is a large, multi-surface change; each feature is independently shippable, so the implementation is decomposed feature-by-feature with its own tests and its own slice of the verification gate. Schema work uses an ephemeral DB (migrate-from-zero). External calls (NBP, MF JPK gateway, KSeF receive) are time-bounded + fail-safe and never block the unrelated flows.

## Overview
SPEC-005…014 made `financial_pl` ~complete for **issuing** structured invoices (FA(3), all doc types, corrections, offline24/awaryjny, PDF/QR, JPK_V7 *generation*, a commercial backoffice). Two **in-force mandatory obligations** remained unimplemented — **receiving** invoices via KSeF and **transmitting** JPK_V7 to MF — plus a set of smaller hardening items (full offline modes, KOD II on the PDF, cert cutover, NBP FX, batch, PDF pagination). This spec implements all seven, each grounded in official documentation and each verifiable.

## Problem Statement
1. **Send-only connector (receiving missing, mandatory 2026-02-01).** `lib/ksef-client.ts` has session/send/UPO/cert methods but **no** `/invoices/query/metadata`, `/invoices/exports`, or `/invoices/ksef/{ksefNumber}`. A taxpayer cannot see or pull invoices issued *to* them. `PurchaseVatRecord` is manual-upsert only.
2. **JPK generated but not filed (mandatory 2026-02-01).** SPEC-012 builds the JPK_V7M/V7K(3) XML and streams it for download; nothing transmits it to MF, so `JpkVatFiling.status` never legitimately reaches `submitted`.
3. **Offline incompleteness.** `niedostępność` / total-`awaria` issuance is calc-only (`lib/offline-deadline.ts` has the modes + deadlines; the issuance path wires only offline24 + awaryjny). The KOD II offline QR (`lib/ksef-qr-cert.ts`) is fully implemented but **never rendered** by the invoice-PDF route.
4. **Auth lifecycle.** Token auth is the default; certificate auth works (SPEC-007) but there is no cutover preference or expiry monitoring before the 2026-12-31 token sunset / the 2-year cert cap.
5. **Manual FX.** Foreign-currency invoices take an operator-supplied `fxRate`; no NBP auto-fetch.
6. **One-at-a-time send.** Only the interactive online session (`POST /sessions/online/{ref}/invoices`, one invoice/request) is implemented; high-volume issuers need the batch (wsadowa) package path.
7. **Single-page PDF.** `lib/invoice-pdf.ts` `renderInvoicePdf` overflows past ~45 line items.

## Proposed Solution
All work under `packages/financial-pl/src/modules/financial_pl/`. New shared `lib/` modules are React-free + unit-tested; new client components use only `@open-mercato/ui` primitives (DS §22). New routes are auth+feature-gated and zod-validated. Each feature is described with its endpoints, data, and acceptance criteria.

### F1 — Inbound invoice receiving (🔴 mandatory)
- **KSeF client (session-less, Bearer access token, permission `InvoiceRead`):**
  - `queryReceivedInvoices(accessToken, filters, page)` → `POST {base}/v2/invoices/query/metadata?pageOffset&pageSize&sortOrder` with `InvoiceQueryFilters` (`subjectType:'Subject2'` for buyer, `dateRange{dateType,from,to}`, optional `sellerNip`/`invoiceTypes`/…). Returns the paged `InvoiceMetadata[]` (+ `hasMore`, `permanentStorageHwmDate`).
  - `downloadInvoiceByKsefNumber(accessToken, ksefNumber)` → `GET {base}/v2/invoices/ksef/{ksefNumber}` (`Accept: application/xml`) → raw FA(3) XML string.
  - (Phase-2-ready) `exportReceivedInvoices` / `getExportStatus` for async bulk incremental sync (`dateType:'PermanentStorage'` + HWM); the UI uses the synchronous metadata query, exports are wired behind a feature flag for large tenants.
- **Receive flow** (`commands/ksef-receive.ts` `receiveInvoicesCommand`): authenticate (reuse `ksef-auth`), page through `queryReceivedInvoices` for the requested date window as `Subject2`. **`isTruncated` handling (spec-jury, Codex):** the metadata query caps a result set at 10,000 — when `isTruncated` is true, the loop must **narrow `dateRange`** (advance `from` to the last returned record's date) and reset `pageOffset`, not rely on `hasMore`/HWM alone (which would silently skip buyer invoices in a high-volume window). Upsert each into the new `financial_pl_received_invoice` entity, **idempotent on `(scope, ksefNumber)`** (mirror the existing 23505 race-winner pattern). **No-clobber rule (spec-jury, Kimi):** on re-fetch, the legally-significant fields (`ksefNumber`, `acquisitionDate` = the receipt date, `issuerNip`, `fa3Xml`, amounts) are **first-write-wins / immutable**; only volatile sync metadata (`fetchedAt`) updates; a received invoice already linked to a `PurchaseVatRecord` is never re-materialized. Time-bounded; fail-safe (a partial page error logs + continues; never throws into unrelated flows).
- **`acquisitionDate` = legal receipt date** ("data otrzymania faktury = data nadania numeru KSeF", per CIRFMF docs); `permanentStorageDate` is the LATER stable cursor key (NOT the receipt date) — do not conflate.
- **Materialization is EXPLICIT-only (spec-jury, Kimi+DeepSeek+Codex):** there is **no** vague "auto when imp/markings resolved" path — a `PurchaseVatRecord` (`financial_pl`'s OWN entity `financial_pl_jpk_purchase_record` — NOT a core entity, so no cross-module ORM; spec-jury Kimi blocker refuted) is created **only** by the explicit `to-purchase-record` action. It is **idempotent + transactional**: a partial-unique link (the received invoice's id / scoped KSeF number on the purchase record) inside a single transaction guarantees repeat clicks / concurrent POSTs cannot duplicate a ledger row.
- **Received corrections (spec-jury, DeepSeek):** a received KOR/correction (`invoiceType` + `hashOfCorrectedInvoice` from the metadata) is stored linked to the corrected received invoice; materializing it produces a corrective `PurchaseVatRecord` (signed/delta amounts) with the right `ksefMarking`. (Full corrective-ledger arithmetic beyond the stored delta is a documented follow-up; the link + corrective row are in scope so the purchase ledger isn't silently wrong on a supplier correction.)
- **Sync cursor:** persist `permanentStorageHwmDate` **per `(scope, subjectType, contextNip)`** (small `financial_pl_receive_cursor` row) so an incremental receive resumes from the high-water mark and **multi-NIP tenants keep isolated cursors** (spec-jury, Kimi). The async `/invoices/exports` path (`dateType:PermanentStorage` + HWM) is **deferred behind a disabled feature flag** (spec-jury, Kimi: avoid premature abstraction); the synchronous metadata query is the shipped path.
- **Routes:** `GET /api/financial_pl/ksef/received-invoices` (list, paged, tenant+`financial_pl.view`), `POST /api/financial_pl/ksef/received-invoices/sync` (trigger a receive for a window, `financial_pl.submit`), `GET /api/financial_pl/ksef/received-invoices/[ksefNumber]/xml` (download stored/fresh FA(3), `financial_pl.view`), `POST /api/financial_pl/ksef/received-invoices/[ksefNumber]/to-purchase-record` (materialize, `financial_pl.manage`).
- **UI:** a module-owned backoffice page `backend/financial/received/` — DataTable of received invoices (issuer NIP/name, KSeF number, issue + receipt dates, amounts, type), a "Sync" action (date-range), row actions "View XML" + "Add to purchase ledger". Reuses the SPEC-013 page patterns (sync `props.params`, not `useParams()`).
- **Acceptance:** sync pulls `Subject2` invoices for a window; receipt date = `acquisitionDate`; XML download by KSeF number works; a received invoice materializes a correct `PurchaseVatRecord` (supplier, amounts, `nrKsef`, `receiptDate`). **Live-verified** via a self-addressed TEST invoice (seller==buyer==context NIP) → query Subject2 → download → materialize.

### F2 — Direct JPK_V7 e-submission to MF (🔴 mandatory)
- **Separate gateway** (NOT KSeF): `config.ts` gains `JPK_GATEWAY_URLS = { test: 'https://test-e-dokumenty.mf.gov.pl', prod: 'https://e-dokumenty.mf.gov.pl' }` + the MF JPK public-key cert (test/prod) for AES-key wrapping + `resolveJpkGateway(env)`.
- **Package format** (per MF JPK interface spec v5.20 — confirm exact sizes/algos against the PDF during impl): the JPK XML is **ZIP/DEFLATE-compressed**, the archive split into binary parts (≤ the spec's per-part cap), **each part AES-256-CBC (PKCS#7, 16-byte IV) encrypted**; the AES key is **RSA key-wrapped (PKCS#1 v1.5)** with the MF JPK public cert — the InitUpload metadata literally labels this `algorithm="RSA" mode="ECB" padding="PKCS#1"` (= RSA PKCS#1 v1.5 key transport; not OAEP). `crypto.ts` only has RSA-OAEP, so F2 adds a **new PKCS#1-v1.5 wrap** helper (the existing OAEP path is untouched). The InitUpload metadata `Document.HashValue` = **SHA-256+Base64 over the whole JPK document**; each uploaded part carries an **MD5+Base64 (`Content-MD5`)** hash.
- **Submission client** `lib/jpk/jpk-submission-client.ts`:
  - `submitJpk({ jpkXml, signer })`: build + sign the **InitUpload metadata XML** with a **NEW `signJpkInitUpload` entry point added to `lib/xades.ts`** (XAdES-BES, two `ds:Reference` — `SignedProperties` + whole-doc, RSA-SHA256). The existing `signAuthTokenRequest` (single-reference, AuthTokenRequest-root) is **left untouched** (BC); the JPK signer is added alongside it. `POST /api/Storage/InitUploadSigned` → `{ ReferenceNumber, RequestToUploadFileList[] }`; **`PUT` each encrypted part to the response-supplied absolute Azure SAS `Url`** (`Content-MD5` + `x-ms-blob-type: BlockBlob`) via a **new small PUT-capable transport helper** (raw `fetch`, `AbortController`-bounded — `lib/ksef-client.ts`'s transport is `GET|POST|DELETE`-only and baseUrl-relative, so it is NOT reused for the blob PUT); `POST /api/Storage/FinishUpload`; poll `GET /api/Storage/Status/{ReferenceNumber}` until terminal; on success extract the `Upo` XML. A `?enableValidateQualifiedSignature=true` knob (test) rehearses the prod qualified-signature check.
  - `dane autoryzujące` (revenue-amount) path: implement the `AuthData` builder behind a flag, **unit-test only** (documented: not exercisable on the test gateway).
- **Signer credential (distinct from KSeF auth — spec-jury, Codex+DeepSeek+Kimi):** the JPK submission requires a **qualified electronic signature / Trusted Profile (podpis zaufany) / `dane autoryzujące`** — a credential SEPARATE from the KSeF Type-1 Authentication certificate. F2 adds a **dedicated JPK-signer credential field** (`jpk_signer_pem`/`_key` or a Trusted-Profile/AuthData selector) to the `ksef_pl` integration config; a KSeF Authentication cert is **never** silently reused as the JPK signer. On **TEST**, a self-signed cert is accepted (validity not checked); **PROD** requires the qualified/trusted credential.
- **Command/route:** `submitJpkFilingCommand` (loads `JpkVatFiling.generatedXml`; **idempotent + crash-safe**: a CAS transition `generated → submitting` claims the filing under a row lock so concurrent POSTs don't double-submit, then `submissionReference` is **persisted immediately after InitUpload** so a crash resumes/retries that reference instead of re-uploading; on terminal success persists `upoXml` + `submittedAt` + `status='submitted'`; refuses to resubmit a `submitted`/`submitting` filing absent an explicit correction flag). `POST /api/financial_pl/ksef/jpk/submit` (`financial_pl.submit`), `GET …/jpk/submit/status?ref=` (poll).
- **UI:** extend the SPEC-012 JPK backoffice page with a "Submit to MF" action + status/UPO display per filing.
- **Acceptance:** a generated JPK_V7M(3) submits to `test-e-dokumenty.mf.gov.pl`, returns a `ReferenceNumber`, polls to a terminal status, and yields a (test) UPO; the filing flips to `submitted` with the UPO stored; a concurrent/duplicate submit is rejected by the CAS lock. **Live-verified** on the test gateway with a self-signed XAdES + an MF test archive shape. **Documented limitation:** `dane autoryzujące` + production qualified-signature authenticity are not test-exercisable.

### F3 — Full offline issuance + KOD II on the PDF (🟠)
- **Offline modes — corrected terminology (spec-jury, Claude+Codex):** the code today has `OfflineSendMode = 'offline24' | 'awaryjny'` ONLY (NOT `niedostępność`); **`awaria` == the existing `awaryjny`** (rule: `failureEndsAt` + 7 business days). This spec ADDS **`niedostępność`** as a NEW mode → widen the `OfflineSendMode` + `KsefSubmissionMode` TS unions (the DB `mode` column is free `text` with no CHECK constraint → **no DB migration for the enum**) + a new `computeOfflineSendDeadline` branch (anchor = the announced unavailability-period end → next business day, art. 106nh). offline24 (always-available, anchor = issue date, next business day, art. 106nda) + awaryjny/awaria (art. 106nf) are already wired. Because **MF publishes unavailability/awaria via BIP, not an API**, the mode + period are an explicit **operator input** on the issue-offline action, not a poll.
- **Total awaria (awaria całkowita) — a DISTINCT state (spec-jury, Codex):** a complete-outage path with **no FA(3) to KSeF, no KSeF send, and no QR codes**. Model it as a separate flag tied to the existing **`issuedOutsideKsef`** meta + the JPK **`BFK`** marking (not an `OfflineSendMode` value, since it never sends to KSeF and has no deadline/QR); define its persisted state + UI/API + that it produces NO KOD I/II.
- **KOD II on PDF — route-only (spec-jury, Claude):** `lib/invoice-pdf.ts` `renderInvoicePdf` **already** accepts `deps.qrIiPng` + `model.ksefCert` and renders the second QR when present (byte-stable single-QR otherwise), and `invoice-pdf-model.ts` already carries `hasKodII`/`qrCertyfikatLabel`/`ksefCert`. The real gap is ONLY the route `api/ksef/invoice-pdf/route.ts`, which does not build/pass KOD II. Wire it: when an invoice was issued offline (no KSeF number yet) and an **Offline (type-2) certificate** is configured, build the KOD II URL via `lib/ksef-qr-cert.ts` **`buildKodIIUrl`** (the public export; `signKodII` is its internal helper), render it to PNG, and pass it (label `CERTYFIKAT`) beside KOD I (label `OFFLINE`). Falls back gracefully (KOD I only) when no Offline cert. Localized labels (i18n).
- **Acceptance:** an offline-issued invoice's PDF renders both KOD I (`OFFLINE`) and a correctly-signed KOD II (`CERTYFIKAT`) when an Offline cert is configured (KOD I only otherwise); `niedostępność` computes the announced-period-end deadline and `awaria`==`awaryjny` the 7-business-day deadline; total-awaria persists an `issuedOutsideKsef`/`BFK` state with no QR/no send; unit tests cover the new deadline branch + the route's KOD II build.

### F4 — Token→certificate cutover + expiry monitoring (🟠)
- **Auth preference (spec-jury, Claude — preserve the SPEC-007 invariant):** `lib/credentials.ts` `buildKsefAuthConfig` deliberately **never infers** cert auth from cert-material presence (must be an explicit `authMethod==='certificate'`), so an org is never silently switched to cert auth. This spec adds a NEW **explicit opt-in** value `'auto'` to `KsefAuthMethod` (currently `'token'|'certificate'`): when — and only when — the operator selects `auto`, the connector prefers a configured, unexpired Authentication certificate, else falls back to token. `'auto'` is **not** the default and is **never retro-applied**; the never-infer guard stays intact for the legacy `'token'`/`'certificate'` settings. No behavior change for existing tenants.
- **Expiry monitoring:** a `lib/credential-health.ts` that reports, for the configured credential: token presence + the **2026-12-31 sunset** proximity, and the Authentication/Offline cert `notAfter` (parsed from the PEM) vs the 2-year cap, as a structured health object. Surface it on the existing credential/health surface (`lib/health-check.ts`) + a small badge on the backoffice (warn when a cert expires < 30 days or the token sunset is < 60 days away).
- **Acceptance:** with a cert configured, `auto` selects certificate auth (unit-tested against `ksef-auth`'s config resolution); the health report flags an expiring cert + the token sunset. No live KSeF change (cert auth already live-verified SPEC-007/this session).

### F5 — NBP FX auto-sourcing (🟡)
- `lib/nbp-fx.ts`: `fetchNbpMidRate(currency, taxPointDate)` — **date semantics (spec-jury, Codex):** the statutory FX rate is the NBP table-A **mid-rate of the last business day BEFORE the tax point**, so the function computes the required table date = the business day preceding `taxPointDate` and fetches THAT (it must **not** use a same-day rate even if NBP has published one). `GET https://api.nbp.pl/api/exchangerates/rates/A/{currency}/{tableDate}/?format=json`; on a 404 (no table that day — holiday/weekend) it walks back to the prior published table. Time-bounded (≤6 s), fail-open (returns `{ ok:false }` → the operator keeps manual entry). `config.ts` gains the NBP base URL (overridable). Unit test: a date where same-day NBP data exists but the prior-business-day rate must be the one returned.
- **Wire-in:** a "Fetch NBP rate" affordance in the PL-VAT meta FX fields (`PlVatMetaForm`) for a non-PLN invoice → fills `exchangeRate` + `exchangeRateDate`. The resolver (`resolve-fa3-from-invoice.ts`) is unchanged (still trusts the stored rate).
- **Route:** `GET /api/financial_pl/ksef/nbp-rate?currency=&date=` (`financial_pl.view`, fail-open). 
- **Acceptance:** the route returns the correct NBP mid-rate + its publication date for a currency/date (live NBP API), falls back to the prior business day, and fails open; unit tests cover the date-fallback + the fail-open mapping.

### F6 — Batch (wsadowa) session (🟡)
- **KSeF client:** `openBatchSession({ accessToken, formCode, encryption, batchFile, fileParts })` → `POST /v2/sessions/batch` → `{ referenceNumber, partUploadRequests[] }`; `uploadBatchPart(request, encryptedBytes)` (verb/headers **from the response**, not hardcoded); `closeBatchSession(accessToken, referenceNumber)` → `POST /v2/sessions/batch/{ref}/close`. Status/UPO reuse the **shared** `/sessions/{ref}`, `/sessions/{ref}/invoices`, `/invoices/failed`, per-invoice + aggregate UPO endpoints.
- **Packaging** `lib/batch-package.ts`: ZIP the FA(3) XMLs, split into ≤ 100 MB parts, AES-256-CBC encrypt each part (reuse `lib/crypto.ts` session-key handshake — same AES-256 + RSA-OAEP-SHA256 wrap as the online session), compute SHA-256 of the whole ZIP + each part for the manifest, and the SHA-256 of each plaintext invoice for result correlation.
- **Command/route:** `sendBatchCommand(invoiceIds[])` creates one `KsefSubmission` row per invoice tagged with a shared `batchReference`, opens/uploads/closes the batch session, then the reconcile worker resolves per-invoice KSeF numbers + UPO via the shared status endpoints. `POST /api/financial_pl/ksef/submissions/batch` (`financial_pl.submit`). The self-billing guard (`assertNotSelfBilled`) applies to every invoice in the batch.
- **Acceptance:** a 2–3-invoice batch round-trips on KSeF TEST (open → upload encrypted part(s) → close → poll → per-invoice KSeF numbers + aggregate UPO); the package crypto matches the online-session handshake (shared unit tests); self-billed invoices are rejected before packaging.

### F7 — PDF multi-page pagination (🟡)
- Modify `lib/invoice-pdf.ts` `renderInvoicePdf` to paginate the line-items table: when lines exceed the page body height, emit additional A4 pages with a repeated table header + "page n / m" footer; the summary/totals + QR block render on the final page. Byte-stability is preserved for the single-page case (no layout change for ≤ ~45 lines); the deterministic clock/font handling stays (SPEC-008).
- **Acceptance:** an invoice with 100 lines renders a multi-page PDF (no overflow/clipping), the totals + QR(s) appear once on the last page, and a ≤45-line invoice is byte-identical to today (a regression assertion).

## Architecture
```
config.ts                                   # MODIFY  JPK gateway URLs + MF JPK pub-cert + NBP base + resolveJpkGateway
lib/ksef-client.ts                          # MODIFY  + queryReceivedInvoices, downloadInvoiceByKsefNumber, (export*), openBatchSession, uploadBatchPart, closeBatchSession (widen transport to PUT or add a PUT helper for response-supplied absolute SAS URLs)
lib/http-put.ts                             # NEW     small AbortController-bounded PUT-to-absolute-URL helper (JPK Azure-SAS blob + batch part upload; NOT baseUrl-relative)
lib/xades.ts                                # MODIFY  + signJpkInitUpload (two ds:Reference XAdES-BES) — existing signAuthTokenRequest untouched (BC)
lib/crypto.ts                               # MODIFY  + RSA PKCS#1-v1.5 key-wrap for the JPK gateway (existing RSA-OAEP untouched; batch reuses OAEP)
encryption.ts (MODULE ROOT, not data/)      # MODIFY  declare financial_pl:received_invoice {fa3_xml} + add upo_xml to financial_pl:jpk_vat_filing
lib/received-invoice.ts                     # NEW     pure InvoiceMetadata/FA(3) → received-invoice + PurchaseVatRecord mappers (unit-tested)
lib/jpk/jpk-submission-client.ts            # NEW     MF JPK gateway client (Init/PUT/Finish/Status/UPO) + crypto + XAdES metadata
lib/jpk/jpk-submission-metadata.ts          # NEW     InitUpload metadata XML builder + (dane autoryzujące) — unit-tested
lib/batch-package.ts                        # NEW     ZIP + split + AES encrypt + manifest hashes (unit-tested)
lib/nbp-fx.ts                               # NEW     NBP mid-rate fetch + business-day fallback (fail-open, unit-tested)
lib/credential-health.ts                    # NEW     token-sunset + cert-expiry health (pure, unit-tested)
lib/invoice-pdf.ts                          # MODIFY  paginate line table; render KOD II QR when offline + Offline cert
lib/invoice-pdf-model.ts                    # MODIFY  carry KOD II inputs (offline cert serial, signature)
commands/ksef-receive.ts                    # NEW     receiveInvoicesCommand + materializePurchaseRecordCommand
commands/jpk.ts                             # MODIFY  + submitJpkFilingCommand
commands/ksef-submission.ts                 # MODIFY  + sendBatchCommand; extend issueOfflineCommand for niedostepnosc/awaria
api/ksef/received-invoices/route.ts                       # NEW  list + sync (GET/POST)
api/ksef/received-invoices/[ksefNumber]/xml/route.ts      # NEW  download FA(3)
api/ksef/received-invoices/[ksefNumber]/to-purchase-record/route.ts  # NEW  materialize
api/ksef/jpk/submit/route.ts                # NEW  submit + status
api/ksef/submissions/batch/route.ts         # NEW  batch send
api/ksef/nbp-rate/route.ts                  # NEW  NBP rate proxy (fail-open)
backend/financial/received/page.tsx + components   # NEW  received-invoices backoffice
backend/financial/jpk/* (SPEC-012 page)     # MODIFY  + Submit-to-MF action/status
components/PlVatMetaForm.tsx                 # MODIFY  + "Fetch NBP rate" affordance
data/entities.ts                            # MODIFY  + ReceivedInvoice + ReceiveCursor entities; JpkVatFiling submission fields; KsefSubmission batchReference
data/validators.ts                          # MODIFY  + zod for the new route bodies/queries + response types
i18n/{en,pl,de,es}.json                     # MODIFY  new keys (received, jpk-submit, offline modes, KOD II labels, nbp, batch)
README.md                                   # MODIFY  document receiving, JPK submission, batch, offline modes, FX, the gateways + their test-env caveats
```

### Commands & Events
New commands dispatch existing-style domain events (`financial_pl.received.synced`, `financial_pl.jpk.submitted`, `financial_pl.batch.sent`) for observability; no cross-module command coupling. The reconcile worker is extended to re-drive stuck batch + JPK-submission rows.

### API interceptors / immutability
Unchanged. Receiving and JPK submission are additive read/transmit paths; they do not touch the SPEC-013 KSeF-`accepted` immutability interceptor or the core `SalesInvoice` write path.

## Data Models
- **NEW `financial_pl_received_invoice`** — `(organizationId, tenantId, contextNip?)` scope; `ksefNumber` (unique per active scope); `issuerNip`, `issuerName`, `buyerIdentifierType`, `buyerIdentifierValue`, `issueDate`, `acquisitionDate` (= receipt date), `invoiceType`, `currency`, `netAmount`/`grossAmount`/`vatAmount` (text), `invoiceHash`, `fa3Xml?` (compliance-sensitive → declared in `encryption.ts`), `linkedPurchaseRecordId?`, `fetchedAt`, timestamps + `deletedAt`.
- **NEW `financial_pl_receive_cursor`** — `(scope, subjectType)` → `permanentStorageHwmDate`, `lastSyncedAt`.
- **EXTEND `JpkVatFiling`** — `submissionReference?`, `submittedAt?`, `upoXml?` (compliance-sensitive), `submissionError?` (status enum already has `submitted`).
- **EXTEND `KsefSubmission`** — `batchReference?` (groups a batch); confirm the existing offline columns cover `niedostepnosc`/`awaria` (extend the mode enum if not).
- Migrations generated via `yarn generate`; partial-unique indexes mirror the existing entities' pattern.

## API Contracts
All new routes: `metadata` with `requireAuth:true` + the stated `requireFeatures`; zod-validated query/body; `openApi` documented; tenant-scoped DB reads; external calls time-bounded + structured-error (fail-open where they are conveniences — NBP, receive sync — and explicit-error where they are the operation — JPK submit, batch send). No change to any existing route contract, ACL feature id, or event name (purely additive). New feature ids: none — reuse `financial_pl.view|submit|manage`.

## Internationalization (i18n)
New keys (en/pl/de/es, `i18n:check-sync` green) namespaced `financial_pl.*`: received-invoices (list columns, sync, view-xml, add-to-ledger, empty state), jpk submit (action, status, upo, errors), offline modes (offline24/niedostepnosc/awaria labels + the deadline notice + the no-API-poll note), KOD II/KOD I labels (`OFFLINE`, `CERTYFIKAT`), NBP (fetch-rate, unavailable), batch (send, per-invoice result). No hardcoded user-facing strings; internal/log strings prefixed `[internal]`.

## Migration & Compatibility
- **DB:** additive — two new tables + nullable columns on two existing tables. No destructive change. Migrate-from-zero verified in an ephemeral DB.
- **BC:** additive — new routes, new client methods, new entities, new i18n keys, new config. No existing API/contract/event/ACL change; the KSeF send side + `metadata.buyerSnapshot` + the immutability interceptor are untouched. `yarn generate` re-emits registries + the ORM snapshot.
- **ACL:** no new feature ids.

## Risks & Impact Review

### External gateway/API unavailability (KSeF receive, MF JPK, NBP, batch upload)
- **Severity:** Medium · **Mitigation:** every external call is time-bounded (`AbortController`); conveniences (NBP, receive list) fail open; operations (JPK submit, batch) surface a clear, retryable error and never corrupt local state (idempotent reference handling + the reconcile worker re-drives). No retry storms. · **Residual:** Low.

### JPK submission can't be fully verified on test (qualified signature / dane autoryzujące)
- **Severity:** Medium · **Mitigation:** the InitUpload→PUT→Finish→Status→UPO mechanics + AES/RSA/XAdES crypto **are** test-verifiable with a self-signed cert + MF test archives; the prod-only bits (qualified-signature authenticity via `?enableValidateQualifiedSignature`, `dane autoryzujące`) are implemented-to-spec + unit-tested and **documented as not-live-verified**, not claimed. · **Residual:** Low–Medium (a documented, bounded gap, mirroring the offline-mode announcement input).

### Receiving a self-addressed invoice is a test artifact, not a real two-party flow
- **Severity:** Low · **Mitigation:** the query/download/materialize logic is identical regardless of who the seller is; the self-addressed invoice exercises the full `Subject2` path end-to-end on TEST. Production receives real third-party invoices through the same code. · **Residual:** Low.

### Offline mode mis-triggered (no MF announcement API)
- **Severity:** Low · **Mitigation:** the mode is an explicit operator choice with the deadline computed + shown; offline24 (always-available) needs no announcement; niedostępność/awaria are documented as operator-driven per the BIP announcement. · **Residual:** Low.

### Batch package crypto / part-upload divergence
- **Severity:** Medium · **Mitigation:** reuse the proven online-session AES/RSA handshake; drive the part-upload verb/headers from the API response (never hardcode); a 2–3-invoice live batch round-trip on TEST validates the whole path before relying on it. · **Residual:** Low.

### PDF pagination regressing the byte-stable single-page output
- **Severity:** Low · **Mitigation:** the multi-page branch only engages past the single-page line threshold; a regression test asserts a ≤45-line invoice is byte-identical to today. · **Residual:** Low.

## Final Compliance Report
- No cross-module ORM relations; tenant + feature gating on every new route; zod at all new boundaries with `z.infer` types, no `any`; external calls time-bounded + fail-safe; no secrets logged; compliance-sensitive blobs (`fa3Xml`, `upoXml`) declared in `encryption.ts`. DS semantic tokens + `@open-mercato/ui` primitives + i18n × 4. No new ACL; additive DB; `yarn generate` after entities. ARCHITECTURE §11 (own UI by composition), §15 (tenancy/auth), §22 (DS/i18n), §26/§28 (generated/standalone), §27 (no contract break), §31 conventions satisfied.
- Verification gate: build:packages → generate → build:packages → i18n:check-sync → typecheck → test → build:app; module jest; Playwright integration tests; live: KSeF TEST (receive self-addressed round-trip, batch round-trip, cert auth), MF JPK test gateway (submit → UPO), NBP API (rate fetch). Non-test-verifiable items explicitly flagged.

## Integration Test Coverage
Module-local `__integration__/TC-*.spec.ts` (API-level, `request` fixture) + unit tests + env-gated live tests. Tests **exercise** behavior, not just render.
- `__integration__/TC-KSEF-RECV-001.spec.ts` (NEW) — received-invoices routes: 401 unauth; list paged/tenant-scoped; `sync` validates the date window; `to-purchase-record` materializes a `PurchaseVatRecord` with the right supplier/amounts/`nrKsef`/`receiptDate`; XML route returns FA(3) or 404.
- `__integration__/TC-KSEF-JPK-002.spec.ts` (NEW) — JPK submit route: 401 unauth; `financial_pl.submit` gate; rejects submitting a non-`generated` filing; idempotent on an already-`submitted` filing; structured error on a gateway failure.
- `__integration__/TC-KSEF-BATCH-001.spec.ts` (NEW) — batch route: 401 unauth; `financial_pl.submit` gate; self-billed invoice rejected (`assertNotSelfBilled`) before packaging; creates `KsefSubmission` rows sharing a `batchReference`.
- Unit (jest): `lib/received-invoice.ts` (InvoiceMetadata→entity + FA(3)→PurchaseVatRecord mappers, `acquisitionDate`→receiptDate); `lib/jpk/jpk-submission-metadata.ts` (metadata XML + MD5/Base64 + the dane-autoryzujące builder) + `jpk-submission-client.ts` crypto (AES/RSA shapes, status→UPO extraction, error mapping) with mocked fetch; `lib/batch-package.ts` (ZIP/split/encrypt/manifest hashes); `lib/nbp-fx.ts` (rate parse + business-day fallback + fail-open); `lib/credential-health.ts` (token sunset + cert `notAfter`); `lib/invoice-pdf.ts` pagination (multi-page line count) + byte-stable single-page regression + KOD II render-when-offline; `lib/ksef-qr-cert.ts` (already covered) reused for KOD II canonical string.
- Live (env-gated, `lib/__tests__/ksef-live.test.ts` + a new `jpk-live`): KSeF TEST receive (self-addressed invoice → query `Subject2` → download → materialize); batch round-trip (open→upload→close→per-invoice KSeF numbers + UPO); MF JPK test gateway submit (`test-e-dokumenty.mf.gov.pl`, self-signed XAdES, MF test archive → ReferenceNumber → Status → test UPO); NBP rate fetch. The non-verifiable bits (dane autoryzujące, prod qualified signature, MF announcement feed) are asserted at the unit level + documented.

## Changelog
- **2026-06-30 (spec-stage 4-model jury — reconciled before coding):** Ran all four reviewers on the spec artifact. **Claude readiness `changes_needed`(4)** (+ extensive code-verified confirmations) · **Codex `fail`(6)** · **DeepSeek `fail`(2)** · **Kimi `fail`(4)**. Every confirmed finding folded into the design above (loop to Phase 2 per the harness):
  - **F2 JPK package/crypto** (Codex): ZIP/DEFLATE → split parts → AES-256-CBC per part; `Document.HashValue`=SHA-256, per-part=MD5; **RSA key-wrap = PKCS#1 v1.5** (MF metadata literal `algorithm=RSA mode=ECB padding=PKCS#1` — Kimi confirmed this is the literal attribute set, reconciling the "ECB invalid" flag; not OAEP). New PKCS#1-v1.5 wrap in crypto.ts.
  - **F2 JPK signer = a SEPARATE qualified/Trusted-Profile/AuthData credential** (Codex + DeepSeek + Kimi — 3 voters): a KSeF Authentication cert is NOT a qualified JPK signer; added a dedicated JPK-signer config field; self-signed only on TEST.
  - **F2 idempotency/crash-safety** (Codex): CAS `generated→submitting` lock + early-persist `submissionReference` + resume; not just refuse-resubmit.
  - **F2 PUT transport + XAdES** (Claude): new PUT-to-absolute-URL helper (ksef-client transport is GET|POST|DELETE/baseUrl-relative); new `signJpkInitUpload` (two references) alongside the untouched `signAuthTokenRequest`.
  - **F1 materialize idempotent + transactional + EXPLICIT-only** (DeepSeek + Codex + Kimi — 3 voters): unique link + transaction; removed the undefined "auto when imp/markings" path; `PurchaseVatRecord` clarified as the module's OWN entity (Kimi's cross-module blocker refuted).
  - **F1 `isTruncated` windowing** (Codex): narrow `dateRange` on the 10k cap. **No-clobber on re-fetch** (Kimi): first-write-wins legal fields; per-`contextNip` cursor isolation; export path deferred behind a flag. **Received corrections** (DeepSeek): store + link KOR via `hashOfCorrectedInvoice` + corrective record.
  - **F3 offline terminology** (Claude + Codex): `awaria`==existing `awaryjny`; `niedostępność` is NEW (widen unions, no DB migration — `mode` is free text); total-`awaria` is a distinct `issuedOutsideKsef`/`BFK` no-send/no-QR state. **KOD II is route-only** (the PDF renderer already accepts the QR); use `buildKodIIUrl`.
  - **F4 `auto`** (Claude): a NEW explicit opt-in value (never default/inferred — preserves the SPEC-007 never-infer guard).
  - **F5 NBP date** (Codex): prior-business-day table date, never same-day.
  - Doc fixes: `encryption.ts` is at module root; reuse `resolveOrganizationScopeForRequest`; mirror the 23505 race pattern.
  - **Spec-stage cross-model: confirmed (claude + codex + deepseek + kimi)** — all four ran; the high-convergence blockers (qualified signer ×3, materialize idempotency ×3) drove the biggest design corrections; one Kimi blocker (PurchaseVatRecord cross-module) refuted against the code.
- **2026-06-30:** Created. Closes the remaining mandatory + hardening KSeF/JPK gaps (receiving, JPK e-submission, full offline + KOD II PDF, cert cutover, NBP FX, batch, PDF pagination) in one branch per user direction. Grounded by three official-source research passes (KSeF receive/batch/offline/KOD II per CIRFMF/ksef-docs; JPK submission per MF JPK spec v5.20 — all confirmed live-verifiable on test environments) + internal recon. Each feature independently shippable + tested; non-test-verifiable items (JPK dane autoryzujące, prod qualified signature, MF announcement feed) documented as bounded limitations.
