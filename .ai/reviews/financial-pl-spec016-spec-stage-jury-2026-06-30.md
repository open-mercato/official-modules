# SPEC-016 — spec-stage cross-model jury (design review, pre-implementation)

Date: 2026-06-30 · Artifact: `.ai/specs/SPEC-016-2026-06-30-financial-pl-invoice-editor-ux-coherence.md`
Rubric: `cross-model-review.spec-rubric.md` · Mode: `OM_XMR_ARTIFACT` (spec, not diff)

All three cross-model voters ran (Codex gpt-5.5 xhigh, Kimi K2.7 Thinking, DeepSeek V4 Pro max). Orchestrator (Opus) is the decider.

## Verdicts (initial draft)
| Reviewer | Verdict |
|---|---|
| Codex 5.5 (xhigh) | fail |
| Kimi K2.7 Thinking | fail |
| DeepSeek V4 Pro (max) | fail |

## Convergent critical findings (all 3, independently) → reconciled into spec
1. **Core invoice schema has no top-level `notes`** → F4a routes Notes through `invoice.metadata.notes` (existing jsonb). [Codex, Kimi]
2. **Core invoice line has no `productId` column (only `sku` + `metadata`)** → F3 stamps `sku` + `line.metadata.productId`; editor `InvoiceLineInput` gains `productId?`/`sku?`. [Codex, Kimi, DeepSeek]
3. **Customers carry no NIP/tax-id field** → F2 fills name + address only (per-company `[id]?include=addresses`); NIP stays via MF Wykaz lookup. [Codex, Kimi]

These three would have caused Codex to emit payloads with fields core silently drops (data loss) — the exact class the jury exists to catch. Verified directly against `node_modules/@open-mercato/core/dist/modules/sales/data/validators.js:584-626` (invoiceCreateSchema) + `entities.js` (SalesInvoiceLine 1679-1770).

## Additional findings → reconciled
- **Codex (correctness):** product price-fill must require `pricing.currency_code === invoice currencyCode`, else a foreign-currency price is silently imported → F3 currency-safe-fill rule added.
- **Codex (requirement):** F4b can't be both an acceptance criterion + mandatory test AND "droppable" → F4b made firmly in-scope.
- **Codex (note):** package ships `en/pl/de/es` locales → Phase 5 syncs all four (i18n:check-sync).
- **Kimi:** catalog list returns `default_unit`, not `quantityUnit` → F3 field-map fix; graceful degradation must handle 403 (missing feature) as well as 404 (module disabled) → added to F2/F3.
- **Kimi/DeepSeek:** F1 edit-mode must auto-expand sections holding existing values; collapsed ≠ cleared (only conditionally-irrelevant fields clear) → F1 disclosure + payload rules added.
- **DeepSeek:** edit-mode picker rules — selecting a customer REPLACES name+address (blank-only merge would no-op in edit mode); a linked line must not lose its `sku`/`metadata.productId` on load or unrelated edit → F2/F3 edit-mode rules added.

## Outcome
All blockers reconciled into the spec **before** any implementation packet was dispatched (shift-left). Zero-core-change invariant preserved (all new data on existing `metadata` jsonb + accepted `sku`). cross-model (spec-stage): **confirmed — all 3 ran (codex + kimi + deepseek), all reconciled.**
