# SPEC-016 — financial_pl: coherent (progressive-disclosure) invoice editor + customer/product integration

- **Package:** `@open-mercato/financial-pl`
- **Module ID:** `financial_pl`
- **Date:** 2026-06-30
- **Status:** Draft → in implementation
- **Builds on:** SPEC-013 (invoice + KSeF backoffice), SPEC-014 (commercial editor: buyer + NIP autofill), SPEC-015 (KSeF/JPK compliance completeness)
- **One-line value:** Make the invoice editor *feel like real Polish invoicing software* — an 80% happy-path surface with the tax/KSeF complexity progressively disclosed — and turn the buyer & line inputs into first-class pickers over the Open Mercato **customers** and **catalog** modules, so a mid-market operator issues a compliant FA(3) invoice in a few fields, not sixty.

---

## TLDR

The editor (`InvoiceForm` = one `CrudForm` with four `column:1` groups: Header, Buyer, Lines, **Polish VAT**) currently renders **~60 input controls on first load** — every GTU code, procedure marker, advance-payment row, OSS country, FX field, bad-debt and exemption control is on-screen at once. No leading Polish product does this (wFirma, inFakt, Fakturownia, iFirma, SaldeoSMART all show a short core form and defer compliance fields behind collapsible "Więcej opcji"/`Dostosuj` sections or advanced tabs). The Open Mercato design system **mandates** progressive disclosure and ships the exact primitives (`CrudForm collapsibleGroups`, `Collapsible`, `accordion`, `SectionHeader`).

Three problems, all addressable **without any schema/migration/BC change** (the rare KSeF/JPK fields already work — they just shouldn't all be *visible*):

1. **Incoherent information density** — restructure into a short default surface + collapsed advanced sections.
2. **Buyer picker is name-only** — `BuyerFields` autocompletes only the company *name* string from `/api/customers/companies`; selecting a customer does **not** pull its address. Make it a real customer pick that fills name + address from the OM customer record (a per-company `/api/customers/companies/[id]?include=addresses` read). **NIP is NOT a standard customer field** (verified: companies carry no tax-id column), so the NIP continues to come from the **MF *Wykaz* "Look up"** path — which is the authoritative NIP source anyway.
3. **Lines are manual-only** — no picker over the catalog. Add a per-line product picker over `/api/catalog/products` that fills name + unit price + unit + VAT rate and records the product link. **The core invoice line accepts `sku` + a `metadata` jsonb, but has no `productId` column** (verified), so the link is stamped as line `sku` + `metadata.productId` — no core change. Free text stays the fallback.

Plus two small completeness gaps the audit surfaced: an invoice **Notes (Uwagi)** field — stored in the invoice's existing **`metadata.notes`** (the core invoice create/update schema has no `notes` field; it has a `metadata` jsonb) — and a **batch (wsadowa) "Send selected to KSeF"** list action (the `POST …/submissions/batch` backend from SPEC-015 has no UI).

> **Reconciliation note (spec-stage cross-model jury — Codex + Kimi + DeepSeek, all 3 ran).** All three independently caught that core 0.6.5's invoice/line schemas accept neither a top-level `notes` nor a line `productId`, and that customers carry no NIP — assumptions the first draft made; resolved by routing through the existing `metadata` jsonb columns + the MF lookup (zero-core-change preserved). Codex added: (a) the product price-fill must require `pricing.currency_code === invoice currency` or it silently imports a foreign-currency price (F3); (b) F4b can't be both an acceptance criterion and "droppable" → made firmly in-scope; (c) sync all four locales `en/pl/de/es`, not just en/pl. DeepSeek added the edit-mode replace/preserve rules for the buyer & product pickers; Kimi added 403-as-well-as-404 graceful degradation and the catalog `default_unit` field-name fix. Full record: `.ai/reviews/financial-pl-spec016-spec-stage-jury-2026-06-30.md`.

**Regulatory context:** mid-market (all non-micro VAT businesses) have been **obligated to issue via KSeF since 1 April 2026**; penalties start 1 Jan 2027. The module is already compliance-complete (SPEC-005→015); this spec is about making it *usable* at that scale.

---

## Problem statement

What is missing from a *usable mid-market* product — not from compliance:

- **Cognitive overload at create time.** ~60 controls, no hierarchy. An operator issuing a plain domestic 23% VAT invoice must visually skip past OSS, GTU_01…13, advance-payment fieldsets, bad-debt relief, etc. This is the single biggest UX defect and the user's primary request.
- **Buyer re-entry.** The org's customers already live in the `customers` module (`customer_entity` + company profile/billing/address), yet the buyer must be re-typed (the picker only completes the name). Re-keying NIP + address per invoice is slow and error-prone.
- **Product re-entry.** The org's products live in `catalog` (`catalog_product` + pricing), yet every line is typed by hand. The core invoice line already has `productId`/`sku`/`priceMode` columns built for exactly this link — they're unused.
- **Hidden capabilities.** Batch KSeF send and the Notes field exist in the data layer but have no UI — "logic that should be exposed in the UI."

### Non-goals (explicitly out of scope — avoid over-engineering)

- **No core modification.** All work is in `packages/financial-pl` + reads of released `@open-mercato/core` (0.6.5) public APIs.
- **No new entities, columns, migrations, or BC-surface changes.**
- **Payment method / payment terms fields** — the core *invoice* create/update contract doesn't cleanly carry `paymentMethod`/`paymentTerms` (they're order-level); not requested → deferred.
- **Separate recipient ("Inny odbiorca"/Podmiot3)** — no core invoice field; would be metadata; not requested → deferred.
- **Line-level discount (rabat), separate sale date (data sprzedaży ≠ issue date), bank-account-on-invoice, barcode scanning** — nice-to-haves, not requested → deferred.
- **Writing back to customers/catalog** (e.g. "save new buyer to contractors") — read-only integration only this round; deferred.
- **Cert-auth (XAdES) enrollment UI** — backend exists; covered as a *verification/research* item below, not a build item.

---

## Research — what real Polish invoicing software does (and what we copy)

Convergent pattern across wFirma, inFakt, Fakturownia, iFirma, SaldeoSMART:

1. **Short 80% happy path up front** (~6–8 fields): buyer, issue date (defaults to today), an editable line-items **table**, auto-computed netto/VAT/brutto totals. Numbering auto-fills.
2. **Tax-compliance complexity is deferred** — GTU, procedure markers (oznaczenia), MPP/split payment, VAT-exemption basis, currency/FX, notes — universally behind collapsible "Więcej opcji" (Fakturownia), a `Dostosuj` toggle (inFakt), or advanced tabs (wFirma `ZAAWANSOWANE`/`KSIĘGOWE`, iFirma). The cleanest model — and the one our DS supports natively — is **collapsible sections on a single page** (Fakturownia/inFakt), *not* a heavy tab/type-selection flow (iFirma).
3. **Buyer = saved-contractor picker + NIP→GUS autofill + inline new entry.** The single biggest UX lever.
4. **Products = saved-catalog type-ahead** that auto-fills unit/price/VAT, with free text as fallback.
5. **One editable line-items table**, add-row/delete-row — never a per-item modal.

**Progressive-disclosure principle (NN/g, GOV.UK):** show the common path; defer the rare; never hide *required* fields; reveal conditionally (e.g. OSS country only when OSS is on). When a deferred section contains a validation error, auto-expand it — which `CrudForm collapsibleGroups` already does.

Design decision: **collapsible sections (DS-native `collapsibleGroups` + internal `Collapsible`) for disclosure; inline type-ahead comboboxes (not modals) for the buyer & product pickers.** This satisfies the user's "tabs or modals so rare features aren't always shown" intent via the DS-idiomatic mechanism, and matches the dominant PL pattern.

---

## Design

### Architecture & constraints (ARCHITECTURE §4, §5, §11)

- **No cross-module ORM relations / imports.** Buyer & product data are read over **public HTTP APIs** (`/api/customers/companies`, `/api/catalog/products`) — never by importing core code or adding a relation. Selection produces a **snapshot** into data the invoice already owns: buyer → `SalesInvoice.metadata.buyerSnapshot` (SPEC-014); product → the core line's `name`/`unitPriceNet`/`quantityUnit`/`taxRate` + the first-class `productId`/`sku` link columns.
- **Works enabled-or-disabled.** If `customers`/`catalog` aren't mounted, the picker calls 404/empty → the field silently falls back to free text. No hard dependency, no thrown error. (Mirror the existing `loadCustomerSuggestions` try/catch-returns-`[]` pattern.)
- **Single source of truth unchanged.** Writes still go through `/api/sales/invoices` (header+lines) and `/api/financial_pl/ksef/invoice-meta` (PL-VAT). The fail-closed immutability interceptor and KSeF-locked read-only mode are untouched.
- **DS discipline (§22, om-ds-guardian).** Semantic tokens only; reuse `CrudForm`, `Collapsible`, `ComboboxInput`, `Dialog`, `flash`, `Notice`, `EmptyState`. No hardcoded colors/sizes. Keyboard a11y on pickers.

### F1 — Progressive-disclosure editor layout

Restructure `InvoiceForm` groups and enable `collapsibleGroups` so the form opens on a short surface:

**Always-expanded (the 80% path):**
- **Buyer (Nabywca)** — the enhanced picker (F2).
- **Items (Pozycje)** — the line table with the product picker (F3) + live totals.
- **Invoice details** — `invoiceNumber` (auto), `issueDate`, `dueDate`, `currencyCode`, `orderId`, **`notes` (Uwagi)** (F4a).

**Collapsed by default — "VAT & KSeF (advanced)":** the entire current `PlVatMetaForm`, wrapped so it's one click away. Internally re-organize `PlVatMetaForm` into a minimal always-visible core (invoiceKind, MPP, reverse-charge, self-billing, OSS toggle) plus **collapsible sub-sections** for the rare clusters, each closed unless it already holds a value:
  - **Foreign currency (FX)** — shown only when `currencyCode !== 'PLN'` (conditional, not just collapsed).
  - **Advance & settlement** — advance payments (ZAL), advance refs (ROZ), order snapshot; auto-shown when `invoiceKind ∈ {zal, roz, kor_zal, kor_roz}`.
  - **JPK markings** — GTU grid + procedure grid + document type (keep the existing search filter).
  - **Adjustments & exemption** — bad-debt relief, VAT-exemption basis, `issuedOutsideKsef`.

**Disclosure mechanism (grounding correction):** CrudForm's `collapsibleGroups` **cannot start a group collapsed** — it always defaults groups expanded and only persists *user* toggles (no per-group `defaultCollapsed`). So the "VAT & KSeF (advanced)" group is a **`bare: true` component group** (no CrudForm chrome) whose component renders the **accordion primitive** (`@open-mercato/ui/primitives/accordion`, `type="multiple"`) — which *does* support a computed `defaultValue`. The top-level "VAT, KSeF & JPK details" item starts **closed** unless the meta already holds a non-default value (edit mode); inside it, the core switches show inline and the rare clusters (FX, Advance & settlement, JPK markings, Adjustments & exemption) are their own accordion items whose `defaultValue` opens only when they hold a value or are contextually relevant (FX↔non-PLN, Advance↔advance kinds). This gives the start-collapsed behavior + edit-mode auto-reveal that `collapsibleGroups` can't.

**Collapse is display-only — never data-clearing.** A collapsed accordion section keeps its values mounted in form state and **always sends them** on submit; only **conditionally-irrelevant** fields are cleared (FX `exchangeRate`/`exchangeRateDate` when currency is PLN — already done in `buildMetaPayload`; advance arrays when the kind isn't an advance kind). Distinguish "collapsed" (kept) from "not applicable" (cleared).

**Acceptance:** create-mode first paint shows the buyer picker, the line table, the details group, and a single collapsed "VAT, KSeF & JPK details" section — on the order of **≤ 12** visible controls before any expansion; every advanced field remains reachable in ≤ 2 clicks, edit-mode auto-expands any section holding existing data, and an invoice round-trips identically to today (no field silently dropped or cleared by collapsing).

### F2 — Buyer = real customer picker (fills name + address; NIP via MF lookup)

Today `BuyerFields` autocompletes only the company *name* (`loadCustomerSuggestions` returns `string[]`). Upgrade it to select a customer **record** and prefill the buyer:

- `ComboboxInput` is **string-only** (`onChange(value)`, no object callback). To capture the customer id, `loadSuggestions` returns `ComboboxOption[]` with **`value = company.id`, `label = displayName`** and builds a parallel `Map<id, company>`; on `onChange(id)` resolve the record from the map (a free-typed value that isn't a map key = manual name).
- On select, **read** the company's billing address via `GET /api/customers/companies/[id]?include=addresses` (the list item carries no address) and fill `companyName`, `addressLine1`/`addressLine2` (+ building/flat), `postalCode`, `city`, `countryCode` from the primary (`isPrimary`) address. **NIP is intentionally NOT filled from the customer** — companies carry no tax-id column (verified); NIP stays the operator's job via the existing **MF *Wykaz* "Look up"** (authoritative source).
- **Edit-mode behavior (jury — DeepSeek):** an explicit customer **selection replaces** the buyer name + address (they're pre-filled from the snapshot, so a blank-only merge would no-op and the picker would seem broken). A field the operator typed *after* the last selection is preserved (track "dirtied-since-select"); a fresh selection overrides a previously-selected customer. Free typing (no map hit) uses `allowCustomValues` and never overwrites.
- **Graceful (jury — Kimi):** customers disabled (404) **or** missing `customers.companies.view` (403) → suggestions empty, no error; free-typed name is the floor. MF lookup is independent of customers availability.

**Acceptance:** picking a customer fills name + address (NIP via MF lookup, not the customer record); in edit mode selecting a *different* customer replaces name+address; an operator field edited after selection survives; with `customers` disabled/forbidden the field still accepts free text.

### F3 — Lines = catalog product picker

Add a per-line product picker to `InvoiceLinesField` (mirror the buyer combobox; `ComboboxOption{value:id,label:title}` + a `Map<id,product>`):

- Type-ahead over `GET /api/catalog/products?search=&pageSize=10`. On select, fill the line: `name ← title` (catalog returns `title`, **not** `name`), `quantityUnit ← default_unit` (catalog returns `default_unit`/`default_sales_unit`, **not** `quantityUnit`), `taxRate ← pricing.tax_rate ?? product.tax_rate` (else leave current/`23`).
- **Currency-safe price fill (jury — Codex):** fill `unitPriceNet ← pricing.unit_price_net` **only when `pricing.currency_code === the invoice's `currencyCode`** (and `pricing` is non-null). On a currency mismatch (or null pricing) leave the price blank for the operator — never silently import a foreign-currency price as if it were the invoice currency. Pass the invoice currency to the picker so it can query `?priceDate`/currency-appropriately and gate the fill.
- **Product link (grounding correction):** the core invoice line has **no `productId` column** — it accepts `sku` + a `metadata` jsonb. So `buildLinesPayload` stamps `sku ← product.sku` (top-level, persisted by core) and `metadata.productId ← product.id` (in the line's `metadata`). Add `productId`/`sku` to the editor's `InvoiceLineInput` type (they don't exist there yet).
- **Edit-mode init (jury — DeepSeek):** a line that already has a `sku`/`metadata.productId` must load with that link intact and **must not null it on load or on a manual edit of an unrelated field** — only an explicit new product selection (or clearing the line) changes the link. (Requires the detail/read route to return line `sku` + `metadata`; confirm/extend at implementation.)
- Free-text entry remains fully supported (no link). Manual edits after selection win.
- **Graceful:** catalog disabled (404) / missing `catalog.products.view` (403) / empty → picker yields nothing, line stays manual.

**Acceptance:** selecting a product fills name+unit (+price/VAT when priced) and the saved line carries `sku` + `metadata.productId` **on create**; a free-typed/cleared line carries no link; a manual line still saves; catalog disabled/forbidden → manual entry unaffected.

> **Core limitation (verified, code-jury — Codex C1):** released core 0.6.5's `sales.invoices.update` command **ignores `lines`** (it applies only header fields + invoice `metadata`; `documents.js` `buildChanges`). The CREATE command persists lines incl. `sku` + line `metadata` (documents.js:6508-6540), so the product link works on create. On EDIT, line changes (incl. changing the product link) do **not** persist — a PRE-EXISTING core constraint the SPEC-013 edit flow already assumed-away (it PUTs `lines` expecting replace-semantics core doesn't honor). Out of scope to work around here (would need a financial_pl-owned line write-path); flagged to the user as a follow-up. Because PUT ignores lines, the create-time link is also never *lost* on edit.

### F4 — Completeness gaps

- **F4a Notes (Uwagi):** the core invoice create/update schema has **no `notes` field** (verified — it has a `metadata` jsonb; there is a separate `sales_notes`/`/api/sales/notes` sub-resource but that's a different, feature-gated write path). Store the note in **`invoice.metadata.notes`** (same mechanism as `buyerSnapshot`): add a `textarea` to the Invoice-details group, merge `notes` into the metadata payload on save, read it back from `metadata.notes` in edit mode, and show it on the invoice **detail page**. To avoid a dead/invisible field, also render it on the invoice **PDF** as an optional "Uwagi" remark — **only when non-empty**, so an absent note changes no bytes (preserves SPEC-015 PDF pagination stability). Keep it **out of the FA(3) XML** (no free-text remark slot worth the schema-validation risk). No core change.
- **F4b Batch (wsadowa) send:** the invoices list is a **self-managed `DataTable<InvoiceRow>`** (`data={rows}`, no host `entityId`/`apiPath`, no selection wired today). Enable row **selection** + a **`bulkActions`** entry "Send selected to KSeF" that collects the selected ids and POSTs `{ invoiceIds }` to the existing `POST /api/financial_pl/ksef/submissions/batch`. That endpoint returns **202 `{ ok, batchReference, count }`** (one batch reference — **not** per-invoice results and **not** a progress-job id), so the UI **`flash`es the accepted count + batchReference** and refreshes the list (per-invoice KSeF status then shows in the existing status column). Add a **client-side eligibility filter** (only issued, not-yet-accepted invoices selectable / counted) so operators don't bulk-submit ineligible rows. Reuse the endpoint + SPEC-015 batch builder — no new backend. **In scope (jury — Codex):** this is a stated acceptance criterion with a mandatory test (TC-BATCH); it is implemented last in the sequence but is not optional.

---

## UMES / extension points used

- **Compose, don't inject** (ARCHITECTURE §4): F1–F4a edit `financial_pl`'s own editor components → composed directly (no self-injection).
- **Cross-module read via public API** (not ORM, not import): `/api/customers/companies` (+ `/[id]?include=addresses`), `/api/catalog/products`.
- **Existing jsonb metadata, not new columns:** product link → line `sku` (accepted column) + `line.metadata.productId`; notes → `invoice.metadata.notes`; buyer → `invoice.metadata.buyerSnapshot` (SPEC-014). No extension entity, no new column.
- **F4b** uses the self-managed list DataTable's selection + `bulkActions` + the existing submissions API.

## API contracts

No new endpoints. Consumed (released core 0.6.5, read-only):
- `GET /api/customers/companies?search&pageSize` → `{ items: [{ id, display_name, legal_name, … }] }` — **no NIP, no address on the item.**
- `GET /api/customers/companies/[id]?include=addresses` → company + `addresses: [{ addressLine1, addressLine2, buildingNumber, flatNumber, city, postalCode, country, isPrimary, … }]` (no NIP/tax-id).
- `GET /api/catalog/products?search&pageSize&priceDate?&quantityUnit?` → `{ items: [{ id, title, sku, default_unit, default_sales_unit, tax_rate, primary_currency_code, pricing?: { unit_price_net, unit_price_gross, currency_code, tax_rate } | null }] }`.

Consumed (existing financial_pl): `POST /api/financial_pl/ksef/submissions/batch` → 202 `{ ok, batchReference, count }` (F4b); `GET /api/financial_pl/ksef/company-lookup` (MF Wykaz, unchanged).
Written (existing, unchanged endpoints): `POST|PUT /api/sales/invoices` (now also line `sku` + `lines[].metadata.productId` + invoice `metadata.notes`), `PUT /api/financial_pl/ksef/invoice-meta`.

## Data model & backward compatibility

**No schema changes — no new entities, columns, migrations, or snapshot edits; no BC-surface change.** All new data rides existing jsonb `metadata` columns the core invoice + line already expose, plus the already-accepted line `sku`: buyer → `invoice.metadata.buyerSnapshot` (SPEC-014, existing); product link → line `sku` + `line.metadata.productId`; notes → `invoice.metadata.notes`. The editor's own `InvoiceLineInput` type gains `productId?`/`sku?` (module-local, not a DB column). Verified against core 0.6.5: `invoiceCreateSchema` accepts `metadata` + `lines[].metadata` + `lines[].sku` and persists them; it does **not** accept a top-level `notes` or `lines[].productId`, which is why those route through `metadata`.

---

## Phases (each buildable + gate-green)

- **Phase 1 — Editor IA / progressive disclosure (F1) + Notes (F4a).** Restructure `InvoiceForm` groups, enable `collapsibleGroups`, refactor `PlVatMetaForm` into core + collapsible sub-sections with conditional FX/advance reveal; add the Notes field. Pure frontend.
- **Phase 2 — Product catalog picker (F3).** `InvoiceLinesField` gains the product combobox + `productId`/`sku` wiring in `buildLinesPayload`.
- **Phase 3 — Buyer customer picker upgrade (F2).** `BuyerFields` selects a customer record and fills NIP+address; MF fallback retained.
- **Phase 4 — Batch send list action (F4b).** Bulk "Send selected to KSeF" wired to the existing batch endpoint. (Lowest priority.)
- **Phase 5 — i18n + integration tests + DS guard.** Add keys for all new strings to **all four locale files the package ships — `i18n/{en,pl,de,es}.json`** (jury — Codex: `i18n:check-sync` fails otherwise); Playwright `__integration__/TC-*.spec.ts`; run `om-ds-guardian` on touched UI.

Phases 1–4 touch largely disjoint files → parallelizable Codex packets; Phase 5 follows.

## Integration test coverage (mandatory — ship with the change)

- **TC-UI-IA:** create page first-paint asserts the advanced VAT/KSeF group is collapsed and a GTU control is not initially in the accessible tree; expanding reveals it; a domestic 23% invoice saves touching only the default surface.
- **TC-BUYER:** typing a customer name → selecting a suggestion fills name + address (NIP stays manual / via MF lookup); in edit mode selecting a different customer replaces name+address; an operator-typed city edited after selection survives; free-typed buyer still saves.
- **TC-PRODUCT:** searching a product → selecting fills name/unit (+price/VAT when priced) and the saved line carries `sku` + `metadata.productId`; editing an unrelated field on a linked line keeps the link; a manual line saves.
- **TC-NOTES:** notes entered on create round-trip on the edit page.
- **TC-BATCH:** selecting eligible invoices + "Send selected to KSeF" calls the batch endpoint and reports results (mock the endpoint).
- **TC-DEGRADE:** with customers/catalog disabled, buyer & line inputs fall back to free text without error.

## Verification (the user's "test in preview" + cert-auth research) — not build items

- **Preview round-trips** (DB `om_fpl_spec013`, login `superadmin@acme.com`/`secret`, dist rebuild + Claude_Preview MCP): create a domestic VAT invoice via the new short surface → issue → KSeF Send (live TEST token) → UPO → PDF; create via product+customer pickers; KOR correction; ZAL advance; received-invoices; JPK page; the batch action.
- **Certificate-auth on KSeF TEST** — document the official path: KSeF 2.0 supports auth by qualified/seal **certificate (XAdES)** as an alternative to the symmetric token. Per SPEC-007/015 + verified live: self-signed seal cert with subject **`2.5.4.97=VATPL-<NIP>` only** (no `serialNumber=TINPL-…` → 21115), current validity, generated via Node `@peculiar/x509` (LibreSSL can't encode OID 2.5.4.97); exercised by `ksef-live.test.ts` with `OM_KSEF_TEST_CERT_PEM/_KEY`. Cert *enrollment UI* remains deferred.
- **Token (TEST env only):** `OM_KSEF_TEST_NIP=2481632647`, `OM_KSEF_TEST_TOKEN=<full pipe bundle>`.

## Risks

- **Customers companies item has no NIP and no address** (verified) → name comes from the list; address from a per-company `[id]?include=addresses` read; **NIP never from the customer** (no such field) — only via MF Wykaz. Severity: low (by design).
- **Catalog `pricing` is nullable** (no price list) → fill only name/unit; leave price for the operator.
- **CrudForm `collapsibleGroups` can't start collapsed** → the advanced VAT/KSeF block is a `bare` component group rendering the **accordion primitive** with a computed `defaultValue` (start-collapsed + edit-mode auto-reveal). Severity: medium (core UX requirement; mitigated by the accordion approach).
- **Collapsing must not clear data** → collapsed sections keep + send their values; only conditionally-irrelevant fields (FX on PLN, advance arrays on non-advance kinds) are cleared. Severity: high (silent data loss) — covered by TC + payload rules.
- **Product/buyer link lost on edit-mode save** → the read route must return line `sku`+`metadata` and invoice `metadata.notes`; the picker must not null an existing link on load/unrelated edit. Severity: high (data loss) — covered by F2/F3 edit-mode rules + TC.
- **Over-hiding** — never collapse/hide a *required* field; FX/advance reveal conditionally so they're never missed when relevant.

## Definition of done

All phases gate-green (build:packages → generate → build:packages → i18n:check-sync → typecheck → test → build:app); integration tests pass; om-ds-guardian clean on changed UI; preview round-trips captured; 4-model jury reconciled; staged on `feat/financial-pl-ksef-compliance` (stop-before-PR).

## Implementation status & changelog

**2026-06-30 — Implemented (staged, stop-before-PR).** All five phases delivered across 11 source files + 4 i18n locales + 2 integration specs.
- **F1 progressive disclosure** — `PlVatMetaForm` reorganized into an always-visible core + 4 collapsible accordion clusters (FX shown only for non-PLN; advance/JPK/adjustments start collapsed unless populated); `InvoiceForm` wraps the whole PL-VAT block in a `bare` accordion group collapsed by default (edit-mode auto-expands when data exists). **Verified live**: create page first-paint shows ~21 inputs vs ~60, advanced section `data-state="closed"`, GTU grid not in the default tree, no console errors.
- **F2 buyer customer picker** — `BuyerFields` selects a customer record (`ComboboxOption{value:id}` + map), reads `/api/customers/companies/[id]?include=addresses`, fills name + address (NIP stays via MF Wykaz — customers carry no NIP). **Verified live**: selecting "Harborview Analytics" filled name + 355 Atlantic Ave / 02210 / Boston / US, NIP left blank.
- **F3 product catalog picker** — per-line combobox over `/api/catalog/products`; fills name(`title`)/unit(`default_unit`)/VAT; currency-safe price (only when `pricing.currency_code === line currency`); stamps line `sku` + `metadata.productId` (merge-safe; free-text clears the link). **Verified live**: selecting the USD-priced "Atlas Runner Sneaker" on a PLN invoice filled name+unit but correctly left price `0`. CREATE persists the link; EDIT cannot (core PUT-ignores-lines limitation, see F3 note).
- **F4a Notes (Uwagi)** — `invoice.metadata.notes`; editor textarea + detail card + guarded byte-stable PDF "Uwagi".
- **F4b Batch send** — invoices list `bulkActions` "Send selected to KSeF"; `isInvoiceIssued`-based eligibility + KSeF-status exclusion; POSTs `{invoiceIds}` to the existing batch endpoint (202), flashes count/ref + refreshes.
- **i18n** — 15 new keys added to all of `en/pl/de/es` (sync passes).
- **Tests** — unit suite green (458 passed); integration specs `TC-KSEF-UI-007` + `TC-KSEF-READ-001` authored (e2e runner unavailable in this env — pre-existing harness gap; behavior verified live in preview instead).
- **Cross-model jury** — spec-stage (3 voters) + code-stage (4 voters, 2 rounds). Round 1 surfaced 4 real bugs (FX stale, line-metadata clobber, free-text stale link, batch eligibility) + 1 tenancy (PDF projection) + 1 async race (buyer) — all fixed in round 2. Records: `.ai/reviews/financial-pl-spec016-spec-stage-jury-2026-06-30.md`, `.ai/reviews/financial-pl-spec016-code-stage-jury-2026-06-30.md`.
- **Known follow-up (out of scope)** — core 0.6.5 `PUT /api/sales/invoices` ignores `lines`, so line edits (incl. product-link changes) on existing invoices don't persist; needs a financial_pl-owned line write-path or a core change.
