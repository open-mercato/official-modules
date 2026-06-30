# SPEC-014 — `financial_pl`: commercial-grade Polish invoice editor (buyer capture + NIP autofill, searchable selects, inline validation)

- **Date:** 2026-06-30
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-013](./SPEC-013-2026-06-29-financial-pl-invoice-ksef-backoffice.md) (module-owned invoice + KSeF backoffice, standalone on released core)
- **Status:** Implemented (2026-06-30) — staged, stop-before-PR.

## TLDR
**Key Points:**
- SPEC-013 gave `financial_pl` a self-contained invoice + KSeF backoffice that works on released `@open-mercato/core`. Live-verified this session (2026-06-30): the KSeF engine round-trips VAT/ZAL/UPR/OSS to the TEST API (STRICT smoke 7/8 pass), certificate (XAdES) auth accepts (`…0673FF400000-01`), self-billed is correctly rejected (410). The **engine is solid**; the **editor UX is not yet at a wFirma / inFakt / Saldeo standard**.
- Confirmed live in the running preview (`om_fpl_spec013`): the invoice **create/edit form captures NO buyer (Nabywca) at all** → a UI-authored invoice has no `metadata.buyerSnapshot`, so **Send-to-KSeF fails 422 `buyer_required`** (`buildBuyer`, `lib/fa3-mapping.ts:152`). VAT rate and unit are **free-text inputs** (typo-prone), the **taxpayer NIP is unvalidated free text** despite a working `isValidPolishNip` checksum (`lib/nip.ts`), there is **no "look up company by NIP"** affordance, and GTU + procedure markings are a **47-checkbox wall**.
- This spec makes the editor commercial-grade: a **Buyer section** persisted to the core invoice `metadata.buyerSnapshot` (the exact shape the FA(3) resolver already reads), a **NIP company lookup** (server proxy to the free MF *Wykaz podatników VAT* API → autofill name + address + VAT status), **inline validations** (NIP checksum, date order, positive amounts, buyer-required), a **VAT-rate quick-pick** (23/8/5/0 + custom), a **unit combobox**, an optional **searchable buyer picker** over core customers, and **searchable GTU/procedure-marking multiselects**.
- **No new entity, no migration, no core change.** Buyer data rides the existing core `metadata` field; the only new backend surface is one read-only NIP-lookup proxy route.

**Scope (committed):**
- **P0 — committed:** (1) Buyer section + persistence to `metadata.buyerSnapshot`; (2) NIP company lookup (new `GET /api/financial_pl/ksef/company-lookup` proxy → MF Wykaz) wired to a "Look up" action on the buyer + taxpayer NIP; (3) inline form validations; (4) line **VAT-rate picker** (23/8/5/0 + custom numeric) and **unit picker** (common-units dropdown, with an explicit "Other…" that reveals a free input — picker-first, not free text by default); (5) **GTU codes + procedure markings searchable** (a filter over the labelled set) and the OSS **consumption-country** select made searchable.
- **P1 — included if clean:** (6) searchable existing-customer picker (core `GET /api/customers/companies`) that prefills the buyer **name** (the NIP + address come from the NIP lookup — core companies carry neither in the list).

**Out of scope (documented follow-ups, NOT this change):** product-line catalog autocomplete (core `GET /api/catalog/products`); MF white-list bank-account verification / split-payment guard; bulk list actions (mass send / mass PDF); inbound invoice receiving + direct JPK e-submission (separately tracked mandatory gaps — see SPEC-011 / the 2026-06-29 audit). None are required to make the editor commercial-grade for **issuing** invoices.

**Concerns:**
- The MF Wykaz API is an external dependency: the lookup must **fail-open** (manual entry always works), be tenant-gated, time-bounded, and never block invoice authoring.
- Buyer persistence must use the **exact** snapshot keys `buildBuyer` reads, or the autofilled data won't reach FA(3).
- Editing a KSeF-`accepted` invoice's buyer must remain blocked by the SPEC-013 immutability interceptor (no regression).

## Overview
A Polish invoicing operator expects, at minimum: pick or type a buyer and pull its registry details by NIP, choose VAT rates and units from lists (not free text), get told immediately when a NIP or a date is wrong, and not hunt through a 47-checkbox grid for one GTU code. SPEC-013 built the page skeleton and wired every KSeF action; this spec raises the **editor** to the standard of the market leaders it referenced (wFirma, inFakt, Saldeo) for the **issue-an-invoice** flow. The headline is the user's explicit ask: *"we should be able to grab company details by NIP."*

> **Market reference (re-confirmed):** wFirma/inFakt/Saldeo all (a) autofill a contractor from its NIP via the MF *Wykaz podatników VAT* (Biała lista) and/or GUS, (b) offer VAT rates as a fixed list (23/8/5/0/zw/np), (c) validate the NIP checksum inline, and (d) let you pick a saved contractor. We adopt the MF Wykaz (free, no API key, returns name + working address + VAT status + REGON + bank accounts; verified live this session against NIP 5252344078). GUS REGON BIR is rejected for v1 (requires a per-deployment API key; Wykaz needs none).

## Problem Statement
1. **No buyer capture (critical).** `backend/financial/invoices/[id]/edit/InvoiceForm.tsx` header = invoice number, issue date, due date, currency, order id. There is **no buyer field**. `resolve-fa3-from-invoice` → `buildBuyer` (`lib/fa3-mapping.ts:152`) reads the buyer from `invoice.metadata.buyerSnapshot`/`.buyer`; with the form unable to set it, every UI-authored invoice without a linked order **cannot be sent** (422 `buyer_required` / `seller_required` for the buyer node). Confirmed live in preview (`hasBuyerText:false`).
2. **No "grab company details by NIP".** The user's explicit request; absent today. `isValidPolishNip` (`lib/nip.ts:19`) exists but is used only in the zod backend schema — the form gives no inline checksum feedback and no autofill.
3. **Free-text where a list belongs.** Line **VAT rate (%)** and **Unit** are `<input>` (confirmed: `inputmode=decimal` free text / `placeholder="pcs"`), inviting `2.3`-vs-`23` and unit-string drift. Commercial tools use fixed lists.
4. **GTU / procedure markings are a 47-checkbox wall** (`PlVatMetaForm`), poor for the common "tag one or two codes" case.

## Proposed Solution
All work is **client UI in `financial_pl` + one read-only server proxy route + i18n**. No entity, no migration, no core modification, no change to the FA(3)/KSeF/JPK backend.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Buyer persists to core `SalesInvoice.metadata.buyerSnapshot` (written via the existing core `POST/PUT /api/sales/invoices` `metadata` field) | `metadata` is already accepted by `invoiceCreateSchema` (core `validators.ts:846`) and is the **exact** source `readInvoiceBuyerSnapshot`/`buildBuyer` read. Zero backend change; the autofilled buyer flows straight into FA(3). Honors SPEC-013's "core `SalesInvoice` is the single source of truth, backend flows unchanged". |
| Buyer snapshot keys mirror `buildBuyer` exactly: `companyName`, `nip`, `addressLine1`, `addressLine2`, `city`, `postalCode`, `countryCode` (no `email` — `buildBuyer` doesn't read it and nothing else consumes it, so it is not captured) | `buildBuyer` reads `companyName ?? company_name ?? name`, `nip ?? taxId`, `addressLine1`, `composeCityLine(...)`, `countryCode`. Using these keys means no resolver change and a correct FA(3) Podmiot2. |
| NIP lookup is a **server-side proxy** (`GET /api/financial_pl/ksef/company-lookup?nip=`) to MF Wykaz, not a browser call | Avoids CORS, centralises the `date=today` param + timeout + error normalisation, keeps it tenant-gated (`financial_pl.view`), and lets us validate/normalise the NIP (`isValidPolishNip`) before the upstream call. **Fail-open**: any upstream error/timeout returns a structured "lookup unavailable" the UI shows as a non-blocking notice; manual entry is never gated on it. |
| VAT-rate **quick-pick** (23/8/5/0) + custom numeric — **no `zw`/`np`/`oo` line option** | Core stores `tax_rate` as `numeric(7,4)`; the four standard PL rates cover ~all domestic lines and a custom field preserves any other numeric rate. **`zw`/`np`/`oo` are deliberately NOT offered as line rates** (spec-jury blocker, Codex + DeepSeek): a non-numeric value can't persist on core's numeric column and storing exempt/reverse-charge as numeric `0` would mis-serialise it as an ordinary 0%-VAT line in FA(3)/JPK (0% ≠ zw). Exempt / reverse-charge invoices remain expressed through the existing meta fields (**VAT-exemption legal basis**, **Reverse charge**); a help note under the VAT picker points there. Full per-line `zw`/`np`/`oo` is a documented limitation on released core (today's free-text input can't store them either — core 422s a non-numeric `tax_rate`). |
| Unit **picker** (dropdown of common units: szt./pcs, kg, g, l, ml, m, m², m³, godz., km, opak., usł., kpl., t) with an explicit **"Other…"** that reveals a free input | A picker is the default path (kills unit-string drift — spec-jury, Codex); free entry stays possible for genuine custom UoM (core `quantityUnit` is a free string) but is a deliberate, secondary choice, not the default. |
| Searchable existing-customer picker uses core `GET /api/customers/companies?search=` (prefills the buyer **name** only) | Feasible on released core (route verified). Core companies carry **no NIP and no structured address** in the list → NIP/address/VAT authority stays the MF lookup or manual entry; the picker is a convenience. It is the buyer-name field itself (a combobox with free entry), so it **degrades to plain free-text** when the customers module/permission is absent — the suggestion loader simply returns nothing (403/empty swallowed); manual entry always works. |
| GTU + procedure markings → searchable multiselect | Same data (`lib/jpk-markings-codes.ts`), better affordance; keeps full labels. |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Add a buyer column/entity to the invoice | Duplicates core data + diverges from `buildBuyer`'s `metadata` read (SPEC-013 single-source rule). `metadata.buyerSnapshot` already exists and is read. |
| Call MF Wykaz directly from the browser | CORS + can't add the `date` param/timeout cleanly + leaks request shape; a thin server proxy is the canonical pattern (mirrors how the KSeF connector centralises external calls). |
| GUS REGON BIR for autofill | Requires a free-but-mandatory per-deployment API key; breaks "works standalone with zero config". MF Wykaz needs none. |
| Hard VAT-rate enum incl. `zw`/`np` as line values | Core line `tax_rate` is numeric; a non-numeric line value can't persist there. Map exemptions through the existing meta fields instead. |

## User Stories / Use Cases
- An **accountant** types a buyer NIP, clicks **Look up**, and the buyer's legal name + address fill in (and a **VAT status** badge shows *Czynny*), so the invoice is KSeF-ready without retyping.
- An **accountant** picks a **VAT rate** and **unit** from a list instead of typing them.
- An **accountant** is told inline that a NIP checksum is wrong, a due date precedes the issue date, or a line quantity is ≤ 0 — before saving.
- An **accountant** picks an **existing customer** from a searchable list to prefill the buyer.
- An **accountant** tags one **GTU** code via a searchable field rather than scanning 13 checkboxes.

## Architecture
All UI under `packages/financial-pl/src/modules/financial_pl/`. New shared `components/` are client components built only from `@open-mercato/ui` primitives (DS §22). One new API route; no new entity/migration.

```
api/ksef/company-lookup/route.ts        # NEW  GET — proxy MF Wykaz podatników VAT (read-only, fail-open)
lib/company-lookup.ts                    # NEW  fetch+normalise MF Wykaz response → CompanyLookupResult (no secrets, timeout)
lib/nip.ts                               # reuse isValidPolishNip (+ a small formatNip helper if needed)
components/BuyerFields.tsx                # NEW  buyer subform (name/nip/address/country) + "Look up" + customer-search name combobox
lib/buyer-snapshot.ts                     # NEW  pure buyer ⇄ metadata.buyerSnapshot mappers (React-free, unit-tested)
components/InvoiceLinesField.tsx          # MODIFY  VAT-rate quick-pick select + unit combobox; keep computed totals
components/PlVatMetaForm.tsx              # MODIFY  GTU + procedure markings → searchable multiselect (same codes)
backend/financial/invoices/[id]/edit/InvoiceForm.tsx   # MODIFY  add Buyer section; map buyer ⇄ metadata.buyerSnapshot; inline validation
backend/financial/invoices/create/page.tsx             # MODIFY  (uses InvoiceForm) — buyer empty-state
backend/financial/invoices/[id]/page.tsx               # MODIFY  show buyer in the read summary
data/validators.ts                       # MODIFY  zod schema for the company-lookup query (nip) + response type
i18n/{en,pl,de,es}.json                  # MODIFY  new keys (buyer, lookup, vat-rate labels, units, validation messages, vat-status)
README.md                                # MODIFY  document the buyer-on-metadata contract + the NIP-lookup route + its external dep
```

### Data flow
- **Create/edit:** the editor sends `metadata: { ...existingMetadata, buyerSnapshot: { companyName, nip, addressLine1, addressLine2, city, postalCode, countryCode } }` in the core `POST/PUT /api/sales/invoices` body. **On edit the form carries the loaded `value.metadata` and spreads it before setting `buyerSnapshot`, so other metadata keys are preserved, never clobbered** (spec-jury, DeepSeek). `buyerSnapshot` is omitted entirely when the buyer is empty. Update keeps SPEC-013 replace-semantics for `lines[]`.
- **Edit prefill / detail:** read `invoice.metadata.buyerSnapshot`. **Confirmed: the detail route `api/ksef/invoices/[id]/route.ts` already returns the core invoice `metadata` (full-row QueryEngine read → `metadata: invoiceRow.metadata ?? null`, route.ts:262; `invoiceSchema.metadata`, route.ts:355), so no read-route change is needed** for prefill/detail. The edit loader extracts `metadata.buyerSnapshot` into the form's buyer fields and carries the whole `metadata` for the merge above. The list route does not surface a buyer (a buyer list column is out of scope).
- **NIP lookup:** `BuyerFields` → `apiCall('/api/financial_pl/ksef/company-lookup?nip=<digits>')` → `lib/company-lookup.ts` validates the NIP, calls `https://wl-api.mf.gov.pl/api/search/nip/{nip}?date=<YYYY-MM-DD today>` with a ≤ 6 s timeout, maps `result.subject` → `{ name, nip, statusVat, regon, address }` (address = `workingAddress ?? residenceAddress`; `accountNumbers` dropped), and the route returns `{ ok:true, company }` or `{ ok:false, reason }`. On `ok:true` the UI fills empty buyer fields (never silently overwrites a field the user already edited) and shows the VAT-status badge. The looked-up `address` is a single string → mapped into `addressLine1` (graceful — spec-jury note, DeepSeek; the operator can split it across line1/line2 manually).
- **Send-to-KSeF** unchanged — it now finds a populated `buyerSnapshot` and builds Podmiot2 without 422.

### API interceptors / immutability
Unchanged. The SPEC-013 fail-closed interceptors on `sales.invoices` PUT/DELETE + `invoice-meta` PUT still reject edits to a KSeF-`accepted`/`processing` invoice (including its buyer) — verified not regressed by an integration assertion.

### Commands & Events
None new. Buyer writes dispatch the existing core `sales.invoices.create/update`. The lookup route dispatches nothing (read-only external call).

## Data Models
**No new entity, no migration.** Buyer rides core `SalesInvoice.metadata` (JSONB, already persisted). `CompanyLookupResult` is a transient zod-typed shape, not stored.

## API Contracts
### New: company lookup (read-only proxy)
- `GET /api/financial_pl/ksef/company-lookup?nip=<10 digits>` — `metadata.GET = { requireAuth: true, requireFeatures: ['financial_pl.view'] }`; `openApi` documented.
- 400 when the NIP fails `isValidPolishNip`. On success: `{ ok: true, company: { nip, name, statusVat: 'Czynny'|'Zwolniony'|'Niezarejestrowany'|string|null, regon, address } }`. **`accountNumbers` is intentionally NOT exposed** (spec-jury note, Codex): MF returns it, but white-list bank-account verification is out of scope, so the route drops it rather than leak an unused field. On upstream failure/timeout: HTTP 200 `{ ok: false, reason: 'unavailable'|'not_found' }` (fail-open; the UI shows a non-blocking notice). No secrets; no tenant data leaves the system beyond the looked-up NIP.
- Zod-validate the query (`data/validators.ts`); response typed via `z.infer`. Tenant scoping not applicable (no DB read) but auth/feature gate enforced.

### Reused (unchanged)
- Core `POST/PUT /api/sales/invoices` (`metadata` accepted; `sales.invoices.manage`).
- Core `GET /api/customers/companies?search=` (`customers.companies.view`) — P1 picker only.
- All SPEC-013 `financial_pl` routes (invoice list, invoice-meta, submissions, upo, pdf, jpk, certificates) — unchanged.

## Internationalization (i18n)
New keys in en/pl/de/es, namespaced `financial_pl.*` (added to all four locales — `i18n:check-sync` green): buyer section (`invoices.form.sections.buyer`, `invoices.detail.buyer`, `buyer.companyName`, `buyer.companyNamePlaceholder`, `buyer.nip`, `buyer.addressLine1/2`, `buyer.postalCode`, `buyer.city`, `buyer.country`); lookup (`buyer.lookup`, `buyer.vatStatus`, `buyer.lookupUnavailable`, `buyer.lookupNotFound`); validation (`validation.nipChecksum`, `validation.nipChecksumBuyer`, `validation.nipChecksumTaxpayer`, `validation.dueBeforeIssue`, `validation.quantityPositive`, `validation.unitPricePositive`, `validation.buyerRequired`, `validation.buyerRequiredUpr`); pickers (`lines.taxRateOther/taxRatePlaceholder/taxRateCustom`, `lines.unitOther/quantityUnitCustom/quantityUnitCustomPlaceholder`, `fields.gtuFilter/procedureFilter/consumptionCountryPlaceholder`). No hardcoded user-facing strings; internal/log strings prefixed `[internal]`.

## UI/UX
- **Buyer section** (new card above/after Invoice details): optional **"Pick existing customer"** searchable combobox (P1) → then **Company name**, **NIP** with an inline **Look up** button + a small **VAT-status badge** (`StatusBadge`, semantic tokens) after a successful lookup, **Address line 1/2**, **Postal code**, **City**, **Country** (default `PL`), optional **Email**. Inline NIP-checksum error via `FormField`. For **UPR** invoice kind, name/address become optional (NIP-only buyer allowed) — mirrors `buildBuyer`'s UPR branch.
- **Lines:** **VAT rate** → picker (`23%`, `8%`, `5%`, `0%`, `Other…`→numeric input); a help note: "for exempt (zw) / reverse-charge, set 0% and use the Polish-VAT section". **Unit** → picker (common-units dropdown + `Other…`→free input). Net/VAT/gross totals stay computed/read-only.
- **PL-VAT meta:** GTU codes + procedure markings get a **filter box** above the labelled grid (type a code/word → narrows the visible options); the OSS **consumption-country** select becomes a searchable combobox. Other fields unchanged.
- **Validation:** block save + show inline errors when — NIP checksum invalid (buyer/taxpayer), due date < issue date, **any line quantity ≤ 0** (a line needs a real quantity) or **unit price < 0** (0 is allowed — free/sample/100%-discount lines are valid), no lines, or buyer missing for a non-UPR kind. Uses `CrudForm`/`FormField` error surfaces + `Alert`, not browser `alert`.
- **Detail page:** render the buyer (name + NIP + address) in the read summary.
- DS: semantic tokens only (§22), `@open-mercato/ui` primitives, `lucide-react` icons with `aria-label`, `Cmd/Ctrl+Enter` submit / `Escape` cancel preserved, `flash()`/`Alert` for feedback.

## Migration & Compatibility
- **No DB migration, no entity change.** Buyer uses an existing JSONB field; merging into `metadata` is additive and preserves unrelated keys.
- **BC:** purely additive — one new GET route, new/extended client components, new i18n keys. No API URL/contract/event/ACL change. `metadata.buyerSnapshot` is the shape `buildBuyer` already reads (so older invoices that happened to carry it keep working; new ones now populate it from the UI). The SPEC-013 immutability interceptor and effective-contract are unchanged. `yarn generate` re-emits route registries.
- **ACL:** no new feature IDs. The lookup route gates on existing `financial_pl.view`; the customer picker gates on existing core `customers.companies.view` (hidden if absent).

## Risks & Impact Review

### MF Wykaz API unavailable / slow / rate-limited
- **Scenario:** the external API is down, slow, or throttles; lookups hang or error.
- **Severity:** Medium · **Affected area:** `company-lookup` route + Buyer section.
- **Mitigation:** ≤ 6 s timeout (`AbortController`), structured `{ ok:false }` fail-open, non-blocking UI notice, manual buyer entry always available; the route never throws into the invoice save path. No retry storms (single attempt per click).
- **Residual risk:** Low (lookup is a convenience; authoring never depends on it).

### Autofilled buyer doesn't reach FA(3)
- **Scenario:** snapshot keys drift from what `buildBuyer` reads → buyer silently empty at send → 422.
- **Severity:** High · **Affected area:** create/edit → KSeF send.
- **Mitigation:** persist the **exact** keys `buildBuyer` consumes; a unit test asserts the editor's `metadata.buyerSnapshot` payload maps 1:1 to `buildBuyer` (and an integration test authors → sends and asserts no `buyer_required`).
- **Residual risk:** Low (pinned by tests to the resolver's contract).

### Overwriting operator-entered buyer data on lookup
- **Scenario:** a lookup clobbers a field the operator already typed.
- **Severity:** Low · **Affected area:** Buyer section.
- **Mitigation:** lookup fills **blank** fields by default; replacing populated fields requires an explicit user action; never overwrites the NIP the user typed.
- **Residual risk:** Low.

### Regression of KSeF-accepted immutability
- **Scenario:** the new buyer write path bypasses the SPEC-013 interceptor.
- **Severity:** High · **Affected area:** edit of an accepted invoice.
- **Mitigation:** buyer writes go through the same core `PUT /api/sales/invoices` the interceptor guards; an integration assertion confirms a buyer edit on an `accepted` invoice still 409s.
- **Residual risk:** Negligible.

### Sending the looked-up NIP to an external service (privacy)
- **Scenario:** a counterparty NIP is sent to MF.
- **Severity:** Low · **Affected area:** lookup route.
- **Mitigation:** only the **public** business NIP the operator is invoicing is sent (the same data printed on the invoice); the MF Wykaz is a public statutory register; no tenant/personal data beyond the NIP leaves the system; documented in the README.
- **Residual risk:** Low (matches every PL invoicing tool's behavior).

## Final Compliance Report
- No cross-module ORM relations (buyer via core invoice `metadata`; lookup is a stateless external call). Tenant/feature gate on the new route (`financial_pl.view`); zod at the new boundary, `z.infer` types, no `any`. External call time-bounded + fail-open; no secrets. Design-system tokens + `@open-mercato/ui` primitives + i18n in all four locales. No new ACL; no DB change; `yarn generate` after the route is added. ARCHITECTURE §11 (own UI by composition), §15 (tenancy/auth), §22 (DS/i18n), §27 (no contract break) satisfied.
- Verification gate: build:packages → generate → build:packages → i18n:check-sync → typecheck → test → build:app; module jest suite; Playwright integration tests; sandbox preview on `om_fpl_spec013` against the KSeF TEST env (author → look-up → send → UPO/PDF).

## Integration Test Coverage
The existing KSeF-UI integration suite is **API-level** (`request` fixture, no browser/`page`), so server-side behavior is asserted via integration tests and client-side UI behavior (pickers, inline validation, filters) via unit tests + the live sandbox preview pass. Tests **exercise** behavior (assert payloads/results), not just that controls render.
- `__integration__/TC-KSEF-UI-006.spec.ts` (NEW) — **NIP lookup route + buyer round-trip (server side):** `GET /api/financial_pl/ksef/company-lookup` enforces auth (**401** unauthenticated), validates the **NIP checksum** (**400** bad/missing NIP), and returns a well-formed **fail-open 200** `{ ok }` for a valid-but-fictional NIP regardless of MF reachability (asserting `accountNumbers` is never exposed on an `ok:true`). **Buyer capture:** author an invoice carrying `metadata.buyerSnapshot` (the exact `buildBuyer` keys) over the core `POST /api/sales/invoices`, then assert the module's own detail route returns that snapshot for the editor/detail prefill.
- **Buyer-edit immutability** is covered by the existing `TC-KSEF-UI-002` (PUT `/api/sales/invoices` on a KSeF-`accepted` invoice → **409**); a buyer write rides the same guarded PUT, so it is blocked too (no separate test needed). A standalone `TC-KSEF-UI-007` is **not** added — its content is either server-side-redundant with TC-002/TC-006 or client-side (pickers/inline validation), which this API-level suite cannot drive; that behavior is covered by the unit tests below + the preview pass.
- Unit (jest, run green): `lib/company-lookup.ts` — MF-response → `CompanyLookupResult` mapping (address = `workingAddress ?? residenceAddress`; `accountNumbers` dropped; missing fields; 404 → `not_found`; 5xx / thrown / aborted → `unavailable`; date param), `parseWykazAddress` split/fallback, NIP normalise + invalid-checksum short-circuit (no fetch), the company-lookup query validator. `lib/buyer-snapshot.ts` — the editor buyer ⇄ `metadata.buyerSnapshot` round-trip asserted against `buildBuyer`'s exact read keys (incl. the snake_case / name·taxId aliases) and the empty-buyer → `undefined` (omit) path.

## Changelog
- **2026-06-30:** Created. Commercial-grade editor on top of SPEC-013 — buyer capture to `metadata.buyerSnapshot`, MF Wykaz NIP autofill (fail-open proxy), inline validations, VAT-rate quick-pick + unit picker, searchable customer/GTU pickers. No entity/migration/core change. Grounded by a live preview pass (buyer absent, VAT/unit free text, no lookup) + live engine/cert/NIP-API verification (KSeF TEST, MF Wykaz).
- **2026-06-30 (spec-stage cross-model jury — Codex `fail`, DeepSeek `pass`, Kimi skipped):** Reconciled Codex's 4 blockers + DeepSeek's notes: (1) VAT-rate picker offers 23/8/5/0 + custom only — **`zw/np/oo` removed as line options** (core `tax_rate` is numeric; storing them as 0 would mis-file an exempt line as ordinary 0% VAT); exemption/reverse-charge stay in the meta layer (documented limitation). (2) GTU codes + procedure-markings searchability **promoted P1→committed**, with a test. (3) Line unit is a **picker-first** dropdown (common units) + explicit "Other…", not free text by default. (4) Validation requires **quantity > 0 and unit price ≥ 0** (a 0-price line is valid for free/discount lines); acceptance criterion updated. (5) **`accountNumbers` dropped** from the lookup response (white-list bank verification out of scope). (6) Edit **merges `buyerSnapshot` into the loaded `metadata`** (no clobber); (7) the MF address string is parsed into street/postal/city with a graceful line-1 fallback. Confirmed the detail read route already returns core invoice `metadata` (route.ts:262) — **no read-route change**. **Spec-stage cross-model: confirmed (codex + deepseek); kimi skipped (ran ~12 min; print-mode verdict unparseable — will retry at the code stage where the diff-scrape differs).**
- **2026-06-30 (IMPLEMENTED).** Built standalone on released core (no entity/migration/core change). New: `lib/company-lookup.ts` (+`parseWykazAddress`), `lib/buyer-snapshot.ts`, `api/ksef/company-lookup/route.ts`, `components/BuyerFields.tsx`, unit tests + `__integration__/TC-KSEF-UI-006.spec.ts`. Modified: `InvoiceForm.tsx` (buyer group + `metadata.buyerSnapshot` merge + validations), `InvoiceLinesField.tsx` (VAT-rate + unit pickers), `PlVatMetaForm.tsx` (GTU/procedure filter + searchable OSS country), edit/detail pages, `data/validators.ts`, i18n×4, README.
  - **Gate:** build:packages PASS (4/4) · i18n:check-sync PASS · module jest **399 passed / 10 skipped** (+22 new) · our-source typecheck **0 errors** · forms suite 803 pass (no cross-package regression). Pre-existing platform gaps unchanged (vendored `@open-mercato/ui` DataTable.tsx types break the full app typecheck/`build:app` — also break the sandbox/forms; NOT this change).
  - **Live preview (released core, DB `om_fpl_spec013`):** create form renders the Buyer section + VAT/unit pickers + GTU/procedure filters; **NIP lookup works end-to-end** (`5252344078` → autofilled Google Poland name + parsed street/postal/city + green *VAT status: Czynny*); create-with-buyer → **201 → redirect to edit**; edit-prefill reads the buyer back from `metadata.buyerSnapshot` and the VAT picker shows a clean **23%** from the DB-scaled `tax_rate`. Engine + certificate (XAdES) auth re-verified live on the KSeF TEST env this session.
  - **Code jury round 1** (Claude `pass`; Codex `fail`×3; DeepSeek `fail`×1; Kimi `fail`×1+1 note) — fixed: BuyerFields async lookup merges against `valueRef.current` (no stale-closure revert), UPR validation requires `(name && address) || nip` (mirrors `buildBuyer`), custom VAT "Other…" validated numeric 0–100, TC-006 line carries `currencyCode`, VAT picker matches standard rates numerically (scaled `23.0000` → `23%`). DeepSeek's "missing generated registry" blocker was reconciled as **spurious** (`.mercato` is gitignored — regenerated by `yarn generate`; the route verified working live). Notes (email field, raw VAT-status string, customer-picker graceful-degradation, format-example placeholders) logged; spec aligned.
  - **Code jury round 2** (Claude pass; DeepSeek `pass`; Codex `fail`×1; Kimi `fail`×2) — fixed: the round-1 numeric-match change made the VAT "Other…" path unreachable (picking Other set `taxRate=''` → snapped back to placeholder); corrected to `isOtherVat = !matchedVat` so Other always reveals the custom input while a matched/scaled value shows the clean pick (Codex) — verified live (dropdown = 23/8/5/0/Other…; Other renders the input). `buyerToSnapshot` now normalises the NIP to bare digits + country to upper-case before persisting, so a dashed NIP no longer 422s at send (Kimi) — unit-tested. Kimi's "BAD_NIP `1234567890` has a valid checksum" blocker was reconciled as **spurious** (miscalc: `230 mod 11 = 10`, the invalid sentinel, not `0`; `isValidPolishNip('1234567890') === false`, test green). Notes (no-lines already blocked pre-this-spec; legacy lowercase country now upper-cased) addressed. **Code-stage cross-model: confirmed (codex + kimi + deepseek) — all three ran in both rounds alongside the mandatory Claude fresh-reviewer; every reproducible blocker fixed, two spurious ones disproven.**
  - **Re-gate after both rounds:** build:packages PASS · i18n:check-sync PASS · module jest **400 passed / 10 skipped** · our-source typecheck **0 errors**.
- **2026-06-30 (FRESH 4-model jury — verification session, all four reviewers re-run on the final diff):** Re-ran the complete jury on `git diff --staged` (the unrelated `yarn.lock`/`apps/sandbox` dep churn excluded). **Round 1:** Claude `pass`, DeepSeek `pass`, Kimi `fail`×1, Codex `fail`×2 → 3 reproducible blockers fixed (the blank-VAT one raised by BOTH Codex + Kimi): (1) a line VAT rate is now REQUIRED non-empty numeric — picking "Other…" and leaving it blank no longer silently persists as 0% (`InvoiceForm.tsx`); (2) the NIP lookup discards a stale response when the operator changed the NIP mid-flight, so the previous NIP's company data can't fill against a different NIP (`BuyerFields.tsx`); (3) `buyerToSnapshot` omits a `{countryCode}`-only buyer (Kimi note, +tests). **Round 2:** Codex `fail`×1 (NEW, real) — the taxpayer NIP (`contextNip`) was checksum-validated on normalised digits but persisted RAW by `buildMetaPayload`, so a dashed `525-234-40-78` 422'd against the `invoice-meta` `^[0-9]{10}$` schema → **fixed:** `buildMetaPayload` normalises `contextNip` to digits, and both buyer + taxpayer NIP validators now reject non-empty garbage that normalises to `''` (not silently drop it); inline indicator aligned. **Polish (DeepSeek note):** added inline taxpayer-NIP checksum feedback in `PlVatMetaForm` for parity with the buyer field (reuses the existing i18n key). **Final round on the fully-fixed diff:** Claude `pass`, Codex `pass` (0/0), DeepSeek `pass`, Kimi `pass` (0 blockers, recovered via a direct raw-output run after the wrapper's kimi-cli print-mode parse gotcha). **Code-stage cross-model: confirmed (claude + codex + deepseek + kimi) — all four reviewers pass on the final diff; every reproducible blocker fixed and re-confirmed.** Re-gate: build:packages PASS · i18n PASS · jest **400 passed** · our-source tsc **0 errors**.
  - **Live KSeF TEST re-verification (this session, token bundle for NIP 2481632647, STRICT):** VAT (`…136440C00000-6B`), KOR (`…13667F400000-5B`), ZAL (`…1368C0C00000-B5`), UPR (`…136AFF400000-37`), OSS EUR (`…136EE3400000-7C`) all **accepted + UPO**; self-billed **rejected 410** (samofakturowanie guard, expected); **certificate (XAdES) auth accepted** (`…140DE3400000-2F`) using a PURE org-seal subject `organizationIdentifier=VATPL-<NIP>` (mixing `serialNumber=TINPL` → KSeF 21115 "Nieprawidłowy certyfikat"). MF Wykaz NIP lookup live-verified (`5252344078` → Google Poland, *Czynny*). Regulatory assumptions (FA(3), 2026-02-01 mandates, JPK_V7M(3)/V7K(3), cert cutover 2027-01-01) re-confirmed current against the official KSeF 2.0 sources. Full report: `.ai/reports/financial-pl-ksef-spec014-verification-2026-06-30.md`; jury record: `.ai/reviews/financial-pl-spec014-commercial-editor-cross-model-jury-2026-06-30.md`.
