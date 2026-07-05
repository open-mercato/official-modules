# Pre-implement analysis — SPEC-009 financial_pl mid-market completeness II

**Date:** 2026-07-02 · **Spec:** `.ai/specs/SPEC-009-2026-07-02-financial-pl-midmarket-completeness.md` · **Verdict: READY (after spec-stage jury reconciliation below)**

## BC audit (contract surfaces touched)

| Surface | Change | BC risk | Mitigation |
|---|---|---|---|
| `invoiceMetaPutSchema` (module PUT) | +3 optional nullable fields (`marginScheme`, `marginPurchaseCost`, `marginVatRate`) | none (additive, optional) | zod optional; older payloads unaffected |
| `SalesInvoicePlMeta` entity | +3 nullable columns | none | additive hand-authored migration (mirrors bad-debt pattern) |
| FA(3) serializer output | new optional row fields (`P_9B`,`P_10`,`P_11A`), `PMarzy` variants, `P_13_11` | must NOT change existing docs | default path unchanged (`P_PMarzyN`); enforced by pre-existing exact-string fa3 tests which must pass UNCHANGED |
| PDF renderer | conditional Rabat column, marża wording, payment QR | must NOT change baseline bytes | all rendering strictly conditional; pre-existing byte-stability regression must pass UNCHANGED |
| Core `/api/sales/invoices` payload | now sends discount fields, `unitPriceGross`, per-line + full header totals, `metadata.priceMode` | uses only schema-accepted fields of released core 0.6.5 (`linePricingSchema` + invoice create schema — verified in dist) | live preview check A-F1-4 |
| Credit-memo payload / KOR resolver | carries new fields through | corrections of new-mode invoices must serialize correctly | A-F3-6 unit tests |
| Events/commands | none changed | — | — |

## Empirical verifications performed before implementation

- Core 0.6.5 `linePricingSchema` accepts `discountAmount`/`discountPercent`/`priceMode`/`unitPriceGross`/`taxAmount`/`totalNetAmount`/`totalGrossAmount` (read from dist validators).
- `sales_invoice_lines` persisted columns include `unit_price_gross`, `discount_amount`, `discount_percent` but **NO `price_mode`** → invoice-level `metadata.priceMode` bridge (jury finding, confirmed).
- **Live bug confirmed:** all existing invoices in the preview DB have `0.0000` header totals — core persists request totals and never recomputes; module never sent them. SPEC-009 F1 fixes this (full header-totals payload).
- FA(3) facts grounded in the official crd.gov.pl FA(3) XSD (downloaded): `P_10` semantics + FaWiersz order, `P_9B`/`P_11A` (art. 106e ust. 7/8), `PMarzy` xsd:choice structure, `P_13_11` margin sum, marża-row field rules (art. 106e ust. 2/3).
- JPK_V7M(3)/V7K(3): `SprzedazVAT_Marza`/`ZakupVAT_Marza` support already present in module JPK builder (`margGross` input, never produced until now).
- ZBP 2D payload format cross-checked against the reference `bank-qrcode-formatter` implementation (9 fields, 8 separators, %06d grosze).

## Spec-stage cross-model jury (shift-left, advisory)

| Reviewer | Verdict | Outcome |
|---|---|---|
| Codex gpt-5.5 xhigh | fail (6 findings) | **all 6 confirmed and folded into the spec**: priceMode not persisted → metadata bridge; header totals not recomputed → full header-totals payload (fixes live zero-totals bug); marża line payload made schema-exact (no `taxRate`); KOR support for new modes added (correction-payload + resolver + A-F3-6); per-line from-gross rounding with sum-only aggregates (no allocation drift); ZBP format made canonical (9 fields, optional CC). |
| DeepSeek V4 Pro (max) | fail (3 blockers) | 2 confirmed → `marginVatRate` (configurable, default 23) + discount×marża rule (A-F3-5); 1 already-enforced (BC byte-stability = pre-existing exact-string tests, now stated explicitly). Notes folded: rounding half-up stated, toggle-conversion rule, partial-payment QR semantics documented. |
| Kimi K2.7 Thinking | first run: skipped (verdict parse); re-run vs updated spec: fail (4 critical) | **all 4 confirmed and folded in**: (K1) spec self-inconsistency between per-line and per-bucket gross-VAT rounding → canonical per-line + sum-only aggregates rule written once (Kimi's "per-bucket is mandated" is over-stated — art. 106e ust. 7 is permissive — but the inconsistency was real); (K2) credit-memo line schema has NO discount fields (verified in dist) → KOR discount detail moves to line `metadata`; (K3) mixed marża+regular lines now actively rejected in FA(3)+JPK resolvers (`marginSchemeMixedLines`, A-F3-8); (K4) marża PLN-only in v1 (`marginSchemeRequiresPln`, A-F3-9). Notes: invoice line schema has NO `priceMode` at all (my earlier `linePricingSchema` sighting was the order-line shape — corrected; metadata flag is sole carrier); KOR resolver must read gross columns; `moneySchema`/rate-literal validation; gross-FX via existing per-line tax_amount conversion. |

Claude (conductor) is the decider; all confirmed findings were fixed in the spec BEFORE packet dispatch.

## Readiness

- Packets P1–P4 (file-disjoint, window-sized) grounded and consistent with the reconciled spec.
- No unaddressed blockers. Implementation may proceed.

## Code-stage 4-model jury (post-implementation) — reconciled

Reviewed the implemented diff (production split from tests/docs to fit reviewer windows). Claude fresh-reviewer (mandatory) + Codex (down-weighted self-check — it authored the code) + Kimi + DeepSeek.

| Finding | Raised by | Verdict | Resolution |
|---|---|---|---|
| Margin mixed-mode guard rejects valid marża because core persists omitted `taxRate` as `0` | **Codex + Kimi** (independent convergence) | CONFIRMED — critical; live smoke bypassed this path (builds docs directly) | `lineCarriesTaxRate` now flags only a **positive** rate; regression test with `tax_rate:'0'` added |
| Gross-mode PDF line VAT recomputed as net×rate → line/header/PDF drift | Codex | CONFIRMED | gross-mode VAT = `gross − net` (diffMoney); net-mode unchanged |
| BC: `computeLineAmounts` recomputes net from qty×unit, breaking existing stored-total invoices | Codex | CONFIRMED | net line **without** discount serialises from stored totals (old behavior); only discounted lines recompute |
| Correction (KOR) UI drops discount/gross fields (detail API omits them) | Codex | CONFIRMED | detail API projects `unit_price_gross`/`discount_amount`/`discount_percent`; page maps them; CorrectionForm threads `priceMode` |
| payment-qr NIP not normalized → whole PDF crash; `\|` not stripped | Kimi | CONFIRMED | seller NIP normalized to bare digits + try/catch (graceful omit); `truncateMb` strips `\|`/control chars |
| MikroORM snapshot missing the 3 new columns → future `db:generate` drift | Claude | CONFIRMED | snapshot updated; `margin_vat_rate` switched to `text` (module convention) for a guaranteed-correct, drift-free shape |
| PDF discount/marża tests only assert model + valid-PDF (not rendered bytes) | Codex (tests) | CONFIRMED (weak) | byte-diff vs a no-discount / plain-23% twin added |
| TC-KSEF-INT-003 never proves org A sees its own invoice | Codex (tests) | CONFIRMED (weak) | positive org-A control (non-zero list+summary) added before the org-B emptiness check |
| Marża without purchase cost = "fraudulent zero-VAT JPK" | DeepSeek | **REJECTED (false positive)** | `SprzedazVAT_Marza` (full gross) is always emitted (resolve-jpk-filing.ts:372); only the optional K-field VAT decomposition defers to documented manual completion — statutorily normal |
| Claude minors (marginVatRate strict-`===`, marginPurchaseCost partial-decimal) | Claude | partially addressed | string↔number round-trip removed by the text-column + boundary coercion; partial-decimal is a low-risk transient |
| Kimi/DeepSeek sub-grosze rounding + hand-written-migration notes | Kimi/DeepSeek | NOTED, not actioned | margin K-field rounding is sub-grosze; hand-authored migrations are this module's established, intentional convention |

**cross-model: confirmed (codex + kimi + deepseek all ran; claude mandatory).** Every actioned blocker re-verified: 525 tests green, typecheck clean, XSD-valid, live-KSeF-accepted.
