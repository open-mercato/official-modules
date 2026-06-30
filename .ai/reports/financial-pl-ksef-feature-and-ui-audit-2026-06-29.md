# financial_pl — KSeF & Invoicing: feature inventory, UI-path audit & live verification

- **Date:** 2026-06-29
- **Branch:** `feat/financial-pl-ksef`
- **Module:** `@open-mercato/financial-pl` (`financial_pl`)
- **Method:** 12-agent audit workflow (6 code-inventory + UI-path matrix + 5 regulatory cross-checks against the official KSeF 2.0 / JPK_VAT sources) + a live round-trip against the real KSeF **TEST** API (`api-test.ksef.mf.gov.pl`) using the supplied test token (NIP 2481632647). **No code changes were made in this session.**

> **CORRECTION (added after review):** TL;DR #2/#3 below originally said the UI "renders nowhere." That was an overstatement. Accurate picture: `financial_pl` was an **enterprise** module on the core branch `feat/financial-accounting-oss`, and that same branch added the `sales.invoices`/`sales.sales_invoice` host page — so the KSeF widgets **render there** (the dev app `apps/mercato` on DB `open-mercato-fin`, which shows the 2 real Polish VAT invoices, confirmed live this session). This `official-modules` branch **extracts** the module into a standalone MIT package; the `apps/sandbox` runs **published** core (0.6.3-develop.3778 / 0.6.5 / 0.6.6-develop), none of which ship that host (they use the unified `sales/documents` page). So the real finding is: **the widgets work where the invoices host + module are both present; the standalone module is not yet usable on a *published* core.** Also: **certificate (XAdES) auth is now live-verified** (see below). Read #2/#3 with this qualifier.

## TL;DR (headline findings)

1. **The engine is real and works live.** Auth → send → status(200) → KSeF number → UPO round-trips end-to-end against the KSeF TEST environment for **VAT, KOR (correction), ZAL (advance), UPR (simplified), and OSS (WSTO_EE)**. Self-billed is correctly **rejected (410)** by KSeF — validating the guard. ~100 capabilities, 82 complete / 15 partial / 3 not-built (by code).
2. **There is effectively NO working operator UI in the running app.** The module ships **zero backend pages of its own** and **zero CLI commands**. Its 4 UI widgets inject into `sales.invoices` (DataTable) and `sales.sales_invoice` (CrudForm) host spots that **do not exist in the installed `@open-mercato/core@0.6.5`** — that host is introduced only by the **unmerged** core branch `feat/financial-accounting-oss`. Installed core renders invoices via the unified `sales/documents` page (spots `sales.document.detail.invoice:tabs|details`). **Net: the KSeF status badge, "Send to KSeF" button, "Download PDF" button, and PL-VAT meta fields render nowhere today.** The only operator-reachable surface is the credential config page `/backend/integrations/ksef_pl`.
3. **Every KSeF capability is API-only in practice.** Send / retry / credit-memo / issue-offline / UPO download / invoice PDF / invoice-meta+markings edit / certificate enroll-list-revoke / JPK export-filings-purchase-records are all reachable **only by hitting the HTTP route directly** (or via the in-process command bus). SPEC-012's promised "minimal JPK backoffice page" was **not built**.
4. **Two regulatory obligations already in force (2026-02-01) are missing:** (a) **inbound invoice RECEIVING** (the connector is send-only) and (b) **direct JPK_V7 e-submission to MF** (it only generates+downloads the XML). Both are mandatory; both are the biggest completeness gaps.
5. **The preview environment is not currently runnable for the full branch.** The app DB (`open-mercato`) has **no** financial_pl tables; the DBs that do (`open-mercato-fin`, `om_fpl_preview`) are on **stale schemas missing the JPK tables**. A fresh migrate + seed + credential config is required before any UI/preview test.

---

## Table A — Feature inventory (what's been built on this branch)

Status: ✅ complete · 🟡 partial / caveated · ⛔ not-built (promised but absent). "Live" = exercised against the KSeF TEST API this session.

| # | Capability | Status | Live | Key evidence | Notes |
|---|------------|:------:|:----:|--------------|-------|
| **KSeF send + auth + reliability** |
| 1 | Online send flow (auth→encrypt→session→send→poll→UPO) | ✅ | ✅ | `lib/submission-flow.ts:79`, `lib/ksef-client.ts:401` | `accepted` only once UPO is in hand |
| 2 | Token auth (RSA-OAEP challenge) | ✅ | ✅ | `lib/ksef-auth.ts:70`, `lib/crypto.ts:104` | default method; tokens sunset 2026-12-31 |
| 3 | Certificate auth (XAdES challenge-signing) | ✅ | ⬜ | `lib/ksef-auth.ts:85`, `lib/xades.ts`, `lib/auth-token-request.ts` | opt-in (`authMethod='certificate'`); **not tested live** (no cert provided) |
| 4 | Auth poll + terminal fast-fail (401/403/410) | ✅ | ✅ | `lib/ksef-auth.ts:99` | |
| 5 | 429 / Retry-After bounded pacing | ✅ | – | `lib/ksef-client.ts:49,289`, `ksef-auth.ts:49` | clamp ≤60s, env-tunable |
| 6 | Per-request timeout (abort hung conn) | ✅ | – | `lib/ksef-client.ts:157` | 30s default |
| 7 | No-resend re-poll recovery | ✅ | – | `lib/submission-flow.ts:237`, `subscribers/ksef-repoll.ts` | read-only heal for in-flight rows |
| 8 | Idempotency (resolve-guard + partial-unique + CAS claim) | ✅ | – | `commands/ksef-submission.ts`, `subscribers/ksef-submit.ts` | |
| 9 | KSeF 440-duplicate recovery | ✅ | – | `lib/recovery.ts:14` | recovers original number + UPO |
| 10 | Reconciliation sweep worker (re-drive stuck rows) | ✅ | – | `workers/ksef-reconcile.worker.ts` | 15-min interval (needs `scheduler`) |
| 11 | KSeF number shape validation | 🟡 | – | `lib/ksef-number.ts:6` | MF checksum unpublished → shape-only |
| 12 | Access-token refresh reuse | ⛔ | – | `lib/ksef-client.ts` refreshToken dead | re-auths each call (works, not a spec gap) |
| **FA(3) document + doc types** |
| 13 | FA(3) serializer (structural subset) | 🟡 | ✅ | `lib/fa3.ts:11` | required subset; must stay XSD-validated |
| 14 | VAT invoice | ✅ | ✅ | `lib/resolve-fa3-from-invoice.ts` | `…9588FF400000-EA` accepted |
| 15 | KOR correction (from credit memo) | ✅ | ✅ | `lib/resolve-fa3-from-credit-memo.ts`, `api/.../from-credit-memo` | `…958AC0C00000-68` accepted (real original ref) |
| 16 | ZAL advance | ✅ | ✅ | `lib/resolve-fa3-advance.ts` | `…958CFF400000-32` accepted |
| 17 | ROZ settlement | ✅ | – | `lib/resolve-fa3-settlement.ts` | |
| 18 | UPR simplified | ✅ | ✅ | `lib/fa3.ts` UPR path | `…958EE3400000-8B` accepted |
| 19 | OSS / WSTO_EE distance sale | 🟡 | ✅ | `lib/resolve-fa3-from-invoice.ts:113` | `…9592FF400000-B1` accepted; dest-rate taken verbatim (review L6) |
| 20 | Self-billing (P_17) submit-guard | 🟡 | ✅ | `commands/ksef-submission.ts:98` | KSeF rejects 410 → blocked by design (confirmed live) |
| 21 | Advance/settlement corrections (KOR_ZAL/ROZ) | 🟡 | – | `resolve-fa3-from-credit-memo.ts:256` | exact P_15ZK pending live confirmation |
| 22 | Buyer polymorphic identity + JST/GV flags | 🟡 | – | `lib/fa3.ts:349` | JST/GV hard-coded '2' (no Podmiot3) |
| **Corrections / JPK markings (per-invoice signals)** |
| 23 | GTU codes, procedure markings, TypDokumentu | ✅ | – | `lib/jpk-vat-marking.ts`, `lib/jpk-markings-codes.ts`, `api/.../jpk-markings` | signals captured for JPK |
| 24 | NrKSeF / OFF / BFK / DI marking derivation | ✅ | – | `lib/jpk-vat-marking.ts` | |
| **Certificates** |
| 25 | Certificate enrollment (async issuance) | ✅ | ⬜ | `commands/ksef-certificate.ts:129`, `lib/cert-enrollment.ts`, `api/.../certificates/enroll` | **bootstrap chicken-and-egg**: enroll needs an existing cert |
| 26 | Certificate list / revoke | ✅ | ⬜ | `commands/ksef-certificate.ts:184,200`, `api/.../certificates/{,revoke}` | |
| 27 | Two cert types (Authentication + Offline) | ✅ | ⬜ | `commands/ksef-certificate.ts:158` | stored in separate credential fields |
| **Offline mode** |
| 28 | offline24 / awaryjny issuance + KOD II store | 🟡 | – | `commands/ksef-submission.ts` issueOffline, `api/.../issue-offline` | **issuance not wired e2e; no UI** |
| 29 | Offline deadline calculator (offline24/niedostępność/awaria) | ✅ | – | `lib/offline-deadline.ts` | enum + calc exist |
| 30 | niedostępność / total awaria issuance | ⛔ | – | (calc only) | issuance path not wired |
| 31 | recompute_offline_deadline | 🟡 | – | `commands/ksef-submission.ts:669` | **no route, no UI, no CLI — command-bus only** |
| 32 | Deferred offline send subscriber | ✅ | – | `subscribers/ksef-send-offline.ts` | |
| **Invoice PDF + QR** |
| 33 | Single-page invoice PDF (byte-stable) | 🟡 | – | `lib/invoice-pdf.ts`, `lib/invoice-pdf-model.ts`, `api/.../invoice-pdf` | overflows >~45 lines (no pagination) |
| 34 | Online KSeF QR (KOD I) | ✅ | – | `lib/ksef-qr.ts`, `lib/invoice-qr.ts` | |
| 35 | KOD II cert-signed offline QR | 🟡 | – | `lib/ksef-qr-cert.ts` | implemented+tested but **dead in the PDF route** (route never builds qrIiPng) |
| 36 | Localized OFFLINE QR label | 🟡 | – | `api/.../invoice-pdf/route.ts:229` | route never passes the i18n label |
| **JPK_V7 VAT export** |
| 37 | JPK_V7M(3)/V7K(3) XML build (Naglowek+Podmiot1+Deklaracja+Ewidencja) | ✅ | – | `lib/jpk/build-jpk-xml.ts`, `compute-declaration.ts` | XSD-validated via xmllint gate |
| 38 | Sales ledger (SprzedazWiersz) builder | ✅ | – | `lib/jpk/build-sprzedaz.ts` | rate→K bucketing, markers, FP |
| 39 | Purchase ledger (ZakupWiersz) + self-assessment dual rows | ✅ | – | `lib/jpk/build-zakup.ts` | K_40..K_47, WNT/import/RC |
| 40 | Declaration math (P_* whole-PLN, settlement chain) | ✅ | – | `lib/jpk/compute-declaration.ts` | |
| 41 | Filing + purchase-record entities/commands | ✅ | – | `commands/jpk.ts`, `data/entities.ts` | upsert/delete/generate |
| 42 | JPK export route (generate POST + stream GET) | ✅ | – | `api/.../jpk/export/route.ts` | |
| 43 | V7K quarterly aggregation | 🟡 | – | `lib/jpk/resolve-jpk-filing.ts` | review H3 / SPEC-012 follow-up (month-3 must aggregate quarter) |
| 44 | Multi-NIP filing identity (context_nip in index) | 🟡 | – | migration `…_jpk`, review H4 | index now coalesces context_nip |
| 45 | Direct JPK e-submission to MF | ⛔ | – | — | **not built — generate+download only (mandatory gap)** |
| 46 | JPK backoffice page (SPEC-012 promised) | ⛔ | – | — | **not built** |
| **Config / data / UI plumbing** |
| 47 | Per-org `ksef_pl` integration provider + credential fields | ✅ | – | `integration.ts`, core integrations page | the one working UI |
| 48 | Encrypted credentials (token, cert PEM/key, serials) | ✅ | – | `encryption.ts`, `lib/credentials.ts` | |
| 49 | ACL features (view/submit/manage) + setup role mapping | ✅ | – | `acl.ts`, `setup.ts` | |
| 50 | i18n (en/pl/de/es) | 🟡 | – | `i18n/*` | review M9: `status.offline_overdue` missing |
| 51 | KSeF status column widget | 🟡 | – | `widgets/injection/ksef-status-column` | **dead-wired (see Table B)** |
| 52 | "Send to KSeF" / Retry row-action widget | 🟡 | – | `widgets/injection/ksef-send-action` | **dead-wired** |
| 53 | "Download invoice PDF" row-action widget | 🟡 | – | `widgets/injection/ksef-invoice-pdf` | **dead-wired** |
| 54 | PL-VAT meta-fields form widget | 🟡 | – | `widgets/injection/pl-vat-meta-fields` | **dead-wired**; also renders only a subset of meta |

---

## Table B — UI-path matrix (can an operator actually execute it?)

🟢 works in running app · 🔴 widget authored but host spot absent in installed core (renders nowhere) · 🟠 API-only (route exists, no button, no CLI) · ⚫ no operator trigger at all.

| Capability | HTTP route (works) | Intended UI | Reachable in running app today | Class |
|------------|--------------------|-------------|-------------------------------|:-----:|
| Configure KSeF credential (NIP, token, env, seller, cert PEM/serials, authMethod) | `/api/integrations/ksef_pl/credentials` | `/backend/integrations/ksef_pl` | **Yes** — generic integrations detail page | 🟢 |
| See KSeF status / numer KSeF / download UPO | `GET /api/financial_pl/ksef/submissions/upo` | `ksef-status-column` on `sales.invoices` table | **No** — host table absent | 🔴 |
| Send invoice to KSeF | `POST /api/financial_pl/ksef/submissions/from-invoice` | `ksef-send-action` row-action | **No** — host table absent | 🔴 |
| Download invoice PDF | `GET /api/financial_pl/ksef/invoice-pdf` | `ksef-invoice-pdf` row-action | **No** — host table absent | 🔴 |
| Edit PL-VAT metadata + JPK markings | `PUT /api/financial_pl/ksef/invoice-meta`, `…/jpk-markings` | `pl-vat-meta-fields` on `sales.sales_invoice` form | **No** — host form absent | 🔴 |
| Send credit-memo (KOR) to KSeF | `POST /api/financial_pl/ksef/submissions/from-credit-memo` | none | API-only | 🟠 |
| Retry a submission | `POST /api/financial_pl/ksef/submissions/retry` | none | API-only | 🟠 |
| List submissions | `GET /api/financial_pl/ksef/submissions` | none | API-only | 🟠 |
| Issue invoice offline (offline24/awaryjny, KOD II) | `POST /api/financial_pl/ksef/submissions/issue-offline` | none | API-only | 🟠 |
| Enroll / list / revoke certificate | `POST …/certificates/enroll`, `GET …/certificates`, `POST …/certificates/revoke` | none | API-only | 🟠 |
| JPK: generate/export | `POST/GET /api/financial_pl/ksef/jpk/export` | SPEC-012 page (not built) | API-only | 🟠 |
| JPK: filings list/upsert | `GET/POST /api/financial_pl/ksef/jpk/filings` | none | API-only | 🟠 |
| JPK: purchase-records CRUD | `GET/POST/DELETE /api/financial_pl/ksef/jpk/purchase-records` | none | API-only | 🟠 |
| Recompute offline deadline | none | none | command-bus only | ⚫ |

**Root cause of the 🔴 rows:** the module's `widgets/injection-table.ts` targets `data-table:sales.invoices:columns`, `data-table:sales.invoices:row-actions`, and `crud-form:sales.sales_invoice:fields`. Those host spots are produced by `packages/core/src/modules/sales/backend/sales/invoices/page.tsx` (`extensionTableId="sales.invoices"`, `entityId=E.sales.sales_invoice`) which exists **only on the unmerged core branch `feat/financial-accounting-oss`**. The installed `@open-mercato/core@0.6.5` has **no** invoices list/form — invoices live under the unified `sales/documents` page, whose injection spots are `sales.document.detail.invoice:tabs` and `sales.document.detail.invoice:details` (and there is **no** invoice DataTable for column/row-action injection).

**Fix options:** (1) publish/merge the core `feat/financial-accounting-oss` invoices UI and bump the sandbox's `@open-mercato/core` to it (intended path — the module was co-developed with it); or (2) re-target the widgets to the documents-page spots that exist on released core (and find a list home for the row-actions/columns). Until then, financial_pl is **not independently usable on released core**.

---

## Live KSeF TEST evidence (this session)

Run: `OM_KSEF_TEST_NIP=2481632647 OM_KSEF_TEST_TOKEN=<supplied> yarn workspace @open-mercato/financial-pl test ksef-live` (+ `OM_KSEF_TEST_CORRECTED_KSEF_NUMBER` set to the real accepted VAT number for a true correction round-trip). Result: **7 passed, 1 skipped** (cert-auth).

| Document type | Result | KSeF number |
|---|---|---|
| VAT (standard) | accepted (200, UPO 5466 B) | `2481632647-20260629-957B63400000-05` / `…9588FF400000-EA` |
| KOR correction (refs real accepted original) | accepted | `2481632647-20260629-958AC0C00000-68` |
| ZAL advance | accepted | `2481632647-20260629-958CFF400000-32` |
| UPR simplified | accepted | `2481632647-20260629-958EE3400000-8B` |
| Self-billed VAT | **rejected 410** (expected) | *„Faktura wystawiania we własnym imieniu nie może posiadać adnotacji 'samofakturowanie'"* |
| OSS EUR (WSTO_EE) | accepted | `2481632647-20260629-9592FF400000-B1` |
| **Certificate (XAdES) auth** — submit via self-signed cert | **accepted (strict)** | `2481632647-20260629-99A9C0C00000-69` |

---

## Certificate-auth testing on the KSeF TEST environment (the specific question)

- **Code is ready:** the `ksef-live.test.ts` `certDescribe` block runs the XAdES cert-auth path when `OM_KSEF_TEST_NIP` + `OM_KSEF_TEST_CERT_PEM` + `OM_KSEF_TEST_CERT_KEY` are set.
- **Bootstrap reality (chicken-and-egg):** `financial_pl.ksef_certificate.enroll` itself **requires an existing cert credential** to authenticate (`commands/ksef-certificate.ts:98` → 409 `certificate_auth_required_for_enrollment`). The *first* certificate cannot be self-issued through this connector.
- **How to get a TEST cert (per MF docs):** the KSeF **TEST** environment accepts fictional NIPs and self-signed certs and offers self-onboarding via `POST /v2/testdata/person` (noted in the test header). Per the official integrator pages, real certificates come from the **MCU (Moduł Certyfikatów i Uprawnień)** / Aplikacja Podatnika, authenticated by Profil Zaufany, qualified e-signature, or qualified e-seal (certs issuable since 2025-11-01, max 2-year validity). The cert **subject must encode the context NIP** (`SubjectIdentifierType=certificateSubject`).
- **VERIFIED LIVE this session ✅:** generated a self-signed cert with subject `organizationIdentifier=VATPL-2481632647` + `serialNumber=TINPL-2481632647` (the EU/ETSI identifiers KSeF's `certificateSubject` matcher expects), set `OM_KSEF_TEST_CERT_PEM/_KEY` + `OM_KSEF_TEST_NIP`, and ran the `certDescribe` block. Result under `OM_KSEF_TEST_STRICT=1`: **accepted**, KSeF number `2481632647-20260629-99A9C0C00000-69`, HTTP 200, UPO 5486 bytes. **No `/testdata` onboarding was needed** — the TEST env accepted the self-signed cert whose subject encodes the NIP. So the recipe to test cert auth on TEST is: `openssl req -x509` with an openssl config defining `organizationIdentifier (2.5.4.97)=VATPL-<NIP>` and `serialNumber=TINPL-<NIP>` in the subject → pass cert+key via the `OM_KSEF_TEST_CERT_*` env vars → run `ksef-live`.

---

## What's missing for KSeF + Invoicing feature/legal completeness

Mandatory and dated (from the official KSeF 2.0 handbook part II, biznes.gov.pl 00239/00241, and the JPK_VAT brochure):

| Gap | Mandatory from | Severity | State |
|-----|---------------|:--------:|-------|
| **Inbound invoice RECEIVING** (query/download FA addressed to the taxpayer; receipt date = KSeF-number assignment) | 2026-02-01 | 🔴 critical | **missing** — connector is send-only; `PurchaseVatRecord` is manual upsert, not a KSeF pull |
| **Direct JPK_V7 e-submission to MF** (the obligation is the filing, not file generation) | 2026-02-01 | 🔴 critical | **missing** — generate+download only; `status='submitted'` is never set by an MF call |
| Certificate auth as production default + token→cert cutover | 2027-01-01 | 🟠 high | partial — cert path works but token is default; no auto-migration |
| Offline24 / niedostępność / awaria full issuance + next-business-day/7-day auto-send | 2026-02-01 | 🟠 high | partial — deadline calc exists; issuance not wired |
| KOD II QR rendered on offline-issued PDFs | 2026-02-01 | 🟠 high | partial — built but dead in the PDF route |
| Purchase-side NrKSeF/markings populated from received invoices | 2026-02-01 | 🟠 high | partial — depends on the missing inbound flow |
| NBP FX-rate auto-sourcing for foreign-currency invoices | (statutory) | 🟡 medium | missing — rates manual |
| DI→NrKSeF reconciliation in JPK after offline invoice gets its number | 2026-02-01 | 🟡 medium | partial — no auto reconciliation |
| Batch (wsadowa) session sending (≤10k/session) | 2026-02-01 | 🟡 medium | partial — only interactive online session |
| Self-billing true flow (issuer ≠ seller) | 2026-02-01 | 🟡 medium | blocked by guard (deliberate scope cut) |
| UPR buyer-NIP enforcement guard | 2026-02-01 | 🟠 high | partial — UPR supported, NIP not enforced |
| Certificate validity/expiry monitoring (2-yr cap) | 2025-11-01 | 🟡 medium | missing |
| MPP split-payment message carries NrKSeF | 2027-01-01 | 🟢 low | missing (future-dated) |
| PDF multi-page pagination | n/a | 🟢 low | known limit (~45 lines) |

The team's own SPEC-011 audit already flags inbound-receive and JPK e-submission as the two biggest gaps — the external sources confirm both are **hard, already-in-force obligations**, not enhancements.

---

## Preview / environment status (why full UI preview couldn't run as-is)

- App DB (`open-mercato`, from `apps/sandbox/.env`): **0** financial_pl tables.
- `open-mercato-fin`: has the `ksef_pl` credential configured (encrypted) but an **old** `ksef_submissions` schema (no `document_kind`/offline/JPK columns).
- `om_fpl_preview`: newer submissions schema **but no JPK tables** and **0** credential rows.
- → No DB currently reflects the full branch (all are missing the parts 6–7 JPK tables). To preview the UI you must: point `DATABASE_URL` at a fresh DB → `yarn generate` + run migrations → configure `ksef_pl` credential at `/backend/integrations/ksef_pl` → seed a sales invoice. **AND** resolve the host-spot mismatch (Table B root cause), or the widgets still won't render.

## Decision (2026-06-29): make it work on RELEASED core (no unmerged-branch dependency)

Per product direction, the module must work as a standalone official module on **published** `@open-mercato/core` — it must NOT depend on the unmerged `feat/financial-accounting-oss` invoices UI. Verified facts about released core (`0.6.3-develop.3778`, the sandbox lock):
- Sales backend pages = `channels` (list+detail), `documents` (`[id]` detail + `create`), `orders` (list+detail), `quotes` (list+detail). **No `invoices` page and no `documents` *list* page.**
- The document **detail** page (`/backend/sales/documents/[id]`) is the only invoice UI surface, and it exposes injection spots **`sales.document.detail.<kind>:details`** (`InjectionSpot`, page.tsx:1923/4792) and **`sales.document.detail.<kind>:tabs`** (`useInjectionWidgets`, page.tsx:3919) — where `<kind>` is the document kind (verify the invoice token, likely `invoice`).
- There is **no DataTable** with id `sales.invoices` and **no CrudForm** for `sales.sales_invoice` → the current 4 widgets have no host and render nothing.

**Required rework (implementation, next session — no code changed here):**
1. Re-target `pl-vat-meta-fields` + `ksef-status` + `ksef-send` + `ksef-pdf` from `data-table:sales.invoices:*` / `crud-form:sales.sales_invoice:fields` to `sales.document.detail.invoice:details` and/or `:tabs` — i.e. a **"KSeF" section/tab on the document detail page** carrying the status badge, Send-to-KSeF, Download-PDF, UPO-download, and PL-VAT meta fields (since there's no list table for a column/row-action).
2. Confirm the exact invoice `kind` token and the `record`/context shape the detail InjectionSpot passes (it provides `data={record}` + `onDataChange`), and adapt the widgets to read the invoice id from that context instead of a table row.
3. Update `widgets/injection-table.ts` + the README (which still documents the `sales.invoices`/`sales.sales_invoice` host as the assumption to fix).
4. Keep the credential config page `/backend/integrations/ksef_pl` (already works on released core).
5. Decide where JPK/cert/offline operator actions live (no host today) — likely a small backoffice page owned by `financial_pl` (which it currently lacks).

## Recommended next steps (priority order)

1. **Re-target the UI to released-core hosts** (above) so the module works standalone. Nothing KSeF-related is operator-usable on released core until this is done.
2. **Build the inbound RECEIVING flow** (mandatory, in force) — KSeF invoice query/download → purchase ledger auto-population + receipt-date capture.
3. **Wire JPK_V7 e-submission to MF** (mandatory) and add the JPK backoffice page SPEC-012 promised.
4. **Verify certificate auth live** on TEST (recipe above) and plan the token→certificate cutover before 2027-01-01.
5. **Wire offline issuance end-to-end** (offline24/niedostępność/awaria + KOD II on PDF + auto-send scheduling).
6. Tidy the smaller carries: i18n `offline_overdue`, V7K quarter aggregation, NBP FX, UPR NIP guard, PDF pagination.
