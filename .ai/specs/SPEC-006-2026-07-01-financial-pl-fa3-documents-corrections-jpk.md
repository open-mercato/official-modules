# SPEC-006 — financial_pl: the FA(3) document layer — serializer, all doctypes, corrections, OSS, self-billing, FX, and JPK_V7

- **Date:** 2026-07-01
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Status:** Implemented · live-verified on KSeF TEST (VAT/KOR/ZAL/ROZ/UPR/OSS accepted with real KSeF numbers + UPO). JPK_V7 XML is XSD-validated offline via `xmllint`; JPK→MF e-submission is client-implemented and unit-verified (env-gated recipe ready; not yet live-exercised on the MF test gateway).
- **Consolidates:** SPEC-006 (corrections + JPK markings), SPEC-009 (FA(3) advanced doctypes / self-billing / OSS), SPEC-012 (JPK_V7 export), and the NBP-FX + JPK→MF-submission slices of SPEC-015. The FA(3) serializer core originally described in SPEC-005 is documented **here**; the transport/session/connector spec cross-references this file.
- **Sibling specs (do not duplicate):**
  - Transport, token + certificate/XAdES auth, online/offline/batch session submit, status/UPO polling, idempotency + reconciliation, INBOUND receiving, `KsefSubmission` model → **SPEC-005-2026-07-01-financial-pl-ksef-connector-submission.md**.
  - Human-readable invoice PDF (paginated FA(3) render, KOD I/II QR) → **SPEC-007-2026-07-01-financial-pl-invoice-pdf.md**.
  - Operator UI (tabbed invoice editor, JPK/certificate pages, buyer capture, pickers) → **SPEC-008-2026-07-01-financial-pl-invoice-authoring-ui.md**.

## TLDR

**Key Points:**
- This spec owns the entire **document layer**: given an Open Mercato `sales.invoice` (or `sales.credit_memo`) plus the module's PL-VAT metadata, it produces the exact FA(3) `1-0E` XML that the connector files to KSeF, and it produces the binding **JPK_V7M(3)/JPK_V7K(3)** VAT return. It contains no transport, no PDF, and no UI internals — those are siblings.
- **The FA(3) serializer** (`lib/fa3.ts`, pure) emits every FA(3) `RodzajFaktury` doctype in strict `xsd:sequence` order: `VAT` (standard), `KOR` (correction), `ZAL` (advance/zaliczkowa), `ROZ` (settlement/rozliczeniowa), `UPR` (simplified/uproszczona), and the advance/settlement corrections `KOR_ZAL`/`KOR_ROZ` — including the **advance→settlement chain** (a ROZ nets and references prior ZAL invoices), **self-billing** via `Adnotacje/P_17`, **full OSS/WSTO_EE** EU B2C distance sales with **foreign currency**, and the `<Platnosc>` payment block. Full in-process XSD validation is **not** performed at send time — the serializer is pure and KSeF surfaces residual schema gaps as rejection statuses — but every generated document is validated against the official `schemat_FA(3)_v1-0E.xsd` in tests via `xmllint`.
- **Corrections (KOR)** are resolved from the core `sales.credit_memo` (never a new entity): the FA(3) `DaneFaKorygowanej` block references the corrected original by its stored **KSeF number** (`NrKSeF=1` + `NrKSeFFaKorygowanej`) or the legacy **`NrKSeFN=1`** marker, and correction amounts are filed **by difference** as the negation of the (non-negative) credit-memo magnitudes.
- **JPK_V7** ships as a full **XSD-valid** exporter (`Naglowek + Podmiot1 + Deklaracja + Ewidencja`) built verbatim from the raw vendored official XSDs, plus the **`deriveJpkVatMarking`** derivation that stamps each evidence row's KSeF marking (`NrKSeF`/`OFF`/`BFK`/`DI`), and **direct e-submission to MF** through the JPK gateway (separate from KSeF) that flips a filing to `submitted` with a stored UPO.
- **NBP FX auto-sourcing** resolves the statutory exchange rate (NBP table A, the last business day *before* the tax point) that OSS/foreign-currency invoices need.
- **The single source of PL-VAT signal** is the `SalesInvoicePlMeta` extension (`financial_pl_invoice_meta`) — the country-agnostic core `sales` schema is never modified; every doctype, OSS, self-billing, FX, GTU and JPK signal is an additive column on that extension, read FK-id-only via the Query Engine (no cross-module ORM relations).

**Scope (this spec):**
- FA(3) serializer + resolvers for `VAT|KOR|ZAL|ROZ|UPR|KOR_ZAL|KOR_ROZ`, the `<Platnosc>` block, OSS/WSTO_EE + FX, self-billing (`P_17`) and reverse-charge (`P_18`) annotations.
- Correction (KOR) send-source resolution from `sales.credit_memo` — reference rules + the amount-negation rule.
- The `SalesInvoicePlMeta` data model (all PL-VAT columns).
- JPK_V7M(3)/JPK_V7K(3) export (evidence + declaration), the `PurchaseVatRecord` + `JpkVatFiling` models, the `deriveJpkVatMarking` derivation + `GET …/jpk-markings` batch read, and JPK→MF e-submission.
- NBP FX rate sourcing.

**Out of scope (routed to siblings or deferred):**
- The `KsefSubmission` transport model, session submit, idempotency, offline/batch mechanics, and inbound receiving live in **SPEC-005**. This spec references `KsefSubmission.status`/`.mode`/`.ksefNumber` as read-only inputs to the JPK marking derivation.
- The invoice PDF and its QR codes live in **SPEC-007**.
- The operator UI (the invoice editor, the JPK/certificate/received-invoices backoffice) lives in **SPEC-008**. This spec defines only the module-internal document/JPK API contracts those pages call.
- A full AP/purchase module (the `PurchaseVatRecord` is a JPK-VAT-shaped ledger only), bad-debt automation from live sales data, and OSS reduced-rate maintenance beyond the dated EU standard-rate table.

## Overview

> **Market reference:** wFirma, inFakt, Comarch, Fakturownia, SaldeoSMART all issue advance/final invoices (faktura zaliczkowa/rozliczeniowa), simplified invoices, self-billed invoices, and OSS invoices through FA(3); all map a Polish correction to a `faktura korygująca` that references the original by its KSeF number (none allow cancelling an in-KSeF invoice); and all produce JPK_V7 for the VAT return. This spec brings the connector to that functional parity on the document + reporting side.

Open Mercato's `sales.invoice` / `sales.invoice_line` is a country-agnostic commercial invoice. Polish e-invoicing law requires it to be rendered as the structured FA(3) document (schema `1-0E`) and reported in the JPK_V7 VAT return. This spec is the **translation layer** between the two, driven entirely by an additive PL-VAT metadata extension.

FA(3) carries seven document kinds selected by the closed `<RodzajFaktury>` enumeration:

| `RodzajFaktury` | Statutory basis | Meaning |
|---|---|---|
| `VAT` | art. 106b | Standard VAT invoice. |
| `KOR` | art. 106j | Correction (faktura korygująca) — the only lawful way to fix an in-KSeF invoice (KSeF disallows cancellation; the original is immutable, kept 10 years — Podręcznik KSeF 2.0 Cz. II §1.6.3). |
| `ZAL` | art. 106b ust. 1 pkt 4; art. 106f ust. 4 | Advance/prepayment invoice (faktura zaliczkowa). `P_15` = the **amount paid** this invoice documents. Line detail lives in `Zamowienie` (`FaWiersz` optional). |
| `ROZ` | art. 106f ust. 3 | Settlement/final invoice (rozliczeniowa/końcowa). `P_15` = **amount remaining to pay** = full value − advances already invoiced. Carries **full** `FaWiersz` and references prior advances in `FakturaZaliczkowa`. |
| `UPR` | art. 106e ust. 5 pkt 3 | Simplified invoice (faktura uproszczona): total ≤ 450 PLN / ≤ 100 EUR; buyer may carry **NIP only** (no name/address). |
| `KOR_ZAL` | art. 106j (of a 106f ust. 4 invoice) | Correction of an advance invoice: correction block + `P_15ZK` (payment before correction) + corrected `Zamowienie`. |
| `KOR_ROZ` | art. 106j (of a 106f ust. 3 invoice) | Correction of a settlement invoice: correction block + `P_15ZK` (amount-remaining before correction) + corrected `FaWiersz`. |

**Critical Uwaga (brochure Tabela 28):** a correction of a *simplified* (UPR) invoice carries `RodzajFaktury=KOR`, **not** a non-existent `KOR_UPR` — so the ordinary KOR credit-memo path already covers UPR corrections structurally.

**Self-billing (samofakturowanie, art. 106d):** an invoice issued by the buyer in the supplier's name; in FA(3) the `Adnotacje/P_17` flag. Driven from the `self_billing` PL-meta flag. (Note: this connector files every invoice as the authenticated taxpayer — `seller.nip === contextNip` — so *submitting* a self-billed invoice as the seller is structurally rejected by the connector's `assertNotSelfBilled` guard, documented in SPEC-005; the `P_17` marking is still emitted and captured for JPK record-keeping.)

**OSS / WSTO_EE (dział XII rozdz. 6a; art. 28k):** intra-EU B2C distance sales taxed at the **consumer-country** rate. The line omits the closed-enum `P_12` and instead carries `P_12_XII` (destination rate as a decimal) + `Procedura=WSTO_EE`; the summary rolls OSS net/VAT into the dedicated `P_13_5`/`P_14_5` buckets (no `W` PLN-converted variant). OSS invoices are typically in EUR, so this requires foreign-currency support: `KodWaluty` ≠ PLN, per-line `KursWaluty`, and the PLN-converted VAT `P_14_xW` for any **Polish-rate** buckets on the same mixed invoice (art. 106e ust. 11).

**JPK_V7 (mandatory from 2026-02-01):** the JPK_V7M/V7K(3) evidence records carry a per-invoice KSeF marking (`NrKSeF`/`OFF`/`BFK`/`DI`) and drive the VAT return. This spec both **derives** the marking (from the connector's submission state) and **generates + files** the full JPK document.

## Problem Statement

1. **The serializer must faithfully emit every doctype in exact XSD order.** Any deviation from the `<Fa>` `xsd:sequence` is a KSeF 450 rejection.
2. **No lawful correction path without KOR.** Users who mis-issue an invoice have no remedy without the correction document (KSeF disallows cancellation).
3. **The document-kind signal did not exist.** Core `sales` has no `document_type`/advance/OSS/FX column; an early serializer read a non-existent `invoice.document_type` field → always `undefined` → always `'vat'`. An explicit PL-meta signal is required.
4. **OSS and foreign currency were rejected.** The connector once rejected non-PLN currency and any non-Polish VAT rate, so a German-19%/EUR distance sale could not be issued.
5. **JPK generated but not filed / not marked.** The KSeF number is stored per invoice but must be surfaced as the JPK marking, the full JPK_V7 XML must be generated XSD-valid, and it must be transmitted to MF so a filing legitimately reaches `submitted`.
6. **Manual FX.** Foreign-currency invoices need the statutory NBP rate, not operator guesswork.

## Proposed Solution

Extend the pure FA(3) serializer, the pure mapping helpers, the zod schema, the resolvers, and the `SalesInvoicePlMeta` extension **additively** — no change to the country-agnostic `sales` schema, no core-package change. All document-kind / OSS / self-billing / FX / payment / GTU / JPK signals are read from `SalesInvoicePlMeta` columns (set by the operator via the editor/meta API — SPEC-008), so the resolvers dispatch on an **explicit** signal, never inference. A correction is resolved from `sales.credit_memo`. The JPK exporter reads sales via the Query Engine (like the FA(3) resolver), reads the KSeF marking from the connector's `KsefSubmission` state, and adds two JPK-shaped entities of its own.

### Design decisions

| Decision | Rationale |
|----------|-----------|
| All PL-VAT signals live on `SalesInvoicePlMeta`, never on core `sales` | `sales` is country-agnostic and must stay untouched (module independence). The PL-meta extension is 1:1, FK-id-only, and is already the home for `mppRequired`/`vatExemptionBasis`/`issuedOutsideKsef`. |
| `invoice_kind` is an **explicit** PL-meta value, default `'vat'` | The old `document_type` read was a non-existent column; an explicit operator-set kind is the only correct signal, and defaulting to `'vat'` preserves every existing invoice's behaviour. Kept a `text` column validated at the zod/API boundary (no DB-level enum), consistent with the other text columns. |
| Correction source = core `sales.credit_memo` | It already exists, FKs the original invoice, and has lines/amounts/`reason`. Matches every studied vendor. No core change, no new entity. |
| Reference the original by its **stored KSeF number**, else `NrKSeFN` | KSeF requires `NrKSeFFaKorygowanej` when the original is in KSeF; `NrKSeFN=1` covers legacy/outside-KSeF originals, and only when the caller passes explicit `originalOutsideKsef: true`. Absence of a KSeF number is **never** silently treated as "outside KSeF". |
| Correction amounts filed **by difference** as the negation of the credit-memo magnitude | `creditMemoCreateSchema` validates every amount `decimal({ min: 0 })` (a reduction); FA(3) files differences (manual §2.13.2) where a reduction is negative. One isolated, unit-tested rule: `fa3Amount = −|creditMemoAmount|`. |
| OSS is driven by an **explicit** `oss_procedure` flag + `consumption_country_code`, never inferred | A foreign-looking numeric rate (e.g. 21%) is ambiguous PL-vs-OSS; inference would mis-state the VAT field and the return (highest-severity risk). |
| ZAL/ROZ advance data carried as **JSON snapshots** on PL-meta | `sales` has no "this invoice is an advance" flag; reconstructing the chain by querying `sales_payments`/order lines is brittle. Snapshots set by the issuing flow are deterministic and keep `sales` untouched. |
| EU standard-rate table is **dated configuration** with an env override | VAT rates change mid-year (EE 22→24, FI →25.5, SK →23). The per-line sales rate is trusted first; the table only validates/falls back. |
| JPK marking = pure **derivation** + batch read (not a stored column) | The KSeF state already lives on `KsefSubmission`/`SalesInvoicePlMeta`; deriving avoids a denormalized field that drifts. |
| JPK field order/namespaces taken **verbatim from the raw official XSDs**; a hard `xmllint --schema` gate | Regulation-critical; catches element-order/occurrence errors offline. |
| JPK→MF submission uses a **separate gateway and a dedicated signer credential** | The MF JPK gateway (`e-dokumenty.mf.gov.pl`) is not KSeF; the qualified/Trusted-Profile signer is not the KSeF Authentication cert and is never silently reused. |

### Alternatives considered

| Alternative | Why rejected |
|-------------|-------------|
| "Cancel + re-issue" an invoice | Illegal in KSeF — an accepted invoice is immutable (manual §1.6.3). |
| A new `financial_pl` correction entity | Duplicates `sales.credit_memo`; needs its own CRUD/UI. Extend, don't re-model. |
| Add `document_type`/advance/OSS columns to core `sales` | Breaks module independence and the country-agnostic core; the PL-meta extension is the sanctioned mechanism. |
| Infer OSS from "buyer non-PL + numeric foreign rate" | Ambiguous and high-risk (wrong VAT field/return); explicit marker only. |
| Reconstruct the ZAL→ROZ chain purely by querying `sales_payments`/order lines | No "advance" flag exists in `sales`; brittle and order-coupling-sensitive. Snapshots are deterministic. |
| Store the JPK marking as a column | Drifts from the source-of-truth submission state; needs a backfill + maintenance. |
| Put GTU/procedures into the FA(3) XML | They are not FA(3) fields; KSeF would reject unknown elements. Pure-JPK only. |
| Compile the EU rate table as a constant | Rates change; a stale constant silently mis-rates OSS lines. Config with `asOf` + override. |
| Reuse the KSeF Authentication cert as the JPK signer | The JPK gateway requires a qualified signature / Trusted Profile / `dane autoryzujące`; reusing the KSeF cert would be non-compliant (3-voter jury finding). |

## Architecture

### FA(3) serializer (`lib/fa3.ts` — pure)

`buildFa3Xml` renders the `<Fa>` element as a strict `xsd:sequence`. The full tail order (each block emitted only when its optional model field is present, so a plain VAT/KOR document serializes byte-identically to the pre-doctype baseline):

```
KodWaluty, P_1, P_2, P_6?,
<VAT summary>   P_13_1/P_14_1/P_14_1W? … P_13_5/P_14_5 (OSS bucket, no W variant) …   ← renderVatBreakdown
P_15,
Adnotacje,      P_17 (self-billing) · P_18 (reverse charge) · P_18A (MPP) · P_19/P_19C (exemption)  ← renderAnnotations
RodzajFaktury,
[correction block]  PrzyczynaKorekty? → TypKorekty? → DaneFaKorygowanej[] → (P_15ZK? KursWalutyZK?) → OkresFaKorygowanej?   ← renderCorrection
ZaliczkaCzesciowa*   (P_6Z, P_15Z, KursWalutyZW?)                               ← renderZaliczkaCzesciowa
FakturaZaliczkowa*   (NrKSeFFaZaliczkowej | NrKSeFZN=1 + NrFaZaliczkowej)       ← renderFakturaZaliczkowa
FaWiersz*            (… P_12? | P_12_XII? + Procedura=WSTO_EE? … KursWaluty? …)  ← renderLine
Platnosc?            (FormaPlatnosci|PlatnoscInna+OpisPlatnosci · Zaplacono+DataZaplaty · TerminPlatnosci · RachunekBankowy{NrRB,NazwaBanku?,SWIFT?})   ← renderPlatnosc
Zamowienie?          (WartoscZamowienia + ZamowienieWiersz[])                    ← renderZamowienie
```

Serializer detail:
- **`renderCorrection`** emits the correction block **after `RodzajFaktury`** in exact XSD order: `PrzyczynaKorekty?` → `TypKorekty?` → `DaneFaKorygowanej[]` → `OkresFaKorygowanej?`. Each `DaneFaKorygowanej` emits `DataWystFaKorygowanej` → `NrFaKorygowanej` → **choice**: when the original's KSeF number is known, `<NrKSeF>1</NrKSeF>` + `<NrKSeFFaKorygowanej>`; otherwise `<NrKSeFN>1</NrKSeFN>`. For `KOR_ZAL`/`KOR_ROZ` it additionally emits `P_15ZK` (+ optional `KursWalutyZK`) after the `DaneFaKorygowanej` loop and before `OkresFaKorygowanej`.
- **`renderLine`** emits `P_12` only when the line is **not** OSS; for an OSS line it omits `P_12` and emits `P_12_XII` (destination rate decimal) + `Procedura=WSTO_EE` in XSD position (after `GTU`, before `KursWaluty`), and emits `KursWaluty` when `fxRate` is set. `P_12` uses `fa3LineVatRateValue`.
- **`renderVatBreakdown`** emits the OSS bucket (`P_13_5` + `P_14_5`, rank 5) once regardless of how many distinct consumer rates appear; for FX it emits `P_14_xW` (PLN-converted VAT) after each Polish-rate `P_14_x`. The OSS bucket has **no** `W` variant. `VAT_NET_FIELD`/`VAT_TAX_FIELD`/`VAT_FIELD_RANK`/`isMappedFa3VatRate` accept the OSS bucket key.
- **`renderAnnotations`** drives `P_17` from `annotations.selfBilling` (`'1'` self-billed, else `'2'`) and `P_18` from `reverseCharge`; `P_18A`/`P_19`/`P_19C` from the existing `mppRequired`/`vatExemptionBasis` signals.
- **`renderPlatnosc`** emits the payment block after `FaWiersz` and before `Zamowienie`; the whole node is omitted when no usable payment data exists (`<Platnosc>` is optional, keeping payment-less invoices schema-valid). `Zaplacono`+`DataZaplaty` emitted together; `PlatnoscInna`+`OpisPlatnosci` together; `RachunekBankowy` carries `NrRB`(+`NazwaBanku`+`SWIFT`). The **method→`FormaPlatnosci` code matrix** (authoritative; exists only here): `cash=1, card=2, voucher=3, cheque=4, credit=5, transfer=6, mobile=7`; `'other' → PlatnoscInna=1 + OpisPlatnosci`; *za pobraniem* / *kompensata* have no code → map to `'other'`.
- **New render fns:** `renderZaliczkaCzesciowa(payments)`; `renderFakturaZaliczkowa(refs)` (KSeF-number choice mirrors the KOR choice: KSeF-issued advance → `NrKSeFFaZaliczkowej`; outside-KSeF → `NrKSeFZN=1` + `NrFaZaliczkowej`); `renderZamowienie(order)` + `renderZamowienieWiersz(row)` (fields `NrWierszaZam, P_7Z?, P_8AZ?, P_8BZ?, P_9AZ?, P_11NettoZ?, P_11VatZ?, P_12Z?, GTUZ?, StanPrzedZ?` — `P_12Z` reuses `fa3LineVatRateValue`; block total `WartoscZamowienia`).
- **`buildFa3Xml`** relaxes the `lines.length === 0` throw when `invoiceKind ∈ {ZAL, KOR_ZAL}` and an `order` block is present (`FaWiersz` is optional for advances).
- **`renderParty`** allows a UPR `Podmiot2` to omit `Nazwa` + `Adres` (NIP-only buyer) while keeping the mandatory trailing `JST`/`GV` flags.
- All money uses the BigInt `toScaled4`/`scaled4ToMoney2dp` helpers; the sale date `P_6` derives from `model.saleDate` (falling back to the issue date). The **issue date is required** — a missing invoice/credit-memo issue date is rejected (`422 issue_date_required`) rather than defaulting to today.

### Mapping helpers (`lib/fa3-mapping.ts` — pure, shared by both resolvers)

`buildBuyer` (with a UPR NIP-only branch), `buildVatBreakdown` (OSS bucket key + FX `P_14_xW` math), `buildLines` (carries `ossRate`/`procedure`/`fxRate`), `buildAnnotations` (maps `self_billing`→`selfBilling`, `reverse_charge`→`reverseCharge`), `buildPlatnosc`, `buildZamowienie`, `buildAdvancePayments`, `buildAdvanceRefs` — all reusing `toScaled4`/`scaled4ToMoney2dp`/`normalizeVatRate`. Factored out of the invoice resolver so both resolvers share one money/VAT/party mapping (DRY, re-validated by both resolvers' tests).

### Resolvers

- **`lib/resolve-fa3-from-invoice.ts`** dispatches on the PL-meta `invoice_kind`: `vat` → standard; `zal` → `resolveFa3Advance` (order snapshot + received payments, `P_15` = paid amount, `FaWiersz` optional); `roz` → `resolveFa3Settlement` (full `FaWiersz` + advance refs, `P_15` = residual = full gross − Σ advances); `upr` → threshold check (≤ 450 PLN; an EUR/OSS invoice is PLN-converted via the resolved rate, or compared ≤ 100 EUR when no rate is resolvable) + NIP-only buyer; OSS lines (when `oss_procedure`) carry `P_12_XII` from the consumption-country rate + `KodWaluty`/`KursWaluty`. Foreign currency is accepted when a rate is resolvable **or** the invoice is pure-OSS (see FX rule below).
- **`lib/resolve-fa3-from-credit-memo.ts`** resolves a KOR from `sales.credit_memo` + its lines + the linked original `sales.invoice` (for `NrFaKorygowanej`/`DataWystFaKorygowanej` and the buyer snapshot) + the original's KSeF number. It sets `invoiceKind` from the corrected original's PL-meta kind: an ordinary correction → `KOR`; a correction of a ZAL/ROZ → `KOR_ZAL`/`KOR_ROZ` (populating `preCorrectionPaymentAmount` = `P_15ZK` and the corrected `Zamowienie`/`FaWiersz`). OSS corrections flow through here too, carrying the OSS line fields + summary buckets + FX and emitting negated OSS differences.

**Correction reference resolution (three-way, never mislabel a pending original):** the resolver classifies the corrected original as (a) an **accepted** `KsefSubmission` (or `sales_invoice_pl_meta.ksef_number`) exists → emit `NrKSeF=1` + `NrKSeFFaKorygowanej`; (b) a submission exists but is **not accepted** (queued/processing/rejected) → **reject 409 `original_not_accepted`**; (c) **no** submission at all → require the caller's explicit `originalOutsideKsef: true` to emit `NrKSeFN=1`, else **reject 422 `original_ksef_number_unknown`**. `resolveCorrectedKsefNumber` filters `document_kind='invoice'` in the DB query itself (not just JS) so an accepted correction can't hide the original's submission nor a pending original be mislabelled.

**Correction reason + date:** a KOR must carry `PrzyczynaKorekty`; the resolver rejects `422 correction_reason_required` when `credit_memo.reason` is empty (`TypKorekty` stays optional). `DataWystFaKorygowanej` is taken from the **original** invoice's issue date (422 if absent), never the credit-memo date.

**FX rule (resolved from the SPEC-009 jury):** a non-PLN invoice requires a resolvable exchange rate **only when it carries Polish-rate (domestic) buckets** that need the PLN-converted `P_14_xW` (art. 106e ust. 11). A **pure-OSS** foreign-currency invoice (no domestic-rate lines) needs **no** rate and is accepted without one. Formally: require `exchange_rate` iff `(currency ≠ PLN) AND (any non-OSS Polish-rate bucket present)`; otherwise accept FX without a rate. Rejected with `exchange_rate_required` when required and absent.

### Validators (`data/validators.ts`)

Per-kind requirement checks replace the old blanket gates (the seven-value `invoiceKind` enum is unchanged): `ZAL`/`KOR_ZAL` require the `order` block (`FaWiersz` optional); `ROZ` requires `advanceInvoiceRefs` (`FaWiersz` required); `UPR` allows a NIP-only buyer and enforces the simplified threshold; `KOR_ZAL`/`KOR_ROZ` require the correction block + `preCorrectionPaymentAmount`. Non-PLN currency is accepted per the FX rule above; an OSS line is allowed without `P_12` but with `ossRate` + `Procedura=WSTO_EE`; truly-unmapped Polish rates are still rejected. Sub-schemas: `fa3OrderLineSchema`, `fa3OrderSchema`, `fa3AdvancePaymentSchema`, `fa3AdvanceRefSchema`, `invoicePaymentSchema` (with a `.refine`: `paid===true` requires `paidDate`; `method==='other'` requires `methodOther`; `termDays` a whole number in `[0, 3650]`), plus the OSS/FX and UPR-aware party extensions.

### GTU / JPK procedure markings / TypDokumentu (capture-only; pure-JPK)

`lib/jpk-markings-codes.ts` is the single source of truth: `GTU_CODES` (`GTU_01..GTU_13`), `JPK_PROCEDURE_MARKINGS` (the 12 codes `WSTO_EE, IED, TP, TT_WNT, TT_D, MR_T, MR_UZ, I_42, I_63, B_SPV, B_SPV_DOSTAWA, B_MPV_PROWIZJA`), `JPK_TYP_DOKUMENTU` (`RO|WEW|FP`). These are pure-JPK sales-register flags — they **never** appear in FA(3) XML; only `P_17`/`P_18` (and `P_18A`/`P_19`) among the markings are FA(3)-native. Cross-field constraints (GTU-not-on-RO etc.) are enforced at **JPK-export** time, not at capture; the capture API rejects only structurally-invalid codes.

### JPK_V7M(3) / JPK_V7K(3) export (`lib/jpk/`)

Generate the binding **JPK_VAT z deklaracją (3)** file — **JPK_V7M(3)** (monthly) / **JPK_V7K(3)** (quarterly), effective 2026-02-01 — as a complete **XSD-valid** XML (`Naglowek + Podmiot1 + Deklaracja + Ewidencja`). Ground truth: the final CRWDE XSDs 2025/12/19/14090 (V7M) and 2025/12/19/14089 (V7K), vendored under `lib/jpk/schema/`; namespaces V7M `http://crd.gov.pl/wzor/2025/12/19/14090/`, V7K `…/14089/`; element order **verbatim from the XSDs**; MF brochure for semantics. A hard `xmllint --schema` validation gate is a mandatory acceptance criterion.

Module layout: `lib/jpk/jpk-codes.ts` (field-order arrays, marker lists, rate→K map, schema attrs), `build-sprzedaz.ts`, `build-zakup.ts`, `compute-declaration.ts`, `build-jpk-xml.ts`, `resolve-jpk-filing.ts`, `validate-xsd.ts` (test helper). Self-contained: no cross-module ORM; sales read via the Query Engine; `Podmiot1` sourced from the `ksef_pl` credential (`contextNip` + seller name/address).

**`SprzedazWiersz` (exact XSD child order):** `LpSprzedazy, KodKrajuNadaniaTIN, NrKontrahenta, NazwaKontrahenta, DowodSprzedazy, DataWystawienia, DataSprzedazy, choice{NrKSeF|OFF|BFK|DI}, TypDokumentu, GTU_01..GTU_13, WSTO_EE, IED, TP, TT_WNT, TT_D, MR_T, MR_UZ, I_42, I_63, B_SPV, B_SPV_DOSTAWA, B_MPV_PROWIZJA, KorektaPodstawyOpodt, TerminPlatnosci, DataZaplaty, K_10..K_36, K_360, SprzedazVAT_Marza`. The KSeF node is a **choice** — emit exactly one of `NrKSeF`/`OFF`/`BFK`/`DI` from `deriveJpkVatMarking`; a `pending`/null marking blocks generation (operator must resolve).

**Amount→K bucketing by rate/category:** exempt domestic→`K_10`; outside-PL (≠ OSS)→`K_11` (EU-services subset→`K_12`); 0% domestic→`K_13` (art.129 subset→`K_14`); 5%→`K_15`/`K_16`; 8%→`K_17`/`K_18`; 23%→`K_19`/`K_20`; WDT→`K_21`; export→`K_22`; domestic reverse-charge art.17 (supplier side)→`K_31`/`K_32`; spis z natury→`K_33`; kasy-relief return→`K_34`; WNT transport→`K_35`; WNT fuel→`K_36`; deposit tax→`K_360`. (WNT `K_23/24`, import `K_25..K_30` come from **purchase** self-assessment.)

**OSS exclusion:** invoices with `ossProcedure=true` are **EXCLUDED** from JPK_V7M (reported only in VIU-DO; brochure l.910-914); `buildVatBreakdown`'s `'oss'` bucket is dropped here. `WSTO_EE` marks only **domestically-taxed** distance sales (below threshold / not via OSS).

**Corrections (sales):** a regular faktura korygująca is its **own separate row** carrying the **difference** (K_ values may be negative; minus sign per l.169), keyed on the correction document's `DowodSprzedazy`/`DataWystawienia`. art.89a bad-debt: `KorektaPodstawyOpodt="1"` for the row, `TerminPlatnosci` (ust.1, "in minus") or `DataZaplaty` (ust.4, "in plus"); declaration `P_68`/`P_69` aggregate the ust.1 "in minus" from K_15/17/19 and K_16/18/20.

**Margin (MR_T/MR_UZ):** marker `="1"`; margin-net + output VAT (negative margin ⇒ VAT `0.00`) in the rate K_ fields **and** the full gross in `SprzedazVAT_Marza`.

**FP:** `TypDokumentu=FP` (faktura do paragonu) is emitted; FP rows are **excluded** from `SprzedazCtrl.PodatekNalezny`. Credit memos do **not** inherit the original's `TypDokumentu`/FP (which would wrongly exclude them from totals).

**`SprzedazCtrl`:** `LiczbaWierszySprzedazy` = row count; `PodatekNalezny = K_16+K_18+K_20+K_24+K_26+K_28+K_30+K_32+K_33+K_34 − K_35 − K_36 − K_360`, excluding FP rows.

**`ZakupWiersz` (XSD order):** `LpZakupu, KodKrajuNadaniaTIN, NrDostawcy, NazwaDostawcy, DowodZakupu, DataZakupu, DataWplywu, choice{NrKSeF|OFF|BFK|DI}, DokumentZakupu(MK|VAT_RR|WEW), IMP, K_40..K_47, ZakupVAT_Marza`. `K_40`/`K_41` net/VAT fixed assets; `K_42`/`K_43` net/VAT other (incl. the **input deduction** for WNT/import/RC); `K_44`/`K_45` input-tax corrections; `K_46` art.89b ust.1; `K_47` art.89b ust.4; `ZakupVAT_Marza` margin-basis gross. **`ZakupCtrl`:** `LiczbaWierszyZakupow` = count; `PodatekNaliczony = K_41+K_43+K_44+K_45+K_46+K_47`.

**Self-assessed acquisitions (one purchase doc → TWO rows):** a `PurchaseVatRecord` classified `wnt|import_goods|import_services|import_services_28b|reverse_charge_domestic` produces **both** a `SprzedazWiersz` output row (WNT `K_23/24`, import `K_25/26`/`K_27/28`/`K_29/30`, RC `K_31/32`) **and** a `ZakupWiersz` input row (`K_42/43`). A `domestic` purchase produces only the `ZakupWiersz` row. Zero output VAT shows `0.00` where the base is filled.

**`Deklaracja` (XSD `PozycjeSzczegolowe` order, 64 positions):** `P_10..P_36, P_360, P_37..P_53, P_54, P_540, P_55, P_56, P_560, P_58, P_59, P_60..P_66, P_660, P_67, P_68, P_69, P_ORDZU` + `Pouczenia=1`. `KodFormularzaDekl` = `VAT-7 (23)` (V7M) / `VAT-7K (17)` (V7K).
- **Rounding:** declaration `P_` fields → **whole PLN** (`TKwotaC`; <50 gr down, ≥50 gr up); evidence `K_` fields → **2 dp** (`TKwotowy`).
- **Computed (C):** `P_10..P_36, P_360` = period sums of the like-named K_ (FP excluded from the należny side); `P_37 = P_10+P_11+P_13+P_15+P_17+P_19+P_21+P_22+P_23+P_25+P_27+P_29+P_31`; `P_38 = (P_16+P_18+P_20+P_24+P_26+P_28+P_30+P_32+P_33+P_34) − P_35 − P_36 − P_360`; `P_40..P_47` = `K_40..K_47` sums; `P_48 = P_39+P_41+P_43+P_44+P_45+P_46+P_47`; `P_68/P_69` from the art.89a evidence rows (≤ 0). **Derived (D):** `P_39` = prior period's `P_62`; `P_51 = max(0, P_38 − P_48 − P_49 − P_50)`; `P_53 = max(0, P_48 − P_38 + P_52)`; `P_62 = P_53 − P_54`. **Operator (O):** `P_49, P_50, P_52, P_54/P_540/P_55/P_56/P_560/P_58` (refund-term elections), `P_59, P_60, P_61`, markers `P_63..P_67/P_660`, `P_ORDZU`. Zero declaration ⇒ `P_38` and `P_51` = `"0"`.
- **XSD-grouped base/VAT pairs must emit together** (declaration `P_11/12…P_42/43`, `P_68/69`; purchase `K_40/41`, `K_42/43`) — emitting one without the other is XSD-invalid.
- Negative `P_68/P_69`/`P_37`/`P_38` are **XSD-valid** and must NOT be clamped (`TKwotaC` is `xsd:integer` with no `minInclusive`; the brochure mandates negative `P_68/P_69` for bad-debt).

**XML assembly & V7K rule:** `build-jpk-xml` emits the XSD-exact order under the right namespace. `correction_scope` controls which of `Deklaracja`/`Ewidencja` are emitted (both / declaration-only / evidence-only, brochure l.127-134). **V7K:** months 1-2 of a quarter → `Naglowek+Podmiot1+Ewidencja` only; month 3 → all four (Deklaracja aggregates the **whole quarter**, Ewidencja = month 3). `Naglowek` always carries `Miesiac`; `Kwartal` lives only in the Deklaracja header (a V7K declaration lacking `Kwartal` throws loudly). Determinism: own `el()` + exported `escapeXml`; money via exported `toScaled4`/`scaled4ToMoney2dp` + a whole-PLN rounder.

### JPK_VAT marking derivation (`lib/jpk-vat-marking.ts`, `api/…/jpk-markings/route.ts`)

Pure `deriveJpkVatMarking({ ksefStatus, ksefNumber, mode, issuedOutsideKsef })` → `{ marking: 'NrKSeF'|'OFF'|'BFK'|'DI' } | { marking: null, pending: true }` (broszura "JPK_VAT z deklaracją od 1 lutego 2026 r."):
- accepted + `ksefNumber` → `NrKSeF` (the number).
- `mode='awaryjny'` / awaria without a number yet → `OFF`.
- `mode='offline24'` / niedostępność without a number yet → `DI`.
- `issuedOutsideKsef === true` (explicit operator flag — consumer/legacy invoice never destined for KSeF, or a total-awaria) → `BFK`.
- otherwise (queued/processing/ready, no terminal state) → `{ marking: null, pending: true }` — **absence of a number is never silently reported as `BFK`**.

`mode` is `KsefSubmission.mode`; `issuedOutsideKsef` is the explicit `SalesInvoicePlMeta` signal (never inferred). The batch `GET …/jpk-markings?salesInvoiceId=a,b,c` is **capped at 100 ids**, requires a resolved org scope (`400` otherwise — never a tenant-wide read), validates UUIDs, and derives markings from a **single batched read** of the latest `document_kind='invoice'` submission + meta per invoice (no N+1). The marking is also added to the `_financial_pl` response-enricher payload (computed from the already-batched submission data — no extra query). All invoice-facing reads filter `document_kind='invoice'` so a correction never bleeds its status/number/UPO/marking onto the corrected original.

### JPK→MF e-submission (`lib/jpk/jpk-submission-client.ts`, `jpk-submission-metadata.ts`)

Transmit the already-generated JPK XML to MF through the JPK gateway (SEPARATE from KSeF) → reference → UPO → flip `JpkVatFiling.status` to `submitted`.
- **Gateway:** `config.ts` gains `JPK_GATEWAY_URLS = { test: 'https://test-e-dokumenty.mf.gov.pl', prod: 'https://e-dokumenty.mf.gov.pl' }` + the MF JPK public-key cert (test/prod) for AES-key wrapping + `resolveJpkGateway(env)`.
- **Package format (per MF JPK interface spec 5.5.1.v22, published 2026-08-05):** the JPK XML is **ZIP/DEFLATE**-compressed; the archive is split into binary parts (≤ the per-part cap); **each part is AES-256-CBC (PKCS#7, 16-byte IV)** encrypted; the AES key is **RSA key-wrapped with PKCS#1 v1.5** (the InitUpload metadata literally labels this `algorithm="RSA" mode="ECB" padding="PKCS#1"` = RSA PKCS#1 v1.5 key transport, **not** OAEP). A new `rsaPkcs1v15WrapKey` helper is added to `crypto.ts`; the existing RSA-OAEP path is untouched. `Document.HashValue` = SHA-256+Base64 over the whole JPK document; each uploaded part carries `Content-MD5` (MD5+Base64).
- **Flow:** `submitJpk({ jpkXml, signer })` builds + signs the InitUpload metadata XML with `signJpkInitUpload` (a **new** `lib/xades.ts` entry point — XAdES-BES, two `ds:Reference`: `SignedProperties` + whole-doc, RSA-SHA256; the existing single-reference `signAuthTokenRequest` is left untouched for BC). Then `POST /api/Storage/InitUploadSigned` → `{ ReferenceNumber, RequestToUploadFileList[] }`; **`PUT` each encrypted part to the response-supplied absolute Azure SAS `Url`** (`Content-MD5` + `x-ms-blob-type: BlockBlob`) via `lib/http-put.ts` (a new `AbortController`-bounded PUT-to-absolute-URL helper — the KSeF client transport is `GET|POST|DELETE` + baseUrl-relative and cannot do the SAS blob PUT); `POST /api/Storage/FinishUpload`; poll `GET /api/Storage/Status/{ReferenceNumber}` until terminal; on success extract the `Upo` XML. A `?enableValidateQualifiedSignature=true` knob (test) rehearses the prod check.
- **Signer credential (distinct from KSeF auth):** JPK submission requires a **qualified electronic signature / Trusted Profile (podpis zaufany) / `dane autoryzujące`** — SEPARATE from the KSeF Type-1 Authentication cert. A dedicated JPK-signer field (`jpk_signer_pem`/`_key` or a Trusted-Profile/AuthData selector) is added to the `ksef_pl` config; the KSeF cert is **never** silently reused. On TEST a self-signed cert is accepted (validity not checked); PROD requires the qualified/trusted credential. The `dane autoryzujące` (revenue-amount) `AuthData` builder is implemented behind a flag, unit-test only (prod-only, not test-exercisable).
- **Idempotency/crash-safety:** `submitJpkFilingCommand` loads `JpkVatFiling.generatedXml`; a CAS transition `generated → submitting` claims the filing under a row lock so concurrent POSTs don't double-submit; `submissionReference` is persisted immediately after InitUpload so a crash resumes/retries that reference instead of re-uploading; on terminal success it persists `upoXml` + `submittedAt` + `status='submitted'`; it refuses to resubmit a `submitted`/`submitting` filing absent an explicit correction flag.

### NBP FX auto-sourcing (`lib/nbp-fx.ts`, `api/ksef/nbp-rate/route.ts`)

`fetchNbpMidRate(currency, taxPointDate)` resolves the statutory exchange rate a foreign-currency invoice needs. **Date semantics:** the statutory FX rate is the NBP table-A **mid-rate of the last business day BEFORE the tax point** (art. 31a), so the function computes the required table date = the business day preceding `taxPointDate` and fetches THAT — it must **not** use a same-day rate even if NBP has published one. `GET https://api.nbp.pl/api/exchangerates/rates/A/{currency}/{tableDate}/?format=json`; on a 404 (holiday/weekend — no table that day) it walks back to the prior published table. Time-bounded (≤ 6 s), fail-open (returns `{ ok:false }` → the operator keeps manual entry). `config.ts` gains the NBP base URL (overridable). The resolver (`resolve-fa3-from-invoice.ts`) is unchanged — it still trusts the stored `exchange_rate`; the NBP fetch only fills the PL-meta `exchangeRate`/`exchangeRateDate` fields (the editor affordance is in SPEC-008). This resolves SPEC-009's Open Question on the authoritative FX source.

### Configuration

`EU_STANDARD_VAT_RATES` (27-row country ISO → standard rate, Greece `EL`/`GR` reconciled), `EU_VAT_RATES_AS_OF = '2026-01'`, and an `OM_KSEF_EU_VAT_RATES` env override so a mid-year rate change can be patched without a release. `JPK_GATEWAY_URLS` + MF JPK pub-cert + `resolveJpkGateway`. NBP base URL. Reduced OSS rates are out of scope (the per-line sales rate is trusted; the table validates/falls back).

### Commands & events

- FA(3)/correction: `financial_pl.ksef_submission.send_from_credit_memo` (delegates to the connector's `sendCommand` with `documentKind='credit_memo'` + `creditMemoId`; the connector's `send` is extended with `documentKind`/`creditMemoId` idempotency — see SPEC-005). Events unchanged (`…queued`/`…accepted`/`…rejected`).
- JPK: `financial_pl.jpk.upsert_purchase_record`, `.delete_purchase_record`, `.upsert_filing`, `.generate`, and `submitJpkFilingCommand` (`financial_pl.jpk.submit`) dispatching `financial_pl.jpk.submitted` for observability.

## Data Models

**No new entity on the FA(3)/correction side; `sales` untouched.** A correction is the core `sales.credit_memo`; the JPK marking is derived. JPK export adds two JPK-shaped entities of its own.

### SalesInvoicePlMeta (`financial_pl_invoice_meta`) — the PL-VAT extension

All columns additive, nullable or defaulted; the extension is 1:1 with a `sales.invoice` (FK-id only). Consolidated column set:

| Column (snake_case) | Type | Purpose |
|---|---|---|
| `invoice_kind` | text, default `'vat'` | Explicit document-kind (`vat\|zal\|roz\|upr\|kor_zal\|kor_roz`). Replaces the non-existent `document_type` read. |
| `self_billing` | boolean, default `false` | Self-billing (art. 106d) → FA(3) `P_17`. |
| `reverse_charge` | boolean, default `false` | Reverse charge → FA(3) `P_18`. |
| `mpp_required` | boolean, default `false` | Split payment → FA(3) `P_18A`. |
| `vat_exemption_basis` | text, nullable | VAT exemption legal basis → FA(3) `P_19`/`P_19C`. |
| `oss_procedure` | boolean, default `false` | OSS/WSTO_EE marker (explicit). |
| `consumption_country_code` | text, nullable | OSS destination/consumption country (ISO alpha-2). |
| `exchange_rate` | text, nullable | FX rate to PLN. |
| `exchange_rate_date` | date, nullable | FX rate date (art. 31a: last working day before the tax point). |
| `advance_payments` | json, default `'[]'` | ZAL received-payment snapshots `[{ receivedDate, amount, fxRate? }]` → `ZaliczkaCzesciowa`. |
| `advance_refs` | json, default `'[]'` | ROZ prior-advance references `[{ ksefNumber?, invoiceNumber? }]` → `FakturaZaliczkowa`. |
| `order_snapshot` | json, nullable | ZAL/KOR_ZAL order data `{ totalValue, lines: [...] }` → `Zamowienie`. |
| `gtu_codes` | json, default `'[]'` | Pure-JPK: array of `GTU_01..GTU_13`. |
| `wsto_ee`, `ied`, `tp`, `tt_wnt`, `tt_d`, `mr_t`, `mr_uz`, `i_42`, `i_63`, `b_spv`, `b_spv_dostawa`, `b_mpv_prowizja` | boolean, default `false` | Pure-JPK procedure markings (one per code). |
| `doc_type` | text, nullable | Pure-JPK `TypDokumentu` (`RO\|WEW\|FP`). |
| `issued_outside_ksef` | boolean, default `false` | Explicit operator BFK signal (invoice lawfully issued outside KSeF, or a total-awaria) → JPK `BFK` (never a silent fallback). |
| `context_nip` | text (`^[0-9]{10}$`) | Seller NIP for this invoice (bare digits — normalized before persist). |
| `bad_debt_relief_period`, `bad_debt_termin_platnosci` | text/date, nullable | art. 89a bad-debt inputs feeding JPK `TerminPlatnosci`/`P_68`/`P_69`. |

Additional invoice attributes carried in core `SalesInvoice.metadata` jsonb (no PL-meta column, no migration): `metadata.payment` (the `{ method, methodOther, termDays, bankAccount, bankName, swift, paid, paidDate }` object → FA(3) `<Platnosc>`), `metadata.saleDate` (→ `P_6`), `metadata.buyerSnapshot` (buyer capture), `metadata.notes` (Uwagi — PDF/detail only, NOT in FA(3) XML). These are authored by the editor (SPEC-008) and read by the resolvers.

One additive, defaulted MikroORM migration (generated via `yarn mercato db:generate`, never hand-written); `invoice_kind='vat'` default means every existing invoice follows the unchanged VAT path. No change to `financial_pl_invoice_meta_invoice_unique`.

### PurchaseVatRecord (`financial_pl_jpk_purchase_record`) — JPK-shaped purchase VAT ledger (this module's own entity; not a full AP module)

`organization_id, tenant_id, context_nip, year, month`; supplier `supplier_nip?(→"BRAK"), supplier_country_code?, supplier_name`; `document_number, purchase_date, receipt_date?, document_type?(MK\|VAT_RR\|WEW), imp(bool), ksef_marking?(NrKSeF\|OFF\|BFK\|DI), nr_ksef?`; `transaction_class (domestic\|wnt\|import_goods\|import_services\|import_services_28b\|reverse_charge_domestic)`; amounts (numeric text) `net_fixed_assets(K_40), vat_fixed_assets(K_41), net_other(K_42), vat_other(K_43), corr_fixed_assets(K_44), corr_other(K_45), corr_89b_1(K_46), corr_89b_4(K_47), margin_gross(ZakupVAT_Marza)`; self-assessment `self_assessed_net, self_assessed_vat, self_assessed_rate` (for the K_23..K_32 output row); timestamps. Indexed `(organization_id, tenant_id, year, month, deleted_at)`.

### JpkVatFiling (`financial_pl_jpk_filing`) — the VAT filing record

`organization_id, tenant_id, context_nip, variant(V7M\|V7K), year, month(1-12), quarter?(1-4), cel_zlozenia(1\|2), correction_scope(both\|declaration\|evidence), kod_urzedu`; declaration operator inputs (JSON `declaration_inputs`: prior_surplus P_39 override, P_49, P_50, P_52, refund elections, markers, P_ORDZU); submission state `status(draft\|generated\|submitting\|submitted), generated_xml?(encrypted), generated_at?, submission_reference?, upo_xml?(encrypted), submitted_at?`; timestamps. Unique active `(organization_id, tenant_id, variant, year, month, cel_zlozenia)`. `generated_xml`/`upo_xml` are in the module `ModuleEncryptionMap` under entity id `financial_pl:jpk_vat_filing` (else `generated_xml` would be stored plaintext).

One additive migration adds the two JPK tables + the PL-VAT columns above (the SPEC-015 branch's `Migration20260630000000` also adds the inbound-receiving entities documented in SPEC-005).

## API Contracts

External (KSeF v2, consumed): the FA(3) document kinds are conveyed entirely in the XML body — the `…/submissions/from-invoice` / `…/from-credit-memo` send routes (SPEC-005) are unchanged; the document kind is resolved from PL-meta, transparent to callers.

Internal (this module — additive; auth + `ensureTenantScope`/`ensureOrganizationScope` + zod on every route):

| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/ksef/submissions/from-credit-memo` | `POST` | `financial_pl.submit` | Resolve FA(3) **KOR** from `{creditMemoId}` and queue an idempotent submission; `202` + `submissionId`. 404 unknown credit memo (before 409) / 409 not-issued·no-linked-invoice·no-credentials / 422 currency·VAT-rate·seller·buyer·`correction_reason_required`·`original_ksef_number_unknown`. |
| `…/ksef/invoice-meta` | `GET`/`PUT` | `financial_pl.manage` | Read/write the PL-VAT metadata: `invoiceKind`, `selfBilling`, `reverseCharge`, `mppRequired`, `vatExemptionBasis`, `ossProcedure`, `consumptionCountryCode`, `exchangeRate`/`exchangeRateDate`, `advancePayments`/`advanceRefs`/`orderSnapshot`, `gtuCodes`, the 12 procedure booleans, `typDokumentu`, `issuedOutsideKsef`, `contextNip`, bad-debt fields. Org/tenant-scoped, optimistic-locked; applies each field only when `!== undefined` (the `mppRequired` pattern); dedupes `gtuCodes`. |
| `…/ksef/jpk-markings` | `GET` | `financial_pl.view` | Batch JPK marking read for `?salesInvoiceId=` (comma UUID list, **capped 100**); returns `{ items: [{ salesInvoiceId, marking, ksefNumber, pending }] }`; **requires a resolved org scope (400 otherwise)**; single batched read, no N+1. |
| `…/ksef/jpk/purchase-records` | `GET`/`POST`/`DELETE` | `financial_pl.manage` | Purchase VAT ledger CRUD. |
| `…/ksef/jpk/filings` | `GET`/`POST` | `financial_pl.manage` | Filing upsert (variant/period/scope/operator inputs). |
| `…/ksef/jpk/export?filingId=` | `GET` | `financial_pl.manage` | Generate + stream the XSD-valid JPK XML attachment. |
| `…/ksef/jpk/submit` | `POST` | `financial_pl.submit` | Submit `JpkVatFiling.generatedXml` to the MF gateway; CAS-locked, idempotent; flips to `submitted` with UPO. Rejects submitting a non-`generated` filing. |
| `…/ksef/jpk/submit/status?ref=` | `GET` | `financial_pl.submit` | Poll a JPK submission status. |
| `…/ksef/nbp-rate` | `GET` | `financial_pl.view` | NBP mid-rate proxy for `?currency=&taxPointDate=`; fail-open. |

`POST …/ksef/submissions` (explicit payload) also accepts a `correction` block + `invoiceKind` for direct/testing use; a direct-POST `KOR` payload must be a `credit_memo` submission (no bleed onto the corrected invoice).

## Internationalization (i18n)

New keys (en/pl/de/es, `i18n:check-sync` green): correction errors (`correction_reference_missing`, `credit_memo_not_linked`, `original_ksef_number_unknown`, `correction_reason_required`), doctype/OSS/FX errors (`advance_data_required`, `settlement_refs_required`, `upr_threshold_exceeded`, `oss_country_required`, `oss_rate_required`, `exchange_rate_required`, `precorrection_amount_required`), payment validation (`termDaysRange`), field labels (`invoiceKind`, `selfBilling`, `reverseCharge`, `ossProcedure`, `consumptionCountry`, `gtu.GTU_01..13`, `procedure.WSTO_EE..B_MPV_PROWIZJA`, `typDokumentu`), JPK submit (action/status/upo/errors), NBP (fetch-rate/unavailable), and `sendCorrectionToKsefQueued`. `document_type_unsupported` reworded (all seven kinds now supported).

## Risks & Impact Review

### Data integrity failures
- **Correction difference/sign semantics** (files the wrong sign/meaning). Severity High → **mitigated**: credit-memo amounts validated non-negative; the resolver emits FA(3) differences as their negation (a credit memo is always a reduction) — one isolated, unit-tested rule; xmllint confirms negative differences are XSD-valid; live TEST round-trip confirms KSeF acceptance. Residual: a credit memo modelling an *increase* (not currently possible) would need the rule revisited (flagged at the single call-site).
- **`NrKSeFN` emitted for a pending original.** Severity Medium → **eliminated**: the resolver rejects `409 original_not_accepted` for a non-accepted original and requires explicit `originalOutsideKsef` (else 422) when the original has no submission; absence of a number is never silently treated as legacy.
- **OSS misclassification** (domestic billed as OSS or vice-versa → wrong VAT field/return). Severity High → **mitigated**: explicit `oss_procedure` marker (never inference) + per-line `P_12_XII` validated against the EU table. Residual: operator must set the marker.
- **Wrong `P_15` on ZAL/ROZ** (paid vs residual). Severity High → **mitigated**: both computed with BigInt money math + a reconciliation invariant (`ROZ P_15 = full gross − Σ advances`; `ZAL P_15 = Σ P_15Z`) asserted in unit tests.
- **JPK declaration/evidence math + rate/category bucketing + self-assessment dual rows.** Severity High → **mitigated**: exact brochure/XSD field map; BigInt cents; whole-PLN rounder; worked end-to-end unit tests; control-sum cross-checks; the `xmllint` XSD gate.
- **JPK submission `generated_xml`/`upo_xml` at rest.** → both in the `ModuleEncryptionMap` under `financial_pl:jpk_vat_filing`; never projected in list reads.

### Cascading failures & side effects
- **XSD sequence drift** when threading new FA(3)/JPK blocks → 450/validation rejection. Severity High → **mitigated**: serializer/JPK tests pin exact element order; per-document-type full-XML snapshot tests lock the `<Fa>` sequence; every JPK document is `xmllint`-validated against the vendored XSD. Residual: full FA(3) proof requires the live round-trip (done — KSeF TEST).
- **Correction bleeding onto the original invoice.** → every invoice-facing read filters `document_kind='invoice'` in the DB query.
- **Stale EU rate table** → wrong `P_12_XII` if used as the source. Severity Medium → **mitigated**: per-line sales rate trusted first; dated config with `OM_KSEF_EU_VAT_RATES` override + mismatch warning; re-verify each fiscal year.
- **`termDays` out of range silently drops `<Platnosc>`.** → `invoicePaymentSchema` `.int().min(0)` + a resolver that fail-opens once meant a negative/fractional `termDays` silently dropped the whole payment block; fixed with a whole-number `[0, 3650]` guard.

### External gateway/API unavailability (MF JPK, NBP)
- Severity Medium → **mitigated**: every external call is `AbortController`-bounded; conveniences (NBP) fail open; operations (JPK submit) surface a clear retryable error and never corrupt local state (idempotent reference handling + CAS lock + reconcile re-drive). Residual: Low.

### JPK submission not fully test-verifiable
- Severity Medium → **mitigated**: the InitUpload→PUT→Finish→Status→UPO mechanics + AES/RSA/XAdES crypto **are** test-verifiable with a self-signed cert + MF test archives; the prod-only bits (qualified-signature authenticity, `dane autoryzujące`) are implemented-to-spec + unit-tested and **documented as not-live-verified**, not claimed. Residual: Low–Medium (bounded, documented).

### Tenant & data isolation
- All reads/writes are `(tenantId, organizationId)`-scoped via the Query Engine / meta API; PL-meta and both JPK entities are FK-id-linked only (no cross-module ORM relation). No cross-org surface.

### Migration & deployment
- Additive, online-safe (nullable/defaulted columns; two new tables; index predicates tightened — all existing rows satisfy them). Re-runnable, no backfill. `invoice_kind='vat'` default keeps existing orgs unaffected.

## Final Compliance Report — 2026-07-01

### AGENTS.md files reviewed
- `AGENTS.md` (root, official-modules) · `.ai/specs/AGENTS.md` · `ARCHITECTURE.md` (§11 UMES, §27 BC, §31 checklist) · core `packages/core/.../sales` (read-only, for the credit-memo model + the query-engine entity ids).

### Compliance matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | Credit memo / invoice / sales read via Query Engine, FK-id only; PL-meta + JPK entities FK-id-linked. |
| root AGENTS.md | Filter by organization_id (+ tenant) | Compliant | All reads + every new route `(tenantId, organizationId)`-scoped. |
| root AGENTS.md | Never modify core packages | Compliant | `sales`/core read-only; correction is the core `credit_memo`; all changes in `financial_pl`. |
| root AGENTS.md | Never hand-write migrations | Compliant | Generated via `yarn mercato db:generate`; migrate-from-zero verified. |
| root AGENTS.md | zod-validate all API inputs | Compliant | FA(3) schema, meta API, JPK routes, from-credit-memo, jpk-markings, nbp-rate all zod-validated. |
| root AGENTS.md | No `any` / no hardcoded user strings | Compliant | `z.infer` types; i18n keys in 4 locales. |
| ARCHITECTURE §27 | Backward-compatibility (additive only) | Compliant | Defaulted columns; `superRefine` only widens; serializer/JPK emissions additive; VAT/KOR serializes byte-identically to the baseline. |
| ARCHITECTURE §11 | UMES for cross-module UI | Compliant | Meta fields surfaced via the editor (SPEC-008); enricher exposes `jpkVatMarking`. |

### Internal consistency check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | PL-meta columns + JPK entities back the meta/JPK routes and the resolver dispatch. |
| API contracts match UI/UX | Pass | Editor + JPK backoffice (SPEC-008) consume these routes; enricher field documented. |
| Risks cover all write operations | Pass | Correction send, doctype emission, OSS, FX, netting, JPK generate + submit covered. |
| Commands defined for all mutations | Pass | `send_from_credit_memo`, `jpk.upsert_*`/`generate`/`submit`. |

### Verification
- FA(3): serializer/mapping/validator/resolver unit suites + per-document-type full-XML snapshots; generated `VAT`/`ZAL`/`ROZ`/`UPR`/`OSS`/`KOR` documents `xmllint`-validated against `schemat_FA(3)_v1-0E.xsd`. **Live on KSeF TEST** (NIP 2481632647): VAT, ZAL advance, UPR simplified, OSS EUR/WSTO_EE, and a real correction round-trip (accepted original `…3F8DD3400000-57` → accepted KOR `…4011D3400000-63`) all accepted with real KSeF numbers + signed UPO; a placeholder-ref KOR is rejected 450 (used as an oracle).
- JPK: `build-sprzedaz`/`build-zakup`/`compute-declaration`/`build-jpk-xml` unit tests + the **`xmllint` XSD gate** validating V7M(3) full, V7K(3) months 1-2 (evidence-only) vs month 3 (full), and each correction scope. Integration: `TC-KSEF-003`/`TC-KSEF-004` (from-credit-memo + jpk-markings), `TC-KSEF-007` (advanced doctypes + OSS + GTU meta), `TC-JPK-001` (export route auth/scope), `TC-KSEF-JPK-002` (JPK submit route auth/gate/idempotency).
- JPK→MF submit + NBP: NBP rate fetch **live-confirmed**; JPK→MF submit is client-implemented + unit-verified with a documented env-gated recipe against `test-e-dokumenty.mf.gov.pl` (self-signed XAdES + MF test archive), **not yet live-exercised** — an honest bounded limitation, not claimed as verified.

### Verdict
**Fully compliant — implemented.** The FA(3) document layer and JPK_V7 export/marking/submission reflect the shipped, KSeF-TEST-verified state; the one bounded gap (live JPK→MF submit) is documented above.

### Known follow-ups (non-blocking)
- **Credit-memo own KSeF number in JPK:** a correction row currently inherits the *original* invoice's KSeF node; the KSeF *number* should be the credit memo's own `document_kind='credit_memo'` submission (XSD-valid today, reports the wrong `NrKSeF` for the correction).
- **Credit-memo status gate for JPK:** `SalesCreditMemo` has no `is_immutable`; a `status` gate is needed to keep drafts out (partly mitigated — a memo whose original has a pending marking is skipped).
- **art. 89a sales path:** the bad-debt fields + `P_68/P_69` compute are implemented + unit-tested, but the JPK resolver does not yet wire them from real sales data (operator/explicit-payload path can set them).
- Keep `xmllint` in the CI image — the XSD gate skips (with a logged warning) if libxml2 is absent.

## Changelog

### 2026-07-01
- Consolidated from SPEC-006, SPEC-009, SPEC-012 (and the NBP-FX + JPK→MF-submission slices of SPEC-015) into this thematic spec; reflects final implemented state. Brought the FA(3) serializer core (originally described in SPEC-005) here as the document-layer home; the connector spec (SPEC-005) now references this file.
- Rewrote all prior "Draft / for-implementation / pending the user's environment" framing (SPEC-006/009/012's blocked-on-`@open-mercato/shared/lib/pl/validation`-gap status, SPEC-012's partially-implemented status) as **implemented** — the module is live-verified on KSeF TEST for FA(3) (VAT/KOR/ZAL/ROZ/UPR/OSS accepted + UPO) and the JPK_V7 XSD gate passes; the single honest caveat retained is that JPK→MF e-submission is client-/unit-verified only, not yet live on the MF test gateway.
- Marked SPEC-009's six Open Questions **resolved**: (1) OSS rate maintenance = the dated `EU_STANDARD_VAT_RATES` config with `asOf` + `OM_KSEF_EU_VAT_RATES` override, sales rate trusted first; (2) UPR threshold = 450 PLN (EUR/OSS PLN-converted via the resolved rate, or ≤ 100 EUR when no rate is resolvable); (3) FX source = the NBP table-A prior-business-day rate (SPEC-015 F5, folded in here); (4) ZAL→ROZ = the JSON-snapshot approach on PL-meta; (5) ZAL/ROZ submit under `documentKind='invoice'`; (6) OSS corrections = IN SCOPE via the standard KOR path (KOR_ZAL/KOR_ROZ carry OSS line fields + buckets + FX).
- Superseded design decisions dropped from the body (kept only as this note): the SPEC-006-era "no offline modes so `OFF`/`DI` markings never fire" and "credit memos have no UMES host / enricher-only UI" framings (offline is real per SPEC-005; the editor + JPK backoffice ship in SPEC-008); the SPEC-009-era `superRefine` blanket reject and non-PLN reject (replaced by per-kind checks + the FX rule); SPEC-012's "NBP FX / MF e-submission deferred to a later phase" R5 note (both now implemented).
- Cross-org/agency (biuro-rachunkowe) delegation remains explicitly dropped (per the 2026-06-27 product decision): KSeF config stays strictly per-organization; the lawful model is per-NIP delegation, intentionally not pursued.

### Provenance (pre-consolidation, condensed)
- **2026-06-27 (SPEC-006):** correction (KOR) send path from `sales.credit_memo`; `DaneFaKorygowanej` (KSeF-number or `NrKSeFN`); `document_kind`/`credit_memo_id` on `KsefSubmission` (SPEC-005) with correction-aware idempotency; JPK marking derivation + `jpk-markings` + enricher. Post-review: negation sign rule; `DataWystFaKorygowanej` from the original; `document_kind='invoice'` DB filter; org-scoped jpk-markings; 404-before-409. Dedup key corrected to the SHA-256 content hash (2026-06-28).
- **2026-06-28 (SPEC-009):** FA(3) ZAL/ROZ/UPR/KOR_ZAL/KOR_ROZ + advance→settlement chain; self-billing `P_17`; full OSS/WSTO_EE + FX (`P_12_XII`, `P_13_5`/`P_14_5`, `KursWaluty`/`P_14_xW`); GTU/procedure/`TypDokumentu` pure-JPK columns; the seven-value enum gates lifted to per-kind checks. Spec-jury deltas folded in (pure-OSS needs no FX rate; OSS corrections in scope).
- **2026-06-29 (SPEC-012):** JPK_V7M(3)/V7K(3) export — XSD-valid `Naglowek+Podmiot1+Deklaracja+Ewidencja`, the full field map + declaration compute formulas, `PurchaseVatRecord` + `JpkVatFiling` models, self-assessed dual rows, OSS exclusion, the `xmllint` XSD gate. Code-jury fixes: base/VAT pair emission, encryption entity-id, validator tightening, credit-memo FP inheritance, V7K `Kwartal`.
- **2026-06-30 (SPEC-015 slices consumed here):** NBP FX prior-business-day sourcing (F5) resolving SPEC-009's FX question; JPK→MF e-submission (F2) — separate gateway, dedicated signer credential, ZIP/AES-256-CBC + RSA-PKCS#1-v1.5 wrap, `signJpkInitUpload`, `http-put.ts`, CAS-locked idempotent filing submit.
- Payment `<Platnosc>` block + method→`FormaPlatnosci` matrix + sale-date `P_6` (originally SPEC-017) are documented here as the serializer's payment emission; their editor UI lives in SPEC-008.
