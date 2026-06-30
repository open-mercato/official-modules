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

## Code-stage (Phase 8)
<!-- FILLED AFTER IMPLEMENTATION + the code-stage jury -->
