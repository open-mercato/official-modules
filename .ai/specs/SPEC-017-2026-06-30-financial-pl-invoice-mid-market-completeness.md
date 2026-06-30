# SPEC-017 — financial_pl: mid-market invoice completeness (payment terms, bank account, sale date, line-edit persistence)

## TLDR
**Key Points:**
- The `financial_pl` invoice editor is already coherent (SPEC-016 progressive disclosure, verified live: ~7 core controls on first paint, advanced KSeF/JPK fields collapsed). This spec closes the remaining **data-completeness** gaps that block real mid-market usage — it is *not* a UX/layout rebuild (accordion stays).
- Add the **Payment & settlement** block (forma płatności, termin, numer konta / IBAN, zapłacono) that every Polish product (wFirma, inFakt, Fakturownia, iFirma) shows on the default view — currently absent from the UI, the FA(3) XML (`Platnosc` node), and the PDF.
- Add **data sprzedaży** (sale/delivery date, FA(3) `P_6`) to the UI (the FA(3) mapping + resolver already support it; only the input is missing).
- Add **smart date defaults** (due date = issue + payment term; sale date prefilled = issue).
- Stop the **silent line-edit data loss**: released core `sales.invoices.update` ignores `lines`, so the edit form's line PUTs vanish while reporting success. **Spec-stage jury decision (3/3 voters + user):** a clean in-module fix is impossible (core has no invoice-line update command and the module must not import/raw-write core entities), so F4 is rescoped to *eliminating the silent loss* (read-only lines on edit + honest notice; stop sending lines on update) plus a documented upstream-core proposal — **not** an in-module line write.

**Scope:**
- F1 — Payment & settlement section (UI default view + `metadata.payment` + FA(3) `Platnosc` + PDF + detail).
- F2 — Sale date (`metadata.saleDate`) input + PDF/detail (mapping already done).
- F3 — Smart defaults (due-from-term, sale-date prefill) with explicit override-tracking.
- F4 — Eliminate silent line-edit loss (lines read-only on edit + notice; no false "saved") + propose the upstream core command.

**Concerns:**
- No DB migration: all new invoice data rides existing `SalesInvoice.metadata` (jsonb), the same additive pattern SPEC-014/016 used for buyer/notes.
- F4 deliberately does NOT add an in-module line write (jury consensus: that would break §4/§31-B); in-place draft line editing is deferred to an upstream core change. The seller bank account (F1) is stored in cleartext metadata by design — it is printed on every invoice PDF and transmitted to KSeF in cleartext (`RachunekBankowy`), i.e. non-secret invoice data, consistent with the buyer NIP/address already in metadata.

## Overview
`financial_pl` is a standalone Polish KSeF + invoicing module on released `@open-mercato/core` 0.6.5. SPEC-005→016 delivered: FA(3) VAT/KOR/ZAL/ROZ/UPR/OSS, online/offline/awaria + KOD II, token & certificate (XAdES) auth, JPK_V7→MF submission, inbound receiving, NBP FX, batch send, paginated PDF, a commercial-grade buyer/NIP editor, and a coherent progressive-disclosure form with customer + product-catalog pickers. Live KSeF TEST round-trips (send/UPO/receive) pass with the configured token.

This spec brings the **invoice document itself** to feature parity with mid-market Polish invoicing software for the fields a buyer actually reads on a faktura (how/when to pay, to which account) and removes a silent data-loss bug on draft editing.

> **Market Reference:** wFirma (tabbed: PODSTAWOWE shows *sposób zapłaty* + dates), inFakt (sprzedawca + termin from settings), Fakturownia (payment method/terms on the default view, `więcej` for the rest), iFirma (Płatności accordion card available at creation). **Adopted:** payment method + term + bank account on the always-visible core view, smart date defaults, and product/contractor autofill (already shipped). **Rejected:** a wFirma-style multi-tab rebuild (our accordion already matches Fakturownia/iFirma; the user confirmed keeping it) and write-back to the catalog/contractors (out of scope).

## Problem Statement
1. **No payment information anywhere.** `grep` confirms the module emits **no** `Platnosc` node in the FA(3) XML (`lib/fa3.ts`), has **no** payment fields in the editor, schema, PDF, or detail page. A Polish invoice without *forma płatności / termin / numer konta* is commercially incomplete — the buyer cannot pay it. FA(3) defines a full `Platnosc` element we never populate.
2. **Sale date is invisible.** FA(3) `P_6` (data dokonania/zakończenia dostawy lub otrzymania zapłaty) is already emitted by `fa3.ts:616` from `model.saleDate`, and `resolve-fa3-from-invoice.ts:285` already reads `metadata.saleDate ?? issue_date` — but there is **no UI field** to set it, so it always silently equals the issue date. For goods delivered in a different period than invoiced, the FA(3) is wrong.
3. **Due date never derives.** The editor defaults both issue date and due date to *today* (verified in preview). Real software derives the due date from a configurable payment term (e.g. +14 days).
4. **Line edits silently vanish.** Released core `sales.invoices.update` (`node_modules/@open-mercato/core/dist/modules/sales/commands/documents.js:6629`) applies only a header+`metadata` whitelist (`buildChanges`, lines 6641-6657) — it has **no `parsed.lines` handling** (unlike create at 6508). The edit form (`InvoiceForm.tsx:347`) PUTs the full `lines[]` expecting replace semantics core does not honor (the inline comment is wrong). Result: a user edits a draft invoice's quantities/prices/line items, saves, sees success — and the change is gone. This is silent data loss and a hard blocker for mid-market editing.

## Proposed Solution
A single `feat/financial-pl-ksef-compliance` branch change, no schema migration, accordion layout unchanged.

### F1 — Payment & settlement
- New always-visible **"Płatność / Payment"** group in the editor core view (directly under the Lines totals), holding:
  - **Payment method** (`method`): select over the canonical FA(3) `FormaPlatnosci` set + `other`. Free-text `methodOther` (→ `OpisPlatnosci`) shown and **required** only when `other`.
  - **Payment term (days)** (`termDays`): numeric (default 14); drives the due date (F3). Optional — clearing it leaves the due date manual.
  - **Bank account** (`bankAccount`): IBAN/NRB string, `bankName` optional, `swift` optional. Shown only when method = `transfer`; on switching away from `transfer` the three bank fields are **cleared** (no stale data). Lightweight format validation (length/charset), not a checksum hard-fail.
  - **Paid** (`paid`: boolean) + **paid date** (`paidDate`): "Zapłacono" toggle; `paidDate` shown and **required** when `paid` is on.
- **FormaPlatnosci mapping matrix** (jury C1/K2 — exhaustive, no implementer guessing). `method` → FA(3):

  | `method` | FA(3) | code |
  |----------|-------|------|
  | `cash` | `FormaPlatnosci` | 1 (Gotówka) |
  | `card` | `FormaPlatnosci` | 2 (Karta) |
  | `voucher` | `FormaPlatnosci` | 3 (Bon) |
  | `cheque` | `FormaPlatnosci` | 4 (Czek) |
  | `credit` | `FormaPlatnosci` | 5 (Kredyt) |
  | `transfer` (default) | `FormaPlatnosci` | 6 (Przelew) |
  | `mobile` | `FormaPlatnosci` | 7 (Płatność mobilna) |
  | `other` | `PlatnoscInna=1` + `OpisPlatnosci`=`methodOther` | — |

  (`za pobraniem`/`kompensata` have no FA(3) `FormaPlatnosci` code → use `other` + description, e.g. "Za pobraniem".)
- Persisted to **core `SalesInvoice.metadata.payment`** (object) via the existing `/api/sales/invoices` create/update call — the same mechanism SPEC-014/016 used for `buyerSnapshot`/`notes`; `metadata` is in core's update whitelist (documents.js:6656) so it persists on both create and edit.
- **FA(3) mapping:** `resolve-fa3-from-invoice.ts` reads `metadata.payment` → a new optional `payment` field on `Fa3InvoiceInput`; `fa3.ts buildFa3Xml` emits a `<Platnosc>` node **inserted after `FaWiersz` (lines) and before `Zamowienie`** per the FA(3) XSD sequence:
  - `FormaPlatnosci` code per the matrix, or `PlatnoscInna=1` + `OpisPlatnosci` for `other`.
  - `TerminPlatnosci/Termin` = the invoice due date (when present).
  - `Zaplacono=1` + `DataZaplaty` when `paid` (both emitted together — never one without the other).
  - `RachunekBankowy/NrRB` (+ `NazwaBanku`, `SWIFT`) when a bank account is present.
  - **The whole `Platnosc` node is omitted** when no usable payment data exists (`Platnosc` is optional in FA(3) → absent-payment invoices stay schema-valid).
- **Conditional-validity refines (jury K4/C-note)** in `invoicePaymentSchema` (zod `.refine`) AND mirrored in UI: `paid===true ⇒ paidDate` present; `method==='other' ⇒ methodOther` non-empty. A save that violates either is rejected before any KSeF send.
- **PDF + detail page** render the payment block.

### F2 — Sale date (FA(3) `P_6`)
- New optional **"Data sprzedaży / Sale date"** input on the core view; prefilled = issue date (F3); written to `metadata.saleDate`. Mapping + serializer already consume it — only the input, PDF line, and detail line are added.

### F3 — Smart defaults (with explicit override-tracking)
- **Override-tracking mechanism (jury K3/D4):** the editor tracks per-field "touched" flags for `dueDate` and `saleDate` (set true on a user edit of that field). Derivation runs only when the field is **untouched**:
  - On issue-date change: if `saleDate` untouched → `saleDate = issueDate`; if `dueDate` untouched → `dueDate = issueDate + termDays`.
  - On `termDays` change: if `dueDate` untouched → `dueDate = issueDate + termDays`; clearing `termDays` leaves `dueDate` manual.
  - Initial create defaults: issue = today (already), `termDays = 14`, `saleDate = today`, `dueDate = today + 14`.
  - A user edit to `dueDate`/`saleDate` sets its touched flag → never auto-overwritten thereafter. In edit mode, an existing explicit value loads as touched.

### F4 — Eliminate silent line-edit data loss (rescoped per jury 3/3 + user)
The original plan (an in-module command writing core `SalesInvoiceLine`) was rejected by all three spec voters: it breaks §4/§31-B (the module imports no core entities and writes only via the public API/command bus), core has no invoice-line update command to delegate to, and the official-module must not modify core. The user selected the **safe fix**:
- **Editor:** on **edit** of an existing invoice, line items become **read-only** with a clear inline notice (i18n): *"Pozycje faktury nie mogą być zmienione po utworzeniu (ograniczenie rdzenia). Aby zmienić pozycje, utwórz nową fakturę lub wystaw korektę (KOR)."* / EN equivalent. Header, dates, buyer, **payment (F1)**, sale date (F2), notes, and all VAT/KSeF/JPK metadata remain fully editable (these persist correctly via core update + the meta route).
- Stop sending `lines` on the edit PUT (so nothing falsely appears to save) and remove the misleading "replace semantics" comment (`InvoiceForm.tsx:206-210, 347`). **Create** is unchanged (core create persists lines correctly).
- **Upstream proposal (documented + follow-up task):** the clean fix is a core `sales.invoices.update` that applies `lines` (or a `sales.invoices.replace_lines` command using `salesCalculationService` for totals). When core ships it, the module adopts it for in-place draft line editing. A follow-up task is filed.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Payment + sale date in `SalesInvoice.metadata`, not `SalesInvoicePlMeta` columns | No migration; matches saleDate/buyerSnapshot/notes already there; metadata persists on core create+update. `SalesInvoicePlMeta` is reserved for filterable JPK columns. |
| F4 = read-only lines on edit + upstream proposal, NOT an in-module line write | 3/3 spec voters: an in-module core-line write breaks §4/§31-B; core has no line command; module must not modify core. Removing the silent loss is the correct within-boundary fix. User-confirmed. |
| Bank account stored in cleartext metadata (no encryption) | Seller's account is printed on every invoice PDF + sent to KSeF in cleartext `RachunekBankowy` → non-secret invoice data, consistent with buyer NIP/address already in metadata (jury D3 reconciled). |
| Payment NOT wired to JPK_V7 | JPK uses `TerminPlatnosci` only for art. 89a bad-debt (already handled by `badDebtTerminPlatnosci`); ordinary payment data is FA(3)/PDF only. |
| Keep accordion (no tabs) | User-confirmed; matches Fakturownia/iFirma; lowest churn; payment goes on the already-visible core view, advanced stays collapsed. |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| In-module command writing core `SalesInvoiceLine` (delete+recreate rows) | 3/3 jury: §4/§31-B violation (cross-module entity import + raw write); drops core line fields (orderLineId/uomSnapshot/discount…); totals would drift from `salesCalculationService`; TOCTOU vs KSeF send. |
| Recreate the whole draft via core create (new id) | Changes the invoice id; lifecycle/numbering risk in a KSeF-compliance module; meta-row migration; user chose the safe fix. |
| Store payment in a new `SalesInvoicePlMeta` column set | Requires a hand-authored migration + snapshot for data that doesn't need to be a filterable column. |

## User Stories / Use Cases
- A **bookkeeper** wants to set *przelew, 14 dni, na konto PL…* on an invoice so the buyer knows how and when to pay, and it appears on the PDF and in KSeF.
- A **seller** delivering goods at month-end but invoicing in the next period wants to record the real *data sprzedaży* so the FA(3) `P_6` is correct.
- A **user** correcting a draft invoice's quantity wants the change to actually save.
- A **user** marking an invoice "Zapłacono" wants it reflected on the document.

## Architecture
- **Extension mode:** UMES external module (`packages/financial-pl/src/modules/financial_pl`); no core modification. Single source of truth remains core `SalesInvoice`.
- **Write paths:** F1/F2 ride the existing core invoice create/update (metadata jsonb). F4 is UI-only (read-only gating); **no new write path, no new entity, no migration.** The module continues to write only via core's public `/api/sales/invoices` + its own meta route.

### Commands & Events
- **No new command or event.** F1/F2 persist through core's existing `sales.invoices.create/update` side effects. (The originally-proposed `financial_pl.invoice.replace_lines` is dropped per the jury.)

## Data Models
No new entity, no migration. New shape inside existing core `SalesInvoice.metadata` (jsonb):
```ts
metadata.payment = {
  method: 'transfer'|'cash'|'card'|'voucher'|'cheque'|'credit'|'mobile'|'other',
  methodOther?: string,        // required when method==='other' → FA(3) OpisPlatnosci
  termDays?: number,           // payment term in days (drives due date)
  bankAccount?: string,        // IBAN/NRB (cleared when method!=='transfer')
  bankName?: string,
  swift?: string,
  paid?: boolean,
  paidDate?: string,           // YYYY-MM-DD; required when paid===true
}
metadata.saleDate?: string      // YYYY-MM-DD (already consumed by the resolver at resolve-fa3-from-invoice.ts:285)
```
A zod `invoicePaymentSchema` (with `.refine`: paid⇒paidDate, other⇒methodOther) validates this in `data/validators.ts`; `fa3InvoiceSchema` gains an optional `payment` object consumed by the serializer. **Bank account is intentionally cleartext** (non-secret: printed on the PDF + sent to KSeF in cleartext).

## API Contracts
**No new API route.** F4 adds no endpoint (rescoped to UI gating). F1/F2 use existing contracts:
- `POST/PUT /api/sales/invoices` — body `metadata.payment` + `metadata.saleDate` added (additive jsonb; unchanged contract).
- The edit PUT **stops sending `lines`** (core ignores them anyway), removing the false-success path.

## Internationalization (i18n)
New keys in **all four** locales (`i18n/en.json`, `pl.json`, `de.json`, `es.json`; flat keys, alphabetical via `jq -S`): `financial_pl.invoices.form.payment.*` (section title, method options, term, bankAccount, bankName, swift, paid, paidDate), `financial_pl.invoices.form.saleDate`, and any new error strings for the lines route. PL labels: *Płatność, Sposób płatności, Termin (dni), Numer konta, Nazwa banku, Zapłacono, Data zapłaty, Data sprzedaży*.

## UI/UX
- Accordion layout unchanged. The payment group is part of the **always-visible** core view (not the advanced accordion), consistent with PL software showing payment by default.
- Progressive disclosure within the group: bank fields appear only for `transfer`; `methodOther` only for `other`; `paidDate` only when `paid`.
- Design system: use `@open-mercato/ui` primitives (Select/Input/Switch), semantic tokens, no raw HTML controls, `lucide-react` icons with `aria-label`. Verified by `om-ds-guardian` on touched lines.

## Migration & Compatibility
- **No DB migration.** All additive: new optional `metadata` keys + one new additive API route. No change to any FROZEN/STABLE contract surface (§27). Existing invoices without `metadata.payment` render exactly as today (no `Platnosc` node — valid FA(3), `Platnosc` is optional).

## Implementation Plan
### Phase 1 — Payment + sale-date data layer (FA3 + schema)
1. `data/validators.ts`: add `invoicePaymentSchema`; add optional `payment` to `fa3InvoiceSchema`.
2. `lib/resolve-fa3-from-invoice.ts`: map `metadata.payment` → `Fa3InvoiceInput.payment` (saleDate already mapped).
3. `lib/fa3.ts`: emit `<Platnosc>` (FormaPlatnosci/PlatnoscInna+OpisPlatnosci, TerminPlatnosci, Zaplacono+DataZaplaty, RachunekBankowy) in `buildFa3Xml`; map method→code.
4. Unit tests: payment→XML matrix; sale-date already covered, add a P_6≠issue case.

### Phase 2 — PDF + detail rendering
1. `lib/invoice-pdf-model.ts` + `lib/invoice-pdf.ts`: render payment block + sale date (byte-stable; guard absent payment).
2. `backend/financial/invoices/[id]/page.tsx`: payment + sale-date cards.

### Phase 3 — Editor (UI, defaults, persistence)
1. New `PaymentFields` component (or inline group) in `InvoiceForm.tsx`; write `metadata.payment` + `metadata.saleDate` into `mergedMetadata`.
2. Smart defaults: due = issue + termDays; sale date prefill = issue (no overwrite of explicit values).
3. i18n keys ×4 locales.

### Phase 4 — Eliminate silent line-edit loss (UI only)
1. `InvoiceForm.tsx`: in edit mode render line items read-only (disable add/remove/field edits) with an i18n notice; stop including `lines` in the edit PUT body; remove the misleading "replace semantics" comment.
2. i18n notice keys ×4 locales.
3. Document the upstream-core proposal in the spec; file a follow-up task.

### File Manifest
| File | Action | Purpose |
|------|--------|---------|
| `data/validators.ts` | Modify | `invoicePaymentSchema` (+ refines); optional `payment` on `fa3InvoiceSchema` |
| `lib/resolve-fa3-from-invoice.ts` | Modify | map `metadata.payment` → `Fa3InvoiceInput.payment` |
| `lib/fa3.ts` | Modify | emit `<Platnosc>` (after FaWiersz, before Zamowienie) per matrix |
| `lib/invoice-pdf-model.ts`, `lib/invoice-pdf.ts` | Modify | render payment + sale date (byte-stable, guarded) |
| `backend/financial/invoices/[id]/page.tsx` | Modify | payment + sale-date detail cards |
| `backend/financial/invoices/[id]/edit/InvoiceForm.tsx` | Modify | payment/sale-date inputs, override-tracked defaults, read-only lines on edit + notice, drop `lines` from edit PUT |
| `components/PaymentFields.tsx` | Create | payment input group (DS primitives) |
| `i18n/{en,pl,de,es}.json` | Modify | new keys (payment, saleDate, line-readonly notice) |
| `lib/__tests__/*`, `__integration__/TC-*.spec.ts` | Create | unit + integration |

### Testing Strategy
- Unit: payment→FA(3) `Platnosc` matrix (each `method`→code; `other`→PlatnoscInna+OpisPlatnosci; paid+DataZaplaty together; bank account; none→node omitted); `invoicePaymentSchema` refines (paid w/o paidDate rejected; other w/o methodOther rejected); P_6≠issue; override-tracking (touched dueDate not overwritten on issue-date change).
- Integration (Playwright, module-local, self-contained): create invoice with payment + sale date → assert persisted + on PDF; verify lines are read-only on edit with the notice; verify header/payment ARE editable on edit and persist.

## Integration Test Coverage (mandatory — ship with the change)
- `__integration__/TC-payment-create.spec.ts` — create with payment method/term/bank + sale date; reopen edit → values present; PDF contains payment + sale date.
- `__integration__/TC-line-readonly-on-edit.spec.ts` — open an existing invoice for edit → line fields/add/remove are disabled and the notice is shown; payment + due date ARE editable and persist on save (regression guard that the false-success line PUT is gone).
- `__integration__/TC-payment-defaults.spec.ts` — create: changing issue date moves due date by `termDays`; once the user edits due date manually, a later issue-date change does NOT overwrite it.

## Risks & Impact Review

### Data Integrity Failures
- **F1/F2 are metadata-only** writes on core create/update (already transactional in core); no new write path. Absent/partial `metadata.payment` → the serializer omits `<Platnosc>` entirely (optional in FA(3)) → no invalid XML.
- **F4 removes a data-loss path** (false-success line PUT) rather than adding a write; net integrity improves.

### Cascading Failures & Side Effects
- FA(3): an empty/partial `metadata.payment` must not emit an invalid `Platnosc` — the serializer omits the node entirely when no usable payment data is present, and conditional children are emitted together (Zaplacono+DataZaplaty; PlatnoscInna+OpisPlatnosci) via schema refines.
- PDF: payment block guarded so an absent payment renders byte-stable to today's output.

### Tenant & Data Isolation Risks
- No new cross-tenant surface. F1/F2 ride core's already-scoped invoice write; F4 is UI-only.

### Migration & Deployment Risks
- Zero-downtime, no migration, fully additive. Existing invoices unaffected; absent `metadata.payment` → identical output to today.

### Operational Risks
- Blast radius: a bug in F1 affects only the FA(3) `Platnosc`/PDF of invoices that set payment; the node is omitted otherwise. F4 only restricts an already-broken edit path.

### Risk Register
#### Malformed FA(3) `Platnosc` rejected by KSeF
- **Scenario:** a wrong `FormaPlatnosci` code, a missing required child (DataZaplaty/OpisPlatnosci), or wrong element ordering makes KSeF reject otherwise-valid invoices.
- **Severity:** High
- **Affected area:** all sends once payment is set.
- **Mitigation:** exhaustive method→code matrix; node omitted unless valid; zod refines for conditional children; `Platnosc` inserted after `FaWiersz`/before `Zamowienie` per XSD; **unit matrix + a live KSeF TEST smoke send with a populated payment block during verification** (no FA(3) XSD ships locally, so live acceptance is the validation).
- **Residual risk:** low; `Platnosc` is optional and the matrix is complete.

#### Bank account (IBAN) at rest in metadata
- **Scenario:** `bankAccount` stored cleartext in `SalesInvoice.metadata`.
- **Severity:** Low (reconciled from jury D3 "High")
- **Affected area:** F1 storage.
- **Mitigation/justification:** the seller's bank account is printed on every invoice PDF and transmitted to KSeF in cleartext (`RachunekBankowy/NrRB`) — it is non-secret invoice data by nature, consistent with buyer NIP/address already stored cleartext in the same metadata. No platform encryption requirement applies (§16 covers tenant-PII columns, not public invoice fields).
- **Residual risk:** acceptable; revisit only if the platform later classifies seller bank details as protected PII.

#### Line editing still unavailable (deferred)
- **Scenario:** users cannot edit a draft's line items in-place; must recreate or issue a KOR.
- **Severity:** Medium (functionality gap, not a defect)
- **Affected area:** F4.
- **Mitigation:** the silent-loss bug is removed (honest read-only + notice); upstream core command proposed; follow-up task filed.
- **Residual risk:** accepted by the user; resolved when core ships invoice-line update.

## Final Compliance Report — 2026-06-30

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)
- `ARCHITECTURE.md` §4, §5, §9, §11, §22, §27, §31 (borrowed core rules)
- `node_modules/@open-mercato/core/AGENTS.md` (sales commands, withAtomicFlush, command side effects)

### Compliance Matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| §4 / §31 A | No import of another module's code | Compliant | rescoped F4 removed the planned core-entity import; module still writes only via core's public API |
| §31 B | Writes via DataEngine/command, not raw em | Compliant | F1/F2 ride core's own create/update commands; no new module write path |
| §31 B | No cross-module ORM relation / raw cross-module write | Compliant | jury-driven rescope eliminated it |
| §31 B | Tenant-scoped reads/writes | Compliant | core invoice write is already org+tenant scoped |
| §31 C | Zod validation | Compliant | `invoicePaymentSchema` + refines; `payment` on `fa3InvoiceSchema` |
| §27 | No change to FROZEN/STABLE surfaces | Compliant | additive metadata keys only; no new/changed route contract |
| §31 L | DS tokens/primitives; strings in all 4 locales | Compliant | DS guardian on touched UI; i18n ×4 |
| §31 O | Integration tests for affected paths; self-contained | Compliant | 3 TC specs ship with the change |
| §8 (schema) | No migration / standard columns untouched | Compliant | metadata jsonb only |
| §16 | Encryption for tenant PII | Compliant (justified) | seller bank account is public invoice data (PDF + KSeF cleartext), not protected PII |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | `metadata.payment` shape ↔ schema ↔ FA(3) node |
| API contracts match UI/UX | Pass | editor writes the same keys the resolver reads |
| Risks cover all write operations | Pass | F1 metadata write covered; F4 removes a path |
| Mutations use existing commands | Pass | no new mutation; core create/update only |

### Verdict
- **Fully compliant** after the spec-stage jury reconciliation (F4 rescoped to within-boundary; F1 mapping/validity/IBAN resolved; F3 override-tracking defined).

## Changelog
### 2026-06-30
- Initial specification (SPEC-017): payment & settlement block, sale date input, smart date defaults, draft line-edit persistence. Migration-free; accordion layout retained per user decision.
- **Spec-stage cross-model jury (Codex + Kimi + DeepSeek, all `fail`) reconciled** (`.ai/reviews/financial-pl-spec017-spec-stage-jury-2026-06-30.md`):
  - F4 rescoped (3/3 voters + user): the in-module core-line write breaks §4/§31-B and core has no line command → F4 = eliminate the silent loss (read-only lines on edit + honest notice; stop sending lines on update) + propose an upstream core command. In-place line editing deferred.
  - F1: exhaustive `FormaPlatnosci` mapping matrix (cod/compensation dropped → `other`); conditional-validity refines (paid⇒paidDate, other⇒methodOther); clear bank fields when method≠transfer; `Platnosc` placed after `FaWiersz`/before `Zamowienie`; node omitted when empty.
  - F1: IBAN-at-rest justified as non-secret invoice data (no encryption).
  - F3: explicit per-field override-tracking (touched flags) so defaults never clobber user edits.
  - Verification: added a live KSeF TEST smoke send with a populated payment block (no FA(3) XSD ships locally).
