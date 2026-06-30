# SPEC-017 code-stage 4-reviewer jury — 2026-06-30

Diff: `git diff HEAD` (SPEC-017, 18 files, +1674/-46). All cross-model voters advisory/local-only; Claude is the decider.

## Verdicts (round 1)
- **Claude fresh-reviewer (Opus, mandatory, independent): PASS — no blockers.** Verified FA(3) <Platnosc> ordering/conditional children, F4 edit-PUT omits lines + lines truly disabled, F3 override-tracking, dual-side payment validation, BC/tenant scoping, genuine tests. Note: 9 detail-page i18n keys missing.
- **Codex gpt-5.5 xhigh (IMPLEMENTER → down-weighted self-check): fail.** (C1) clearing termDays still re-derives due=issue+14 on issue-date change (F3 edge); (C2) detail-page i18n keys absent from all locales.
- **DeepSeek V4 Pro max (independent): fail.** (D1 CRITICAL) <Platnosc>: TerminPlatnosci before FormaPlatnosci — claimed XSD-invalid; (D2 CRITICAL) RachunekBankowy: SWIFT before NazwaBanku — claimed XSD-invalid; notes: termDays-clear, 2 i18n keys, server doesn't clear bank on non-transfer, PAYMENT_METHODS duplicated.
- **Kimi K2.7 Thinking (independent): fail** (wrapper parse-skipped; recovered via direct-binary run). (K1) `invoice-pdf.ts` duplicate `const drawPaymentBlock` → claimed TS2451; (K2) termDays-clear edge.

## Reconciliation (Claude decides; authoritative checks, not blind chasing)
- **D1 + D2 (DeepSeek CRITICAL, FA(3) ordering) → FALSE POSITIVES.** Resolved authoritatively by a **live KSeF TEST send** of a payment-bearing invoice (token auth): the exact emitted XML `…<TerminPlatnosci>…<FormaPlatnosci>6</FormaPlatnosci><RachunekBankowy><NrRB>…<SWIFT>…<NazwaBanku>…` was **ACCEPTED** (status `accepted`, KSeF number 2481632647-20260630-9D4DFF400000-0D, code 200). The real FA(3) XSD accepts this ordering; Claude's reading was correct. NOT changed.
- **K1 (Kimi, duplicate drawPaymentBlock TS2451) → FALSE POSITIVE.** Two `drawPaymentBlock` consts exist (invoice-pdf.ts:228, 442) but in SEPARATE layout-path scopes (single-page vs continuation); `tsc --noEmit` reports 0 errors in financial_pl/src and build + 18 PDF tests pass. NOT changed (minor duplication noted, functionally correct).
- **termDays-clear edge (Codex C1 + DeepSeek note + Kimi K2 — 3 voters) → REAL → FIXED.** InvoiceForm derivation effect now guards `payment.termDays !== undefined` (clearing the term leaves the due date manual). Full suite still green.
- **Detail-page i18n keys (Claude + Codex C2 + DeepSeek — 3 voters) → REAL → FIXED.** Added 9 keys (`invoices.detail.payment.{title,method,term,bankAccount,swift,paid,paidBadge,days}`, `invoices.detail.saleDate`) to en/pl/de/es; `i18n:check-sync` passes.
- Non-blocking (recorded, not chased): resolver fail-open drops the whole <Platnosc> on a partially-invalid stored payment (documented behavior, keeps XML valid); server-side doesn't strip bank fields for non-transfer (client does; harmless — RachunekBankowy is XSD-independent of FormaPlatnosci); PAYMENT_METHODS duplicated in PaymentFields + validators (identical); double due-derivation on create (idempotent).

## Outcome
cross-model: confirmed (claude PASS; codex + deepseek + kimi all reconciled) — 2 real blockers (both raised by ≥3 voters) fixed; 3 "critical" cross-model findings disproven by authoritative live-KSeF + typecheck evidence. The independent-voter payoff: the termDays edge was caught by all three cross-model voters; Kimi's recovery (direct-binary + prose-tail) worked again.
