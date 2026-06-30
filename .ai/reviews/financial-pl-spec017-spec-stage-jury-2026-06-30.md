# SPEC-017 spec-stage cross-model jury — 2026-06-30

Artifact reviewed: `.ai/specs/SPEC-017-2026-06-30-financial-pl-invoice-mid-market-completeness.md`
Rubric: cross-model-review.spec-rubric.md. All advisory, local-only.

## Verdicts
- **Codex (gpt-5.5 xhigh): fail** — F1 payment mapping incomplete (cod/compensation); F4 narrower-than-core line shape (drops orderLineId/description/kind/discount/normalized/uomSnapshot/metadata → silent destruction for order/externally-created invoices); F4 concurrency unspecified (no version/If-Match/lock/CAS, edit-vs-send race); F4 totals must go via salesCalculationService, not hand-copied (drift).
- **Kimi K2.7 Thinking: fail** — F4 cross-module import/raw-write of core SalesInvoice(Line) breaks §4/§31-B; core has no line command + module must not modify core ⇒ needs upstream core command or explicit architectural exception; F1 cod/compensation unmapped FormaPlatnosci; F3 no override-tracking mechanism; F1 Platnosc conditional validity (Zaplacono⇒DataZaplaty, PlatnoscInna⇒OpisPlatnosci) unenforced.
- **DeepSeek V4 Pro max: fail** — F4 two-call (core PUT + module PUT) non-atomicity → inconsistent state; F4 TOCTOU without row lock; F1 IBAN plaintext at rest (PII); F3 override ambiguity. Notes: cross-module coupling; Platnosc mandatory children; concurrency test; idempotency.

## Consensus (≥2 voters)
- **F4 architecture/feasibility (Codex+Kimi+DeepSeek):** the in-module line write is unsound; the proper fix is an upstream core command. → escalate to user (functionality vs. boundary tradeoff).
- **F1 FormaPlatnosci mapping for cod/compensation (Codex+Kimi):** define matrix / drop unmapped methods. → fixed in spec.
- **F1 Platnosc conditional validity (Kimi+DeepSeek note):** add zod refine + UI. → fixed in spec.
- **F3 override tracking (Kimi+DeepSeek):** define dirty-flag mechanism. → fixed in spec.
- **F1 IBAN at rest (DeepSeek):** justify (seller account is printed on every invoice + sent to KSeF in cleartext → non-secret) — no encryption needed; documented in spec.
- **Live KSeF smoke send with payment (Codex+Kimi+DeepSeek note):** add to verification. → added.

## Resolution
F1/F2/F3 reconciled into the spec. F4 escalated to the user (recreate-via-core vs. safe read-only + upstream core fix).
