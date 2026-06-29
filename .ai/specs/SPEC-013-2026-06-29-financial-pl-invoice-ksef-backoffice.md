# SPEC-013 — `financial_pl`: full invoice + KSeF operator backoffice (standalone on released core)

- **Date:** 2026-06-29
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md) … [SPEC-012](./SPEC-012-2026-06-29-financial-pl-jpk-vat-export.md)
- **Status:** Draft → for implementation.

## TLDR
**Key Points:**
- The `financial_pl` KSeF backend (send/status/UPO, FA(3) doc types, corrections, offline, PDF, JPK, certificates) is complete and **live-verified** against the KSeF TEST API, but it has **no working operator UI on released `@open-mercato/core`**: the module's widgets inject into `data-table:sales.invoices:*` and `crud-form:sales.sales_invoice:fields`, host spots that exist only on an **unmerged** core branch. Released core ships **no invoice UI at all** (no list, no detail; the `documents/[id]` page is order/quote-only; `SalesInvoice` is data+API only).
- This spec gives the module a **self-contained Polish invoicing + KSeF backoffice** (own backend pages, direct composition — not UMES injection into a non-existent host), to a wFirma / inFakt / Saldeo standard, that **works on released core today**.
- **Single source of truth = core `SalesInvoice`/`SalesInvoiceLine`** (authored/edited through core's public `/api/sales/invoices` CRUD, read via the QueryEngine). The module adds the Polish VAT layer (`SalesInvoicePlMeta`) and the KSeF lifecycle (existing `KsefSubmission` + routes) on top. **No new invoice entity, no backend-flow changes** — the existing `resolve-fa3-from-invoice` keeps working unchanged.

**Scope:**
- Module-owned backend pages: **Invoices** (list / create / detail / edit), an **Invoice KSeF panel** (status, Send, Retry, Download UPO, Download PDF, Issue offline, Issue correction), the **PL-VAT metadata editor** (full field set), **JPK** (filings + generate/export + purchase records), **Certificates** (enroll/list/revoke), and sidebar nav.
- A self-contained read endpoint that joins invoices + their KSeF status for the list (no dependency on core opting into the enricher).
- Retire the dead `sales.invoices` / `sales.sales_invoice` widget-injection wiring; keep the response enricher (still valid).

**Concerns:**
- Editing an invoice already accepted by KSeF must be blocked (KSeF immutability → corrections only).
- The operator needs both core `sales.invoices.manage` and `financial_pl.*` features (ACL composition).
- Correction (KOR) authoring depends on a core credit-memo write path (verified at implementation; degrade to "send existing credit memo" if absent).

## Overview
`financial_pl` is a send-complete KSeF 2.0 connector. The 2026-02-01 Polish mandate requires businesses to **issue** structured invoices via KSeF; an operator therefore needs to author an invoice, attach Polish VAT metadata (GTU, procedure markings, MPP, invoice kind, OSS, FX), send it to KSeF, watch its status, download the UPO and the PDF visualisation, issue corrections, and file JPK_V7. Released core has no invoice screen, so this module must provide the entire operator surface itself.

> **Market reference:** wFirma, inFakt, Saldeo (PL e-invoicing leaders). Adopted: an invoices list with a prominent KSeF status, an invoice editor with VAT-rate lines + Polish-specific annotations, one-click "Send to KSeF" with the UPO/PDF afterwards, and a JPK area. Rejected: full double-entry accounting / bank reconciliation / OCR import (out of scope; this is an e-invoicing connector, not an accounting suite).

## Problem Statement
1. **No UI surface on released core.** The KSeF capabilities are reachable only by calling HTTP routes directly; the four injection widgets render nowhere because their host spots (`sales.invoices` DataTable, `sales.sales_invoice` CrudForm) do not exist in released `@open-mercato/core` (they were added by the unmerged `feat/financial-accounting-oss` branch). Verified: released `sales` backend = `channels`, `documents` (order/quote), `orders`, `quotes` — no invoices page, no documents list.
2. **Capabilities with no operator trigger at all** (audit `.ai/reports/financial-pl-ksef-feature-and-ui-audit-2026-06-29.md`): JPK filings/export/purchase-records, certificate enroll/revoke, offline issuance, correction-from-credit-memo, UPO download, invoice PDF, PL-VAT meta editing — all API-only. SPEC-012's promised "minimal JPK backoffice page" was never built. The module owns **zero** backend pages.
3. **Partial PL-VAT editor + a no-op retry** (review M8): the meta panel rendered only a subset of the supported metadata and passed a non-functional `retryLastMutation`.

## Proposed Solution
Provide a complete operator backoffice **owned by `financial_pl`** (direct composition in the module's own pages — the UMES boundary §11 says a module composes its **own** UI directly and only uses injection to extend **another** module). Invoice data lives in core `SalesInvoice`; the Polish VAT + KSeF layer lives in `financial_pl` (existing tables/routes). The UI is the missing glue.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Core `SalesInvoice` is the single source of truth (write via `/api/sales/invoices`, read via QueryEngine) | The KSeF backend already reads `E.sales.sales_invoice`; a duplicate invoice entity would diverge and break `resolve-fa3-from-invoice`. Honors "backend flows unchanged". |
| Module-owned backend pages (direct composition), not UMES injection | Released core exposes no invoice host spot; §11 says compose your **own** UI directly. Works standalone today. |
| **Lines: write via core API, read via QueryEngine** | Verified: core's `sales.invoices.create/update` command persists `SalesInvoiceLine` rows from the payload's `lines[]` (`documents.ts:8502/8608`), so write works. But core's `GET /api/sales/invoices` is **header-only** (no lines), so the editor **prefills lines by reading `E.sales.sales_invoice_line` via the QueryEngine** (filter `invoice_id`) — exactly as `resolve-fa3-from-invoice.ts:168` already does. (Resolves spec-jury blocker: lines are both readable and writable on released core.) |
| **Remove** the dead `sales.invoices`/`sales.sales_invoice` injection-table entries; extract the widget logic into shared `components/`; **keep** the response enricher | The injection entries target host spots that don't exist on released core — dead wiring whose only payoff is a hypothetical future/enterprise host. Per the change-discipline rule (don't design for hypothetical future requirements) and the standalone-on-released-core requirement, they're removed; re-adding 4 lines is trivial if core ever ships the host. (Spec-jury decider call: Kimi blocked on "keep = over-engineering"; Codex/DeepSeek's "keep for compat" were advisory notes — Kimi + change-discipline + the user's explicit rejection of unmerged-branch coupling win.) The enricher (`E.sales.sales_invoice` → `_financial_pl`) stays (valid, harmless). The widget component logic moves to `components/` (used by the new pages); the now-unused `widgets/injection/*` wrappers + their `injection-table.ts` mappings are deleted. |
| A `financial_pl` read endpoint joins invoices + KSeF status for the list | Self-contained: does not require core's invoices route to opt into our enricher. |
| Lock invoice edit once a KSeF submission is `accepted` — **UI guard + server-side API interceptor** | KSeF/legal immutability. A disabled button alone is insufficient (API/stale-tab/other-client can still mutate) — so `financial_pl` also registers **fail-closed API interceptors** (§11.4) on core `sales.invoices` `PUT`/`DELETE` and on the module's own `invoice-meta` `PUT` that reject when an `accepted`/`processing` KSeF submission exists for the invoice. (Resolves spec-jury blocker: server-side enforcement, not just UI.) |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Inject into `sales.document.detail.invoice:*` | That spot doesn't exist on released core (documents page is order/quote-only); it's the unmerged-branch dependency the user explicitly rejected. |
| `financial_pl` owns its own invoice entity | Duplicates core data, diverges from the KSeF backend's `SalesInvoice` reads, violates single-source-of-truth. |
| Keep injection-only and wait for a core invoices page | Leaves the module unusable on released core (the user's hard requirement: works standalone now). |

## User Stories / Use Cases
- An **accountant** authors a VAT invoice with line items + GTU/procedure markings, so that it is KSeF-ready.
- An **accountant** clicks **Send to KSeF** and sees the status go `queued → processing → accepted` with the **numer KSeF** and a **Download UPO** / **Download PDF**.
- An **accountant** issues a **correction (KOR)** against an accepted invoice.
- An **accountant** generates and downloads a **JPK_V7M** filing for a period.
- An **admin** **enrolls/revokes** a KSeF certificate and switches auth to certificate.
- An **operator** issues an invoice **offline** (offline24) and later confirms it reached KSeF.

## Architecture
All new UI lives under `packages/financial-pl/src/modules/financial_pl/backend/`. Auto-discovery builds the routes + sidebar nav from `page.meta.ts`. Pages are client components using `@open-mercato/ui` primitives.

```
backend/financial/invoices/page.tsx            # list (DataTable) + KSeF status + filters + Create
backend/financial/invoices/page.meta.ts        # nav: group "Financials (PL)", feature financial_pl.view
backend/financial/invoices/create/page.tsx     # CrudForm: header + lines + PL-VAT meta
backend/financial/invoices/[id]/page.tsx       # detail: summary + KSeF panel + meta + markings + corrections
backend/financial/invoices/[id]/edit/page.tsx  # edit (locked when accepted)
backend/financial/jpk/page.tsx                 # JPK filings list + generate/export + purchase records
backend/financial/certificates/page.tsx        # cert enroll/list/revoke + auth method
components/                                     # reusable: KsefStatusBadge, KsefActions, PlVatMetaForm, InvoiceLinesField, CorrectionForm
api/interceptors.ts                            # NEW: fail-closed guards on core sales.invoices PUT/DELETE + own invoice-meta PUT (KSeF immutability)
```

Data flow:
- **Read/list:** new `GET /api/financial_pl/ksef/invoices` → QueryEngine read of `E.sales.sales_invoice` (org/tenant scoped) joined with latest `KsefSubmission` + `SalesInvoicePlMeta` (reuse the enricher's join logic). Returns invoice rows + `ksefStatus/ksefNumber/upoAvailable/...`.
- **Read one invoice (detail/edit prefill):** read the header via QueryEngine `E.sales.sales_invoice` and the **lines via QueryEngine `E.sales.sales_invoice_line`** (filter `invoice_id`) — core's GET is header-only — plus `SalesInvoicePlMeta` via `invoice-meta` GET.
- **Create/edit invoice:** the CrudForm POSTs/PUTs `/api/sales/invoices` (core; nested `lines[]` are persisted by the core command, auto-numbering) for the base invoice, then PUTs `/api/financial_pl/ksef/invoice-meta` for the PL-VAT layer (graph-style: invoice first, then meta keyed by `salesInvoiceId`). **After a successful create POST the editor switches to edit/PUT mode on the new invoice id** so a failed meta step is retried in place — never re-POSTing the invoice (avoids duplicate-create; Kimi note). **Update = replace semantics:** core's update `nativeDelete`s the invoice's lines then recreates them (`documents.ts:8608`), so the editor always submits the **full** `lines[]` array on PUT, never a partial.
- **KSeF actions:** existing routes — `submissions/from-invoice`, `/retry`, `/upo`, `/issue-offline`, `invoice-pdf`. **Retry** targets the invoice's latest non-`accepted` `KsefSubmission` (the panel resolves and shows which one).
- **Correction (KOR):** create a `SalesCreditMemo` via core `POST /api/sales/credit-memos` (verified: command `sales.credit_memos.create` persists memo + lines; carries the corrected `invoiceId` + `reason`), then send it via the existing `submissions/from-credit-memo` route. Requires `sales.credit_memos.manage`.
- **JPK / certs:** existing routes — `jpk/{filings,export,purchase-records}`, `certificates/{,enroll,revoke}`.

### Commands & Events
No new commands/events. The UI dispatches existing command-backed routes (invoice writes dispatch core `sales.invoices.create/update/delete`; corrections dispatch `sales.credit_memos.create`; KSeF actions dispatch the existing `financial_pl.ksef_submission.*` commands).

### API interceptors (NEW — KSeF immutability, §11.4)
API interceptors are the sanctioned UMES mechanism for one module to guard **another** module's route without editing it (§11.4 — fail-closed, timeout-safe, may reject). `api/interceptors.ts` registers fail-closed `before` interceptors (resolve via `context.em.fork()`, never importing core entities):
- on `sales.invoices` `PUT`/`DELETE` and on `financial_pl` `invoice-meta` `PUT` → reject (`{ ok: false, statusCode: 409 }`) when the target invoice has a KSeF submission in `accepted` (and `processing`) state. This makes the immutability rule enforced server-side regardless of UI, stale tabs, or other clients.
- **Effective-contract note (Kimi):** when `financial_pl` is installed, core `sales.invoices` `PUT`/`DELETE` gain this conditional 409 — documented in the README as part of the module's effective contract so a core consumer isn't surprised. (No core code changes; behavior is additive and only triggers for KSeF-accepted invoices.)

## Data Models
**No new entities, no migrations.** Reuse:
- Core `SalesInvoice` (`sales_invoices`) + `SalesInvoiceLine` (`sales_invoice_lines`) — written via core API, read via QueryEngine (`E.sales.sales_invoice`).
- Core `SalesCreditMemo` for KOR corrections.
- Existing `financial_pl` tables: `SalesInvoicePlMeta` (PL-VAT meta), `KsefSubmission`, `JpkVatFiling`, `PurchaseVatRecord`.

## API Contracts
### New: list invoices with KSeF status
- `GET /api/financial_pl/ksef/invoices?search=&status=&page=&pageSize=` — `requireFeatures: ['financial_pl.view', 'sales.invoices.manage']` (composed: it exposes core `SalesInvoice` business data that core itself gates behind `sales.invoices.manage`; gating on `financial_pl.view` alone would be a permission bypass — spec-jury blocker).
- Response: `{ items: Array<{ id, invoiceNumber, issueDate, dueDate, currencyCode, grandTotalNetAmount, grandTotalGrossAmount, status, ksefStatus, ksefNumber, upoAvailable, offlineSendDeadlineAt, invoiceKind }>, total, page, pageSize }`
- Org/tenant scoped; encrypted columns never projected into the response (decryption helpers for reads).

### Feature gating (composed)
- **Invoice list / detail / edit pages** require `['financial_pl.view', 'sales.invoices.manage']`.
- **Correction (KOR)** authoring requires `sales.credit_memos.manage` (the action is hidden/disabled without it).
- **KSeF action buttons** are gated in the UI (wildcard-aware `hasAllFeatures`, not `Array.includes`) AND by the server route: Send/Retry/Issue-offline → `financial_pl.submit`; JPK generate/export + Certificates enroll/revoke → `financial_pl.manage`; UPO/PDF/view → `financial_pl.view`. The UI never relies on a server 403 alone to hide an action.

### Reused (unchanged) — consumed by the new UI
- Core: `GET/POST/PUT/DELETE /api/sales/invoices` (`sales.invoices.manage`); `POST /api/sales/document-numbers`.
- `financial_pl`: `GET/PUT /api/financial_pl/ksef/invoice-meta`; `POST /api/financial_pl/ksef/submissions/{from-invoice,from-credit-memo,retry,issue-offline}`; `GET /api/financial_pl/ksef/submissions/upo`; `GET /api/financial_pl/ksef/invoice-pdf`; `GET/PUT /api/financial_pl/ksef/jpk-markings`; `GET/POST /api/financial_pl/ksef/jpk/{filings,export,purchase-records}`; `GET/POST /api/financial_pl/ksef/certificates`, `…/enroll`, `…/revoke`.

PL-VAT meta editor exposes the full `invoiceMetaPutSchema`: `contextNip, mppRequired, issuedOutsideKsef, vatExemptionBasis, invoiceKind (vat|zal|roz|upr|kor_zal|kor_roz), selfBilling, reverseCharge, ossProcedure, consumptionCountryCode, exchangeRate, exchangeRateDate, advancePayments[], advanceRefs[], orderSnapshot, gtuCodes[], procedureMarkings{12 flags}, typDokumentu, badDebtReliefPeriod, badDebtTerminPlatnosci`.

## Internationalization (i18n)
New keys for all four locales (en/pl/de/es), namespaced `financial_pl.*`: nav group + page titles; list columns; invoice form labels; line-item labels; the full PL-VAT meta field labels + help; KSeF action labels (send/retry/upo/pdf/offline/correction) + confirmations; JPK + certificate page labels; status labels (incl. the previously-missing `financial_pl.status.offline_overdue`, review M9). No hardcoded user-facing strings; internal messages prefixed `[internal]`.

## UI/UX
- **Invoices list:** `DataTable` (`pageSize ≤ 100`), columns Number / Issue date / Buyer / Net / Gross / Status / **KSeF status** (`StatusBadge` + a `KsefStatusMap`, never hardcoded colors); RowActions `open`/`edit`/`send`/`pdf`; toolbar Create + search + status filter.
- **Invoice create/edit:** `CrudForm` — header (number auto/manual, issue/due dates, currency, buyer), repeatable **lines** (name, qty, unit, unit price net, VAT rate, computed net/vat/gross), and a **Polish VAT** section (the full meta editor: invoice kind, MPP, OSS + consumption country, FX rate/date, self-billing, reverse charge, GTU multi-select, 12 procedure markings, typDokumentu, advance payments/refs). `Cmd/Ctrl+Enter` save, `Escape` cancel; conflict-safe via `useGuardedMutation` with a **real** `retryLastMutation` (fixes M8).
- **Invoice detail:** read summary + **KSeF panel** — status badge, numer KSeF (copy), Send to KSeF (arm-then-confirm via `useConfirmDialog`), Retry, Download UPO, Download PDF, Issue offline, Issue correction (KOR). Distinct loading / not-found / error states (`LoadingMessage`/`RecordNotFoundState`/`ErrorMessage`). Edit disabled once `accepted`.
- **JPK page:** filings list + period picker → Generate → Download (XML); purchase-records table (add/delete).
- **Certificates page:** list, Enroll (name + type Authentication/Offline), Revoke; shows active auth method.
- Design system: semantic tokens only (§22), `@open-mercato/ui` primitives, `lucide-react` icons with `aria-label`, `flash()` feedback, `Alert` not `Notice`.

## Migration & Compatibility
- **No DB migration.** No schema change.
- **BC:** additive except for removing the module's own dead injection mappings. The `sales.invoices`/`sales.sales_invoice` `injection-table.ts` entries (+ their `widgets/injection/*` wrappers) are **removed** — they're internal to `financial_pl`, target host spots absent on released core, and are not a public import/contract surface (no external consumer references them); the logic moves into `components/`. New surfaces are additive: one new GET route, new backend pages, and a new `api/interceptors.ts` (interceptors are an additive UMES mechanism, §11.4). The interceptor adds a **conditional 409** to core `sales.invoices` PUT/DELETE only for KSeF-accepted invoices (documented effective contract). API route URLs, event IDs, DB columns, ACL feature IDs — unchanged. `yarn generate` re-emits the injection/enricher/interceptor registries.
- New ACL: none required beyond existing `financial_pl.view/submit/manage`; the invoice **editor** additionally needs core `sales.invoices.manage` (documented; the page guards on `financial_pl.view` and surfaces a clear message if the core feature is missing).

## Implementation Plan

### Phase 1 — Read API + list page
1. `GET /api/financial_pl/ksef/invoices` (QueryEngine read + KSeF status join; zod query schema in `data/validators.ts`; `openApi`).
2. `backend/financial/invoices/page.tsx` + `page.meta.ts` (nav group, `financial_pl.view`) — DataTable + KSeF `StatusBadge` + filters + Create link.
3. Reusable `KsefStatusBadge` + `KsefStatusMap` component.

### Phase 2 — Invoice create/edit (over core API) + PL-VAT meta
1. `InvoiceLinesField` + `PlVatMetaForm` components (full `invoiceMetaPutSchema`).
2. `create/page.tsx` + `[id]/edit/page.tsx` — `CrudForm` → core `/api/sales/invoices` (graph lines) then `PUT invoice-meta`; real `retryLastMutation`; edit locked when accepted.

### Phase 3 — Invoice detail + KSeF actions + immutability interceptor
1. `[id]/page.tsx` — summary + `KsefActions` (send/retry/upo/pdf/offline/correction) wired to existing routes via `apiCall` + `useGuardedMutation` + `useConfirmDialog`; Retry resolves+shows the latest non-`accepted` submission; action buttons gated (Send/Retry/offline → `financial_pl.submit`).
2. Correction (KOR): `CorrectionForm` creates a `SalesCreditMemo` via core `POST /api/sales/credit-memos` (verified command `sales.credit_memos.create`; corrected `invoiceId` + `reason` + lines), then `from-credit-memo`. Gated on `sales.credit_memos.manage`.
3. `api/interceptors.ts` — fail-closed `before` interceptors on core `sales.invoices` `PUT`/`DELETE` + own `invoice-meta` `PUT` rejecting (409) when an `accepted`/`processing` KSeF submission exists. `yarn generate` to register.

### Phase 4 — JPK + Certificates pages
1. `backend/financial/jpk/page.tsx` (filings + generate/export + purchase-records).
2. `backend/financial/certificates/page.tsx` (enroll/list/revoke), gated `financial_pl.manage`.

### Phase 5 — Cleanup + i18n + generate
1. **Remove** the `sales.invoices`/`sales.sales_invoice` entries from `injection-table.ts` and delete the now-unused `widgets/injection/*` wrappers (their logic lives in `components/`); **keep** the enricher.
2. Add all i18n keys to en/pl/de/es (incl. `financial_pl.status.offline_overdue`, review M9); `yarn generate`; update README (incl. the interceptor's conditional-409 effective contract).

### File Manifest (high level)
| File | Action | Purpose |
|------|--------|---------|
| `api/ksef/invoices/route.ts` | Create | List invoices + KSeF status (GET) |
| `backend/financial/invoices/{page,page.meta}.tsx/ts` | Create | Invoices list + nav |
| `backend/financial/invoices/{create,[id],[id]/edit}/page.tsx` | Create | Create / detail / edit |
| `backend/financial/{jpk,certificates}/page.tsx` (+meta) | Create | JPK + cert backoffice |
| `components/*` | Create | KsefStatusBadge, KsefActions, PlVatMetaForm, InvoiceLinesField, CorrectionForm (shared by pages + kept injection widgets) |
| `api/interceptors.ts` | Create | Fail-closed KSeF-immutability guards on core sales.invoices PUT/DELETE + own invoice-meta PUT |
| `widgets/injection/*` + `injection-table.ts` | Delete/Modify | Move widget logic to `components/`; remove the dead `sales.invoices`/`sales.sales_invoice` mappings (keep the enricher) |
| `data/validators.ts` | Modify | Add the invoices-list query schema |
| `i18n/{en,pl,de,es}.json` | Modify | New keys (+ offline_overdue) |
| `acl.ts` / `setup.ts` | Verify | No new features needed |
| `README.md` | Modify | Document the backoffice + released-core host reality |

### Testing Strategy
- Unit: the list read endpoint (org/tenant scope, status join), the meta form field mapping.
- Integration (Playwright, `__integration__/TC-*.spec.ts`): list renders with KSeF status; create invoice → appears in list; open detail → KSeF panel present; ACL (401 unauth, 403 without `financial_pl.view`); cross-org isolation on the list endpoint; JPK + certificates pages render and gate.

## Risks & Impact Review

### Risk Register
#### Cross-tenant leak via the new list endpoint
- **Scenario:** the joined invoice+KSeF read forgets org/tenant scope and returns other tenants' invoices.
- **Severity:** High · **Affected area:** `GET /api/financial_pl/ksef/invoices`.
- **Mitigation:** QueryEngine requires `tenantId` and filters org/tenant; reuse the enricher's scoped join; integration test for two-org isolation; never project encrypted columns.
- **Residual risk:** Negligible (covered by test + platform guarantees).

#### Editing an invoice already in KSeF
- **Scenario:** operator (or a stale tab / another client / a raw API call) edits or deletes an `accepted` invoice or its PL meta; the on-file KSeF document and the local copy diverge (illegal).
- **Severity:** High · **Affected area:** invoice edit/delete + invoice-meta.
- **Mitigation:** **server-side** fail-closed API interceptors (§11.4) on core `sales.invoices` `PUT`/`DELETE` and own `invoice-meta` `PUT` reject (409) when an `accepted`/`processing` submission exists — **not** just a disabled button; the UI also disables edit + offers "issue a correction"; the backend send-guard prevents re-issuing.
- **Residual risk:** Negligible (enforced at the API boundary regardless of client).

#### Core invoice API contract drift
- **Scenario:** core changes `/api/sales/invoices` request shape; the editor breaks.
- **Severity:** Medium · **Affected area:** create/edit.
- **Mitigation:** treat `/api/sales/invoices` as the STABLE core contract (§27 #7); validate responses with `readJsonSafe`; integration test exercises the round-trip.
- **Residual risk:** Medium — mitigated by tests; pinned to released core.

#### Correction authoring depends on a core credit-memo write path — RESOLVED
- **Scenario:** released core has no credit-memo create API → KOR can't be authored from the UI.
- **Severity:** ~~Medium~~ → **resolved** · **Affected area:** correction action.
- **Mitigation:** **Verified** — core exposes `POST /api/sales/credit-memos` (`makeCrudRoute`, command `sales.credit_memos.create` at `documents.ts:8909`, persists memo + `SalesCreditMemoLine`, feature `sales.credit_memos.manage`). The UI creates the memo (corrected `invoiceId` + `reason` + lines) then sends via `from-credit-memo`. Integration test covers the full create→send round-trip.
- **Residual risk:** Low (depends on the STABLE core credit-memos contract; covered by a test).

#### Missing core `sales.invoices.manage` feature
- **Scenario:** a `financial_pl`-only user can't author invoices.
- **Severity:** Low · **Affected area:** create/edit.
- **Mitigation:** page guards on `financial_pl.view`; create/edit surface a clear "requires sales.invoices.manage" message; viewing/sending still works.
- **Residual risk:** Low.

#### Operation interrupted between invoice write and meta write
- **Scenario:** invoice created in core but the subsequent `invoice-meta` PUT fails → invoice without PL-VAT meta.
- **Severity:** Low · **Affected area:** create flow.
- **Mitigation:** meta is optional for a draft; the editor reopens to complete it; send-to-KSeF resolves meta defaults; surfaced via `flash` error + retry.
- **Residual risk:** Low (no data corruption; recoverable).

## Final Compliance Report
- No cross-module ORM relations (core invoice via API + QueryEngine; PL layer via own tables). Tenant/org scoping on the new read. Zod at the new boundary; `z.infer` types; no `any`. DI for services. No new encrypted field; reads via decryption helpers; no encrypted-column equality filters. Design-system tokens + primitives; i18n in all four locales. ACL unchanged; guards use `requireFeatures`. `yarn generate` after injection/registry change. ARCHITECTURE §11 (UMES boundary: own UI by composition), §15 (tenancy), §22 (DS/i18n), §27 (no contract break) satisfied.
- Verification gate: build:packages → generate → build:packages → i18n:check-sync → typecheck → test → build:app; module jest suite; Playwright integration tests; sandbox preview against the KSeF TEST env (token path known-good; cert path verified).

## Integration Test Coverage
Tests must **exercise the actions** (assert payloads + results / state changes), not merely that controls render (spec-jury blocker, Codex + DeepSeek).
- `__integration__/TC-KSEF-UI-001.spec.ts` — invoices list: auth + composed-feature gate (401 unauth; 403 missing `financial_pl.view` OR `sales.invoices.manage`); two-org isolation (caller sees only own-org rows); KSeF status column renders from `_financial_pl`.
- `__integration__/TC-KSEF-UI-002.spec.ts` — **author** invoice via the form (header + ≥1 line + PL-VAT meta) → POST `/api/sales/invoices` (assert lines persisted) + PUT `invoice-meta` (assert full field set) → appears in list; **edit-prefill reads lines** via QueryEngine; the **interceptor** returns 409 on PUT/DELETE of an invoice with an `accepted` submission (server-side, by direct API call, not just a disabled button).
- `__integration__/TC-KSEF-UI-003.spec.ts` — invoice detail: **Send to KSeF** dispatches `from-invoice` and the panel reflects the resulting status + numer KSeF; **Retry** targets the latest non-accepted submission; **Download UPO** and **Download PDF** return non-empty content; **Issue offline** creates an offline submission. (KSeF reached via the TEST env when env is configured; otherwise a stubbed KSeF client — assert the dispatched payload + persisted submission either way.)
- `__integration__/TC-KSEF-UI-004.spec.ts` — **Correction (KOR)**: create a credit memo via `POST /api/sales/credit-memos` (corrected invoiceId + reason + lines) then send via `from-credit-memo`; gated on `sales.credit_memos.manage`.
- `__integration__/TC-KSEF-UI-005.spec.ts` — **JPK** page: create/generate a filing → export returns well-formed XML; purchase-record add/delete. **Certificates** page: enroll/list/revoke wired + gated on `financial_pl.manage`.
- Unit: `api/ksef/invoices` route (org/tenant scope + status join), the invoices-list query validator, `PlVatMetaForm` field mapping (full `invoiceMetaPutSchema`), the interceptor predicate (accepted/processing → reject; other states → pass).

## Changelog
- **2026-06-29:** Created. Module-owned full invoice + KSeF backoffice on released core (core `SalesInvoice` as source of truth; KSeF/PL-VAT layer on top; fix M8/M9).
- **2026-06-29 (spec-stage cross-model jury — Codex `fail`, DeepSeek `fail`, reconciled):** (1) Lines — clarified write via core API (verified persists `lines[]`) + read via QueryEngine `E.sales.sales_invoice_line` (core GET is header-only). (2) Permissions — list endpoint + pages now require composed `['financial_pl.view','sales.invoices.manage']`; correction needs `sales.credit_memos.manage`; action buttons UI-gated by `financial_pl.submit`/`manage`. (3) Immutability — added **server-side fail-closed API interceptors** (`api/interceptors.ts`) on core `sales.invoices` PUT/DELETE + own invoice-meta PUT, not just a UI guard. (4) Correction — **verified** core `POST /api/sales/credit-memos` (`sales.credit_memos.create`) exists; KOR authoring uses it (was an unverified risk). (5) Tests — strengthened to **exercise** every flow (send/retry/UPO/PDF/offline/KOR/JPK/cert + the interceptor 409) with payload/result assertions. (6) Injection entries: **removed** (decider call). (7) Two-step create switches to edit mode after the invoice POST; update uses replace semantics (full `lines[]`); interceptor's conditional-409 documented as effective contract.
- **2026-06-29 (Kimi `fail` reconciled):** Kimi blocked on KEEPING the dead injection entries as over-engineering (opposite of Codex/DeepSeek's advisory "keep" notes). Decider call: **remove** them (aligns with change-discipline + the user's rejection of unmerged-branch coupling); extract widget logic to `components/`. Kimi notes folded in: §11.4 sanctions cross-module interceptors (409 documented as effective contract); post-create redirect to edit mode (no duplicate-create); verified core update = replace semantics (submit full `lines[]`). **Spec-stage cross-model: confirmed (codex + kimi + deepseek)** — all reconciled into the spec; no remaining design blockers.
