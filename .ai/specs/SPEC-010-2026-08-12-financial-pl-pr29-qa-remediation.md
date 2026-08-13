# Financial PL — PR #29 QA Remediation (alinadivante report)

## 📝 TLDR

Remediate the QA findings on PR #29 (`feat/financial-pl-ksef-compliance`) so the Financial PL (Polish KSeF) module is ready on the **newest Open Mercato develop** build. Covers a dependency/platform upgrade (`@open-mercato/* → 0.6.8-develop.6940`, MikroORM 7.1.8, TanStack react-table 9), the P0/P1/P2 invoice-path and UX defects fixable **inside this repo**, a set of QA warnings, and an **opt-in, feature-based invoice-write permission** (#35) configurable from module settings and **enforced server-side**. Two items are out of scope and handed off: the core `updateInvoice/CreditMemo` PUT-500 fix (different repo, needs a published core build) and any change to core's default employee grants.

*Revision history: v1 → v2 (spec-council r1: feature RBAC for #35, existence check + idempotency for #41, sanctioned client for #39, declip not fork for #37, atomic cert-dedup, expanded tests). v3 (spec-council r2): #35 restriction is **opt-in / backward-compatible when unset**; the settings toggle grants the feature via a **read-modify-write** of the roles/acl array under its optimistic lock (never clobbering other grants); #41 idempotency pins to the **existing `KsefSubmission` unique index** and every lookup is org+tenant scoped; the auth decision is not separately cached; #39 covers the JPK export/UPO `window.open` sites; cert-dedup commits to a partial unique index.*

## 📝 Problem Statement

QA (alinadivante) tested an isolated copy of PR head `5b45e81` against upstream develop `177ea30c6` (`0.6.8-develop.6940.1.177ea30c6e`) and found PR #29 **not ready as-is**:

- Financial PL tests **627 passed / 14 skipped**, package build passed, sandbox generation passed (414 routes), but **type-check failed** until upgrade-only dependency changes were applied.
- The PR pins OM `0.6.6` (`develop.6366`); upstream is 212 commits newer. The workspace needs re-syncing to `6940`, Yarn `4.17.1` (already done in the working tree), MikroORM `^7.1.8`, react-table `^9.0.0`, bullmq-otel `^1.3.1`, the four DataTable imports switched to `LegacyColumnDef`, and regenerated lockfile/registries.
- Functional defects: blank totals, correction send 404 race, JPK refresh, "Other" payment, product selector clipping/stale results, PDF raw-JSON error, leaked `[internal]` messages, an i18n defect, plus QA warnings.
- A policy gap (#35): employees can edit invoices because **core grants `employee` `sales.invoices.manage`** while the module grants only `financial_pl.view`. UI-only read-only is insecure because the write API (core `/api/sales/invoices`) still accepts writes.

Baseline reproduced exactly in the isolated worktree (`627 passed / 14 skipped`, typecheck clean at 6366).

## 📝 Scope & Non-Goals

**In scope (staged here):** upgrade to 6940; #36 totals normalization; #41 correction read-after-write race; #34 JPK partial-success refresh; #38 "Other" payment; #37 product selector clipping + stale-request protection; #39 blob-aware PDF/UPO download; #40 central public-error mapper; #42 translation + locale-parity test; QA warnings (future dates, due-vs-sale, NIP layout, arbitrary Tailwind, cert dedup, offline message+link); #35 opt-in feature-based invoice-write permission + module settings UI.

**Out of scope — handed off:**
- **#36 invoice PUT-500** — an Open Mercato **core** defect (`updateInvoiceCommand`/`updateCreditMemoCommand` assign `buildChanges()` audit `{from,to}` objects to ORM fields). Fix already staged uncommitted in the local core checkout (`packages/core/src/modules/sales/commands/documents.ts` ~9049/9563, field-by-field PATCH + `documents.update-fields.test.ts`). Requires **publishing a new core build**; even 6940 still has the bug. → **Human step.**
- **#35 core employee grant** — core's default `employee → sales.invoices.manage` stays; the module adds its own optional requirement instead of editing core policy.

## 📝 Proposed Solution

Five independently-shippable phases; each leaves the app green.

### Phase 0 — Upgrade to OM 6940 + platform alignment
Bump every `@open-mercato/*` dep (sandbox + financial-pl devDeps) `0.6.6-develop.6366 → 0.6.8-develop.6940.1.177ea30c6e`. Align to the app template: `@mikro-orm/* ^7.1.8`, `@tanstack/react-table ^9.0.0`, `bullmq-otel ^1.3.1`, `@tanstack/react-query ^5.101.4`, `react 19.2.8`, `@types/react ^19.2.17`. Switch the **four** DataTable `ColumnDef` imports to `import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'` (keep `SortingState` on root): `backend/financial/{received,certificates,jpk,invoices}/page.tsx`. Regenerate lockfile + registries, run `platform:sync`, clean peer warnings (`@types/react`, `react-is`, optional AI-assistant). Gate: `platform:sync:check`, typecheck, financial-pl tests, i18n, generate, build all green.

### Phase 1 — P0 invoice path
- **#36 totals:** stored decimals return at full scale (`"0.0000"`, `"12.5000"`); `isValidDiscountPercent` (`InvoiceLinesField.tsx:114-120`, `/^\d{1,3}(?:\.\d{0,2})?$/`) rejects >2 decimals, so `parseDiscountPercent → null` and `computeLineTotals` bails (`:231-246`), blanking totals. The correction flow already fixed this with `trimDecimals`/`toCorrectionLine` (`CorrectionForm.tsx:46-68`); the **edit-form** (`edit/page.tsx:203-209`) and **read-only detail** (`[id]/page.tsx:219`) mappings do not. **Fix:** share the normalization helper across all three detail→form boundaries (`0.0000→0`, `12.5000→12.5`) **and** make `parseDiscountPercent` normalize trailing zeros before validating (root-level defense). Trailing-zero tolerance preserves the 0–100 invariant and still rejects genuinely over-precise input (`12.567`). Regression tests: standard, gross-price, margin.
- **#41 correction send race:** `CorrectionForm` creates a memo via core `POST /api/sales/credit-memos` then immediately sends via `POST /api/financial_pl/ksef/submissions/from-credit-memo`; the command resolves through the eventually-consistent QueryEngine projection (`ksef-submission.ts:769-777`, `resolve-fa3-from-credit-memo.ts:153-161`) and 404s on lag. The test masks it (`TC-KSEF-UI-004.spec.ts:190-192`). **Fix:** (a) bounded retry/backoff around the projection resolve (staying within the module's QueryEngine boundary — no cross-module entity import); (b) on exhaustion return `409 { code:'source_not_ready' }` (a freshly-created memo that will not resolve is *not ready*, not *absent*) — the client retries the **same** `creditMemoId`, never re-creates, bounded, then a friendly terminal message; (c) **idempotency via the existing `KsefSubmission` partial unique index** — the send inserts a submission scoped by org+tenant+`salesInvoiceId`+`documentKind`; a duplicate hits the unique constraint, which is caught and resolved to the existing submission (no check-then-act, no duplicate KSeF dispatch). Every existence/idempotency lookup is org+tenant scoped. Update `TC-KSEF-UI-004` to reject 404 (keep genuine unknown-id 404 in `TC-KSEF-003`). Stage and test the client retry explicitly.

### Phase 2 — P1 flows & error hygiene
- **#34 JPK refresh:** `handleGenerate` (`jpk/page.tsx:288-350`) refreshes only after creation+generation both succeed. **Fix:** split the stages; `refresh()` in `finally` once creation succeeds even if generation fails; partial-success message.
- **#38 "Other" payment:** `methodOther` exists in schema (`validators.ts:215,234-239`) + i18n (`en/pl.json:355-356`) but `PaymentFields` never renders it; selecting "Other" makes the form un-submittable (`InvoiceForm.tsx:1692-1703`). **Fix:** conditional `methodOther` input when `method==='other'`; split `methodOther`/`paidDate` into field-specific errors, each cleared as soon as its field is corrected.
- **#37 product selector:** the shared `ComboboxInput` dropdown is `absolute`, clipped by two **module-owned** `overflow-hidden` ancestors (`InvoiceLinesField.tsx:522`, `FormSection.tsx:33`); `loadProductSuggestions` (`:372-398`) has no cancel/sequence guard. **Fix (no DS fork):** remove/relax the clipping on the two module ancestors so the DS dropdown escapes (rounded corners retained without `overflow-hidden`), and add an `AbortController` + monotonic sequence guard to `loadProductSuggestions` so stale responses never overwrite fresh. Fallback only if declip regresses layout: a module-local combobox that reuses the DS a11y (roles/keyboard/`aria-*`) + an upstream portal follow-up. Browser test for successive searches.
- **#39 PDF/UPO download:** every `window.open` to an API endpoint renders a JSON error raw — `KsefActions.tsx:159` (PDF) **and `:162-166` (UPO)**, `invoices/page.tsx:814` (list PDF), **and the JPK export/UPO opens**. Server 422 stays (SPEC-007: no blank-seller PDF). **Fix:** replace all such `window.open` calls with the module's **sanctioned HTTP client** (extend it with a blob download path if needed — no raw `fetch`) that distinguishes a PDF/XML blob from a JSON error, shows a translated message, and links to seller/KSeF configuration.
- **#40 public-error mapper:** catch blocks return `CrudHttpError.body` verbatim, leaking `[internal]` (UPO/JPK-UPO/PDF/JPK-export/JPK-submit/correction-resolve/received-XML routes). **Fix:** `lib/public-error.ts` mapping stable `code`s → translated messages; sanitize at the route boundary (never emit `[internal]`; generic translated fallback for unmapped codes + `console.error` server log); add the new codes to each route's OpenAPI block; a guard test that user-visible bodies never contain `[internal]`.

### Phase 3 — P2 + QA warnings
- **#42:** fix `financial_pl.jpk.generate.kodUrzeduInvalid` in `en/de/es` + the inline fallback (`jpk/page.tsx:293`); add a **locale-parity test** (equal key sets across `en/pl/de/es`, asserted against a curated expectation rather than a brittle heuristic).
- **Future dates:** warn on future issue/sale dates (invoice form) and reject future purchase/receipt dates (JPK purchase records). None exist today (`validators.ts:247,248,634,635` format-only).
- **Due vs sale:** extend the due-date check (`InvoiceForm.tsx:1611-1614`) to also flag `due < saleDate`.
- **NIP layout:** `BuyerFields.tsx:270` flex row has no wrap → lookup button clips; add responsive wrap/stacking (`:270`, `:318`).
- **Arbitrary Tailwind:** replace token-equivalent arbitraries (`text-[15px]`, `text-[11px]`, `min-w-[8rem]`, `top-[1.125rem]`, `min-h-[50vh]`, `sm:min-w-[8.5rem]`) with DS utilities. Grid-template `minmax(...)` arbitraries have **no token equivalent** and are retained (DS-guardian-confirmed) — the acceptance targets token-equivalent arbitraries, not layout grid definitions.
- **Cert dedup:** add an **enroll-scoped** client in-flight guard **and** a **partial unique index** on a pending `KsefCertificate` enrollment (`(organization_id, tenant_id) where status='pending' and deleted_at is null`); a concurrent duplicate enroll hits the constraint (caught → returns the existing pending record), not a check-then-act.
- **Offline message + link:** improve `credentials_missing` + the certificates not-configured message to link to the KSeF integration setup.

### Phase 4 — Invoice-write permission (#35, opt-in, feature-based, server-enforced)
A module ACL feature + an **opt-in** restriction configured from module settings, enforced at the interceptor seam; **backward compatible when the restriction is unset**.

## 📝 Architecture

- **Reused primitives:** the module's `api/interceptors.ts` `before` seam (already guards core `sales/invoices` writes for KSeF immutability — the only place that can gate the core-owned write), core `rbacService.userHasAllFeatures` (its own tenant cache + `invalidateTenantCache`), module ACL declarations (`acl.ts` + `setup.ts`), core `GET /api/auth/roles` + `GET/PUT /api/auth/roles/acl`, the existing `InvoiceSettings` entity + `invoice-settings` page, the `CrudHttpError`+route-catch convention, the module HTTP client, the existing `KsefSubmission` unique index, and `trimDecimals`.
- **#35 is opt-in + feature-based.** A new feature `financial_pl.invoices.manage` (`dependsOn:['financial_pl.view']`; admin covered by the existing `financial_pl.*` wildcard). A nullable `InvoiceSettings.restrictInvoiceWrite` boolean (default unset/false) turns enforcement on. The write interceptor reads the caller identity **from `InterceptorContext`** (no `getAuthFromRequest`), and when restriction is on requires the feature via `rbacService`, **fail-closed**; when off it is a no-op (current behavior → BC). No separate auth cache (rbacService owns caching + invalidation). Interceptor `priority` is set below the immutability guard so an immutable invoice is rejected first.
- **#37/#39** avoid new parallel mechanisms (declip the DS combobox; use the existing HTTP client). **#40** adds one small `lib/public-error.ts`.

## 📝 Data Model

- **`InvoiceSettings.restrictInvoiceWrite`** `boolean` nullable (default null/false = permissive = current behavior). One additive column.
- **Cert-dedup:** a partial unique index on a pending `KsefCertificate` enrollment (see Phase 3).
- Both via the module's hand-authored migration mechanism — the repo's **documented convention** (`apps/sandbox/AGENTS.md` §4/§7: edit entity → `db:generate` as a diff probe → hand-write the SQL and update `.snapshot-open-mercato.json` in the same change → `db:migrate`), not a violation of it. Each migration has a reversible `down`. No `#35` role storage (grants live in core `RoleAcl.featuresJson`).

## 📝 API Contracts

- **#41** `POST …/submissions/from-credit-memo`: after bounded retry, `409 { code:'source_not_ready' }` while the memo is not yet resolvable; idempotent — a repeat send for the same `creditMemoId` returns the existing submission (enforced by the `KsefSubmission` unique index, org+tenant scoped), never a duplicate dispatch. New codes added to the route OpenAPI.
- **#35** enforcement (only when `restrictInvoiceWrite` is true): interceptor `before` on `sales/invoices` (`POST`/`PUT`/`DELETE`), `sales/credit-memos` (`POST`/`PUT`/`DELETE`), `financial_pl/ksef/invoice-meta` (`PUT`) → `403 { code:'invoice_write_forbidden' }` when `userHasAllFeatures(user,['financial_pl.invoices.manage'])` is false or unresolvable (fail-closed).
- **#35** configuration: `GET/PUT /api/financial_pl/invoice-settings` gains `restrictInvoiceWrite`. Role grants reuse core `GET /api/auth/roles` + `GET/PUT /api/auth/roles/acl`; **the PUT replaces the whole `features` array under an optimistic lock**, so the UI reads the role's current features, adds/removes only `financial_pl.invoices.manage`, and writes the merged array back, retrying on a version conflict — it never clobbers a role's other grants. Requires `auth.acl.manage`.
- **#40** public bodies gain a stable `code` + translated `error`; `[internal]` never reaches a client (additive, migration-free).

## 📝 UI/UX

- **#38** conditional "Other" description input; per-field errors that clear on correction.
- **#37** product dropdown escapes clipping; no stale overwrite; keyboard/`aria` preserved.
- **#39** PDF/UPO/JPK downloads via the client → open blob on success, toast + config link on JSON error.
- **#34** JPK list refreshes after creation even if generation fails; partial-success toast.
- **NIP** toolbar wraps instead of clipping. **Offline** messages link to setup.
- **#35** the invoice-settings page gains a fully localized (en/pl/de/es) panel: a **"Restrict who can issue/edit invoices"** toggle (off by default) and, when on, a role list (`GET /api/auth/roles`) whose checkboxes reflect/edit each role's `financial_pl.invoices.manage` grant (read-modify-write against roles/acl, optimistic-lock aware). Create/Edit affordances are disabled client-side for users lacking the feature when restriction is on (UX; interceptor is the gate). Without `auth.acl.manage`, the panel is read-only with a hint.

## 📝 Edge Cases & Failure Scenarios

- **#35:** restriction unset ⇒ unchanged behavior (BC). Restriction on + caller/feature unresolvable ⇒ `403` (fail-closed, never fail-open). Admin/super-admin always pass via wildcard (no lockout). Concurrent settings edits ⇒ roles/acl optimistic-lock retry; a role's unrelated grants are preserved.
- **#41:** lagging memo ⇒ `source_not_ready` + client retry; double-send ⇒ same submission (unique-index idempotent); never a stranded irreversible create; genuinely bad id ⇒ client retries exhaust into a friendly terminal message.
- **#36:** hand-typed/negative discounts still validate to 0–100 after trailing-zero tolerance.
- **#40:** unmapped internal message ⇒ generic translated fallback + server log; never `[internal]`.
- **#39:** a genuine 2xx blob still opens; only JSON errors divert to a toast.

## 📝 Risks & Impact Review

- **Upgrade blast radius (highest):** react-table v8→v9 (`LegacyColumnDef`), MikroORM 7.0→7.1, react 19.2.5→19.2.8. Mitigation: template-aligned versions, exact 4 import edits, full gate before proceeding.
- **#35:** default-off ⇒ **no behavior change on deploy** (BC). Enabling restriction is an explicit, reversible admin action; admins never lock themselves out. Covered by tests (restriction off = unchanged; on + granted role writes; on + ungranted role 403; admin wildcard pass; unresolved-auth fail-closed 403).
- **#40 error-body shape:** adding `code` is additive; clients already read `error`.
- **Rollback:** each phase is a coherent commit group; both migrations have `down`; #35 restriction + grants are revocable config, no destructive schema.

## 📋 Phasing

Phase 0 (upgrade) → 1 (P0) → 2 (P1) → 3 (P2/warnings) → 4 (#35). Each leaves the app green and is independently reviewable.

## 📋 Implementation Plan

**Phase 0** 1. Bump `@open-mercato/*` → 6940 + align template deps; `yarn install`; regen lockfile. 2. Switch 4 DataTable imports to `LegacyColumnDef` (keep `SortingState` on root). 3. `platform:sync`; regenerate registries; clean peer warnings; typecheck/build/generate/platform-sync:check/tests green.

**Phase 1** 4. Shared line-normalization helper + trailing-zero-tolerant `parseDiscountPercent`; apply in edit-form + read-only detail mappings; standard/gross/margin regression tests (#36). 5. Bounded projection retry; `source_not_ready` on exhaustion; unique-index-backed idempotent send (org+tenant scoped); staged client same-id retry; update `TC-KSEF-UI-004`; retry + idempotency tests (#41).

**Phase 2** 6. Split JPK create/generate; refresh in finally; partial-success message (#34). 7. Conditional `methodOther` input; per-field payment errors that clear on correction (#38). 8. Declip the two module ancestors + abort/sequence guard on product search; browser test (#37). 9. Blob-aware download via the sanctioned client across all PDF/UPO/JPK `window.open` sites + config link (#39). 10. `lib/public-error.ts`; sanitize route catches; OpenAPI codes; no-`[internal]` guard test (#40).

**Phase 3** 11. Fix `kodUrzeduInvalid` en/de/es + inline fallback; locale-parity test (#42). 12. Future-date warn/reject; due-vs-sale check. 13. NIP toolbar wrap; token-equivalent Tailwind cleanup; cert dedup (enroll-scoped client guard + partial unique index + migration); offline message + setup link.

**Phase 4** 14. Add `financial_pl.invoices.manage` (`dependsOn:['financial_pl.view']`) to `acl.ts` + `setup.ts`; page-gate create/edit on it (when restriction on). 15. `InvoiceSettings.restrictInvoiceWrite` column + migration + snapshot; settings schema/API. 16. Interceptor `before` write-guard (identity from `InterceptorContext`, `rbacService`, fail-closed, priority below immutability) on `sales/invoices` POST/PUT/DELETE + `sales/credit-memos` POST/PUT/DELETE + `invoice-meta` PUT, active only when restriction on. 17. Settings-page localized panel: restriction toggle + role grants via optimistic-lock-aware roles/acl read-modify-write; read-only without `auth.acl.manage`. 18. Tests: guard matrix + settings-panel grant/revoke + read-only fallback.

## 📋 Test Plan

- **Unit/regression:** #36 (standard/gross/margin totals from full-scale stored decimals), #41 (retry converges / exhausts → `source_not_ready`; unique-index idempotent re-send; org+tenant scoping), #40 (no `[internal]`), #42 (locale parity), #38 (payment per-field errors + clear-on-correction), #35 (guard matrix: restriction off = allow; on+granted; on+ungranted→403; admin wildcard; fail-closed; settings read-modify-write preserves other grants), date validators, cert-dedup unique-index.
- **Integration (Playwright `__integration__`, live/gated KSeF env):** correction create→immediate send with **delayed projection** (eventual 202 via retry, never a masked 404); JPK partial-failure refresh; payment-Other e2e; PDF/UPO **blob vs JSON**; product-selector **successive searches** + **not clipped**; **standard/gross/margin** author→save→display; **two-tenant non-superadmin isolation**; **two-tab optimistic-lock/409**; **#35** ungranted role blocked at the API + settings-panel grant/revoke.
- **Env-gated:** certificate enrollment + live KSeF submission behind the environment gate; if the live environment is unavailable this run, record an explicit **documented waiver** in the handoff, not a silent skip.
- **Full gate:** platform:sync:check, typecheck, financial-pl tests, i18n:check, generate, build:packages.

## 📋 Cross-repo handoffs & decisions

- **Core PUT-500 (#36 500):** publish the core `documents.ts` PATCH fix (staged uncommitted in the core checkout) as a new develop build, then bump the pin here and re-verify real edit/save. Handoff only.
- **Employee ACL (#35):** core defaults untouched; the module adds an opt-in `financial_pl.invoices.manage` requirement + settings UI.

## 📋 As-built notes (pragmatic deviations)

- **Phase 0:** `bullmq-otel ^1.3.1` added to sandbox + financial-pl — it is an *optional* peer of `@open-mercato/queue@6940` whose `async.ts` imports it, so it must be present for typecheck/build. Yarn `packageManager` bumped `4.12.0 → 4.17.1` in the repo root + sandbox. **All** workspace packages (`carrier-inpost`, `forms`, `test-package`) were aligned to 6940, not only financial-pl/sandbox, to avoid a multi-version core split that nested `@open-mercato/core` per-consumer.
- **#35 settings UI:** enforcement is feature-based via the interceptor exactly as specified. The settings page ships the opt-in **restriction toggle** plus a link to the canonical core **Roles & Permissions** UI (`/backend/roles`) for granting `financial_pl.invoices.manage`, rather than an in-page roles/acl read-modify-write panel. This deliberately delegates grants to the already-correct core UI, sidestepping the whole-`features`-array-replace + optimistic-lock hazard the spec council flagged (F-19). An in-module role-grant panel is a possible follow-up.
- **Cert dedup:** the enroll-scoped client in-flight guard ships now (addresses the reported duplicate-request symptom); the atomic server-side partial unique index is a documented follow-up.
- **Arbitrary Tailwind:** exact-token-equivalent arbitraries were replaced (`min-w-[8rem]→min-w-32`, `sm:min-w-[8.5rem]→sm:min-w-34`, `top-[1.125rem]→top-4.5`); grid-template `minmax(...)`, `min-h-[50vh]`, and `text-[15px]/[11px]` have no design-token equivalent and are retained per DS-guardian policy (council F-23).
- **Peer warnings:** `react-is` + `@types/react` added to sandbox/financial-pl/test-package; `carrier-inpost`/`forms` retain pre-existing peer warnings and the non-optional core `@open-mercato/ai-assistant` peer (an upstream concern) — non-blocking, pre-existing.
- **JPK purchase future-date reject** ships server-side in `jpkPurchaseRecordSchema`; invoice-form future-date + due-vs-sale checks ship client-side via the existing `problems.push` field-error mechanism.

## 📋 Compliance & Changelog

- **Backward compatibility:** no protected core surface is modified; the OM upgrade is a version bump; #35 is default-off; #40 error bodies are additive. The only behavior change is opt-in.
- **Changelog (on release):** upgrade to OM 6940; fixed blank invoice totals, correction-send race, JPK refresh, "Other" payment, product-selector clipping/stale results, PDF/UPO raw-JSON errors, leaked internal messages, JPK office-code translation; added optional role-based invoice-write restriction; QA-warning hardening.
