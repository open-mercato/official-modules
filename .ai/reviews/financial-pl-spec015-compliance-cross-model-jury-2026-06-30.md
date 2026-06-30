# Cross-model review record — SPEC-015 (financial_pl KSeF compliance completeness)

- **Date:** 2026-06-30 · **Branch:** `feat/financial-pl-ksef-compliance` (off the committed SPEC-014) · **Scope:** 7 features (inbound receiving, JPK_V7→MF e-submission, full offline+KOD II PDF, token→cert cutover, NBP FX, batch session, PDF pagination) in one branch (user-directed).
- **Jury:** Claude readiness (mandatory, in-family) + Codex gpt-5.5 xhigh + Kimi K2.7 Thinking + DeepSeek V4 Pro max.

## Spec-stage (Phase 3) — on the SPEC artifact (design review)
- **Claude readiness** `changes_needed` (4) + extensive code-verified confirmations (BC additive holds; indexes unaffected by nullable adds; interceptor + send-side untouched; PurchaseVatRecord/acl/JpkVatFiling.status='submitted'/crypto/qr-cert/pdf/fa3-mapping all as assumed). Blockers: no PUT in ksef-client transport (F2/F6); xades single-reference (F2 needs a new signer); offline mode terminology (`niedostępność` not in code, `awaria`==`awaryjny`); F4 `auto` vs the SPEC-007 never-infer guard.
- **Codex** `fail` (6): F2 package format (ZIP/DEFLATE + SHA-256 doc hash + MD5 part hash); F2 signer must be qualified (not the KSeF auth cert); F2 in-progress idempotency/crash-safety; F3 total-awaria distinct state + niedostępność-not-in-code; F1 `isTruncated` 10k-cap windowing; F1 materialize idempotency/no-clobber. Note: F5 NBP prior-business-day date.
- **DeepSeek** `fail` (2): F1 materialize idempotency (duplicate ledger rows); F1 received corrective-invoice (KOR) mapping missing. Notes: RSA "ECB" nomenclature; signer-cert differentiation; batch resubmit idempotency.
- **Kimi** `fail` (4): F2 separate qualified JPK signer (critical); F1 PurchaseVatRecord cross-module boundary (**refuted** — it is `financial_pl`'s own entity); F1 no-clobber/re-fetch + multi-NIP cursor rules; F1 undefined "auto-materialize on imp/markings". Notes: "RSA ECB PKCS#1" matches the MF metadata literal (reconciles the ECB flag); export path = premature abstraction (defer behind flag); verify acquisitionDate=legal receipt.

### High-convergence signals
- **Separate qualified JPK signer** — Codex + DeepSeek + Kimi (3 voters).
- **F1 materialize idempotency/no-clobber** — Codex + DeepSeek + Kimi (3 voters).
- **Offline-mode terminology / total-awaria** — Claude + Codex (2 voters).

### Reconciliation (all confirmed findings folded into SPEC-015 before coding; one refuted)
See the SPEC-015 changelog "spec-stage 4-model jury" entry for the per-finding resolution. Net design changes: F2 corrected crypto (ZIP/DEFLATE, SHA-256/MD5, RSA PKCS#1-v1.5 wrap) + a dedicated qualified JPK-signer credential + CAS/early-persist idempotency + a PUT-to-absolute-URL transport + a new `signJpkInitUpload`; F1 explicit-only + idempotent/transactional materialization + `isTruncated` windowing + no-clobber legal fields + per-`contextNip` cursors + received-correction linkage; F3 `awaria`==`awaryjny`, `niedostępność` new (no DB migration — free-text `mode`), total-awaria a distinct `issuedOutsideKsef`/`BFK` no-QR state, KOD II route-only via `buildKodIIUrl`; F4 `auto` a new explicit opt-in (preserves SPEC-007); F5 prior-business-day NBP date. **Spec-stage cross-model: confirmed (claude + codex + deepseek + kimi)** — all four ran and parsed; one Kimi blocker refuted against the code.

## Code-stage (Phase 8) — `-optimized` profile (Codex implemented; jury on `git diff 6e2dd0a..HEAD`)
**Implementation:** fanned out to Codex 5.5 (xhigh) across grounded, file-disjoint packets in waves (foundation → libs → backends → wires → UI/i18n/tests), each integrated + gated + committed by the orchestrator (8-commit series). Independence note: Codex authored, so Kimi + DeepSeek + the Opus fresh-reviewer carry the independent signal; Codex-review is a down-weighted self-check.

### Round 1 — all four `fail` (the gate working as intended)
- **Opus fresh-reviewer (mandatory decider)** `fail`(2): CRITICAL missing migration + un-regenerated ORM snapshot for the new entities/columns; HIGH JPK submit not early-persisting `submissionReference` after InitUpload (crash → stuck `submitting`, broken AC5). Verified everything else correct (F1 isTruncated guard + no-clobber + transactional materialize; F2 PKCS#1-v1.5 + CAS lock; F3/F4/F5/F6/F7; BC/tenancy/zod/i18n).
- **Codex** `fail`(7, down-weighted self-check): migration missing (bc); JPK raw-DEFLATE-not-ZIP; JPK not crash-safe/resumable; JPK signer fields absent from `integration.ts`; isTruncated same-day stall; PDF threshold 40≠45; batch external-before-local dup race.
- **DeepSeek** `fail`(4): JPK raw-DEFLATE-not-ZIP (critical); JPK status poll ~0.5s (critical); batch unique-violation race (high); PDF ≤45 byte-stability (medium).
- **Kimi** `fail`(4): JPK raw-DEFLATE (high); PDF ≤45 (high); total-awaria "not implemented" (high — **refuted**: Opus verified it's the by-design `issuedOutsideKsef`/BFK state); batch UPO/status reconcile missing (high).

**High-convergence:** JPK ZIP (Codex+DeepSeek+Kimi); PDF ≤45 (all 4); migration (Opus+Codex+2 notes).

### Reconciliation → fixes (loop 1, all via fresh Codex fix-packets)
1. **Migration + snapshot** (`Migration20260630000000_financial_pl_spec015.ts`) — 2 tables + 5 cols + 2 partial-unique idx; **migrate-from-zero verified on a fresh DB** (all objects created). 2. **JPK** real STORE-mode ZIP; `onReference` early-persist + resumable `submitting`; 60s status poll; `jpkSignerCertPem/_key` in `integration.ts`; `GET /jpk/submit/status`. 3. **PDF** ≤45-line byte-stability + a 45-line assertion. 4. **Batch** claims local rows (race-winner) before the external session + reconcile-worker batch UPO. **Refuted/by-design:** total-awaria (Opus-verified); isTruncated >10k-same-day (Opus-verified guarded; deferred export path).

### Round 2 — re-review the fixed diff
- **DeepSeek** `pass` (0 blockers) — round-1 fixes confirmed.
- **Opus fresh-reviewer (decider)** `fail`(1) → **fixed**: a NEW typecheck regression the batch-reconcile fix introduced — a field-projected `Loaded<KsefSubmission,…>[]` passed to `groupBatchRows(KsefSubmission[])` (TS2345) in `workers/ksef-reconcile.worker.ts`. Runtime-correct (reads projected fields, writes via `nativeUpdate`); resolved with a documented type-widening cast. Opus confirmed all 5 round-1 blockers genuinely resolved + no reward-hacks + 454 tests pass.
- **Kimi** `fail`(1) → **fixed**: `materializePurchaseRecordCommand` performed the external XML download (+auth) INSIDE `em.transactional` while holding a `PESSIMISTIC_WRITE` row lock (lock + pool connection held across an HTTP round-trip → contention/deadlock risk). Fixed: fetch the FA(3) XML BEFORE the transaction; the transaction only re-checks idempotency, persists the XML, creates the `PurchaseVatRecord` + link. Kimi confirmed all round-1 + the edges fixes resolved.
- **Codex** `fail`(4, down-weighted self-check) → **all 4 independently confirmed + fixed** (the decider acted on them because they are reproducible and two are fiscal-duplicate-safety): (1) a JPK non-timeout failure WITH a reference was reset-to-`generated` (losing the reference → re-InitUpload duplicate) → now kept resumable (re-poll the reference); (2) batch rows marked `rejected` on a post-`openBatchSession` ambiguous failure freed the unique guard → now left `processing`+batchReference (resumable by the reconcile worker); (3) `auto` selected cert without a validity check → now verifies the cert's `[notBefore,notAfter]` window, else falls back to token (preserves SPEC-007); (4) MF JPK public cert was read from an undocumented env var → now a documented `config.ts resolveJpkMfPublicCert` resolver.

### Final reconciliation
Every reproducible blocker across both rounds was fixed (round-1: 7, with the migration + JPK-early-persist as the criticals; round-2: typecheck + materialize-lock + 4 Codex fiscal-safety/config edges). Two cross-model flags were **refuted** by the Opus decider (total-awaria — the by-design `issuedOutsideKsef`/BFK state; the `isTruncated` >10k-same-day case — guarded against infinite-loop, with the async export path the deferred answer). No spurious blocker was chased. Independence held as designed: Codex (the implementer) was the down-weighted self-check; **Kimi + DeepSeek + the Opus fresh-reviewer carried the independent signal** and converged. **Code-stage cross-model: confirmed (opus + deepseek + kimi + codex) — all four ran both rounds; final state passes after the reconciled fixes.** Re-gate after all fixes: build · generate · i18n-sync · tsc **0** · jest green · migrate-from-zero PASS.

## Live verification (this session)
- **F1 inbound receive — LIVE round-trip PASS** (KSeF TEST): self-addressed invoice (seller==buyer==2481632647) accepted → `Subject2` metadata query found it → FA(3) XML downloaded (1349 B). Env-gated test added to `ksef-live.test.ts`.
- **NBP FX (F5)** — live-confirmed (EUR mid 4.289, effectiveDate D-1).
- **Migrate-from-zero** — all 6 migrations apply clean to a fresh DB; SPEC-015 tables/cols/indexes verified.
- KSeF send engine (which the receive fixture depends on) live-verified earlier this session.
- **Not live-exercised (documented):** JPK→MF submit round-trip on `test-e-dokumenty` (client unit-verified; needs the MF test public cert + a self-signed signer — env-gated recipe ready); batch session live round-trip (unit-verified). JPK dane-autoryzujące is prod-only by design.

## Gate
build:packages · generate · i18n:check-sync · our-source tsc **0** · module jest **454 passed / 11 skipped** · **migrate-from-zero PASS**. (Pre-existing vendored `@open-mercato/ui/DataTable.tsx` tsc errors are not this change.)
