# Financial PL — PR #29 QA Remediation Round 2 (alinadivante report, round 2)

*Revision history: v1 → **v2** (spec council: 4 reviewers — fresh Claude + deepseek-v4-pro + deepseek-v4-flash + kimi — verdict request_changes, 33 findings). v2 corrects #43's enforcement seam (interceptor, not mutation guard) and test; reworks #44 to avoid the `crudInitialValues` reset/data-loss hazard; extends #48 read-back to `crudInitialValues` + `saleDate` + `payment`; exempts advance kinds from the HARD `due≥sale` date rule and pins the `today` clock to Europe/Warsaw; specifies #49 as a complete `$in`/`$nin` partition on KSeF issuance; ships #50-A only and corrects #50-B's direction; keeps the form-state collectors client-safe; resolves all four open questions; adds UI regression tests; opportunistically aligns the invoice-meta KSeF lock set. See “Council dispositions”.*

## 📝 TLDR

Remediate the eight round-2 QA findings on PR #29 (`feat/financial-pl-ksef-compliance`, `@open-mercato/financial-pl`) that are fixable **inside this repo**, plus add the maintainer-requested **shared date cross-check** rule on the invoice form. Round 1 (SPEC-010) is already consolidated onto this branch. The defects cluster into three roughly file-disjoint areas: the **invoice create/edit form + PL-VAT metadata** (#43 employee RBAC, #44 currency default, #45 preview dates, #46 stale validation, #47 advances, #48 authorized persons, + date cross-checks), the **invoices-list status filter** (#49), and the **KSeF credentials/certificates surface** (#50). No new entity/migration is required except possibly none; the fixes are RBAC-alignment, form-state wiring, read-back hydration, one query-filter re-base, and a credentials read-scope alignment. The known **edit-invoice PUT-500** (core defect) remains handed off as in SPEC-010; the npm **platform quarantine** keeps the interim `6931` pin + ioredis shim.

## 📝 Problem Statement

QA (alinadivante) round 2 tested PR #29 field-by-field on the "Podatki i KSeF"/"Uwagi" tabs, the JPK/Ustawienia/Certyfikaty pages, and the `employee` role, and filed eight issues (#43–#50) — one **High** (#43: an `employee` can never get an invoice's Polish VAT/KSeF data saved). Two non-bug maintainer calls were raised: **date fields don't cross-check each other** (round 1 flagged due-before-sale; round 2 also issue-vs-sale — "one shared rule, not pairwise patches"), and the list defaulting to the current month. The user has directed: **add the date cross-checks**.

All eight were reproduced/root-caused against the branch (details per finding below). Several are subtler than the report's surface description — notably #48 (data IS written, not read back), #49 (status is structurally always-null), and #50 (the token DOES save; the visible failure is a certificate-specific message + a super-admin org-scope divergence).

## 📝 Scope & Non-Goals

**In scope (staged here):**
- #43 employee-role PL-VAT/KSeF metadata save (RBAC feature alignment).
- #44 default currency applied on new invoice.
- #45 invoice preview reflects live issue/sale dates (+ number/currency/notes).
- #46 field validation errors clear on correction, not only on next submit.
- #47 advances (ZAL/ROZ) no longer silently dropped.
- #48 authorized-person ("Podpis") fields persist and read back.
- #49 "Status dokumentu" filter returns correct results.
- #50 KSeF authorization-token configuration is truthfully reflected (not "silently nothing").
- **Date cross-checks:** one shared invoice-date rule replacing the scattered pairwise checks.

**Non-Goals / handed off:**
- **Edit-invoice PUT-500** — a core `updateInvoice`/`updateCreditMemo` defect (SPEC-010 handoff); the edit path for the Podatki/Uwagi tabs cannot fully round-trip until a fixed core build ships. Round-2 fixes target the **create path + read-back + module logic**; the edit-500 stays a cross-repo item. QA already acknowledged this.
- **Platform repin off 6931** — blocked on the npm quarantine of develop 6940–6950; the interim `6931` pin + `types/ioredis-protocol-shim.d.ts` + waived `platform:sync:check` stay until it clears (delete the shim on repin).
- **Core credentials-form UX** (sentinel-prefill "leave blank to keep" affordance) — a `@open-mercato/core` change; not touched here.
- **List month-default search scope** — a UX call for the screen owner (@zielivia); not filed, not implemented this round unless directed.
- **Core default `employee` grants** — unchanged (module aligns its own requirement).

## 📝 Root Causes & Fixes

### Packet A — Invoice form + PL-VAT metadata + validators
Files: `backend/financial/invoices/[id]/edit/InvoiceForm.tsx`, `backend/financial/invoices/[id]/edit/page.tsx`, `data/validators.ts`, `api/ksef/invoice-meta/route.ts`, `components/*` as needed, `i18n/{en,pl,es,de}.json`, `data/__tests__/*`, `api/__tests__/*`.

**#43 (High) — employee PL-VAT/KSeF meta silently dropped.**
Root cause: create is two-step — POST `/api/sales/invoices` (core; employee holds core `sales.invoices.manage`) then PUT `/api/financial_pl/ksef/invoice-meta`. The meta PUT requires `requireFeatures: ['financial_pl.manage','sales.invoices.manage']` (invoice-meta/route.ts:24), but `financial_pl.manage` is the KSeF **config-admin** feature (acl.ts:4); `setup.ts` grants `employee: ['financial_pl.view']` only → 403 → `metaOk=false` → toast `financial_pl.errors.meta_save_failed`.
Fix (§14): change the meta PUT `requireFeatures` to **`['financial_pl.view','sales.invoices.manage']`** — symmetric with who can create the invoice (the create/edit page gates + the core POST both require `sales.invoices.manage`; `financial_pl.manage` `dependsOn financial_pl.view`, so no current manage-holder loses access). Every invoice-creator can write its statutory metadata; this is non-escalating.
**Enforcement seam (council F-07/F-08, corrected):** the opt-in #35 write-restriction is **NOT** enforced by `validateCrudMutationGuard` on this route — no `MutationGuard` is registered for `financial_pl.invoice_meta` (that call is a pass-through). It is enforced by the module's **`before` API interceptor** `invoiceWriteGuard` (`api/interceptors.ts:125-148`, mapped ~232-240), which checks `financial_pl.invoices.manage` only when `InvoiceSettings.restrictInvoiceWrite===true`. Relaxing `requireFeatures` does **not** open a hole: the interceptor still denies a `view`+`sales.invoices.manage` principal lacking `invoices.manage` when the restriction is ON (and the core POST is likewise blocked). **Keep the interceptor.**
Regression (council F-06): (a) a metadata-level assertion — import the route module and assert `metadata.PUT.requireFeatures === ['financial_pl.view','sales.invoices.manage']`; (b) a route/integration test driving `PUT /api/financial_pl/ksef/invoice-meta` with an employee-shaped principal: restriction OFF ⇒ 200, restriction ON without `invoices.manage` ⇒ 403 (via the interceptor). Keep the existing `invoice-write-guard.test.ts` (which tests `invoiceWriteGuard`) as the #35 interceptor test — do not repurpose it for the requireFeatures change.

**Opportunistic (council F-09):** while editing this route, align its KSeF-immutability lock `KSEF_LOCKED_STATUSES` (currently `['accepted','processing']`, invoice-meta/route.ts:29) with the module's active-submission set `{queued, processing, accepted, offline_issued}` (the `financial_pl_ksef_submissions_active_unique` index in entities.ts). **`offline_issued`** especially is a legally-final issued state currently editable — a real immutability gap. Verify the exact set against `api/interceptors.ts` (whose lock this route’s comment says it mirrors) and match it; add a lock test for `offline_issued`.

**#47 (Med/High) — advances (ZAL/ROZ) never save.**
Root cause: `buildMetaPayload` (InvoiceForm.tsx:928) sets `advancePayments=[] / advanceRefs=[] / orderSnapshot=null` whenever `invoiceKind ∉ ADVANCE_INVOICE_KINDS = {zal,roz,kor_zal,kor_roz}` (line 161). Advances read back fine (edit page.tsx:141-142) — it is a **silent write-strip**: on a regular `vat` invoice the entered advances are dropped with no feedback. (Advances are legitimately only valid on advance/settlement invoices for FA(3)/KSeF.)
Fix (council Q4 — do both): eliminate the silent loss. (1) Gate the "Zaliczki i rozliczenie (ZAL/ROZ)" editor so it is only active when `invoiceKind ∈ ADVANCE_INVOICE_KINDS` (which already includes `kor_zal`/`kor_roz`, so corrections stay editable); when not, show a hint (`financial_pl.invoices.form.advances.kindHint`) instead of an editable-but-stripped section. (2) Keep a **submit-guard** that BLOCKS (never silently strips) when advances/order data are present on a non-advance kind, with a message offering to switch the kind or clear the advances. The gate is UX; the submit-guard is the safety net — do not rely on `buildMetaPayload`'s silent zeroing (928-932) for correctness. Verify end-to-end persistence for a `zal` invoice.

**#48 (Med) — authorized-person ("Podpis") fields never save → read-back gap.**
Root cause: the write is correct — InvoiceForm.tsx:1768-1777 builds `mergedMetadata.signature = {mode,issuerSignatory,recipientSignatory}` into core `SalesInvoice.metadata` (same path as `notes`, which QA confirms persists). The **read-back is missing**: edit page.tsx header build (lines 225-231) hydrates only `invoiceNumber/issueDate/dueDate/currencyCode/orderId` and `notes` (236) — never maps `metadata.signature → header.issuerSignatory/recipientSignatory/signatureMode` (same latent gap for `contractNumber`, `transportTerms`).
Fix (council F-14/F-15/F-17 — three coordinated parts, since these are CrudForm fields seeded only via `crudInitialValues`):
1. **edit page.tsx `mapResponseToFormValue`** (~224-239): hydrate `header.issuerSignatory`/`recipientSignatory`/`signatureMode` from `invoiceMetadata.signature`, `header.contractNumber`/`transportTerms` from metadata, `header.saleDate` from `invoiceMetadata.saleDate` (via `toDateInput`), and reconstruct `value.payment` from `invoiceMetadata.payment` — the write persists all of these to core `SalesInvoice.metadata` (InvoiceForm.tsx:1772/1779-1785) but the read-back currently drops signature/contract/transport/saleDate/payment.
2. **InvoiceForm.tsx `crudInitialValues`** (~2099-2115): extend the whitelist to include `signatureMode`/`issuerSignatory`/`recipientSignatory`/`contractNumber`/`transportTerms` (with matching deps on `value.header.*`) — otherwise CrudForm never seeds them and the read-back has no effect. (`saleDate` is already whitelisted.)
3. **Header type** (`InvoiceHeaderValues` / the form value type): ensure the added fields are declared so the hydration typechecks.
Regression: a read-back test asserting `metadata.signature`/`saleDate`/`payment` round-trip into the form’s initial values.

**#44 (Low/Med) — default currency ignored on new invoice.**
Root cause: the create-mode defaults effect (InvoiceForm.tsx:1499-1533) applies `invoiceSettings.defaultPriceMode` + `defaultTaxRate` but **never reads `defaultCurrencyCode`** (referenced 0× in the form); the field stays at hardcoded `DEFAULT_CURRENCY='PLN'` (line 135). Settings persist/return the field correctly.
Fix (council F-13 — **not** a naive "mirror priceMode"): `currencyCode` **is** a member of `crudInitialValues` (2104), so blindly writing `value.header.currencyCode` in the async effect churns `crudInitialValues` identity and makes CrudForm **reset every header field** (issueDate/dueDate/saleDate/invoiceNumber/notes/orderId) to mount defaults — a data-loss hazard the priceMode/taxRate path avoids (those touch only payment/priceMode/lines, none in `crudInitialValues`). Instead seed the currency default **without** a post-interaction reset: prefer seeding it into the initial value **before CrudForm mounts** (thread `invoiceSettings.defaultCurrencyCode` into `emptyInvoiceFormValue`/`normalizeInvoiceFormValue` on create, guarded by `isValidCurrencyCode`), or apply it in the effect **only while** the currency field is still `DEFAULT_CURRENCY` **and** no header field has been touched (CrudForm `userEditedFieldIds`). Verify `@open-mercato/ui` CrudForm's reset-on-initialValues-identity semantics before finalizing.

**#45 (Low/Med) — preview shows stale issue/sale dates.**
Root cause: the preview snapshot reads `liveHeader.X ?? value.header.X`, but the `liveHeader` bridge is **dead code** — `PreviewSync` (1274-1286) is never rendered and `setLiveHeader` (1301) never called, so header fields fall back to the initial (mount-time) `value.header.*`; live date edits live in CrudForm `ctx.values`. Lines/amounts reflect because they read `value.lines`. (Also silently staled number/currency/notes.) Likely lost in the SPEC-018 tabbed refactor.
Fix: mount `<PreviewSync values={ctx.values} onValues={setLiveHeader}/>` inside the `topRow` group (line ~1994) which receives `ctx` and stays mounted (hidden via `className`, **not** a `TabsContent`-unmounted panel — SPEC-018 gotcha). No signature change needed. The preview also reads `liveHeader.notes/signatureMode/issuerSignatory/recipientSignatory` (1374-1385), which render in the body panels — **verify those panels stay mounted-hidden, not `TabsContent`-unmounted** (council F-29), or notes/signature will lag in the preview (and the SPEC-018 gotcha applies). Add a regression test for the remount (council F-21).

**#46 (Med) — validation errors persist until next submit.**
Root cause: `fieldErrors` (state, 1312) is a **custom** error map written only in `handleSubmit` (set 1723, reset 1743); child fields (BuyerFields/InvoiceLinesField/PaymentFields) render from it but nothing prunes an entry on change.
Fix (§8/§10): extract **only the `problems.push` field checks** (council F-28) — NOT the `throw failSubmit(...)` submit-only hard stops (currency 1570, margin+PLN, taxpayer NIP, termDays, etc.), which stay in `handleSubmit` — into a pure `collectInvoiceFieldProblems(value, header, { isEdit, today, priceMode, marginScheme }) → Problem[]`. Place it in `data/validators.ts` (verified client-safe — it imports only a `type` from `./entities`; keep it so, no server imports — council F-30/F-32). Call it from `handleSubmit` **and** from a `useEffect/useMemo` keyed on `[value, liveHeader]` gated behind a `hasSubmittedRef` that **prunes** `fieldErrors` to the still-failing subset (never adds errors pre-submit). Reuse the exact problem-key scheme (`buyer.companyName`, `buyer.addressLine1`, `buyer.nip`, `line.${i}.*`, `payment.*`, `issueDate`/`dueDate`/`saleDate`, `orderId`) so child `errorFor` matching and existing tests stay green. **Land with #45** (council F-27): the live-prune reads `liveHeader`, which is `{}` until #45 wires `PreviewSync → setLiveHeader`; implement/test #45 and #46 together. Unit-test the extracted collector.

**Date cross-checks (maintainer-requested).**
Root cause: the checks are scattered imperative `if`s in `handleSubmit` (1611-1628), all hard errors: `dueBeforeIssue`, `issueDateFuture`, `saleDateFuture`, `dueBeforeSale`.
Fix: one pure `invoiceDateProblems({issueDate,saleDate,dueDate,today,invoiceKind}) → { errors: Problem[]; warnings: Problem[] }` in `data/validators.ts` (client-safe), replacing the four inline checks. Rules (PL art. 106i), council F-05/F-12/F-23/F-26:
- **HARD `due ≥ issue`** — payment cannot fall due before the invoice is issued. Applies to all kinds.
- **HARD `due ≥ sale`** for **non-advance kinds only**. **Exempt `ADVANCE_INVOICE_KINDS`** (zal/roz/kor_zal/kor_roz): an advance/prepayment invoice's payment legitimately falls due before a *future* delivery/sale date, so hard-erroring `due < sale` there is a false positive (for advance kinds, demote to a warning or drop).
- **HARD `issue ≤ today`** — no future issue.
- **WARNING (non-blocking)**: issue-vs-sale ordering, and sale-in-future for non-advance kinds — both lawful for advance invoices (issue up to 60 days before sale; up to the 15th of the following month after).
- **`today` clock (F-23/F-26):** compute `today` in **Europe/Warsaw** (reuse the existing `todayInWarsaw()` in validators.ts, 623-627) and pass it in — the current UTC `todayInput()` false-rejects same-day issue/sale for 1-2 hours after Warsaw midnight.
Ship the minimal **non-blocking warning channel** now (Open Q2, resolved): a `warnings` list distinct from `fieldErrors`, rendered with DS status-warning tokens (not hardcoded amber, §22). Unit-test the helper across regular and advance kinds and the Warsaw-midnight boundary.

### Packet B — Invoices list "Status dokumentu" filter (#49)
Files: `api/ksef/invoices/route.ts`, `backend/financial/invoices/page.tsx` (vocab, only if re-scoped), `lib/invoice-status.ts` (reuse), `api/__tests__/*`.

Root cause: `route.ts:238` `if (documentStatus) filters.status = documentStatus` — exact-equality of literal `'draft'`/`'issued'` on core `sales_invoice.status`, which is **always `null`** for financial_pl invoices (the create flow sends no status; core stores null; KSeF issuance mutates only `KsefSubmission.status`), and `'issued'` is a **derived** predicate (`isInvoiceIssued`), never a stored value. Every selection → zero rows.
Fix (Open Q1 resolved — **re-base on the module's own issuance signal `KsefSubmission`**; the `isInvoiceIssued`/null fallback is rejected because the module never writes an issued lifecycle status, so *Wystawiona* would stay permanently empty). Resolve, for the org/tenant scope, the set `acceptedIds` = sales-invoice ids that have a submission with `status ∈ {accepted, offline_issued}` (note: the existing KSeF-status filter at route.ts:181 uses exact-equality on ONE status, so `documentStatus` needs an **`$in`** over the two issued statuses), reusing the route's existing submission→invoice-id-set pattern (route.ts:168-232). Then a **complete two-value partition** (council F-11):
- **Wystawiona** = `id ∈ acceptedIds` (positive `$in` — composes with the current `filters.id` intersection at route.ts:237).
- **Robocza** = `id ∉ acceptedIds` (**`$nin`** — the current positive-only intersection cannot express this, council F-02/F-10). Every non-issued invoice (null-status, queued, processing, rejected) falls here, so the partition is complete and queued/processing invoices are not lost.
**Query composition (must verify):** confirm the QueryEngine accepts `id: { $in, $nin }` (or restructure to a top-level `$and`) and that it ANDs correctly with the existing org/tenant/`issue_date`/search/kind filters and pagination/total. If the engine cannot compose `$nin` under `id`, restructure the Robocza branch accordingly (do not silently degrade to an empty positive set).
Regression: route test over a fixture with a null-status invoice + a queued-submission invoice + an accepted-submission invoice — assert the accepted lists under *Wystawiona* and is excluded from *Robocza*; the null/queued list under *Robocza* and are excluded from *Wystawiona*; and that status composes with a concurrent `issue_date`/search filter.

### Packet C — KSeF credentials/certificates surface (#50)
Files: `backend/financial/certificates/page.tsx`, `api/ksef/credential-health/route.ts`, `api/ksef/certificates/route.ts`, `lib/credentials.ts`, `api/__tests__/*`. (`integration.ts` is correct — no change.)

Root cause: the token **does** save (it is `type:'secret'`, encrypted through core's integration-credentials path exactly like the cert key, proven live via the sibling secret). The visible failure is two things: (1) the certificates page renders a page-blocking "nie skonfigurowano poświadczenia" from a **certificate-specific 409** (`certificates/page.tsx:148-153`; `requireCertCredentials` needs cert PEM material) that a token can never satisfy — read as "token save failed"; (2) a real **org-scope divergence** — core writes credentials under `resolveActiveOrganizationId(auth)` but financial_pl **reads** via `resolveOrganizationScopeForRequest → scope.selectedId ?? auth.orgId` (credential-health/route.ts, certificates/route.ts, lib/credentials.ts), so for a super-admin/org-switcher the saved token is read from a different org ("saved, still not configured").
Fix (Open Q3 resolved — **ship A now; do NOT ship B as originally written**, council F-16/F-18/F-31/F-33):
- **A (presentational, financial_pl-owned):** treat the certs-list **409** as informational ("no certificate enrolled yet; token auth may still be configured"), not a page-blocking `ErrorMessage`, and surface credential-health `token.present` as the authoritative token-configured indicator (`certificates/page.tsx:147-155,463-465`). For the common single-org caller `token.present` is already true, so **A alone fixes the visible "not configured" message**. No org-scope change.
- **B (scope) — deferred and redirected:** the naive "align credential-health + certificates reads to `resolveActiveOrganizationId(auth)`" is **wrong** — `resolveActiveOrganizationId` is request-blind (returns `auth.orgId`, never the `om_selected_org` cookie), while the **entire module** (invoice-meta PUT, invoices list, certificates, and all ~15 `readKsefCredentials` call sites in commands/workers/subscribers) scopes by `selectedId`. Switching only 2 read routes would create a super-admin **split-brain** (health shows "configured" under `auth.orgId` while every KSeF send for the switched org still fails under `selectedId`). `lib/credentials.ts` itself only *takes* a scope param — the org choice lives in the callers. **If** Phase-4 (below) proves a real divergence, fix it by scoping the credential **write** the same way the module reads (a module-owned credentials write under `selectedId`, or a core change), applied consistently to **all** call sites — never by switching reads to `auth.orgId`.
Phase-4 disambiguation (one live capture): save a token → confirm `PUT …/credentials` 200 → `GET …/credential-health`. `token.present:true` ⇒ A is sufficient (single-org case). `token.present:false` after a 200 save ⇒ the write/read org divergence is real and a follow-up (redirected B) is filed. Regression: a `credential-health` test proving A renders the token-configured state without the certs-409 blocking it.

## 📝 Architecture alignment (§ / §31)
- §14 RBAC feature-based: #43 aligns `requireFeatures` (never `requireRoles`); features already in acl.ts/setup.ts. §31-H.
- §7/§11: #49 list filter built in `buildFilters` via QueryEngine `$in`/`$nin`/`$or`; no post-filtering of arrays. §31-C.
- §8 Zod + `z.infer`, no `any`: extracted validators (#46, dates, advances). §31-C.
- §10 CrudForm/write path: all writes stay on `apiCall`/`runMutation` (already followed); no raw fetch; feedback via `flash`. §31-E.
- §16 encryption: #50 leaves the token in the encrypted integration-credentials blob (no plaintext, no hand-rolled crypto). §31-I.
- §22 DS/i18n: every new user-facing string added to all four locales (`i18n:check-sync` gate); internal messages `[internal]`; DS tokens on touched lines (Boy-Scout). §31-L.
- §30 tests: unit + route/regression tests for each changed behavior. §31-O.

## 📝 Data Model impact
None expected. No new columns/migrations: #43 is route metadata; #47 uses existing `SalesInvoicePlMeta.advancePayments`; #48 uses existing `SalesInvoice.metadata.signature`; #49 reuses `KsefSubmission`/`sales_invoice.status`; #50 reuses the existing encrypted credentials blob. (If Packet C surfaces a genuine need, it is read-scope only.)

## 📝 UI/UX
- #44 currency pre-fills from settings like VAT/price-mode.
- #45 preview reflects every header edit live.
- #46 field errors disappear on correction.
- #47 advances editor is gated to advance kinds with a hint (no silent loss).
- #48 authorized persons reappear after save.
- #49 status filter lists the right invoices.
- #50 the certificates/token surface truthfully shows the token-configured state instead of a misleading "not configured".
- Dates: impossible orderings block with a clear message; lawful-but-unusual orderings warn without blocking.

## 📝 Edge Cases & Failure Scenarios
- #43: opt-in invoice-write restriction ON → employee still blocked at the guard (correct); admin unaffected.
- #47: switching kind away from advance with advances present → explicit error, not silent strip.
- #45: tab switches must not unmount the PreviewSync bridge (topRow `hidden` group, not TabsContent).
- #46: empty form pre-first-submit must not light up; live prune only after first submit.
- #49: combined status + kind + date + search filters compose (AND) correctly; null-status handling.
- #50: single-org admin (converges), super-admin selected-org, and all-orgs must all read the token consistently; never 401 (use the scope-required 400 contract).
- Dates: advance invoices (`zal`/`kor_zal`) must not false-positive on issue-vs-sale or sale-in-future.

## 📝 Risks & Impact Review
- #49 KsefSubmission re-base is the larger change; validate query composition and the existing KSeF-status filter don't conflict. Fallback available.
- #50 scope alignment (B) touches all financial_pl KSeF credential reads — must preserve tenant scoping; verify across org modes. Misclassifying #50 as a save-path bug would be a no-op — disambiguate first.
- #46/dates validator extraction must exactly preserve the current problem keys/messages to avoid child mismatch and to keep existing tests green.
- All changes are additive/behavioral within the module; no FROZEN contract surface changes (§27).

## 📋 Phasing
1. Packet A (invoice form + meta + validators) — the bulk; #43/#44/#45/#46/#47/#48 + dates.
2. Packet B (status filter) — #49.
3. Packet C (credentials surface) — #50.
Packets are roughly file-disjoint (A=form/meta/validators, B=list route, C=credentials); the shared surface is `i18n/*.json` (additive, different key namespaces) reconciled at integration under `i18n:check-sync`.

## 📋 Implementation Plan
- **A1** invoice-meta/route.ts (#43): `metadata.PUT.requireFeatures` → `['financial_pl.view','sales.invoices.manage']`; **keep** the `invoiceWriteGuard` interceptor; align `KSEF_LOCKED_STATUSES` (F-09). Tests: metadata assertion + route test (employee principal, restriction ON/OFF) + lock test for `offline_issued`; keep invoice-write-guard.test.ts as the interceptor test.
- **A2** InvoiceForm.tsx / normalize (#44): seed `defaultCurrencyCode` **without** churning `crudInitialValues` (pre-mount seed or untouched-only); reset-safe.
- **A3** InvoiceForm.tsx (#45): mount `PreviewSync` in the mounted-hidden topRow group; verify body panels stay mounted; remount test.
- **A4** data/validators.ts (client-safe) + InvoiceForm.tsx (#46): extract **only the `problems.push`** checks into `collectInvoiceFieldProblems`; live-prune after first submit; land with A3.
- **A5** data/validators.ts + InvoiceForm.tsx (dates): `invoiceDateProblems → {errors,warnings}` (advance-kind exemption for `due≥sale`; `todayInWarsaw`) + non-blocking warning surface (DS tokens).
- **A6** InvoiceForm.tsx (+ advances component) (#47): gate advances editor on invoiceKind + hint + **submit-guard** (block, never strip).
- **A7** edit page.tsx `mapResponseToFormValue` + InvoiceForm.tsx `crudInitialValues` + header type (#48): hydrate signature/contractNumber/transportTerms/**saleDate/payment** read-back; extend the whitelist; round-trip test.
- **A8** i18n (all 4 locales en/pl/es/de): new keys (advances hint, date warnings, #50-A informational message) — `i18n:check-sync` parity.
- **B1** api/ksef/invoices/route.ts (#49): re-base status filter on `KsefSubmission` as a complete `$in`/`$nin` partition; verify query composition; route test.
- **C1** certificates/page.tsx (#50-A): certs-409 → informational; surface `token.present`; test. **C2 (#50-B) is deferred** — filed as a follow-up (redirected: scope the credentials write under `selectedId`, not switch reads to `auth.orgId`), gated behind the Phase-4 capture.

## 📋 Test Plan
- Unit (`data/__tests__/validators.test.ts`): `collectInvoiceFieldProblems`, `invoiceDateProblems` (regular + advance kinds, all hard/warn branches, Warsaw-midnight boundary), advances-gating logic.
- Route (`api/__tests__/`): invoice-meta `metadata.requireFeatures` assertion + employee-principal allow/deny (restriction ON via interceptor / OFF) (#43); the `offline_issued` lock (F-09); status filter (#49) over a null-status + queued-submission + accepted-submission fixture, both directions + composed with an issue_date/search filter.
- UI regression (council F-04/F-21 — the client fixes need automated coverage): #44 no header-reset on async currency default; #45 `PreviewSync` remount reflects live date/number/currency; #46 error pruning after first submit; #48 read-back hydrates signature/saleDate/payment into initial values; #50-A the certs-409 renders informational (not blocking) and `token.present` shows configured. Component/unit level via the module's jest infra.
- Full gate: `platform:sync:check` (waived — quarantine), `typecheck`, `yarn workspace @open-mercato/financial-pl test`, `i18n:check-sync`, `generate`, `build:packages`.
- Live QA (Phase 4, `om-auto-qa-pr` local): #45 preview, #46 error-clear, #47 advance round-trip on a ZAL invoice, #49 filter, #50 disambiguation capture + token surface, employee-role #43 create.

## 📋 Cross-repo handoffs & platform note
- **Edit-invoice PUT-500** (core) — unchanged handoff from SPEC-010; the Podatki/Uwagi edit round-trip depends on it.
- **npm quarantine** on develop 6940–6950 — interim `6931` pin + `types/ioredis-protocol-shim.d.ts`; `platform:sync:check` waived; delete shim + repin when it clears.
- **Core credentials-form** sentinel-prefill UX papercut — noted, out of scope (core).

## 📋 Resolved Decisions (were Open Questions; decided by the spec council)
1. **#49 semantic:** re-base on `KsefSubmission` as a complete `$in`/`$nin` partition. The `isInvoiceIssued`/null fallback is rejected (Wystawiona would stay permanently empty).
2. **Dates warning channel:** ship the minimal non-blocking `warnings` surface now; pair with the advance-kind `due≥sale` exemption.
3. **#50-B:** ship A only; defer B and redirect it (scope the credentials write under `selectedId`, not switch reads to `auth.orgId`), gated behind the Phase-4 capture.
4. **#47:** do both — gate the editor to advance kinds AND keep a submit-guard that blocks (never strips) advances on a non-advance kind, offering to switch kind or clear.

## 📋 Council dispositions (33 findings)
- **F-01 (blocker, `platform:sync:check` waived): ACCEPTED WAIVER, not a code defect.** The develop dist-tag (6950) is npm-quarantined and uninstallable; the branch is on the newest installable `6931` + `types/ioredis-protocol-shim.d.ts`; the waiver is user-approved and re-syncs when the quarantine clears (delete the shim on repin). Every *other* gate command is green.
- **Fixed in v2:** F-02/F-10/F-11 (#49 `$in`/`$nin` partition + composition), F-03/F-20/F-22 (open questions resolved above), F-04/F-21 (UI regression tests added), F-05/F-12 (advance-kind `due≥sale` exemption), F-06/F-07/F-08 (#43 interceptor seam + correct tests), F-09 (KSeF lock alignment), F-13 (#44 reset-safe currency seed), F-14/F-15/F-17 (#48 `crudInitialValues` + saleDate + payment + header type), F-16/F-18/F-31/F-33 (#50 ship-A, B redirected/deferred, all-callers noted), F-23/F-26 (Warsaw clock), F-27 (#46 lands with #45), F-28 (#46 extract only `problems.push`), F-29 (#45 panel-mount), F-30/F-32 (collectors kept client-safe in validators.ts).
- **F-19/F-25 (justify lowering the meta feature): documented** — `financial_pl.view`+`sales.invoices.manage` matches the create/edit gate and core POST; non-escalating; per-invoice statutory data, not KSeF config.
- **F-24 (removes access for `financial_pl.manage`-without-`sales.invoices.manage` principals): FALSE POSITIVE** — the current gate already requires BOTH (`requireFeatures` is AND), so such a principal is already denied; v2 does not change that.
