# Handoff — PR #29 QA Remediation (financial-pl)

**Spec:** [SPEC-010](../specs/SPEC-010-2026-08-12-financial-pl-pr29-qa-remediation.md) · **Branch:** `feat/financial-pl-ksef-compliance` · **Worktree:** `/Users/haxiorz/GIT/official-modules.wt-pr29-qa`
**Base (unchanged HEAD):** `5b45e81` · **Delivery mode:** stage-only (NOT committed / pushed / PR-opened)
**QA source:** alinadivante review on [open-mercato/official-modules#29](https://github.com/open-mercato/official-modules/pull/29)

---

## 1. What this delivers

1. **Upgrade to the current Open Mercato develop build** (`0.6.8-develop.6940.1.177ea30c6e`) across the whole workspace, Yarn `4.17.1`, MikroORM `^7.1.8`, TanStack Table `^9` (with the `LegacyColumnDef` migration), `bullmq-otel`, and React `19.2.8` — QA requirement #1.
2. **Every alinadivante finding that is fixable in this repo** — P0 (#36 totals, #41 correction race), P1 (#34/#37/#38/#39/#40), P2 (#42), and the QA-warnings list.
3. **A new opt-in, server-enforced invoice-write permission** (#35) — feature `financial_pl.invoices.manage`, gated at the API interceptor seam, off by default.

Two items are **cross-repo handoffs, not code here** (§5): the #36 core PUT-500 fix and the #35 employee-grant policy decision.

---

## 2. Validation evidence (final gate, on the staged diff)

| Gate | Result |
|---|---|
| financial-pl **typecheck** | EXIT=0 ✓ |
| financial-pl **test** | **661 passed**, 14 skipped, 71/72 suites ✓ |
| financial-pl **build** | 157 entry points, built successfully ✓ |
| **sandbox generate** | All generators completed ✓ |
| **platform:sync:check** | *"Repository is in sync for channel develop"* ✓ |
| **check:dep-versions** | No major version conflicts (single-version tree) ✓ |
| **i18n:check-sync** | All 4 locales (en/pl/de/es) in sync ✓ |
| lint:ds (DeepSeek health) | report generated ✓ |

Baseline for comparison (QA-reported PR head `5b45e81` against 6940 **before** fixes): 627 pass / 14 skip, **type-check failed**. After this work: **type-check passes**, 659 pass, platform-sync clean.

---

## 3. Per-finding disposition

| # | QA finding | Disposition | Where |
|---|---|---|---|
| **#36a** | invoice PUT 500 | **Cross-repo handoff** — upstream core `documents.ts` audit-object assignment bug; fix staged in core checkout, must be published + re-pinned. | §5 |
| **#36b** | totals blank (PLN) | **Fixed** — `discount_percent` like `0.0000`/`12.5000` normalized before `computeLineTotals`; over-precise values preserved (not silently rounded) so the validator rejects them honestly. | `InvoiceLinesField.tsx` (`trimStoredDecimal`/`normalizeStoredLine`) |
| **#41** | correction created, send 404 | **Fixed** — bounded read-after-write retry (5 attempts, exp backoff): a lagging memo **header** is retried by the existence probe (unknown id still 404); the memo **lines** (separate projection query) are the genuine post-header lag → retried → public `source_not_ready` (409), client retries the same id; a genuinely-unlinked memo is a terminal, actionable 422. Integration test no longer accepts 404. | `commands/ksef-submission.ts`, `CorrectionForm.tsx`, `TC-KSEF-UI-004.spec.ts` |
| **#34** | JPK list doesn't refresh | **Fixed** — filing-create and generation split; refresh in `finally` after create even if generation fails; partial-success message. | `backend/financial/jpk/page.tsx` |
| **#38** | "Other" payment uncompletable | **Fixed** — conditional `methodOther` input; field-specific errors for method/paid-date, cleared on correction. | `PaymentFields.tsx`, `InvoiceForm.tsx` |
| **#37** | product selector clip/stale | **Fixed** — portal-free clipping removed + monotonic sequence guard + abort on the product search (stale responses discarded). Live successive-search proof is env-gated (§6). | `InvoiceLinesField.tsx` |
| **#39** | PDF raw-JSON error | **Fixed** — blob-aware download (`openKsefDownload`) distinguishes PDF from JSON error, shows a translated message + seller-config link; server 422 for missing seller kept (SPEC-007). | `lib/ksef-download.ts`, callers |
| **#40** | raw `[internal]` messages | **Fixed** — module-level public-error mapper (stable codes → translated), internal detail logged server-side only, applied across 31 route catch blocks; test asserts no `[internal]` reaches the client. | `lib/public-error.ts` |
| **#42** | Polish text in EN validation | **Fixed** — `kodUrzeduInvalid` de-leaked; i18n-parity test added. | `i18n/*.json`, `__tests__/i18n-parity.test.ts` |
| **#35** | employee can edit invoices | **New feature (opt-in) + policy handoff** — `financial_pl.invoices.manage` + interceptor guard + settings toggle; core defaults untouched (§5). | `api/interceptors.ts`, `acl.ts`, settings page, migration |
| QA warnings | future dates / due-vs-sale / NIP clip / Tailwind / cert dedup | **Fixed / hardened** (see spec As-built notes). | multiple |

---

## 4. Review evidence

- **Spec council** (multi-optimized) — ran before implementation; findings folded into spec v3 (notably F-19, delegating role grants to the core Roles UI).
- **Implementation council round 1** — 0 blockers; findings fixed (chiefly the initial #41 unknown-404/409 collapse).
- **Implementation re-review (round 2, 4-voice: fresh Claude + deepseek-v4-pro + deepseek-flash + kimi)** — authoritative fresh-Claude verdict **0 blocker / 0 major / 2 minor / 2 nit**; all four addressed in the final fix pass.
- **Fresh-Claude delta pass** over the post-re-review edits (#41 existence retry, OpenAPI strings, settings schema) — see verdict in §7.

### Reconciled surviving provider findings (conductor dispositions, code-grounded)

| Provider finding (round 2) | Disposition | Evidence |
|---|---|---|
| #41 memo-existence lag returns 404 | **Fixed** | existence check now a bounded retry that throws 404 only on exhaustion of a genuinely-absent id |
| `financial_pl.invoices.manage` "not granted in setup.ts" (deepseek ×2) | **Spurious** | empirically `matchFeature('financial_pl.invoices.manage','financial_pl.*') === true` — admin's wildcard grants it; **no admin lockout** |
| invoice-write guard "fails open on empty scope" | **Spurious** | guard is fail-**closed**: any resolution error → `catch` → 403 deny (verified in `interceptors.ts`) |
| cert enroll dedup needs atomic DB index | **Waived (follow-up)** | client in-flight guard ships now and covers the reported double-click; server-side partial-unique index documented as hardening follow-up |
| in-module full role-grant panel | **Waived (by design, F-19)** | toggle + link to canonical core `/backend/roles`, avoiding the whole-`features`-array-replace + optimistic-lock hazard |
| migration snapshot divergence | **Waived (by convention)** | module uses hand-authored migrations; migrate-from-zero verified previously |
| #37/#34 live browser tests | **Waived (env-gated)** | see §6 |

No **unresolved** confirmed blocker/major/minor remains. Surviving items are fixed, empirically-disproven, or explicitly waived with justification.

---

## 5. Cross-repo handoffs & decisions (action required outside this repo)

1. **#36 core PUT-500** — the invoice/credit-memo update 500 is an **upstream Open Mercato core** defect (`documents.ts` assigns `buildChanges()` audit objects directly to ORM fields). A field-by-field PATCH fix + regression test is staged uncommitted in the local core checkout. **Publish it as a develop build, re-pin here, and re-run the real edit/save regression** before merging PR #29. Until then, header/payment/buyer edits still 500 on save against unpatched core.
2. **#35 employee ACL policy** — this repo adds the *mechanism* (opt-in `financial_pl.invoices.manage` + guard + toggle), default-off, core defaults untouched. The *policy* call (retain current semantics / remove employee access / upstream `sales.invoices.view|manage` split) remains a product decision. Recommended short-term: retain current semantics; enable the restriction where employees must not write.

---

## 6. Environment-gated UI-test waiver

The QA release gate lists live browser tests (standard/gross/margin/payment-other/PDF/UPO/JPK partial-failure), two-tenant isolation, two-tab 409, and live KSeF/cert enrollment. These need a running app + live KSeF test endpoint + seeded multi-tenant DB — **not available in this staging environment**. They are covered structurally by unit/integration tests and are explicitly deferred as a **documented waiver** per the spec Test Plan. #36's real edit/save regression is additionally blocked on the §5.1 core publish. **These must be run before merge.**

---

## 7. Fresh-Claude delta verdict + follow-through

A fresh-context Claude pass reviewed the post-re-review delta (#41 existence retry, from-credit-memo OpenAPI, invoice-settings schema). **Verdict: APPROVE — no blocker, no major.** It verified all four #41 axes (unknown-id→404 preserved, lag→409 `source_not_ready`, no infinite loop, bounded ~4.5 s worst-case) and confirmed the `invoice-settings` schema has no drift. It raised **two non-blocking minors**, and I then investigated and **fixed both** (evidence-based, validated):

- **Minor 2 — a "permanently-unlinked" memo would loop on a retryable 409 instead of a terminal 422.** Root-caused in code: `buildCreditMemoPayload` writes `metadata.correctedInvoiceId` **and** the `invoice_id` FK at creation, and the resolver reads the link from either — both on the header row, which materializes atomically. So `credit_memo_not_linked` is **provably never a projection lag** (only a genuinely unlinked memo). Meanwhile the memo **lines** are read by a *separate* projection query (`loadNegatedCreditMemoLines`) that genuinely can lag after the header. **Fix (`isCreditMemoProjectionLag`):** retry `correction_lines_required` (the real post-header read-after-write tail → `source_not_ready` 409 on exhaustion, honoring the QA #41 mandate + the client retry), and let `credit_memo_not_linked` be a **terminal, actionable 422** ("link it to the original invoice first"). Added a unit test asserting the terminal-422, no-retry behavior.
- **Minor 1 — OpenAPI 422 list named a code that is now surfaced as 409.** Updated the from-credit-memo route docs: 422 (terminal) keeps `credit_memo_not_linked`; `correction_lines_required` moves to the 409 `source_not_ready` (projection-lag) description; the 404 note clarifies the existence-probe window.

Re-validated after this fix pass: **typecheck EXIT=0**, retry suite **12/12**, full financial-pl suite **661 passed** / 14 skipped. This is a net **correctness improvement** to the headline #41 fix, not just doc polish.

---

## 8. Suggested commit message

```
feat(financial-pl): PR #29 QA remediation + upgrade to OM develop 6940

Upgrade the workspace to Open Mercato 0.6.8-develop.6940.1.177ea30c6e
(Yarn 4.17.1, MikroORM 7.1.8, TanStack Table 9 via LegacyColumnDef,
bullmq-otel, React 19.2.8) and remediate the alinadivante QA review.

Fixes:
- #36 blank invoice totals: normalize stored discount_percent before
  recomputing line totals; reject over-precise values honestly
- #41 correction send 404: bounded read-after-write retry around the
  freshly-created credit-memo projection; public source_not_ready on
  exhaustion; client retries the same id; test no longer accepts 404
- #34 JPK list refresh split from generation (partial-success message)
- #38 "Other" payment: conditional input + field-specific errors
- #37 product selector clipping + stale-response sequence/abort guard
- #39 PDF/UPO: blob-aware download separates PDF from JSON errors
- #40 leaked [internal] messages: module public-error mapper
- #42 Polish text in English validation (kodUrzeduInvalid)
- QA warnings: future-date/due-vs-sale checks, NIP-row wrapping,
  arbitrary-Tailwind cleanup, certificate request de-duplication

Adds (opt-in, default-off, server-enforced):
- #35 financial_pl.invoices.manage feature + API interceptor guard +
  invoice-settings restriction toggle linking the core Roles UI

Cross-repo (NOT in this change): publish the upstream core documents.ts
invoice/credit-memo PUT fix and re-pin before merge; resolve the
employee-ACL policy decision.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## 9. Suggested PR description

> **PR #29 QA remediation + Open Mercato develop 6940 upgrade**
>
> Remediates the alinadivante QA review and aligns the module with the current OM develop build.
>
> **Upgrade:** OM `0.6.8-develop.6940.1.177ea30c6e`, Yarn 4.17.1, MikroORM 7.1.8, TanStack Table 9 (`LegacyColumnDef`), bullmq-otel, React 19.2.8. `platform:sync:check` clean; single-version tree.
>
> **Fixed:** #36 totals, #41 correction race, #34 JPK refresh, #37 product selector, #38 "Other" payment, #39 PDF/UPO downloads, #40 internal-message leak, #42 translation, plus the QA-warnings list.
>
> **Added:** #35 opt-in server-enforced invoice-write restriction (`financial_pl.invoices.manage`), default-off.
>
> **Gate:** typecheck / 659 tests / build / sandbox-generate / platform-sync / dep-versions / i18n all green.
>
> **⚠️ Before merge:** (1) publish the upstream core `documents.ts` PUT-500 fix and re-pin, then run the real edit/save regression; (2) run the env-gated browser + live-KSeF + multi-tenant + two-tab tests; (3) resolve the #35 employee-ACL policy decision.

---

## 10. Staged paths

83 files: 7 dependency/lockfile · 53 financial-pl product+i18n · 6 financial-pl tests · 4 forms TanStack-compat · 7 spec/process (+ this report). Full list in the run allowlist. Excluded from the staged set: `.ai/reports/ds-health-*.txt` (generated evidence) and `.ai/agentic.config.json` (git-ignored harness config).
