# SPEC-016 — code-stage 4-model jury (final diff review)

Date: 2026-06-30 · Diff: staged SPEC-016 changes (17 files) · Range: `--staged`
Implementer: Codex (so Codex-review is a down-weighted self-check; Kimi + DeepSeek + the Claude fresh-reviewer carry the independent signal — `*-multi-optimized` independence rule).

## Round 1 verdicts
| Reviewer | Model · effort | Verdict |
|---|---|---|
| Claude fresh-reviewer (mandatory) | Opus 4.8 · max | fail (1 blocker + 1 major + 1 minor) |
| OpenAI Codex | gpt-5.5 · xhigh | fail (4) |
| Moonshot Kimi K2.7 Thinking | thinking | fail (4) |
| DeepSeek V4 Pro | reasoning max | fail (3) |

All four ran. **cross-model: confirmed (codex + kimi + deepseek) + Claude.**

## Reconciled blockers (the independence payoff — 4 real bugs + tests)
1. **Integration tests absent** (all 4) → authored in packet P8 (TC-* for progressive disclosure, pickers, notes round-trip, read-route projection, batch, degrade).
2. **FX (and advance) metadata not cleared when conditionally hidden** (Claude major + Codex C3) — EUR→PLN leaves a stale `exchangeRate` that `resolveFa3FromSalesInvoice` applies regardless of currency → wrong PLN FA(3). Verified against `invoice-meta` route. → P9 Fix 1: `buildMetaPayload` clears FX when PLN + advance arrays when kind not advance.
3. **Line `metadata` clobbered, not merged** (DeepSeek B1) — `buildLinesPayload` wrote `metadata:{productId}`, dropping other keys. → P9 Fix 2: add `metadata?` to `InvoiceLineInput`, carry through edit page, merge in `buildLinesPayload`.
4. **Free-text/cleared product combobox keeps a stale link** (DeepSeek B2 + Kimi K2, 2 voters) → P9 Fix 3: `updateLineProduct` clears `productId`/`sku`/`metadata.productId` on no-match.
5. **Batch eligibility too narrow** (Kimi K1) — literal `status === 'issued'` misses other issued states (sent/paid). → P9 Fix 4: use the module's `isInvoiceIssued()` helper; drop the dead `'sent'` KSeF-status entry.
6. **PDF `readSalesInvoiceNotes` loads encrypted columns** (Kimi K3a) — no `fields` projection. → P9 Fix 5: add `fields: ['metadata']`.
7. **Buyer selection can leave new name + OLD address** (Codex C2) — name set immediately, address filled async; save-before-return / 403-404 → mismatch. → P9 Fix 6: clear old address on selection; async fill with stale-guard.

## Verified-and-refuted (Claude is decider; not chased)
- **DeepSeek B3 "no `enableRowSelection` → batch unusable"** — REFUTED: `@open-mercato/ui` DataTable auto-enables row selection when a non-empty `bulkActions` prop is passed (`enableRowSelection: hasInjectedBulkActions`, DataTable.tsx:1496).
- **Kimi K3b "don't import generated `E`"** — REFUTED for this context: `@open-mercato/core/generated-shims/entities.ids.generated` is the sanctioned cross-package entity-id shim, already imported by 10 other files in this module.
- **Kimi K1 stated cause ("type doesn't declare status")** — the type DOES declare `status`; the real issue was the too-narrow literal match (fixed in P9 Fix 4).

## Verified core limitation (documented, not worked around — out of scope)
- **Codex C1: core 0.6.5 `PUT /api/sales/invoices` (sales.invoices.update) ignores `lines`** — verified at `node_modules/@open-mercato/core/.../commands/documents.js:6641-6657` (`buildChanges` applies only header fields + `metadata`; never processes `parsed.lines`). The CREATE command DOES persist lines incl. `sku` + `metadata` (documents.js:6508-6540). **Consequence:** the product link + any line edit persist on CREATE but NOT on EDIT — a PRE-EXISTING core limitation that the SPEC-013 edit flow already assumed-away (it sends `lines` on PUT expecting replace-semantics core doesn't honor). Not introduced by SPEC-016 and out of scope to work around here (would need a financial_pl-owned line write-path). Surfaced to the user; spec F3 edit-mode wording adjusted.

## Round 2 (post-fix — packet P9 applied all 6 fixes)
Gate re-run: build PASS · test 458 PASS · i18n-sync PASS · typecheck 0 errors in `financial_pl/src` (18 pre-existing in `node_modules/@open-mercato/ui`).

| Reviewer | Round-2 verdict |
|---|---|
| Claude fresh-reviewer (mandatory) | **pass** — all 6 fixes correct + complete, verified against `invoiceMetaPutSchema` (no 422), read-route projection, API shapes; no new regression |
| DeepSeek V4 Pro | **pass** — blockers resolved (notes advisory only) |
| Kimi K2.7 Thinking | **pass** (recovered via direct-binary brace-scan after the wrapper's print-mode parse skipped — verified FX/advance clearing, metadata merge, free-text link removal, isInvoiceIssued eligibility, PDF projection, atomic buyer fill; "no new regressions identified") |
| Codex 5.5 | not re-run round 2 (down-weighted self-check; its only un-fixed round-1 item is the documented core PUT-ignores-lines limitation, accepted out-of-scope) |

**Final: cross-model confirmed (claude + deepseek + kimi all pass round 2).** All round-1 blockers reconciled; 1 verified core limitation documented + flagged as a follow-up (not worked around).
