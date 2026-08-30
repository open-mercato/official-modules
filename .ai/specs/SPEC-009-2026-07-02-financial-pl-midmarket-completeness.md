# SPEC-009 — financial_pl: mid-market completeness II (line discounts, gross-price entry, VAT marża, payment QR)

**Date:** 2026-07-02 · **Package:** `@open-mercato/financial-pl` · **Module:** `financial_pl` · **Branch:** `feat/financial-pl-ksef-compliance`
**Depends on:** SPEC-005 (connector), SPEC-006 (FA(3)/JPK), SPEC-007 (PDF), SPEC-008 (authoring UI) — all shipped on this branch.

## TLDR

Close the four highest-value gaps that separate the module from Polish mid-market invoicing products (wFirma, inFakt, Fakturownia):
1. **F1 — per-line discounts (rabat)** — entry in the editor, FA(3) `P_10`, PDF column, correct totals;
2. **F2 — gross-price entry (ceny brutto)** — per-invoice `netto|brutto` toggle using core's native `priceMode`/`unitPriceGross`, statutory art. 106e ust. 7 VAT-from-gross math, FA(3) `P_9B`/`P_11A`;
3. **F3 — VAT marża** — meta-level margin-scheme selection (travel/used goods/art/collectibles), FA(3) `PMarzy` annotation + gross-only rows + `P_13_11` totals, statutory PDF wording, JPK `SprzedazVAT_Marza` wiring;
4. **F4 — payment QR on the PDF** — ZBP 2D-standard transfer code next to the payment block.

Plus **F5** — four boundary integration tests the gap audit flagged (immutability-interceptor 409, `_financial_pl` enricher contract, multi-tenant isolation of the invoices join, line-edit no-lines-in-PUT boundary), and **F6** — README drift fixes (certificate auth is shipped, not a follow-up; token sunset wording).

All changes ride on **released core 0.6.5** — no core modification, no new module entities; one additive column set on `SalesInvoicePlMeta` (margin scheme + optional purchase cost) via the module's hand-authored migration mechanism.

## Resolved questions (no Open Questions gate)

- *Where does per-line discount live?* → On the **core line** — released core's `linePricingSchema` already accepts `discountAmount` + `discountPercent` per line (verified in `@open-mercato/core` 0.6.5 `dist/modules/sales/data/validators.js`). The module also sends explicit per-line `taxAmount`/`totalNetAmount`/`totalGrossAmount` (schema-accepted) so stored totals are discount-aware regardless of core's own computation; the create flow must be verified live (acceptance A-F1-4).
- *Where does gross entry live?* → Core line `priceMode: 'net'|'gross'` + `unitPriceGross` (same schema). The invoice-level toggle is UI state; per-line persisted fields are the source of truth for FA(3)/PDF.
- *Marża scope?* → Invoice-wide (a `SalesInvoicePlMeta.marginScheme` column). Mixed marża + regular lines on one invoice are **out of scope** (rare even in dedicated products; FA(3) allows it but the JPK derivation gets ambiguous) — and **actively rejected, not just undocumented**: the FA(3) resolver and the JPK `resolveSalesRow` both throw a clear error (`marginSchemeMixedLines`) when `marginScheme` is set and any line carries a `taxRate`, so a direct API client cannot produce a mis-filed document (unit-tested, A-F3-8).
- *Marża currency?* → **PLN-only in v1** (`marginSchemeRequiresPln` — enforced in the meta form AND in the FA(3)/JPK resolvers): JPK amounts must be PLN and defining FX rules for `margGross`/`marginPurchaseCost` is deferred (unit-tested, A-F3-9).
- *Discount UX?* → wFirma-style single **Rabat %** input per line (0–100, ≤2 dp). `discountAmount` is derived and displayed. Amount-first entry deferred.

## Problem statement

The SPEC-008 UI-6 gap audit and a fresh 2026-07 official-docs sweep left these as the remaining mid-market blockers: no rabat entry (table stakes in every Polish invoicing product), no gross-first pricing (retail/B2C-adjacent sellers price in brutto), no marża documents (travel, used goods, art dealers — FA(3) natively supports them and the module's own JPK builder already has `SprzedazVAT_Marza` plumbing with no upstream producer), and no płatność QR on the PDF (bank-app scan-to-pay is expected on Polish invoices).

## F1 — Per-line discounts (rabat)

### UI (create mode; lines stay read-only on edit per SPEC-008)
- New optional **Rabat %** input per line row in `components/InvoiceLinesField.tsx` (after unit price, before VAT). Accepts `0–100`, ≤2 dp, comma-decimal normalized via existing `normalizeDecimalInput`.
- Line net (net mode): `lineNet = round2(qty × unitPriceNet) − discountAmount`, where `discountAmount = round2(qty × unitPriceNet × pct/100)`. VAT and gross derive from the discounted net. In gross mode (F2) the same rule applies to the gross value.
- Totals bar and per-line computed cells reflect the discount; a "Rabat" summary line appears in the totals area only when Σ discounts > 0.

### Persistence
- Line payload gains `discountPercent`, `discountAmount`, plus explicit `taxAmount`, `totalNetAmount`, `totalGrossAmount` (all already in core's `linePricingSchema`).
- **Header totals — full set, always (fixes a live pre-existing bug):** core 0.6.5 persists header totals from the request and does NOT recompute from lines — verified in the preview DB, where every existing invoice has `0.0000` in all header total columns. The create payload therefore sends the complete set from the same pricing math the UI displays: `subtotalNetAmount`, `subtotalGrossAmount`, `discountTotalAmount` (Σ line discounts), `taxTotalAmount`, `grandTotalNetAmount`, `grandTotalGrossAmount`, `outstandingAmount` (= grand gross − `paidTotalAmount`; `paidTotalAmount` = grand gross when `payment.paid` else 0). Acceptance A-F1-4 asserts non-zero stored header totals.

### FA(3) (SPEC-006 serializer)
- `Fa3Line` gains `discount?: string` (2-dp amount). `buildLines` (lib/fa3-mapping.ts) reads the core row's `discount_amount`; the row renderer emits `P_10` between `P_9A`/`P_9B` and `P_11`/`P_11A` (XSD order: … P_9A, P_9B, **P_10**, P_11, P_11A …). Per the XSD annotation, `P_10` is emitted **only** when a discount exists and is *not* already folded into the unit price — our unit price stays pre-discount, so `P_9A×P_8B − P_10 = P_11` holds.
- Fa aggregates (`P_13_x`/`P_14_x`, `P_15`) are computed from **discounted** line values (they already sum line nets — the resolver just feeds discounted nets).

### PDF (SPEC-007)
- `InvoiceLineView` gains `discountPct?`/`discountAmount?`; the lines table renders a **Rabat** column only when at least one line has a discount (10-column layout variant); totals block gains a "Rabat łącznie" row under the same condition. i18n in 4 locales.

### Acceptance
- A-F1-1: FA(3) XML for a discounted line carries `P_10`, `P_11 = P_9A×P_8B − P_10`, and rate sums match discounted nets (unit test, exact-string level like existing fa3 tests).
- A-F1-2: PDF renders the Rabat column + total only for discounted invoices; byte-stable regression for the non-discounted baseline unchanged.
- A-F1-3: editor computes and displays discounted totals live; submit payload carries the three explicit line totals + header `discountTotalAmount`.
- A-F1-4 (live preview): a created discounted invoice shows correct stored totals in the list/detail (proves core accepted our explicit totals).

## F2 — Gross-price entry (ceny brutto)

### UI
- A `Ceny: netto | brutto` two-option control in the editor's coordinate strip (default `netto`; disabled + forced `brutto` when F3 marża is active). Toggling converts nothing retroactively — it switches which price the unit-price column edits (`unitPriceNet` vs `unitPriceGross`); already-entered rows recompute their derived side.
- In brutto mode: `lineGross = round2(qty × unitPriceGross) − discountAmount`; VAT is computed **per line** with the from-gross formula: `lineVat = round2(lineGross × rate/(100+rate))`, `lineNet = lineGross − lineVat`. **All aggregates (per-rate buckets, header totals, FA(3) `P_13_x`/`P_14_x`) are sums of these line values — never recomputed at aggregate level** (deterministic, no allocation drift between line totals, header totals, JPK buckets and FA sums).

### Persistence
- Each line stores `unitPriceGross` and the derived `unitPriceNet` plus explicit line totals — core columns (verified persisted: `unit_price_net`, `unit_price_gross`, `discount_amount`, `discount_percent`, `tax_amount`, `total_net_amount`, `total_gross_amount`).
- **Price mode bridge:** the invoice line create schema has **no `priceMode` field at all** (verified in core 0.6.5 dist — the earlier `linePricingSchema` sighting is the *order*-line shape; invoice lines accept prices/discounts/totals/`metadata` only, and unknown keys are stripped). The mode is stored invoice-wide in **invoice `metadata.priceMode: 'net'|'gross'`** (default/absent = net) — the single source of truth; no per-line mode is sent. Mixed-mode is structurally impossible (one flag per invoice).

### FA(3)
- When invoice `metadata.priceMode='gross'`: rows emit `P_9B` (unit gross) + `P_11A` (line gross) and omit `P_9A`/`P_11`; `P_12` stays; aggregates `P_14_x = Σ lineVat`, `P_13_x = Σ lineNet` (sums of per-line values per the rule above). (XSD: `P_9B`/`P_11A` are the art. 106e ust. 7/8 fields.)

### Acceptance
- A-F2-1: fa3 unit test — gross invoice emits `P_9B`/`P_11A`, no `P_9A`/`P_11`/`P_12` omissions beyond spec (P_12 still present for gross non-marża), VAT sums use from-gross math (worked example: 2 lines 9.99 gross @23 → VAT 3.74? **no** — exact expected values computed in-test, no floating drift).
- A-F2-2: editor round-trip — enter 123.00 brutto @23% → shows 100.00 netto; payload carries `priceMode:'gross'`, both unit prices.
- A-F2-3 (live KSeF TEST): a gross-mode invoice is **accepted** by api-test.ksef.mf.gov.pl (extend the env-gated `ksef-live` suite).

## F3 — VAT marża

### Meta + data model
- `SalesInvoicePlMeta` gains `marginScheme` (`travel|used_goods|art|collectibles`, nullable), `marginPurchaseCost` (decimal string, nullable — the dealer's acquisition cost used only for JPK margin math), and `marginVatRate` (numeric, nullable, default-treated as 23 — the VAT rate applicable to the margin; UI offers 23/8/5/0 since the margin is taxed at the rate applicable to the goods/service). Validation: `marginPurchaseCost` uses the module's existing `moneySchema`; `marginVatRate` is a literal union of 0|5|8|23. Additive columns → hand-authored migration `Migration20260702000000_financial_pl_margin` following the module's existing migration mechanism; zod: `data/validators.ts` meta schema + PUT route pass-through.
- UI: in the **Podatki i KSeF** tab (`PlVatMetaForm`), a "Procedura marży" select (none/travel/used goods/art/collectibles) + optional purchase-cost and margin-VAT-rate inputs (visible only when a scheme is chosen). Choosing a scheme: forces gross entry mode (F2), replaces the per-line VAT column with a read-only "marża" label, auto-sets the matching JPK procedure marking (`MR_T` for travel, `MR_UZ` for used goods/art/collectibles) in `procedureMarkings`.
- **Marża line payload (schema-exact):** core accepts `taxRate` as an *optional* numeric — marża lines send **no `taxRate` and no `taxAmount`**; they send `unitPriceGross`, `discountAmount`/`discountPercent` (if any), and `totalGrossAmount` = `totalNetAmount` = the discounted gross (no VAT is disclosed on a marża invoice, so net equals gross; header `taxTotalAmount` = 0 and grand net = grand gross for a pure marża invoice); invoice `metadata.priceMode='gross'` + meta `marginScheme` identify marża downstream. The FA(3) resolver treats `marginScheme` as invoice-wide: NO `P_12`, NO rate buckets, no bogus 0% — a unit test asserts a marża row never emits `P_12`.

### FA(3)
- `Fa3Annotations` gains `marginScheme?`; `renderAnnotations` emits `<PMarzy><P_PMarzy>1</P_PMarzy> + <P_PMarzy_2|P_PMarzy_3_1|P_PMarzy_3_2|P_PMarzy_3_3>1</…></PMarzy>` (XSD choice: travel→`P_PMarzy_2`, used goods→`P_PMarzy_3_1`, art→`P_PMarzy_3_2`, collectibles→`P_PMarzy_3_3`) instead of today's hard-coded `P_PMarzyN`.
- Rows (art. 106e ust. 2/3): emit `P_9B` + `P_11A` gross values, omit `P_9A`, `P_10`→allowed with gross semantics, `P_11`, **`P_12`** (no stawka on marża rows).
- Aggregates: marża gross total → **`P_13_11`** ("Suma wartości sprzedaży w procedurze marży, art. 119 i 120"); no `P_13_x`/`P_14_x` rate rows for marża lines; `P_15` = total due as usual.

### PDF
- Prints the **statutory wording** exactly as required by the XSD annotations: `procedura marży dla biur podróży` / `procedura marży - towary używane` / `procedura marży - dzieła sztuki` / `procedura marży - przedmioty kolekcjonerskie i antyki` in the annotations area; the VAT-summary table collapses to a single gross row labeled with the marża wording (no rate/VAT columns for marża).

### JPK
- The single call site that builds the sales register input (producer of `buildSprzedaz`'s `SprzedazInput`, currently never setting `margGross` — it is `resolveSalesRow` in `lib/jpk/resolve-jpk-filing.ts`) sets: `margGross = invoice gross` when `meta.marginScheme` is set (normal rate buckets suppressed for that document); when `marginPurchaseCost` is present and `margin = gross − cost > 0`, the positive margin is decomposed at `rate = meta.marginVatRate ?? 23` (`base = round2(margin×100/(100+rate))`, `vat = margin − base`) into that rate's K-fields; with no cost (or non-positive margin) only `SprzedazVAT_Marza` + the MR marking are emitted (operator completes the register manually — documented in README).

### Discount × marża interaction (explicit)
A discount on a marża row uses `P_10` with gross semantics: `P_9B×P_8B − P_10 = P_11A`; the margin bucket (`P_13_11`) and JPK `SprzedazVAT_Marza` use the **discounted** gross. Covered by a dedicated unit test (A-F3-5).

### Corrections (KOR) of discounted / gross / marża invoices (required — immutable KSeF invoices are only fixable via KOR)
Core 0.6.5 `creditMemoCreateSchema` lines accept `unitPriceNet/Gross`, `taxRate/​taxAmount`, totals and `metadata` — but **NOT `discountAmount`/`discountPercent`** (verified in dist; unknown keys are stripped). Therefore `lib/correction-payload.ts` (credit-memo payload builder) copies discount detail into **credit-memo line `metadata.discountAmount`/`metadata.discountPercent`**, sends `unitPriceGross` + gross totals via the native fields, and copies the invoice-level `metadata.priceMode` onto the credit-memo header metadata. `resolve-fa3-from-credit-memo.ts` must additionally read `unit_price_gross`/`total_gross_amount` and the line-metadata discount keys (today it reads only net fields), then route rows through the same row-building helpers so: a discounted KOR negates `P_10`/`P_11`, a gross-mode KOR emits negated `P_9B`/`P_11A`, and a marża KOR carries the `PMarzy` annotation + negated `P_13_11`. Acceptance: A-F3-6 unit tests cover full-reversal KOR for one discounted, one gross, one marża case.

### Acceptance
- A-F3-1: fa3 unit tests per scheme — exact `PMarzy` XML, gross-only rows, `P_13_11`, no rate sums.
- A-F3-2: JPK unit test — marża invoice yields `SprzedazVAT_Marza` + MR_T/MR_UZ (+ K-fields only when cost given, exact worked example).
- A-F3-3 (live KSeF TEST): a `used_goods` marża invoice is **accepted** on api-test.ksef.mf.gov.pl (extend `ksef-live`).
- A-F3-4: PDF snapshot carries the exact statutory wording.
- A-F3-5: discounted marża line — P_10 gross semantics invariant + discounted margin totals (unit test).
- A-F3-6: full-reversal KOR unit tests for one discounted, one gross-mode, one marża invoice (negated P_10 / P_9B+P_11A / PMarzy+P_13_11 respectively).
- A-F3-7: a marża row never emits `P_12` (explicit negative assertion).
- A-F3-8: marża invoice with a `taxRate`-bearing line → FA(3) resolver AND JPK resolveSalesRow throw `marginSchemeMixedLines`.
- A-F3-9: non-PLN marża invoice → resolvers throw `marginSchemeRequiresPln`; meta form blocks the selection with the same message.

## F4 — Payment QR (ZBP 2D) on the PDF

- New pure lib `lib/payment-qr.ts`: `buildZbpTransferString({ nip?, countryCode?, nrb, amountGrosze, name, title })` → the ZBP payload = **exactly 9 fields joined by `|` (8 separators, always)**: `NIP(10 digits or '')|countryCode(''|'PL')|NRB(26)|amount zero-padded ≥6 grosze|name mb≤20|title mb≤32|''|''|''` (last three reserved fields always empty). Reference fixture (verbatim from the upstream `bank-qrcode-formatter` BuildTest): `|PL|01234567890123456789012345|012399|Acme Inc.|Payment title|||` — **3 trailing pipes** (an earlier draft said 4; corrected against the upstream test fixtures). Our PDF caller passes `countryCode:'PL'` + the seller NIP.
- PDF: when `metadata.payment.bankAccount` is a valid 26-digit NRB (reuse `lib/bank-account.ts`), the invoice is **not** marked paid, and currency is PLN → render a "Zapłać przelewem" QR (existing `generateQrPng`) near the payment block, with the seller name (≤20) and title `FV <invoiceNumber>` (≤32). Non-PLN or paid invoices render no payment QR.
- Seller NIP: reuse the same seller-NIP source the FA(3) resolver uses for Podmiot1.

### Acceptance
- A-F4-1: unit tests for `buildZbpTransferString` — exact payload strings incl. the reference example `||01234567890123456789012345|014050|Marcin sp. z o.o.|FV 1234/2020||||`, truncation, padding, PLN-only guard at the call site.
- A-F4-2: PDF for an unpaid PLN invoice with valid NRB embeds a second QR labeled "Zapłać przelewem" (and KOD I still renders when present — no regression, positions don't overlap); paid/non-PLN/no-NRB invoices byte-identical to today.

## F5 — Boundary integration tests (gap-audit follow-ups)

- `TC-KSEF-INT-001` — immutability interceptor: create invoice + accepted `KsefSubmission` fixture → core `PUT /api/sales/invoices` and `DELETE` return **409**; without the accepted submission both pass.
- `TC-KSEF-INT-002` — enricher contract: `GET` core invoice read path carries `_financial_pl` KSeF fields for an invoice with a submission.
- `TC-KSEF-INT-003` — tenant isolation: org B token cannot see org A rows via `GET /api/financial_pl/ksef/invoices` (list + summary both empty).
- `TC-KSEF-INT-004` — line-edit boundary: module edit-save PUT payload contains **no** `lines` key; lines in DB unchanged after edit-save.
- Pattern: existing `apiRequest`/`getAuthToken`/`getTokenContext` helpers (as in `TC-KSEF-001.spec.ts`).

## F6 — README drift

- `packages/financial-pl/README.md`: certificate/XAdES auth is **shipped** (auth methods `token|certificate|auto`, cert enrollment UI, KOD II) — drop the "documented additive follow-up" wording; token para states the 2026-12-31 sunset and points to certificates as the successor + `credential-health` monitoring. Document the marża JPK manual-completion fallback (F3).

## F7 — Immutability-interceptor scope guard (bug found during this session's live baseline)

A raw `PUT /api/sales/invoices` from a session with **no selected organization** made `isInvoiceKsefLocked` query `KsefSubmission` with empty-string uuids → Postgres `invalid input syntax for type uuid: ""` → **500 "Internal interceptor error" on every unscoped invoice mutation** (observed live; UI sessions carry scope so UI editing was unaffected). Fix: fail closed on missing caller scope — treat the invoice as locked (clean 409 + the standard immutability message) without querying. Unit-tested (`api/__tests__/interceptors.test.ts`: unscoped → 409 with no DB query; scoped → unchanged pass/block behavior). Orchestrator-implemented (outside Codex packets).

## Explicitly deferred (recorded, with reasons)

| Item | Reason |
|---|---|
| Recurring invoices | needs scheduler product decisions (templates, next-run policy) — separate spec |
| E-mail invoice/PDF to buyer | needs a mail-transport/template infrastructure decision |
| Multiple numbering series | numbering is core-owned (`sales_document_sequences`) — core follow-up |
| Proforma | non-KSeF document kind; separate small spec |
| Bilingual PDF | low demand; layout rework |
| Collective payment identifier (KSeF API) | obligatory only 2027-01-01; payer-side feature |
| FA(3) structured attachments | requires per-org ZGL_ZAL registration in e-US; admin flow undefined |
| Faktura VAT RR / RR KOR | flat-rate-farmer niche; voluntary |
| PEF (B2G) FA_PEF(3) | B2G out of module scope |
| Awaria-announcement polling | offline/awaryjny issuance already supported; auto-detection is an enhancement |

## Architecture & compatibility notes

- **No core modification; UMES only.** All new behavior is module-owned: UI fields, FA(3)/PDF/JPK libs, one meta migration. Core writes go through the public `/api/sales/invoices` schema with fields that schema already accepts.
- **BC:** all changes additive. Existing invoices (no discount, net mode, no margin scheme) serialize byte-identically — **enforced mechanically** by the pre-existing FA(3) exact-string unit tests and the PDF byte-stability regression, which must pass UNCHANGED (no expected-string edits for baseline cases), plus A-F1-2/A-F4-2.
- **Rounding (single canonical rule):** all derived amounts round **half-up to 2 dp** (the module's existing `toMoney`/round2 helpers) — applied **per line**; every aggregate (per-rate bucket, header total, FA(3) `P_13_x`/`P_14_x`/`P_15`, JPK K-fields) is a **sum of the per-line values**, never recomputed from an aggregate base. (Art. 106e ust. 7 *permits* the summed-gross method but does not mandate it; per-line valuation with summation keeps lines, buckets, header totals, FA(3) and JPK exactly consistent by construction. A multi-line gross acceptance test asserts Σ lines = buckets = totals; live KSeF TEST acceptance validates the serialization.) Non-PLN gross-mode invoices reuse the existing per-line `tax_amount` FX-conversion path for `P_14_xW` unchanged.
- **Partial payments:** the module models only a boolean `payment.paid`; the payment QR always carries the full `P_15` amount when unpaid (documented; partial-payment support is out of scope). The meta PUT schema accepts the two new optional fields; older clients unaffected. No event/command signature changes.
- **Tenancy:** no new query paths; F5 adds isolation proof for the existing join.
- **i18n:** every new label/validation message in en/pl/de/es, `i18n:check-sync` green.
- **DS:** editor/PDF-adjacent UI uses existing DS components (`Input`, `Select`, two-option control styled like existing toggles); `om-ds-guardian` on touched files.

## Integration Test Coverage (ships with this change)

- `TC-KSEF-INT-001..004` (F5, above).
- `TC-KSEF-UI-010` — create-mode rabat: type a discount %, assert computed line totals + payload keys (`discountPercent`, `discountAmount`, explicit totals).
- `TC-KSEF-UI-011` — gross toggle: switch to brutto, enter 123,00 @23% → netto 100,00 shown; marża selection forces + locks brutto.
- Unit: fa3 (P_10 / gross rows / PMarzy / P_13_11), payment-qr, JPK marża, pdf-model discount/marża rows.
- Live (env-gated, `ksef-live`): discounted VAT + gross-mode VAT + marża used-goods invoices accepted on KSeF TEST.

## Implementation phases (all Codex packets, file-disjoint)

1. **P1 — libs/FA(3)+JPK** (`lib/fa3.ts`, `lib/fa3-mapping.ts`, `lib/resolve-fa3-from-invoice.ts`, `lib/payment-qr.ts` (new), JPK sales-input producer, `data/validators.ts`, `data/entities.ts` + migration) + unit tests.
2. **P2 — editor UI** (`components/InvoiceLinesField.tsx`, `components/PlVatMetaForm.tsx`, create/edit pages' payload assembly, i18n ×4).
3. **P3 — PDF** (`lib/invoice-pdf-model.ts`, `lib/invoice-pdf.ts`) + unit tests.
4. **P4 — integration tests** (TC-KSEF-INT-001..004, TC-KSEF-UI-010..011) + `ksef-live` extension + README (F6).

Each phase gates on `yarn workspace @open-mercato/financial-pl test` + typecheck; P2/P3 also DS-guardian + live preview.

## Implementation status

- [x] **P1** — libs/FA(3)/JPK/payment-qr/migration (Codex) — landed + integrated.
- [x] **P2** — editor UI (rabat, netto/brutto toggle, marża selector, i18n ×4) (Codex) — landed.
- [x] **P3** — PDF (rabat column, marża wording, payment QR) (Codex) — landed.
- [x] **P4** — integration tests (INT-001..004, UI-010/011) + ksef-live extension + README (Codex) — landed.
- [x] **F7** — interceptor fail-closed scope guard (orchestrator) — landed.

**Verification:** 525 unit/component tests pass; financial-pl src typecheck 0 errors; i18n 4-locale sync; build green. **Live KSeF TEST (api-test.ksef.mf.gov.pl) accepted** discounted-VAT, gross-mode, and used-goods-marża invoices (real KSeF numbers + UPO). All four FA(3) sample document types validate against the official crd.gov.pl FA(3) `1-0E` XSD.

**`margin_vat_rate` storage decision:** stored as a **text** column (this module has no numeric columns — every amount/rate is text), coerced to a number at the API boundary. Chosen during code-jury reconciliation to keep the MikroORM snapshot drift-free and to remove a string↔number round-trip hazard.

**Code-stage 4-model jury (post-implementation):** see the analysis record. Fixed blockers: margin mixed-mode false-rejection on core's `tax_rate=0` default (Codex+Kimi); gross-mode PDF VAT recompute-from-net drift (Codex); BC — net-line stored-total preservation (Codex); correction (KOR) UI dropping discount/gross fields (Codex); payment-QR NIP-normalization crash + pipe-injection (Kimi); MikroORM snapshot drift for the new columns (Claude). Strengthened two weak tests (Codex). Rejected as false positive: DeepSeek "marża without purchase cost = fraudulent JPK" — `SprzedazVAT_Marza` (full gross) is always emitted; only the optional K-field VAT decomposition defers to manual completion (statutorily normal).

### 2026-08-06 — final UI acceptance fixes
- Explicit, confirmed KSeF send now constitutes issuance for blank/draft/pending invoices; canceled/void invoices remain blocked. This unblocks create+send without inventing a core status transition.
- KSeF edit locks include `queued` and `offline_issued`; an offline-issued invoice exposes one send-now action rather than contradictory Send/Retry/Issue actions.
- Correction authoring stores the corrected-invoice id in metadata as a compatibility fallback and retries the same already-created credit memo after a send failure, preventing orphan/duplicate KOR documents.
- Edit prefill preserves gross unit price and discounts, the draft preview shows the configured seller, the order reference is UUID-validated before number claim, and certificate enrollment supports Cmd/Ctrl+Enter.
