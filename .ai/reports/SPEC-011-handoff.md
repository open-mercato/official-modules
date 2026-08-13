# Handoff — Financial PL PR #29 QA Remediation Round 2 (SPEC-011)

**Branch:** `feat/financial-pl-ksef-compliance` (main worktree) · **HEAD:** `5b45e81` (unchanged — nothing committed/pushed) · **Staged:** 102 files (round-1 + round-2 code, deps, config, specs, tests). Local-only scaffolding (KSeF test-cert `*.zip`, `tmp/`) intentionally left unstaged.

## Summary

Round 2 of alinadivante's QA on PR #29 filed 8 bugs (#43 High … #50) plus two maintainer calls. This run:
1. **Consolidated round-1's remediation onto the PR branch** (it had been left staged in an orphan side-worktree `feat/financial-pl-pr29-qa-remediation`) — the prerequisite you asked for.
2. **Fixed all 8 round-2 bugs** that are fixable in this repo, plus **added the shared date cross-check rule** you requested.
3. Verified via the full gate, a spec council, and a final implementation council (fresh Claude + deepseek-v4-pro + deepseek-v4-flash + kimi).

## ⚠️ Platform / npm-quarantine situation (read this)

The `@open-mercato` **develop dist-tag builds 6940–6950 are npm-quarantined** (uninstallable; `YN0016 … are quarantined`) — including round-1's validated pin `6940` and the live develop tip `6950`. The newest **installable** build is **`6931`**, which already carries the react-table-v9 UI migration round-1's code needs. So:
- Platform is pinned to **`6931`**; **Next 16.3 / TS 6.0.3** (your bump) is kept.
- One interim shim `types/ioredis-protocol-shim.d.ts` (wired via `tsconfig.base.json` `files`) bridges a single type gap in `6931`'s `@open-mercato/shared` ratelimit source that `6940` fixes. **Delete the shim + its `tsconfig.base.json` entry and run `yarn platform:sync` when the quarantine clears / you repin to 6940+.**
- `platform:sync:check` is therefore **waived** (it resolves the live tip 6950 → quarantined → its temp install fails). Every other gate command is green.
- Root manifest re-added `jest`/`ts-jest` (main's test-infra fix — the root-context mikroorm jest transformer needs them hoisted).
Your original uncommitted dep bump is backed up at `<scratchpad>/main-uncommitted-tracked.patch`.

## Fixes (root cause → fix)

| # | Sev | Root cause | Fix | Key files |
|---|---|---|---|---|
| **#43** | High | Two-step create; the PL-meta PUT required `financial_pl.manage` (KSeF config-admin), which `employee` lacks (`view` only) → 403 → "metadane VAT" toast | requireFeatures → `['financial_pl.view','sales.invoices.manage']` (symmetric with who creates the invoice). #35 write-restriction still enforced by the `invoiceWriteGuard` **interceptor** (kept). Also aligned `KSEF_LOCKED_STATUSES` to the 4 active statuses (incl. `offline_issued`). | `api/ksef/invoice-meta/route.ts` |
| **#44** | Low/Med | Create-defaults effect read priceMode/VAT but never `defaultCurrencyCode` → stuck at PLN | Seed the settings currency **without** churning `crudInitialValues` (guarded, untouched-only) so it can't reset other header/date fields | `InvoiceForm.tsx` |
| **#45** | Low/Med | Preview's `liveHeader` bridge was dead code (`PreviewSync` never mounted) → dates/number/currency read mount-time values | Mount `PreviewSync` in the mounted-hidden `topRow` group (not a `TabsContent` panel) | `InvoiceForm.tsx` |
| **#46** | Med | `fieldErrors` (custom map) only rebuilt on submit; nothing cleared on change | Extract the `problems.push` checks to a client-safe `collectInvoiceFieldProblems`; live-prune after first submit (never adds pre-submit) | `data/validators.ts`, `InvoiceForm.tsx` |
| **#47** | Med/High | `buildMetaPayload` silently stripped advances unless kind ∈ ZAL/ROZ | Gate the advances editor to advance kinds + a **submit-guard that blocks** (never silently strips) advances on a non-advance kind | `PlVatMetaForm.tsx`, `InvoiceForm.tsx` |
| **#48** | Med | Signature/authorized-person written to `metadata.signature` but **never read back** | Hydrate signature + contractNumber + transportTerms + **saleDate + payment** in `mapResponseToFormValue`, and extend the `crudInitialValues` whitelist + header type | `edit/page.tsx`, `InvoiceForm.tsx` |
| **#49** | Med | `status` filter did exact-equality on core `sales_invoice.status`, which is **always null** for these invoices | Re-base on the module's issuance signal: Wystawiona = `id ∈` accepted/offline_issued submissions (`$in`), Robocza = `id ∉` (`$nin`) — a complete partition (verified the QueryEngine ANDs `$in`+`$nin`) | `api/ksef/invoices/route.ts` |
| **#50** | Med/High | Token **does** save (encrypted). Symptom = the certs page rendered a *certificate*-specific 409 as a page-blocking "not configured" | **#50-A**: certs-409 → informational + surface `token.present`. **#50-B deferred** (a real super-admin org-scope divergence; redirected to scope the write like the module reads, not switch reads to `auth.orgId`) | `certificates/page.tsx`, `CertificateStates.tsx` |
| **Dates** | — | 4 scattered hard `if`s; issue-vs-sale ungated | One `invoiceDateProblems() → {errors,warnings}`: HARD due≥issue (all), due≥sale (non-advance only), issue≤today; WARN issue-vs-sale + sale-future; `today` = Europe/Warsaw | `data/validators.ts`, `InvoiceForm.tsx` |

## Validation (gate)

| Command | Status |
|---|---|
| `yarn typecheck` | ✅ 4/4 |
| `yarn workspace @open-mercato/financial-pl test` | ✅ **687 passed** / 14 skipped / 75 suites (661 round-1 + **26 new round-2**) |
| `yarn i18n:check-sync` | ✅ in sync (en/pl/es/de; 28 new keys parity) |
| `yarn generate` | ✅ 306 artifacts |
| `yarn build:packages` | ✅ 4/4 (financial-pl 164 files) |
| `yarn lint:ds` | ✅ exit 0; round-2 lines add no new DS violations |
| `yarn platform:sync:check` | ⏸️ **WAIVED** — develop tip 6950 npm-quarantined (env condition; re-syncs on repin) |

## Review evidence

- **Spec council** (SPEC-011 v1→v2): 4 reviewers (fresh Claude + deepseek-v4-pro + deepseek-v4-flash + kimi), 33 findings → **all incorporated** into v2 (currency-reset hazard, `crudInitialValues` whitelist, advance-kind date exemption, #49 `$nin` partition, #50 split-brain, resolved all 4 open questions).
- **Implementation council** (final): 4 reviewers, verdict request_changes, 23 findings. **Fresh Claude (broadest context) approved** with only 1 minor + 1 nit. On verification, **0 confirmed round-2 defects** — the rest are review-scope artifacts / pre-existing / intended:
  - **Verified non-issues:** F-01/F-03 (QE `$in`+`$nin` composition — confirmed correct at `engine.js` `applyColumnOp`); F-02 (id-set scale — consistent with the route's existing pattern).
  - **False positives (round-1, outside the 17-file scope):** F-04/F-15 (`restrictInvoiceWrite` enforcement lives in round-1's `api/interceptors.ts`); F-09/F-10 (contractNumber/transportTerms keys **do** exist); F-12/F-13/F-14 (pre-existing JPK-refine wording/clock); F-07/F-21 (pre-existing).
  - **Intended / by design:** F-05 (#43 `view`+`sales.invoices.manage` — council-approved, non-escalating); F-06/F-17 (the module's existing `organizationId:null` multi-org scope pattern); F-11 (#47 hidden-editor + submit-guard — SPEC-011 Q4 accepted tradeoff, recovery message provided).
  - **Trivial nit follow-ups (not applied to preserve the exact reviewed diff):** F-16 (lock-message English fallback wording for the widened lock set), F-18 (pre-existing openApi summary omits dueTotal/rejectedCount), F-19 (one InvoiceForm test asserts via source-text), F-20 (currency ref-order edge case), F-22/F-23 (unused `validation.saleDateFuture` key).

## Human follow-ups

1. **When the npm quarantine clears / you repin to 6940+:** delete `types/ioredis-protocol-shim.d.ts` + its `tsconfig.base.json` `files` entry, run `yarn platform:sync`, re-run the gate (platform:sync:check goes green).
2. **Live QA** (env-gated, per SPEC-011 Test Plan): #45 preview reflects date edits; #46 error-clear; #47 advance round-trip on a ZAL invoice; #49 status filter; **#50 disambiguation capture** (save a token → confirm PUT 200 → GET credential-health `token.present`; `false` ⇒ the #50-B super-admin org-scope follow-up is real); employee-role #43 create.
3. **#50-B** org-scope follow-up (file it): scope the credentials **write** under `selectedId` like the module reads — never switch reads to `auth.orgId` (would split-brain super-admins).
4. **Edit-invoice PUT-500** — unchanged cross-repo handoff from SPEC-010 (core defect); the Podatki/Uwagi edit round-trip depends on a fixed core build.
5. Optional: apply the trivial nits above (F-16/F-18/F-20/F-23).

## Not committed

Nothing was committed or pushed. 102 files staged for your review; `git status` shows the local-only scaffolding (test-cert zips, `tmp/`) left unstaged.
