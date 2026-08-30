# SPEC-008 — financial_pl: invoice authoring & KSeF operator UI (tabbed editor, buyer/NIP autofill, payment block, backoffice pages)

- **Date:** 2026-07-01
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Status:** Implemented — live-verified on KSeF TEST, staged on `feat/financial-pl-ksef-compliance` (stop-before-PR).
- **Sibling specs (this is one of four thematic financial_pl specs — cross-reference, do not duplicate):**
  - [SPEC-005 — KSeF connector & submission](./SPEC-005-2026-07-01-financial-pl-ksef-connector-submission.md): token/certificate auth, online/offline/batch submit, status/UPO polling, idempotency + reconciliation, inbound receiving, `ksef_pl` credentials, the `KsefSubmission` model + the **fail-closed KSeF-immutability API interceptors** this UI relies on.
  - [SPEC-006 — FA(3) documents, corrections & JPK](./SPEC-006-2026-07-01-financial-pl-fa3-documents-corrections-jpk.md): the FA(3) serializer (all doctypes, self-billing, OSS, corrections), the **`<Platnosc>` node emission + `FormaPlatnosci` code matrix**, the `SalesInvoicePlMeta` model + its full column set, and JPK_V7 export/e-submission.
  - [SPEC-007 — invoice PDF](./SPEC-007-2026-07-01-financial-pl-invoice-pdf.md): the human-readable FA(3) PDF (pagination, KOD I/II QR, i18n labels).

## TLDR
**Key Points:**
- Released `@open-mercato/core` 0.6.5 ships **no invoice UI at all** (no list, no detail, no editor; `SalesInvoice`/`SalesInvoiceLine` are data + API only; the `sales` backend is channels/documents(order/quote)/orders/quotes). The four legacy widget-injection host spots (`data-table:sales.invoices:*`, `crud-form:sales.sales_invoice:fields`) exist only on the **unmerged** `feat/financial-accounting-oss` branch. `financial_pl` therefore owns its **entire** Polish invoicing + KSeF operator backoffice by direct composition (UMES §11 — a module composes its **own** UI, injection is only for extending *another* module's host).
- The backoffice is a set of module-owned backend pages — **Invoices** (list / create / detail / edit), **JPK** (filings + generate/export + purchase records), **Certificates** (enroll / list / revoke) — plus one self-contained list read endpoint and the read-only MF *Wykaz* NIP-lookup proxy. Core `SalesInvoice`/`SalesInvoiceLine` stay the single source of truth (write via core `/api/sales/invoices`, read header + lines via the QueryEngine).
- The invoice editor is the centrepiece and reached its **final tabbed layout**: an always-visible document-coordinate strip (number + dates + currency) above a DS `Tabs` body with three tabs — **Faktura** (buyer, lines, payment, notes), **Podatki i KSeF** (the full PL-VAT/KSeF/JPK editor), **Dodatkowe** (order id + extras). Panels are kept **mounted and toggled with `hidden`** (not the DS `TabsContent`, which unmounts) so typed custom buyer/product names in `ComboboxInput` are never lost on a tab switch.
- The editor is **commercial-grade**: buyer capture to `metadata.buyerSnapshot` with MF *Wykaz podatników VAT* (Biała lista) NIP autofill, a real customer picker over the `customers` module, a per-line product picker over the `catalog` module, VAT-rate/unit pickers, searchable GTU/procedure-marking filters, a payment & settlement block (forma / termin / konto / zapłacono), a sale-date input, smart date defaults, and inline validations (NIP checksum, date order, positive quantities, whole-number term-days).
- **Presentational over the core sales-invoice contract**: no new entity, no migration, no core change, no FA(3)/PDF/JPK behaviour change. All new invoice data rides existing jsonb `metadata` (`buyerSnapshot`, `payment`, `saleDate`, `notes`, line `metadata.productId`) and the already-accepted line `sku`; the PL-VAT layer rides `SalesInvoicePlMeta` (SPEC-006) via `PUT /api/financial_pl/ksef/invoice-meta`.

**Scope:**
- **UI-1 — Backoffice pages:** module-owned Invoices (list/create/detail/edit), JPK, Certificates pages + sidebar nav; the `GET /api/financial_pl/ksef/invoices` list-with-KSeF-status endpoint; ACL composition.
- **UI-2 — Tabbed editor:** the final `InvoiceForm` layout (coordinate strip + Faktura/Podatki-i-KSeF/Dodatkowe tabs, mounted-hidden panels, always-mounted date-derivation, cross-tab error routing, has-data tab indicators).
- **UI-3 — Buyer & NIP autofill:** `metadata.buyerSnapshot` capture, the MF *Wykaz* company-lookup proxy route, customer picker over `customers`.
- **UI-4 — Lines & pickers:** product picker over `catalog`, VAT-rate/unit pickers, GTU/procedure searchable filters, the create-only line-link + read-only-lines-on-edit reality.
- **UI-5 — Payment, sale date, smart defaults:** the payment block, `metadata.saleDate` input, override-tracked smart date defaults, inline validations.
- **UI-6 — Mid-market gap-audit register:** documentation-only prioritized follow-up backlog.

**Concerns:**
- Editing a KSeF-`queued`/`processing`/`accepted`/`offline_issued` invoice must be blocked server-side (not just a disabled button) — enforced by the fail-closed API interceptors owned by the connector spec (SPEC-005 §"KSeF immutability").
- Buyer persistence must use the **exact** snapshot keys `buildBuyer` reads or autofilled data never reaches FA(3).
- The MF *Wykaz* dependency must fail-open — manual entry is never gated on it.
- Line edits do **not** persist on core PUT (a released-core constraint); the editor must not *appear* to save them.

## Overview
The 2026 Polish mandate requires businesses to **issue** structured invoices via KSeF (mid-market — all non-micro VAT businesses — obligated since 1 April 2026; penalties from 1 January 2027). An operator needs to author an invoice, attach Polish VAT metadata (kind, GTU, procedure markings, MPP, OSS, FX, advance/settlement, bad-debt, exemption), capture a buyer and payment terms, send it to KSeF, watch its status, download the UPO and the PDF, issue corrections, and file JPK_V7. The compliance engine (SPEC-005/006/007) is complete and live-verified on the KSeF TEST API; released core provides no invoice screen, so this module supplies the entire operator surface.

This spec is purely about **information management and authoring UX** over that engine. It applies established progressive-disclosure / information-architecture practice — task-oriented chunking, default-path minimization, recognition-over-recall — to the invoice form, matching the Polish market leaders.

> **Market reference (researched across the SPEC-013→018 line):** wFirma, inFakt, Fakturownia, iFirma, SaldeoSMART all (a) show a short everyday form (buyer, dates, an editable line table, payment method/term, auto totals) with tax/compliance complexity **one click away**; (b) autofill a contractor from its NIP via the MF *Wykaz podatników VAT* (Biała lista) and/or GUS; (c) offer VAT rates and units as fixed lists; (d) validate the NIP checksum inline; (e) let you pick a saved contractor and product. **wFirma** specifically uses a **tabbed** form (PODSTAWOWE / ZAAWANSOWANE / KSIĘGOWE / KSeF) — the user's #1 named reference and the pattern this module's editor adopts. **Rejected:** full double-entry accounting / bank reconciliation / OCR import (this is an e-invoicing connector, not an accounting suite); GUS REGON BIR autofill (needs a per-deployment API key — MF *Wykaz* needs none); a modal-per-advanced-area (more clicks; hides tax attributes the operator reconciles against core fields).

## Problem Statement
1. **No UI surface on released core.** All KSeF capabilities were reachable only by calling HTTP routes directly; the legacy injection widgets render nowhere (host spots absent on released core). JPK filings/export/purchase-records, certificate enroll/revoke, offline issuance, correction-from-credit-memo, UPO download, invoice PDF, and PL-VAT meta editing were all API-only — the module owned **zero** backend pages.
2. **No buyer capture.** The original editor captured no *Nabywca* at all, so a UI-authored invoice had no `metadata.buyerSnapshot` → **Send-to-KSeF failed 422 `buyer_required`** (`buildBuyer`, `lib/fa3-mapping.ts:152`). No "look up company by NIP", the taxpayer NIP was unvalidated free text (despite a working `isValidPolishNip` checksum in `lib/nip.ts`), and VAT rate + unit were typo-prone free-text inputs.
3. **First-paint density / no task chunking.** Early iterations rendered ~60 controls at once (every GTU code, procedure marker, advance-payment row, OSS country, FX field, bad-debt and exemption control on-screen), then a single monolithic collapsed accordion — a "wall of fields" versus mainstream Polish software, with no separation of "the invoice I issue every day" from "tax attributes only some invoices need" from "rarely-touched extras". The user explicitly asked for **tabs or modals so rarely-used features are not always presented** after seeing the accordion in practice.
4. **Missing mid-market document fields.** No payment information (forma płatności / termin / numer konta / zapłacono) anywhere — not in the UI, the FA(3) `<Platnosc>` node, or the PDF; a buyer literally could not pay the invoice. The FA(3) `P_6` sale date was emitted by the serializer but had no UI input (so it silently equalled the issue date). The due date never derived from a payment term.
5. **Silent line-edit data loss.** Released core `sales.invoices.update` applies only a header + `metadata` whitelist and has **no `lines` handling**; the edit form PUT-ed the full `lines[]` expecting replace semantics core does not honor — a user edited a draft's quantities/prices, saved, saw success, and the change was gone.

## Proposed Solution
A complete operator backoffice **owned by `financial_pl`** (direct composition in the module's own backend pages), with the invoice editor raised to a wFirma / inFakt / Saldeo standard. Every write still goes through core's public `/api/sales/invoices` (header + lines + `metadata`) and the module's own `PUT /api/financial_pl/ksef/invoice-meta` (PL-VAT layer); the module never imports core code or adds a cross-module ORM relation. **No new entity, no migration, no core modification, no change to the FA(3)/KSeF/JPK/PDF backend.**

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Core `SalesInvoice`/`SalesInvoiceLine` is the single source of truth (write via `/api/sales/invoices`, read header via QueryEngine `E.sales.sales_invoice`, **lines via QueryEngine `E.sales.sales_invoice_line`** filtered by `invoice_id` — core GET is header-only, exactly as `resolve-fa3-from-invoice.ts` reads) | A duplicate invoice entity would diverge from the KSeF backend's `SalesInvoice` reads and break `resolve-fa3-from-invoice`. Honors "backend flows unchanged". |
| Module-owned backend pages by direct composition, not UMES injection | Released core exposes no invoice host spot; UMES §11 says compose your **own** UI directly, inject only into *another* module. Works standalone on released core today. |
| Remove the dead `sales.invoices`/`sales.sales_invoice` injection-table entries + `widgets/injection/*` wrappers; move their logic into `components/`; **keep** the response enricher (`E.sales.sales_invoice → _financial_pl`) | The injection entries target host spots absent on released core — dead wiring; re-adding 4 lines is trivial if core ever ships the host. (Spec-jury decider: Kimi "remove = change-discipline" over Codex/DeepSeek advisory "keep".) The enricher is valid + harmless and stays. |
| A self-contained `GET /api/financial_pl/ksef/invoices` joins invoices + latest `KsefSubmission` + `SalesInvoicePlMeta` for the list | Self-contained: the list does not depend on core opting into the enricher. Composed feature gate `['financial_pl.view','sales.invoices.manage']` (it exposes core `SalesInvoice` business data core itself gates behind `sales.invoices.manage`) to avoid a permission bypass. |
| Two-step create: POST core invoice, then PUT invoice-meta; **switch to edit/PUT mode on the new id** after the invoice POST | A failed meta step retries in place — never re-POSTing the invoice (no duplicate-create). |
| **Tabbed editor** on the DS `Tabs` primitive (wFirma-style), not accordion, not modal-per-area, not a from-scratch non-CrudForm rebuild | The user explicitly asked for tabs/modals after empirically reviewing the accordion; wFirma (their #1 reference) uses tabs; the DS ships `Tabs`; tabs keep tax/core fields one click apart in-context. Keeping `CrudForm` preserves `useGuardedMutation` conflict handling, the two-step write, zod validation, and the date pickers. |
| Panels kept **MOUNTED and toggled with `hidden`** (display:none), not the DS `TabsContent` (which returns `null` for inactive tabs) | `ComboboxInput` buffers typed custom buyer/product text and commits to the parent only on **blur**; the DS `TabsContent` unmount dropped that pending commit → typed custom names lost (confirmed live in preview). Keeping panels mounted means no field type can lose buffered text. The coherence goal is met by **visibility** (advanced surface not *shown* by default), not DOM absence. |
| Smart date derivation extracted into an always-mounted `DateDerivationEffect` rendered **outside** `<Tabs>` | The SPEC-017 issue→due/sale derivation lived in `PaymentGroup`; if that unmounted with an inactive Faktura tab, editing the issue date on the always-visible strip from another tab would skip derivation → stale due/sale dates saved. An always-mounted null-returning effect fixes it regardless of active tab. |
| `activeTab` lifted to `InvoiceForm`; `handleSubmit` calls `setActiveTab(<tab>)` per an explicit field→tab map before each `createCrudFormError` throw | Mandatory cross-tab error routing so a validation failure always brings the offending section into view (a submit-blocking error is never trapped behind a tab). |
| Buyer persists to core `SalesInvoice.metadata.buyerSnapshot` using the **exact** keys `buildBuyer` reads | `metadata` is accepted by `invoiceCreateSchema` and is the exact source `readInvoiceBuyerSnapshot`/`buildBuyer` consume — zero backend change, buyer flows straight into FA(3) Podmiot2. |
| NIP lookup is a **server-side proxy** to MF *Wykaz*, fail-open, tenant-gated | Avoids CORS, centralises the `date=today` param + timeout + NIP validation; **fail-open** — any upstream error/timeout returns a structured "unavailable" the UI shows as a non-blocking notice; manual entry is never gated on it. GUS REGON BIR rejected (per-deployment key). |
| VAT-rate quick-pick (23/8/5/0 + custom numeric); **no `zw`/`np`/`oo` line option** | Core `tax_rate` is `numeric(7,4)`; a non-numeric line value can't persist and storing exempt as `0` would mis-file it as ordinary 0% VAT in FA(3)/JPK (0% ≠ zw). Exemption / reverse-charge stay in the PL-VAT meta layer (exemption legal basis, reverse-charge flag); a help note under the picker points there. |
| Buyer/product pickers snapshot into data the invoice already owns; degrade to free text when `customers`/`catalog` are absent (404) or forbidden (403) | No hard dependency, no thrown error; the free-typed value is the floor. |
| Payment + sale date persist to `SalesInvoice.metadata` (`metadata.payment` object + `metadata.saleDate`), not `SalesInvoicePlMeta` columns | No migration; matches the additive-jsonb pattern; `metadata` is in core's create + update whitelist so it persists on both. `SalesInvoicePlMeta` is reserved for filterable JPK columns. |
| Seller bank account stored cleartext in `metadata` | It is printed on every invoice PDF and transmitted to KSeF in cleartext (`RachunekBankowy`) → non-secret invoice data (§16 covers tenant-PII, not public invoice fields). |
| F4/line-edit: lines become **read-only on edit** with an honest notice; the edit PUT stops sending `lines`; an upstream core `sales.invoices.replace_lines` command is proposed | 3/3 spec voters: an in-module core-line write breaks §4/§31-B and core has no line-update command. Eliminating the silent-loss path is the correct within-boundary fix; create is unchanged (core persists create lines correctly). |
| Mid-market feature gaps audited, not built | "Expose existing logic coherently" is the ask; net-new capabilities (discount, gross-entry, QR, recurring, email) are separate features that would balloon the change. Registered as prioritized follow-ups (UI-6). |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Inject into `sales.document.detail.invoice:*` / `sales.invoices` host spots | Those spots don't exist on released core (documents page is order/quote-only); the unmerged-branch dependency the user explicitly rejected. |
| `financial_pl` owns its own invoice entity | Duplicates core data, diverges from `buildBuyer`/`resolve-fa3` `SalesInvoice` reads, violates single-source-of-truth. |
| Keep the single accordion (SPEC-016) / keep it and just trim the core (SPEC-017) | The empirical user complaint *is* the accordion form; trimming alone gives no task-oriented chunking. Reversed to tabs. |
| One modal per advanced area | More clicks; hides tax attributes the operator reconciles against core line/buyer data; DS `Tabs` keeps it all one click away in-context. |
| Rebuild the form off `CrudForm` (custom `<form>` + Tabs) | High churn; loses guarded-mutation/conflict handling, builtin validation, and date pickers — correctness risk on a KSeF-compliance form. |
| Call MF *Wykaz* directly from the browser | CORS; can't cleanly add `date`/timeout; leaks request shape. A thin server proxy is the canonical pattern. |
| Hard VAT-rate enum incl. `zw`/`np` as line values | Core line `tax_rate` is numeric; map exemptions through the meta layer instead. |
| In-module command writing core `SalesInvoiceLine`; or recreate the draft via core create | §4/§31-B violation (cross-module entity import + raw write); drops core line fields; totals drift from `salesCalculationService`; recreate changes the invoice id (lifecycle/numbering risk). User chose the safe read-only fix. |

## User Stories / Use Cases
- A **bookkeeper** issuing a standard domestic VAT invoice fills buyer → lines → payment on the **Faktura** tab and saves, never seeing GTU/JPK/OSS/FX controls.
- An **accountant** types a buyer NIP, clicks **Look up**, and the buyer's legal name + address fill in with a *Czynny* VAT-status badge — the invoice is KSeF-ready without retyping.
- An **accountant** picks an **existing customer** (name + address prefilled from the `customers` record) and a **product** per line (name + unit + price + VAT prefilled from `catalog`), then opens **Podatki i KSeF** to set OSS/split-payment, with the tab indicator confirming tax data is present.
- A **bookkeeper** sets *przelew, 14 dni, na konto PL…*; the due date derives from the term; it appears on the PDF and in KSeF.
- A **seller** delivering goods at month-end but invoicing next period records the real *data sprzedaży* so FA(3) `P_6` is correct.
- An **operator** clicks **Send to KSeF** and watches the status go `queued → processing → accepted` with the numer KSeF, a **Download UPO** and a **Download PDF**; issues a **correction (KOR)**; generates a **JPK_V7M** filing; **enrolls/revokes** a certificate; issues an invoice **offline**.
- A **user with a validation error** sees a form-level banner and lands on the tab holding the offending field.

## Architecture
- **Extension mode:** UMES external module under `packages/financial-pl/src/modules/financial_pl`; no core modification. Auto-discovery builds routes + sidebar nav from `page.meta.ts`. Pages are client components on `@open-mercato/ui` primitives.
- **Backoffice page tree:**
```
backend/financial/invoices/page.tsx                       # list (DataTable) + KSeF status + filters + Create + bulk "Send to KSeF"
backend/financial/invoices/page.meta.ts                   # nav group "Financials (PL)", feature financial_pl.view
backend/financial/invoices/create/page.tsx                # uses InvoiceForm (create mode)
backend/financial/invoices/[id]/page.tsx                  # detail: summary + buyer + payment + KSeF panel + meta + markings + corrections
backend/financial/invoices/[id]/edit/page.tsx             # edit (lines read-only; locked entirely when KSeF-accepted)
backend/financial/invoices/[id]/edit/InvoiceForm.tsx      # THE shared create/edit tabbed form (+ module-scope InvoiceTabs / DateDerivationEffect)
backend/financial/jpk/page.tsx                            # JPK filings list + generate/export + purchase records
backend/financial/certificates/page.tsx                  # cert enroll/list/revoke + active auth method
components/                                                # BuyerFields, InvoiceLinesField, PaymentFields (PaymentGroup), PlVatMetaForm,
                                                          #   KsefStatusBadge, KsefActions, CorrectionForm
api/ksef/invoices/route.ts                                # NEW GET — list invoices + KSeF status (self-contained join)
api/ksef/company-lookup/route.ts                          # NEW GET — MF Wykaz proxy (read-only, fail-open)
lib/company-lookup.ts / lib/buyer-snapshot.ts / lib/nip.ts# lookup fetch+normalise; buyer⇄snapshot mappers; NIP checksum
```
- **KSeF immutability** is enforced by the fail-closed `before` API interceptors on core `sales.invoices` PUT/DELETE and the module's own `invoice-meta` PUT (owned + specified by SPEC-005). The UI additionally disables edit and offers "issue a correction"; it never relies on a disabled button alone.

### Data flow
- **List:** `GET /api/financial_pl/ksef/invoices` → QueryEngine read of `E.sales.sales_invoice` (org/tenant scoped) joined with the latest `KsefSubmission` + `SalesInvoicePlMeta`; encrypted columns are never projected.
- **Read one (detail / edit prefill):** header via QueryEngine `E.sales.sales_invoice` (which already returns core `metadata` → `buyerSnapshot`/`payment`/`saleDate`/`notes`), lines via QueryEngine `E.sales.sales_invoice_line` (filter `invoice_id`), PL-VAT via `GET /api/financial_pl/ksef/invoice-meta`.
- **Create / edit:** `POST`/`PUT /api/sales/invoices` with `metadata: { ...existingMetadata, buyerSnapshot, payment, saleDate, notes }` + `lines[]` (create only; see below) + line `sku` + `lines[].metadata.productId`; then `PUT /api/financial_pl/ksef/invoice-meta` keyed by `salesInvoiceId`. On edit the loaded `value.metadata` is spread first so unrelated metadata keys are never clobbered. `buyerSnapshot`/`payment` are omitted when empty.
- **NIP lookup:** `BuyerFields` → `GET /api/financial_pl/ksef/company-lookup?nip=<digits>` → `lib/company-lookup.ts` validates the NIP, calls `https://wl-api.mf.gov.pl/api/search/nip/{nip}?date=<today>` (≤6 s `AbortController`), maps `result.subject`. Fills **blank** buyer fields only, never overwriting operator-typed values; discards a stale response when the operator changed the NIP mid-flight.
- **KSeF actions / JPK / certs:** the existing SPEC-005/006 routes — `submissions/{from-invoice,from-credit-memo,retry,issue-offline,batch}`, `upo`, `invoice-pdf`, `jpk/{filings,export,purchase-records}`, `certificates/{,enroll,revoke}`.
- **Correction (KOR):** `CorrectionForm` creates a `SalesCreditMemo` via core `POST /api/sales/credit-memos` (command `sales.credit_memos.create`, verified at `documents.ts:8909`; carries corrected `invoiceId` + `reason` + lines, currency defaults PLN, positive quantities), then sends via `submissions/from-credit-memo`. Gated on `sales.credit_memos.manage`.

### Commands & Events
- **None new.** The UI dispatches existing command-backed routes: invoice writes dispatch core `sales.invoices.create/update/delete`; corrections dispatch `sales.credit_memos.create`; KSeF actions dispatch the existing `financial_pl.ksef_submission.*` commands. No new migration.

## UI-2 — Tabbed editor (the final layout)
```
┌─ Create / Edit invoice ──────────────────────────────────────────────┐
│  [ Number ] [ Issue date ] [ Sale date ] [ Due date ] [ Currency ]    │  ← always-visible coordinate strip
│                                                                        │     (builtin CrudForm fields; validated; never hidden)
│  ┌ Faktura ─┬─ Podatki i KSeF ─┬─ Dodatkowe ─┐                         │  ← DS Tabs (underline variant); panels mounted, toggled `hidden`
│  │ Buyer (Nabywca)            …               │                        │
│  │ Lines (Pozycje)            …  read-only on edit                     │
│  │ Payment (Płatność)         …               │   default tab          │
│  │ Notes (Uwagi)              …               │                        │
│  └────────────────────────────────────────────┘                       │
│  [ Save ]  [ Cancel ]                                                   │
└────────────────────────────────────────────────────────────────────────┘
```

- **Two CrudForm groups.** `header` — builtin CrudForm `fields` (`invoiceNumber`, `issueDate`, `saleDate`, `dueDate`, `currencyCode`), the always-visible coordinate strip; CrudForm keeps rendering its date **popover pickers** (`type:'date'` renders a `<button>`, not a native date input) and running zod validation, so "currency required" / "due < issue" is never trapped behind a tab. `body` — a `bare:true` component group whose `component(ctx)` renders `<InvoiceTabs …/>`.
- **`InvoiceTabs` is a stable module-scope component** — never defined inside `InvoiceForm`, a `useMemo`, or the group closure (a component type redefined every render is remounted by React, resetting the active tab). It renders `Tabs`/`TabsList`/`TabsTrigger` (`variant="underline"`) for the tab UI + a11y, and **three `role="tabpanel"` `<div>`s toggled via `className={activeTab===X ? '' : 'hidden'}`** (mounted, not `TabsContent`) that host the existing components verbatim:
  - **Faktura (default):** `<BuyerFields>`, the lines block (read-only notice on edit + `<InvoiceLinesField>`), `<PaymentGroup>` (`<PaymentFields>`; drives the due date), and **Notes** (`Uwagi`).
  - **Podatki i KSeF:** `<PlVatMetaForm>` in full (kind, taxpayer NIP, MPP / reverse-charge / self-billing / issued-outside-KSeF switches, OSS + consumption country, FX, advance/settlement, GTU + procedure markings, doc type, bad-debt, exemption — its internal sub-accordions preserved), receiving the live `currencyCode`/`issueDate` props.
  - **Dodatkowe:** `Order ID` + a slot for future extras.
- **`notes` and `orderId` relocation.** Both move off the strip into tabs but stay in the CrudForm `schema`/`initialValues`, rendered as **controlled inputs driven by `ctx.values` + `ctx.setValue`** (a CrudForm component group cannot render a builtin field by id — `ctx` is `{ values, setValue, errors }`, no `renderField`). Each renders its own `ctx.errors[id]` below the field (future-proof; both `optional()` today). DS primitives: `Textarea` for notes, `Input` for order id.
- **`DateDerivationEffect`** — the SPEC-017 issue→due/sale derivation + per-field touch-detection effects, extracted into an always-mounted null-returning component rendered **outside `<Tabs>`** so editing dates on the strip from any tab still derives. It receives `ctx`, `value.payment.termDays`, and the `dueTouched/saleTouched/lastAutoDue/lastAutoSale` refs. `PaymentFields` keeps its own `deriveDue`-on-term-change `onChange` wiring (fires only on the Faktura tab); both share the same refs → identical behaviour.
- **Cross-tab error routing (mandatory).** `activeTab` is lifted to `InvoiceForm` (`useState<'faktura'|'podatki'|'dodatkowe'>('faktura')`, passed down as controlled `value`/`onValueChange`). `handleSubmit` calls `setActiveTab` before each `createCrudFormError` throw per this map:

  | Failing check (in `handleSubmit`) | Tab to focus |
  |---|---|
  | lines required / line name / line qty / line VAT rate | `faktura` |
  | buyer required / buyer NIP checksum / UPR buyer | `faktura` |
  | payment refine (paid w/o date, other w/o desc), term-days out of range | `faktura` |
  | taxpayer (context) NIP checksum | `podatki` |
  | due < issue (also on the always-visible strip) | `faktura` |

  Custom-section validations throw `createCrudFormError` → CrudForm shows a form-level banner (visible on any tab); the auto-switch guarantees the user lands on the offending tab.
- **Has-data tab affordance.** A non-default tab trigger shows a "has data" cue when its panel holds non-empty data — `podatki` when `hasMeaningfulPlVatMeta(value.meta)` is true, `dodatkowe` when `orderId` is non-empty (recognition-over-recall; mirrors ifirma's filled-card cue). The cue lives in the trigger **children** (the sandbox runtime's `Tabs` did not render a `count`-only badge). On **edit** of an invoice with PL-VAT data, the active tab defaults to `faktura` with the `podatki` indicator lit — no auto-jump.
- **Hidden-native-validation guard.** Because all panels are mounted, a native-constrained control (`required`/`min`/`step`) blank or out-of-range while under `display:none` silently blocks native submit as "not focusable". Native `required`/`min`/`step` were removed from `methodOther`/`paidDate`/`term-days`; the JS `handleSubmit` guards are the gate. The term-days input is `type="text" inputMode="numeric"` (no implicit `step=1` stepMismatch).

## UI-3 — Buyer capture & MF *Wykaz* NIP autofill
- **Buyer section** on the Faktura tab: an optional searchable **"Pick existing customer"** combobox (UI-4), then **Company name**, **NIP** with an inline **Look up** button + a `StatusBadge` VAT-status chip after a successful lookup, **Address line 1/2**, **Postal code**, **City**, **Country** (default `PL`). Inline NIP-checksum error via `FormField`. For **UPR** invoice kind, name/address become optional (NIP-only buyer allowed) — mirrors `buildBuyer`'s UPR branch `(name && address) || nip`.
- **Buyer snapshot keys mirror `buildBuyer` exactly:** `companyName`, `nip`, `addressLine1`, `addressLine2`, `city`, `postalCode`, `countryCode` (no `email` — `buildBuyer` doesn't read it). `buildBuyer` reads `companyName ?? company_name ?? name`, `nip ?? taxId`. `buyerToSnapshot` normalises the NIP to bare digits + `countryCode` to upper-case before persisting so a dashed `525-234-40-78` doesn't 422 against the `invoice-meta` `^[0-9]{10}$` schema at send. `buyerSnapshot` is omitted entirely when the buyer is empty.
- **MF *Wykaz podatników VAT* (Biała lista) contract** (`lib/company-lookup.ts`): endpoint `https://wl-api.mf.gov.pl/api/search/nip/{nip}?date=<YYYY-MM-DD today>`, ≤6 s `AbortController` timeout, `result.subject` mapped to `{ name, nip, statusVat, regon, address }` where `address = workingAddress ?? residenceAddress`, split by `parseWykazAddress` into street/postal/city with a line-1 fallback. **`accountNumbers` is intentionally dropped** (white-list bank verification out of scope). On upstream failure/timeout the proxy returns HTTP 200 `{ ok:false, reason:'unavailable'|'not_found' }` (fail-open); on success `{ ok:true, company }`. Only the public business NIP the operator is invoicing leaves the system (a public statutory register; no tenant/personal data).
- **Taxpayer (contextNip) NIP** in `PlVatMetaForm` also gets inline checksum feedback; `buildMetaPayload` normalises it to digits before persisting.

## UI-4 — Lines, product picker, VAT/unit pickers
- **Customer picker** (`BuyerFields`): `ComboboxInput` is string-only, so `loadSuggestions` returns `ComboboxOption[]` with `value = company.id`, `label = displayName` + a parallel `Map<id, company>`; on select, `GET /api/customers/companies/[id]?include=addresses` fills `companyName` + address from the primary (`isPrimary`) address. **NIP is NOT filled from the customer** — companies carry no tax-id column; NIP stays via MF *Wykaz*. Edit-mode rule: an explicit selection **replaces** name+address (they're pre-filled from the snapshot, so a blank-only merge would no-op); a field typed *after* the last selection is preserved ("dirtied-since-select"); free typing via `allowCustomValues` never overwrites.
- **Product picker** (`InvoiceLinesField`, per line): type-ahead over `GET /api/catalog/products?search=&pageSize=10` (`ComboboxOption{value:id,label:title}` + `Map<id,product>`). On select fills `name ← title`, `quantityUnit ← default_unit` (catalog returns `title`/`default_unit`, **not** `name`/`quantityUnit`), `taxRate ← pricing.tax_rate ?? product.tax_rate`. **Currency-safe price:** fill `unitPriceNet ← pricing.unit_price_net` **only when `pricing.currency_code === the invoice `currencyCode`** — never silently import a foreign-currency price (verified live: a USD-priced product on a PLN invoice fills name+unit but leaves price `0`). The link is stamped as line `sku` (top-level, core-persisted) + `metadata.productId` (line jsonb) — core has **no `productId` column**. Free text stays the fallback.
- **VAT-rate picker:** `23% / 8% / 5% / 0% / Other…`→numeric input; a matched/scaled DB value (`23.0000`) shows the clean `23%` pick, an unmatched value reveals the custom input. A line VAT rate is **required non-empty numeric** (picking "Other…" and leaving it blank cannot silently persist as 0%).
- **Unit picker:** dropdown of common units (szt./pcs, kg, g, l, ml, m, m², m³, godz., km, opak., usł., kpl., t) + explicit `Other…`→free input (picker-first, not free text by default).
- **GTU + procedure markings** (`PlVatMetaForm`): a filter box above the labelled grid narrows the visible options; the OSS **consumption-country** select is a searchable combobox.
- **Read-only lines on edit (core-PUT limitation, verified).** Released core `sales.invoices.update` (`documents.js:6629`, `buildChanges` whitelist 6641-6657) has **no `lines` handling** (create at 6508 persists lines incl. `sku` + line `metadata`). So on **edit** the line items are **read-only** with an inline notice — *"Pozycje faktury nie mogą być zmienione po utworzeniu (ograniczenie rdzenia). Aby zmienić pozycje, utwórz nową fakturę lub wystaw korektę (KOR)."* / EN equivalent — and the edit PUT **stops sending `lines`** (killing the false-success path). Header, dates, buyer, payment, sale date, notes, and all VAT/KSeF/JPK metadata remain fully editable. Because PUT ignores lines, the create-time product link is also never *lost* on edit. **Upstream proposal (follow-up filed):** a core `sales.invoices.update`-with-lines / `sales.invoices.replace_lines` command using `salesCalculationService`; the module adopts it when core ships it.
- **Inline validations (block save + inline error):** buyer NIP checksum, taxpayer NIP checksum, due date < issue date, any line quantity ≤ 0, unit price < 0 (0 is allowed — free/sample/100%-discount lines), no lines, buyer missing for a non-UPR kind, and the term-days whole-number guard (see UI-5). Uses `CrudForm`/`FormField` error surfaces + `Alert`, never browser `alert`.

## UI-5 — Payment, sale date, smart defaults
- **Payment & settlement block** on the Faktura tab (directly under the lines totals):
  - **Payment method** (`method`): select over the FA(3) `FormaPlatnosci` set + `other`; free-text `methodOther` (→ `OpisPlatnosci`) shown + required only when `other`.
  - **Payment term (days)** (`termDays`): drives the due date (default 14); clearing it leaves the due date manual. **Must be a whole number in `[0, 3650]`** — enforced by a `handleSubmit` guard (i18n `financial_pl.validation.termDaysRange`), because a negative/fractional `termDays` fails `invoicePaymentSchema` `.int().min(0)` and `resolve-fa3-from-invoice.ts` then **fail-opens, silently dropping the entire `<Platnosc>` block from the FA(3)**.
  - **Bank account** (`bankAccount`, IBAN/NRB), `bankName`, `swift`: shown only when method = `transfer`; cleared on switching away (no stale data). Lightweight format validation, not a checksum hard-fail.
  - **Paid** (`paid` boolean) + **paid date** (`paidDate`, required when `paid`).
  - Conditional-validity refines in `invoicePaymentSchema` (zod `.refine`) mirrored in UI: `paid ⇒ paidDate`, `method==='other' ⇒ methodOther`.
- **Sale date** (`metadata.saleDate`, FA(3) `P_6`): a "Data sprzedaży / Sale date" input on the coordinate strip, prefilled = issue date. The mapping + serializer already consume it (`fa3.ts:616` ← `model.saleDate`; `resolve-fa3-from-invoice.ts:285` ← `metadata.saleDate ?? issue_date`) — this adds only the input + PDF/detail line.
- **Smart date defaults with per-field override-tracking:** `dueDate = issueDate + termDays`, `saleDate` prefilled = `issueDate`; a user edit sets a per-field "touched" flag so derivation never clobbers explicit values; existing values load as touched in edit mode. Initial create defaults: issue = today, `termDays = 14`, `saleDate = today`, `dueDate = today + 14`.
- The payment block, sale date, and their smart defaults persist to `SalesInvoice.metadata`; the FA(3) `<Platnosc>` node emission + the `method → FormaPlatnosci` code matrix live in **SPEC-006** (the doc layer). Payment is deliberately FA(3)/PDF-only and **not** wired to JPK_V7 (JPK uses `TerminPlatnosci` only for art. 89a bad-debt, handled by `badDebtTerminPlatnosci`).

## UI-6 — Mid-market completeness gap audit (documentation only)
A register of where `financial_pl` stands vs. Polish mid-market products, so the product owner can prioritize. **Nothing here is built** — each is its own follow-up spec.

| Capability | Status in `financial_pl` | Gap / follow-up | Priority |
|---|---|---|---|
| FA(3) VAT/KOR/ZAL/ROZ/UPR/OSS, online/offline/awaria, KOD II | ✅ shipped (SPEC-005/006/007) | — | — |
| Token + XAdES certificate auth (KSeF) | ✅ shipped + live-verified (SPEC-005) | — | — |
| JPK_V7 → MF e-submission, inbound receiving, batch, NBP FX | ✅ shipped (SPEC-005/006) | — | — |
| Buyer from customers list, products from catalog | ✅ shipped (UI-4 pickers) | — | — |
| Payment method / term / bank / paid, sale date, smart due | ✅ shipped (UI-5) | — | — |
| Coherent tabbed authoring UX | ✅ shipped (UI-2) | — | — |
| **Line-level discount (rabat)** | ❌ none (qty·price·VAT only) | FA(3) supports per-line discount; add discount field + totals + FA(3)/PDF | High |
| **Gross-price entry toggle (cena brutto/netto)** | ❌ net-only entry | mid-market expects gross-first entry with back-calc | High |
| **Payment QR (przelew QR / KSeF payment QR) on PDF** | partial (offline KOD II only) | add a płatność QR to the PDF | Medium |
| **Recurring / cyclical invoices** | ❌ none | scheduler-driven recurring issue | Medium |
| **E-mail the invoice/PDF to the buyer** | ❌ (KSeF send only) | mail transport + template | Medium |
| **Multiple numbering series / prefixes** | core auto-numbers; no per-series UI | likely core-owned; confirm | Low |
| **Proforma (non-KSeF) document** | ❌ none | proforma kind (not an FA(3) doc) | Low |
| **Bilingual / foreign-language invoice** | ❌ Polish PDF only | second-language PDF column | Low |

## Data Models
**No new entity, no migration, no metadata-shape change beyond additive jsonb keys.** All new invoice data rides existing core `SalesInvoice.metadata` (jsonb) + the already-accepted line `sku` + `SalesInvoiceLine.metadata`; the PL-VAT layer rides `SalesInvoicePlMeta` (owned by SPEC-006). Reused entities: core `SalesInvoice`/`SalesInvoiceLine`, core `SalesCreditMemo` (KOR), `financial_pl` `SalesInvoicePlMeta`, `KsefSubmission`, `JpkVatFiling`, `PurchaseVatRecord`.

Metadata shapes written by the editor (all optional, additive):
```ts
metadata.buyerSnapshot = { companyName, nip, addressLine1, addressLine2?, city, postalCode, countryCode }
metadata.payment = {
  method: 'transfer'|'cash'|'card'|'voucher'|'cheque'|'credit'|'mobile'|'other',
  methodOther?: string,   // required when method==='other' → FA(3) OpisPlatnosci
  termDays?: number,      // whole number in [0,3650]; drives the due date
  bankAccount?: string,   // IBAN/NRB (cleared when method!=='transfer'); cleartext by design
  bankName?: string, swift?: string,
  paid?: boolean, paidDate?: string,  // paidDate required when paid===true
}
metadata.saleDate?: string   // YYYY-MM-DD; consumed by resolve-fa3-from-invoice.ts:285
metadata.notes?: string      // rendered on detail + PDF (only when non-empty; byte-stable); kept OUT of FA(3) XML
// per line:
lines[].sku?: string, lines[].metadata.productId?: string   // catalog link (create-persisted only)
```
`invoicePaymentSchema` (with `.refine`: paid⇒paidDate, other⇒methodOther) validates `metadata.payment` in `data/validators.ts`; `CompanyLookupResult` is a transient zod-typed shape (not stored). The editor's `InvoiceLineInput` type gains module-local `productId?`/`sku?` (not DB columns).

## API Contracts
### New: list invoices with KSeF status
- `GET /api/financial_pl/ksef/invoices?search=&status=&page=&pageSize=` — `requireFeatures: ['financial_pl.view','sales.invoices.manage']` (composed; gating on `financial_pl.view` alone would be a permission bypass).
- Response: `{ items: Array<{ id, invoiceNumber, issueDate, dueDate, currencyCode, grandTotalNetAmount, grandTotalGrossAmount, status, ksefStatus, ksefNumber, upoAvailable, offlineSendDeadlineAt, invoiceKind }>, total, page, pageSize }`. Org/tenant scoped; encrypted columns never projected.

### New: company lookup (read-only MF *Wykaz* proxy)
- `GET /api/financial_pl/ksef/company-lookup?nip=<10 digits>` — `requireFeatures: ['financial_pl.view']`. **400** when the NIP fails `isValidPolishNip`. On success **200** `{ ok:true, company:{ nip, name, statusVat:'Czynny'|'Zwolniony'|'Niezarejestrowany'|string|null, regon, address } }`. On upstream failure/timeout **200** `{ ok:false, reason:'unavailable'|'not_found' }` (fail-open). `accountNumbers` never exposed. No DB read (tenant scoping N/A) but auth/feature gate enforced; query zod-validated.

### Feature gating (composed)
- **Invoice list / detail / edit pages** require `['financial_pl.view','sales.invoices.manage']`; a `financial_pl`-only user sees a clear "requires sales.invoices.manage" message (viewing/sending still works).
- **Correction (KOR)** requires `sales.credit_memos.manage` (action hidden/disabled without it).
- **KSeF actions** UI-gated with wildcard-aware `hasAllFeatures` (never `Array.includes`, never relying on a server 403 alone) AND by the server route: Send/Retry/Issue-offline/batch → `financial_pl.submit`; JPK generate/export + Certificates enroll/revoke → `financial_pl.manage`; UPO/PDF/view → `financial_pl.view`.

### Reused (unchanged) — consumed by the UI
- Core: `GET/POST/PUT/DELETE /api/sales/invoices` (`sales.invoices.manage`; `metadata` accepted + persisted on create+update; line `sku` + `lines[].metadata` accepted); `POST /api/sales/document-numbers`; `POST /api/sales/credit-memos` (`sales.credit_memos.create`); `GET /api/customers/companies?search=` + `/[id]?include=addresses` (`customers.companies.view`); `GET /api/catalog/products?search=&pageSize=` (`catalog.products.view`).
- `financial_pl`: `GET/PUT /api/financial_pl/ksef/invoice-meta`; `POST /api/financial_pl/ksef/submissions/{from-invoice,from-credit-memo,retry,issue-offline,batch}`; `GET …/submissions/upo`; `GET …/invoice-pdf`; `GET/PUT …/jpk-markings`; `GET/POST …/jpk/{filings,export,purchase-records}`; `GET/POST …/certificates`, `…/enroll`, `…/revoke`.

The PL-VAT meta editor exposes the full `invoiceMetaPutSchema`: `contextNip, mppRequired, issuedOutsideKsef, vatExemptionBasis, invoiceKind (vat|kor|zal|roz|upr|kor_zal|kor_roz), selfBilling, reverseCharge, ossProcedure, consumptionCountryCode, exchangeRate, exchangeRateDate, advancePayments[], advanceRefs[], orderSnapshot, gtuCodes[], procedureMarkings{12 flags}, typDokumentu, badDebtReliefPeriod, badDebtTerminPlatnosci` (the column semantics are owned by SPEC-006).

## Internationalization (i18n)
New keys in **all four** locales (`i18n/{en,pl,de,es}.json`; flat keys, alphabetical via `jq -S`; no hardcoded user-facing strings; internal/log strings prefixed `[internal]`):
- Nav group + page titles; list columns; the coordinate-strip + tab labels (`form.tabs.faktura` *Faktura*/Invoice, `form.tabs.podatki` *Podatki i KSeF*/Taxes & KSeF, `form.tabs.dodatkowe` *Dodatkowe*/Additional, `form.tabs.hasDataHint` *Zawiera dane*/Has data).
- Buyer section + lookup (`invoices.form.sections.buyer`, `buyer.companyName`, `buyer.nip`, `buyer.addressLine1/2`, `buyer.postalCode`, `buyer.city`, `buyer.country`, `buyer.lookup`, `buyer.vatStatus`, `buyer.lookupUnavailable`, `buyer.lookupNotFound`).
- Validation (`validation.nipChecksumBuyer`, `validation.nipChecksumTaxpayer`, `validation.dueBeforeIssue`, `validation.quantityPositive`, `validation.unitPricePositive`, `validation.buyerRequired`, `validation.buyerRequiredUpr`, `validation.termDaysRange`).
- Pickers (`lines.taxRateOther/taxRateCustom`, `lines.unitOther/quantityUnitCustom`, `fields.gtuFilter/procedureFilter/consumptionCountryPlaceholder`).
- Payment + sale date (`invoices.form.payment.*` — title, method options, term, bankAccount, bankName, swift, paid, paidDate; `invoices.form.saleDate`).
- Notes (`invoices.form.notes`), the read-only-lines-on-edit notice, KSeF action labels + confirmations, JPK + certificate labels, and status labels (incl. `financial_pl.status.offline_overdue`).

## UI/UX
- **Invoices list:** `DataTable` (`pageSize ≤ 100`), columns Number / Issue date / Buyer / Net / Gross / Status / **KSeF status** (`StatusBadge` + `KsefStatusMap`, never hardcoded colors); RowActions `open`/`edit`/`send`/`pdf`; toolbar Create + search + status filter; **bulk "Send selected to KSeF"** (`bulkActions`) uses the same explicit-issuance predicate as single send (blank/draft/pending eligible; canceled/void blocked), excludes accepted/active submissions, POSTs `{invoiceIds}` to `submissions/batch` (202 `{ ok, batchReference, count }`), flashes the accepted count + batchReference, and refreshes.
- **Invoice detail:** read summary + buyer (name + NIP + address) + payment + sale-date cards + **KSeF panel** — status badge, numer KSeF (copy), Send (arm-then-confirm via `useConfirmDialog`), Retry (targets the latest non-`accepted` submission), Download UPO, Download PDF, Issue offline (+ deadline surfaced), Issue correction (KOR). Distinct loading / not-found / error states. Edit disabled once `accepted`.
- **JPK page:** filings list + period picker → Generate (requires `kodUrzedu` + `contextNip` the resolver needs) → Download (XML); purchase-records table (add/delete).
- **Certificates page:** list, Enroll (name + type Authentication/Offline), Revoke; shows the active auth method.
- **DS discipline:** `@open-mercato/ui` primitives + the `Tabs` primitive (`variant="underline"`); semantic tokens only (§22); `lucide-react` icons with `aria-label`; `Cmd/Ctrl+Enter` save / `Escape` cancel; `flash()`/`Alert` (not `Notice`) feedback; verified by `om-ds-guardian` on touched lines. Mobile: the underline tab strip scrolls horizontally; each panel stacks its fields.
- **Detail/edit page params:** the backend `/[...slug]` catch-all passes `params` as a **sync prop**, so detail/edit pages read `props.params.id` (`useParams()` returns the slug array → empty id → 308 → "Failed to load").

## Migration & Compatibility
- **No DB migration, no schema change, no BC-surface break (§27).** Purely additive: new backend pages, one new list GET route, one new MF-lookup GET route, additive jsonb `metadata` keys, and new i18n keys. The removed `sales.invoices`/`sales.sales_invoice` injection-table entries + `widgets/injection/*` wrappers are internal to `financial_pl` (no external consumer references them); the enricher stays. An existing invoice opens with identical data on the tabbed layout; a saved invoice produces a byte-identical payload/FA(3)/PDF to before this UI work. The SPEC-005 immutability interceptor (its conditional-409 on core `sales.invoices` PUT/DELETE for KSeF-accepted invoices, documented as the module's effective contract) is unchanged. `yarn generate` re-emits the route/injection/enricher registries.
- **ACL:** no new feature IDs; the invoice editor additionally needs core `sales.invoices.manage` (documented).

## Risks & Impact Review

### Switching tabs loses entered data — CONFIRMED + fixed
- **Scenario:** a user types a **custom** buyer/product name into a `ComboboxInput` (buffers locally, commits on blur), then clicks another tab; the DS `TabsContent` unmount drops the pending blur-commit → the typed value is lost. Confirmed live in preview.
- **Severity:** High (real data loss). **Affected area:** the tab body.
- **Mitigation (implemented):** panels are kept **mounted** and toggled with `hidden` instead of `TabsContent`; nothing unmounts, so no field type can lose buffered text. Re-verified live: the typed custom buyer name survives a tab round-trip. Guarded by TC-5. Trade-off: all panels render on first paint (PL-VAT controls present but `hidden`); the coherence goal is met by visibility, not DOM absence.
- **Residual risk:** low.

### Stale due/sale date — derivation unmounted with the Faktura tab
- **Scenario:** a user on *Podatki i KSeF* edits the issue date on the always-visible strip; the SPEC-017 derivation (living in an unmounted `PaymentGroup`) doesn't run → a stale due/sale date is saved.
- **Severity:** High. **Mitigation:** the date effects are extracted into an always-mounted `DateDerivationEffect` outside `<Tabs>`. **Residual:** low.

### Negative/fractional term-days silently drops `<Platnosc>` from the FA(3) — CONFIRMED + fixed
- **Scenario:** in edit mode (due-derivation suppressed, so `-1` no longer trips `dueBeforeIssue`; native `min=0` removed for the hidden-panel fix) a negative/fractional `termDays` fails `invoicePaymentSchema` `.int().min(0)` and `resolve-fa3-from-invoice.ts` **fail-opens**, silently dropping the entire `<Platnosc>` block from the KSeF FA(3).
- **Severity:** High (KSeF-compliance data regression). **Mitigation:** a `handleSubmit` guard requires a whole number in `[0,3650]` (`financial_pl.validation.termDaysRange`) + Faktura routing; the input is `type="text" inputMode="numeric"` (no native `step=1` mismatch). Live-verified (`-1`, `0.5` both blocked). **Residual:** low.

### Autofilled buyer doesn't reach FA(3)
- **Scenario:** snapshot keys drift from what `buildBuyer` reads → buyer silently empty at send → 422.
- **Severity:** High. **Mitigation:** persist the **exact** keys `buildBuyer` consumes; `lib/buyer-snapshot.ts` unit-tests the 1:1 mapping (incl. snake_case / name·taxId aliases, NIP/country normalisation, empty→omit); an integration test authors → sends and asserts no `buyer_required`. **Residual:** low.

### Editing a KSeF-accepted invoice
- **Scenario:** an operator (or a stale tab / other client / raw API call) edits or deletes an `accepted` invoice or its PL meta → the on-file KSeF document and the local copy diverge (illegal).
- **Severity:** High. **Mitigation:** the SPEC-005 **server-side fail-closed API interceptors** reject (409) PUT/DELETE + `invoice-meta` PUT when a `queued`/`processing`/`accepted`/`offline_issued` submission exists — not just a disabled button; buyer/payment writes ride the same guarded PUT. **Residual:** negligible.

### MF *Wykaz* API unavailable / slow / rate-limited
- **Scenario:** the external API is down/slow/throttles; lookups hang or error.
- **Severity:** Medium. **Mitigation:** ≤6 s `AbortController` timeout, structured `{ ok:false }` fail-open, non-blocking UI notice, manual entry always available, single attempt per click; the route never throws into the invoice save path. **Residual:** low.

### Cross-tenant leak via the new list endpoint
- **Scenario:** the joined invoice+KSeF read forgets org/tenant scope.
- **Severity:** High. **Mitigation:** QueryEngine requires `tenantId` + filters org/tenant; reuse the enricher's scoped join; two-org isolation integration test; encrypted columns never projected. **Residual:** negligible.

### Line edits still unavailable on edit (deferred)
- **Scenario:** users cannot edit an existing draft's line items in-place; must create a new invoice or a KOR.
- **Severity:** Medium (functionality gap, not a defect). **Mitigation:** the silent-loss bug is removed (honest read-only + notice; edit PUT drops `lines`); the upstream core `sales.invoices.replace_lines` command is proposed + a follow-up filed. **Residual:** accepted; resolved when core ships invoice-line update.

### Bank account (IBAN) at rest in metadata
- **Scenario:** `bankAccount` stored cleartext in `SalesInvoice.metadata`.
- **Severity:** Low. **Justification:** the seller's account is printed on every PDF + transmitted to KSeF in cleartext (`RachunekBankowy/NrRB`) → non-secret invoice data, consistent with the buyer NIP/address already in the same metadata; §16 covers tenant-PII columns, not public invoice fields. **Residual:** acceptable.

### Hidden validation error / submit-blocking field trapped behind a tab
- **Scenario:** a required field on an inactive tab errors and the user can't see why save failed.
- **Severity:** Medium. **Mitigation:** all CrudForm-validated fields are on the always-visible strip; custom-section errors are form-level banners; mandatory tab-error routing (`setActiveTab` before each throw per the field→tab map) brings the offending tab into view; relocated notes/orderId render `ctx.errors`. **Residual:** low.

## Final Compliance Report — 2026-07-01

### Compliance Matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| §4 / §31 A | No import of another module's code | Compliant | UI-only; reuses own components + core public HTTP APIs; no cross-module ORM relation |
| §31 B | Writes via command/public API; tenant-scoped | Compliant | writes ride core `sales.invoices.create/update/delete` + own `invoice-meta`; new reads org/tenant scoped |
| §31 C | Zod validation | Compliant | `invoicePaymentSchema` (+refines), company-lookup query schema, invoices-list query schema; `z.infer` types; no `any` |
| §27 | No change to FROZEN/STABLE surfaces | Compliant | additive routes + jsonb keys; identical payloads/FA(3)/PDF; injection removal is module-internal |
| §31 L | DS tokens/primitives; strings in all 4 locales | Compliant | DS `Tabs`/primitives; i18n ×4; `om-ds-guardian` on touched UI |
| §31 O | Integration tests for affected paths; self-contained | Compliant | TC-KSEF-UI-001…009, TC-payment-*, TC-line-readonly-on-edit ship with the change |
| §8 (schema) | No migration | Compliant | none |
| §16 | Encryption for tenant PII | N/A / justified | no data change; seller bank account is public invoice data |
| §11 / §11.4 | UMES boundary: own UI by composition; cross-module guard via interceptors | Compliant | module-owned pages; immutability via SPEC-005 interceptors |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | metadata shapes ↔ schemas ↔ routes |
| API contracts match UI/UX | Pass | editor writes the same keys the resolver/list route read |
| Risks cover all write operations | Pass | metadata writes covered; tab-unmount + term-days + immutability + tenancy covered |
| Mutations use existing commands | Pass | no new command/migration; core create/update + own meta route only |

### Verdict
- **Fully compliant** — a presentational, BC-safe operator UI over the core sales-invoice contract, live-verified end-to-end on KSeF TEST, with the mandatory integration tests and DS guard.

## Integration Test Coverage
Server-side flows are asserted by API-level Playwright specs (`request` fixture); client-side pickers/inline-validation/tab behaviour by unit tests + the live sandbox preview pass. Tests **exercise** behaviour (assert payloads/results), not merely that controls render.
- `TC-KSEF-UI-001` — invoices list: auth + composed-feature gate (401; 403 missing `financial_pl.view` OR `sales.invoices.manage`); two-org isolation; KSeF status column from `_financial_pl`.
- `TC-KSEF-UI-002` — author invoice via the form (header + ≥1 line + PL-VAT meta) → POST `/api/sales/invoices` (lines persisted) + PUT `invoice-meta` (full field set); edit-prefill reads lines via QueryEngine; the interceptor returns **409** on PUT/DELETE of an invoice with an `accepted` submission (by direct API call).
- `TC-KSEF-UI-003` — detail: Send dispatches `from-invoice`; Retry targets the latest non-accepted submission; UPO + PDF return non-empty content; Issue-offline creates an offline submission.
- `TC-KSEF-UI-004` — Correction (KOR): create a credit memo via `POST /api/sales/credit-memos` then send via `from-credit-memo`; gated on `sales.credit_memos.manage`.
- `TC-KSEF-UI-005` — JPK page (create/generate → well-formed XML; purchase-record add/delete); Certificates page (enroll/list/revoke wired + gated `financial_pl.manage`).
- `TC-KSEF-UI-006` — NIP lookup route (401 unauth; 400 bad checksum; fail-open 200 `{ ok }` for a valid-but-fictional NIP; `accountNumbers` never exposed) + buyer round-trip (author with `metadata.buyerSnapshot`; the module detail route returns it for prefill).
- `TC-KSEF-UI-007` — buyer customer picker fills name+address (NIP stays manual/MF); edit-mode selecting a different customer replaces name+address; an operator field edited after selection survives; product picker fills name/unit (+price/VAT when currency-matched) and the saved line carries `sku` + `metadata.productId` on create; free-typed/cleared line carries no link; catalog/customers disabled → manual entry unaffected; notes round-trip; batch "Send selected" calls the batch endpoint and reports results.
- `TC-KSEF-UI-009` — the tabbed form: TC-1 first paint (coordinate strip + 3 tab triggers, Faktura active, Buyer/Lines/Payment visible, a PL-VAT-only control `toBeHidden()`); TC-2 tab switch reveals `PlVatMetaForm` + a typed value is retained (panel hidden, not unmounted); TC-3 has-data indicator lit on `podatki` with an edit fixture; TC-4 mandatory tab-error routing (invalid taxpayer NIP → auto-switch to `podatki` + form-level banner; missing buyer while on `podatki` → switch to `faktura`); TC-5 no-combobox-data-loss across tabs (typed custom buyer name survives a tab round-trip). Assertions use visibility (`toBeHidden`) + `getByPlaceholder`/`getByText` (CrudForm labels lack `htmlFor`; test NIP `7980332920` is checksum-valid).
- `TC-payment-create` / `TC-line-readonly-on-edit` / `TC-payment-defaults` — payment method/term/bank + sale date round-trip on the PDF; lines read-only + notice on edit while payment/due ARE editable and persist (regression guard the false-success line PUT is gone); due date moves by `termDays` until the user edits it manually.
- Unit: `api/ksef/invoices` (org/tenant scope + status join); the invoices-list + company-lookup query validators; `lib/company-lookup.ts` (MF-response mapping, address split/fallback, `accountNumbers` dropped, 404→`not_found`, 5xx/abort→`unavailable`, NIP short-circuit); `lib/buyer-snapshot.ts` (buyer⇄snapshot vs `buildBuyer` keys; NIP/country normalisation; empty→omit); the interceptor predicate (queued/processing/accepted/offline-issued→reject); `PlVatMetaForm` field mapping.

## Changelog
### 2026-07-01
- **Consolidated from SPEC-013, SPEC-014, SPEC-016, SPEC-017, SPEC-018 into this thematic spec; reflects final implemented state.** The invoice editor is described only in its **final tabbed layout** (always-visible coordinate strip + Faktura / Podatki-i-KSeF / Dodatkowe tabs on the DS `Tabs` primitive, panels kept mounted via `hidden`, always-mounted `DateDerivationEffect`, mandatory cross-tab error routing, has-data indicators). The intermediate layouts are superseded and dropped from the body: SPEC-013's flat one-screen ~60-field `CrudForm`, SPEC-016's progressive-disclosure **accordion**, and SPEC-017's "keep accordion (no tabs)" decision were all reversed to tabs after the user reviewed the accordion empirically. Content routed to sibling specs to avoid duplication: the KSeF transport / submission / **fail-closed immutability interceptors** / credentials → SPEC-005; the FA(3) `<Platnosc>` node emission + the `method→FormaPlatnosci` code matrix + the `SalesInvoicePlMeta` column semantics + JPK export → SPEC-006; the invoice PDF internals (pagination, KOD I/II QR, i18n labels) → SPEC-007. This spec retains only the UI: backoffice pages, the tabbed editor, buyer/NIP autofill + customer/product pickers, VAT/unit pickers + GTU/procedure filters, the payment/sale-date/smart-defaults inputs + the `metadata.payment`/`metadata.saleDate` shapes, inline validations (incl. the term-days whole-number guard), the read-only-lines-on-edit core-PUT limitation, and the mid-market gap-audit register.
- **Live-verified on KSeF TEST** (NIP 9261275657; token and XAdES certificate): online invoice, KOR, offline issuance/deferred send, and two-invoice ZIP batch accepted with KSeF numbers and UPO/PDF actions; certificate enroll/list/revoke and inbound-sync empty-state handling passed. Full preview flow passed, including draft order-UUID validation, edit-save, locked-state actions, and retrying the same correction without creating a duplicate. The edit-save failure found during QA was a core command defect: update commands were assigning audit `{from,to}` change objects to entities instead of parsed update values; the local core fix now has a regression test.
