# SPEC-009 — `financial_pl`: FA(3) advanced document types, self-billing, full OSS/WSTO_EE + GTU/JPK markings

- **Date:** 2026-06-28
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md) (send-only token connector), [SPEC-006](./SPEC-006-2026-06-27-financial-pl-ksef-corrections-jpk.md) (corrections + JPK markings), [SPEC-007](./SPEC-007-2026-06-27-financial-pl-ksef-cert-auth-reliability.md) (certificate auth + reliability), [SPEC-008](./SPEC-008-2026-06-28-financial-pl-invoice-pdf.md) (invoice PDF visualization)
- **Status:** Draft → for implementation. Pure-logic verification (jest serializer/resolver/validator + the live unauthenticated contract probe) runs in this checkout; the full typecheck/build/integration gate and the live authenticated round-trip (advance→settlement chain, self-billing, OSS) are pending the user's environment (same pre-existing `@open-mercato/shared/lib/pl/validation` dependency gap documented in SPEC-006/007 — not introduced here).

## TLDR

**Key Points:**
- **Four feature areas, all additive, no core change.** This spec extends the working FA(3) connector (today: VAT + KOR, PLN-only, closed Polish VAT enum) with: (1) the **advanced FA(3) document types** `ZAL` (advance/zaliczkowa), `ROZ` (settlement/rozliczeniowa-końcowa), `UPR` (simplified/uproszczona), and their corrections `KOR_ZAL`/`KOR_ROZ`, including the **advance→settlement chain** (a ROZ nets and references its prior ZAL invoices); (2) **self-billing (samofakturowanie)** wired through the FA(3)-native `Adnotacje/P_17` element; (3) **full OSS / WSTO_EE** EU B2C distance sales — the destination-country VAT rate via `P_12_XII`, the OSS summary buckets `P_13_5`/`P_14_5`, the line procedure marker `Procedura=WSTO_EE`, **and** foreign-currency support (`KodWaluty` ≠ PLN, per-line `KursWaluty`, PLN-converted `P_14_xW`); (4) **GTU_01..GTU_13 + the JPK procedure markings + TypDokumentu** captured as pure-JPK PL-meta fields for the future JPK_VAT export, with the markings that are *also* FA(3) `Adnotacje` (P_17 self-billing, P_18 reverse charge) wired through the existing annotation path.
- **The enum already exists; the gates are lifted, not invented.** `Fa3InvoiceModel.invoiceKind` and `data/validators.ts` already enumerate all seven `RodzajFaktury` values (`VAT|KOR|ZAL|ROZ|UPR|KOR_ZAL|KOR_ROZ`); today a `superRefine` *rejects* everything except VAT/KOR, and a second gate rejects non-PLN. This spec replaces those blanket gates with **per-kind requirement checks** and a **foreign-currency-with-rate** path, so the serializer can faithfully emit the new blocks in strict XSD sequence order.
- **The biggest data-model decision is where the new signals live.** Core `sales` has no `document_type` column (the current `resolve-fa3-from-invoice.ts:123` reads a non-existent field and defaults to `'vat'`), no advance/settlement construct, no OSS/consumption-country flag, and no FX rate. To keep the country-agnostic `sales` schema untouched (§ module-independence) every new signal is added to the existing `SalesInvoicePlMeta` extension (`financial_pl_invoice_meta`): an `invoice_kind` enum, advance/settlement JSON snapshots, the self-billing flag, the OSS procedure + consumption-country + FX fields, and the pure-JPK GTU/procedure/TypDokumentu columns. One additive, defaulted MikroORM migration (generated, never hand-written).
- **Money math and XSD order are preserved by construction.** All new amounts (`P_15`, `P_15Z`, `WartoscZamowienia`, `P_14_xW`, OSS `P_13_5/P_14_5`) reuse the existing BigInt `toScaled4`/`scaled4ToMoney2dp` helpers; the new line/summary fields are threaded into `buildFa3Xml` in the exact `xsd:sequence` positions (any deviation is a KSeF 450 rejection). The document MUST still be validated against `schemat_FA(3)_v1-0E.xsd` before a production send (the connector records schema rejections rather than masking them).

**Scope (this spec):**
- FA(3) `ZAL`/`ROZ`/`UPR`/`KOR_ZAL`/`KOR_ROZ` serialization + resolvers, incl. the advance→settlement chain (`ZaliczkaCzesciowa`, `FakturaZaliczkowa`, `Zamowienie`/`ZamowienieWiersz`, the correction-tail `P_15ZK`/`KursWalutyZK`, UPR NIP-only buyer + threshold).
- Self-billing (`Adnotacje/P_17`) driven from a new `self_billing` PL-meta flag.
- Full OSS/WSTO_EE: `P_12_XII`, `Procedura=WSTO_EE`, `P_13_5`/`P_14_5`, foreign currency (`KodWaluty`, `KursWaluty`, `P_14_xW`), the EU standard-rate config table.
- GTU_01..13 + 12 JPK procedure markings + TypDokumentu as pure-JPK PL-meta columns; the invoice-meta API + the `pl-vat-meta-fields` widget; the FA(3)-native ones (P_17, P_18) wired through `buildAnnotations`.

**Concerns:**
- OSS and ZAL/ROZ are regulation-critical and only fully provable against the live API; mitigated with rigorous serializer/resolver unit tests (exact field names + XSD order) and the env-gated live round-trip extension.
- OSS misclassification (domestic vs OSS) and a stale EU-rate table are the two highest-severity risks; both are mitigated by an **explicit** OSS marker (never inference) and treating the rate table as dated configuration with a per-tenant override.
- Foreign-currency exchange-rate sourcing is a genuine open question (NBP table vs a sales-carried rate) recorded in Open Questions.

## Overview

> **Market reference**: wFirma, inFakt, Comarch, Fakturownia all issue advance/final invoices (faktura zaliczkowa/rozliczeniowa), simplified invoices, self-billed invoices, and OSS invoices through FA(3), and capture GTU/JPK procedure markings for the JPK_VAT return. This spec brings the connector to that functional parity on the issuance side, staying additive to the proven VAT/KOR/token/cert paths.

FA(3) carries five document kinds beyond the basic VAT invoice and its correction, all selected by the closed `<RodzajFaktury>` enumeration that the serializer already emits at `lib/fa3.ts:361`:

| `RodzajFaktury` | Statutory basis | Meaning |
|---|---|---|
| `ZAL` | art. 106b ust. 1 pkt 4; art. 106f ust. 4 | Advance/prepayment invoice (faktura zaliczkowa). `P_15` = the **amount paid** this invoice documents. Line detail lives in `Zamowienie` (FaWiersz optional). |
| `ROZ` | art. 106f ust. 3 | Settlement/final invoice (rozliczeniowa/końcowa). `P_15` = **amount remaining to pay** = full value − advances already invoiced. Carries **full** `FaWiersz` and references prior advances in `FakturaZaliczkowa`. |
| `UPR` | art. 106e ust. 5 pkt 3 | Simplified invoice (faktura uproszczona): total ≤ 450 PLN / ≤ 100 EUR; buyer may carry **NIP only** (no name/address). |
| `KOR_ZAL` | art. 106j (of a 106f ust. 4 invoice) | Correction of an advance invoice. Correction block (as KOR) + `P_15ZK` (payment before correction) + corrected `Zamowienie`. |
| `KOR_ROZ` | art. 106j (of a 106f ust. 3 invoice) | Correction of a settlement invoice. Correction block + `P_15ZK` (amount-remaining before correction) + corrected `FaWiersz`. |

**Critical Uwaga (brochure Tabela 28):** a correction of a *simplified* (UPR) invoice carries `RodzajFaktury=KOR`, **not** a `KOR_UPR` value (no such enum member exists). The existing KOR credit-memo path already covers UPR corrections structurally — no new work for that case.

**Self-billing (samofakturowanie, art. 106d):** an invoice issued by the buyer in the supplier's name. In FA(3) this is the **`Adnotacje/P_17`** flag, currently hardcoded to `'2'` (does not apply) in `renderAnnotations` (`lib/fa3.ts:288`). This spec drives it from a PL-meta flag — the FA(3)-native wiring is a single annotation field; the rest (who the issuing party is) is already carried by the existing buyer/seller resolution.

**OSS / WSTO_EE (dział XII rozdz. 6a; art. 28k):** intra-EU B2C distance sales of goods and TBE/EE services taxed at the **consumer-country** rate. FA(3) has a purpose-built mechanism: the line omits the closed-enum `P_12` and instead carries `P_12_XII` (the destination rate as a decimal) + `Procedura=WSTO_EE`; the summary rolls OSS net/VAT into the dedicated `P_13_5`/`P_14_5` buckets (no `W` PLN-converted variant for `P_14_5`). OSS invoices are typically in EUR, so this also requires foreign-currency support: `KodWaluty` ≠ PLN, per-line `KursWaluty`, and the PLN-converted VAT `P_14_xW` for any **Polish-rate** buckets on the same invoice (art. 106e ust. 11).

**GTU + JPK procedure markings + TypDokumentu:** GTU_01..GTU_13 and the 12 procedure markings (`WSTO_EE, IED, TP, TT_WNT, TT_D, MR_T, MR_UZ, I_42, I_63, B_SPV, B_SPV_DOSTAWA, B_MPV_PROWIZJA`) and `TypDokumentu` (RO/WEW/FP) are **pure-JPK** sales-register flags — they never appear in the FA(3) XML. They are captured now on the PL-meta for the **future** JPK_VAT export (out of scope to build the export). The only JPK concepts that are *also* FA(3) `Adnotacje` are split payment (P_18A, already `mppRequired`), VAT exemption (P_19/P_19C, already `vatExemptionBasis`), reverse charge (P_18), and self-billing (P_17) — the latter two are wired through `buildAnnotations` here.

## Problem Statement

1. **Only VAT + KOR can be issued.** `data/validators.ts` `superRefine` (lines 105–156) rejects every `invoiceKind` except VAT/KOR, so advance, settlement, simplified, and their corrections cannot be filed even though the enum and `RodzajFaktury` emission already exist.
2. **No advance→settlement chain.** There is no way to file a faktura zaliczkowa and later a faktura rozliczeniowa that nets and references it (`ZaliczkaCzesciowa`, `FakturaZaliczkowa`, `Zamowienie` blocks are unimplemented).
3. **Self-billing cannot be flagged.** `P_17` is hardcoded to `'2'`; an art. 106d self-billed invoice cannot set it.
4. **OSS is impossible.** The connector rejects non-PLN currency (3 sites) and any VAT rate not in the closed Polish map, so a German-19%/EUR distance sale cannot be issued; `P_12_XII`/`Procedura`/`P_13_5`/`P_14_5`/`KursWaluty`/`P_14_xW` are unimplemented.
5. **GTU / procedure markings / TypDokumentu cannot be captured.** The PL-meta has no columns for them, so the future JPK_VAT export has no data to read.
6. **`document_type` is read but does not exist.** `resolve-fa3-from-invoice.ts:123` reads `invoice.document_type` (not a `sales` column) → always undefined → always `'vat'`. The real document-kind signal must be defined.

## Proposed Solution

Extend the pure serializer (`lib/fa3.ts`), the pure mapping helpers (`lib/fa3-mapping.ts`), the zod schema (`data/validators.ts`), the two resolvers, the PL-meta entity + extension, the invoice-meta API, and the meta widget — all **additively**. No change to the country-agnostic `sales` schema, no core-package change, no new entity beyond columns on the existing `SalesInvoicePlMeta`. The seven-value `invoiceKind` enum is kept; the blanket `superRefine` gates are replaced with per-kind requirement checks and a foreign-currency-with-rate path. The advance/settlement/OSS/self-billing signals are read from new `SalesInvoicePlMeta` columns (set by the operator via the meta widget/API), so the resolvers dispatch on an **explicit** signal rather than inference. The pure-JPK GTU/procedure/TypDokumentu columns are captured but not yet exported.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| All new document-kind / OSS / self-billing / FX signals live on `SalesInvoicePlMeta` (new columns), not `sales` | The `sales` schema is country-agnostic and must stay untouched (module independence, §). The PL-meta extension already exists (1:1, FK-id only) and is the established home for `mppRequired`/`vatExemptionBasis`/`issuedOutsideKsef`. |
| `invoice_kind` is an **explicit** PL-meta enum, default `'vat'` | The current `document_type` read is a non-existent column; an explicit operator-set kind is the only correct signal. Defaulting to `'vat'` preserves every existing invoice's behavior. |
| OSS is driven by an **explicit** `oss_procedure` flag + `consumption_country_code`, never inferred | A foreign-looking numeric rate (e.g. 21%) is ambiguous PL-vs-OSS without a marker; inference would mis-state the VAT field and the return (highest-severity risk). |
| ZAL/ROZ advance data carried as **JSON snapshots** on PL-meta (`advance_payments`, `advance_refs`, `order_snapshot`), mirroring the existing `metadata` snapshot pattern | `sales` has `SalesPayment`/`SalesPaymentAllocation`/`SalesOrderLine` but **no** "this invoice is an advance" flag; reconstructing the chain by querying is fragile. A snapshot set by the issuing flow is deterministic and keeps `sales` untouched. (Querying remains a future option; not relied on here.) |
| EU standard-rate table is **dated configuration** with a per-tenant/env override, not a compiled-in constant | VAT rates change mid-year (EE 22→24, FI →25.5, SK →23). The table is a fallback/validation source; the per-line OSS rate from the sales data is trusted first. |
| `P_12_XII` value comes from the sales-computed per-line rate when present, with the EU table as fallback + a mismatch warning | Handles destination reduced rates correctly; the table only validates/fills. |
| Foreign currency accepted only when an **exchange rate is resolvable** and `P_14_xW` can be computed for Polish-rate buckets | art. 106e ust. 11 requires PLN VAT for domestic-rate buckets; without a deterministic rate the connector cannot emit a compliant FX document. |
| GTU/procedure/TypDokumentu are **pure-JPK** PL-meta (never in FA(3) XML); only P_17/P_18 wired through `buildAnnotations` | Per the JPK brochure, GTU/procedures are JPK sales-register flags, not e-invoice fields. Self-billing (P_17) and reverse charge (P_18) are the FA(3)-native annotations among the requested markings. |
| GTU as a `json` string array; procedure markings as individual booleans; TypDokumentu as a text enum | Booleans match the existing `mpp_required` style and are trivially export-filterable; GTU is a small closed set best as an array. Constraints (GTU-not-on-RO etc.) are enforced at **export** time, not capture. |
| Reject still applies to genuinely-unsupported combinations | An unmapped Polish rate, a missing OSS marker on a foreign-rate line, or a non-PLN invoice with no resolvable FX rate is rejected with a localized 422 — narrowing is only for previously-broken cases. |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Add `document_type`/advance/OSS columns to core `sales` | Breaks module independence and the country-agnostic core; the PL-meta extension is the sanctioned mechanism. |
| Infer OSS from "buyer non-PL + numeric foreign rate" | Ambiguous and high-risk (wrong VAT field/return); explicit marker only. |
| Reconstruct the ZAL→ROZ chain purely by querying `sales_payments`/order lines | No "advance" flag exists in `sales`; brittle and order-coupling-sensitive. Snapshots are deterministic. |
| Compile the EU rate table as a constant | Rates change; a stale constant silently mis-rates OSS lines. Config with `asOf` + override. |
| Put GTU/procedures into the FA(3) XML | They are not FA(3) fields; KSeF would reject unknown elements. Pure-JPK only. |
| One `jpk_markings` JSON blob | Loses column-level export queryability and diverges from the boolean-column convention. |

## User Stories / Use Cases
- **An operator** wants to **issue an advance invoice (ZAL) and later a settlement invoice (ROZ) that nets and references it** so that **a prepaid order is invoiced correctly through KSeF**.
- **An operator** wants to **issue a simplified invoice (UPR) with only the buyer's NIP** so that **low-value sales (≤ 450 PLN) are filed without full buyer identity**.
- **An operator** wants to **flag a self-billed invoice (samofakturowanie)** so that **the FA(3) `P_17` marker is set per art. 106d**.
- **An operator** wants to **issue an OSS distance sale in EUR at the German rate** so that **WSTO_EE is filed with `P_12_XII`/`P_13_5`/`P_14_5` and the OSS return reconciles**.
- **An operator/accountant** wants to **tag an invoice with GTU codes and JPK procedure markings** so that **the future JPK_VAT export carries the statutory sales-register flags**.

## Architecture

### Serializer (`lib/fa3.ts` — modify; pure)
The `<Fa>` tail is a strict `xsd:sequence`. New blocks are threaded into `buildFa3Xml` (currently lines 352–366) in this exact order between `renderCorrection(...)` (line 363) and `...lines.map(renderLine)` (line 364):

```
KodWaluty, P_1, P_2, P_6?,
<VAT summary: P_13_1/P_14_1/P_14_1W? … P_13_5/P_14_5 (OSS) … >   ← renderVatBreakdown extended
P_15,
Adnotacje,                                                       ← renderAnnotations extended (P_17)
RodzajFaktury,
[correction block: … DaneFaKorygowanej[] … P_15ZK? KursWalutyZK?]← renderCorrection extended
ZaliczkaCzesciowa*  (P_6Z, P_15Z, KursWalutyZW?)                 ← renderZaliczkaCzesciowa (new)
FakturaZaliczkowa*  (NrKSeFZN?|NrFaZaliczkowej?|NrKSeFFaZaliczkowej?) ← renderFakturaZaliczkowa (new)
FaWiersz*           (… P_12? P_12_XII? … Procedura? KursWaluty? …)   ← renderLine extended (OSS)
Zamowienie?         (WartoscZamowienia + ZamowienieWiersz[])     ← renderZamowienie (new)
```

Concrete serializer changes:
- **Types (`Fa3InvoiceModel`, line 89):** add optional `advancePayments?: { receivedDate; amount; fxRate? }[]` (→ `ZaliczkaCzesciowa`), `advanceInvoiceRefs?: { ksefNumber?; invoiceNumber? }[]` (→ `FakturaZaliczkowa`), `order?: { totalValue; lines: Fa3OrderLine[] }` (→ `Zamowienie`), `selfBilling?: boolean`. On `Fa3Correction` (line 75): `preCorrectionPaymentAmount?` (→ `P_15ZK`), `preCorrectionFxRate?` (→ `KursWalutyZK`). On `Fa3Line` (line 46): `ossRate?: string`, `procedure?: 'WSTO_EE'`, `fxRate?: string`. On `Fa3Annotations` (line 37): `selfBilling?: boolean`.
- **`renderLine` (253):** emit `P_12` only when the line is **not** OSS; for an OSS line omit `P_12` and emit `P_12_XII` (the destination rate decimal) + `Procedura=WSTO_EE` in XSD position (after `GTU`, before `KursWaluty`); emit `KursWaluty` when `fxRate` is set. Reuse `fa3LineVatRateValue` for `P_12`.
- **`renderVatBreakdown` (238):** add an OSS bucket (`P_13_5`+`P_14_5`, rank 5 between `5`→3 and `0`→6) emitted once regardless of how many distinct consumer rates appear; for FX, emit `P_14_xW` (PLN-converted VAT) after each Polish-rate `P_14_x`. The OSS bucket has **no** `W` variant. Extend `VAT_NET_FIELD`/`VAT_TAX_FIELD`/`VAT_FIELD_RANK` and `isMappedFa3VatRate` to accept the OSS bucket key.
- **`renderAnnotations` (278):** drive `P_17` from `annotations.selfBilling` (`'1'` when self-billed, else `'2'`); `P_18` already driven by `reverseCharge`. Element order unchanged.
- **`renderCorrection` (307):** after the `DaneFaKorygowanej` loop and before `OkresFaKorygowanej`, emit `P_15ZK` + optional `KursWalutyZK` for `KOR_ZAL`/`KOR_ROZ`.
- **New render fns:** `renderZaliczkaCzesciowa(payments)`, `renderFakturaZaliczkowa(refs)` (KSeF-number choice mirrors the KOR `NrKSeF`/`NrKSeFN` choice: KSeF-issued advance → `NrKSeFFaZaliczkowej`; outside-KSeF → `NrKSeFZN=1` + `NrFaZaliczkowej`), `renderZamowienie(order)` + `renderZamowienieWiersz(row)` (fields `NrWierszaZam, P_7Z?, P_8AZ?, P_8BZ?, P_9AZ?, P_11NettoZ?, P_11VatZ?, P_12Z?, GTUZ?, StanPrzedZ?` — `P_12Z` reuses `fa3LineVatRateValue`; block total `WartoscZamowienia`).
- **`buildFa3Xml` (333):** relax the `lines.length === 0` throw (335) when `invoiceKind ∈ {ZAL, KOR_ZAL}` and an `order` block is present (FaWiersz optional for advances); thread the new render fns in the order above.
- **`renderParty` (196):** for a UPR `Podmiot2`, allow omitting `Nazwa` + the `Adres` block (NIP-only buyer) while keeping the mandatory trailing `JST`/`GV` flags.

### Mapping helpers (`lib/fa3-mapping.ts` — modify; pure)
- `buildBuyer` (144): a UPR branch that returns a NIP-only party without throwing `buyer_required`.
- New `buildZamowienie(orderSnapshot)`, `buildAdvancePayments(snapshot)`, `buildAdvanceRefs(snapshot)`, reusing `toScaled4`/`scaled4ToMoney2dp`/`normalizeVatRate`.
- `buildVatBreakdown` (306): an OSS bucket key so OSS lines never merge into Polish-rate buckets (one `P_13_5`+`P_14_5` summary regardless of distinct consumer rates); FX → compute `P_14_xW` per Polish bucket from the resolved rate.
- `buildLines` (234): carry `ossRate`/`procedure`/`fxRate` onto OSS lines.
- `buildAnnotations` (354): map the PL-meta `self_billing` flag onto `selfBilling`; `reverse_charge` (new optional meta) onto `reverseCharge`.

### Resolvers
- **`lib/resolve-fa3-from-invoice.ts` (120–137):** replace the `document_type !== 'vat'` reject and the `currencyCode !== 'PLN'` reject with a **dispatch** on the PL-meta `invoice_kind`: `vat` → existing path; `zal` → `resolveFa3Advance` (order snapshot + received payments, P_15 = paid amount, FaWiersz optional); `roz` → `resolveFa3Settlement` (full FaWiersz + advance refs, P_15 = residual = full gross − Σ advances); `upr` → threshold check + NIP-only buyer; OSS lines (when `oss_procedure`) carry `P_12_XII` from the consumption-country rate + `KodWaluty`/`KursWaluty`. Foreign currency is accepted when a rate is resolvable.
- **`lib/resolve-fa3-from-credit-memo.ts`:** `KOR_ZAL`/`KOR_ROZ` flow from here — set `invoiceKind` from the corrected original's kind, populate `preCorrectionPaymentAmount` (P_15ZK), build the corrected `Zamowienie` (KOR_ZAL) or full `FaWiersz` (KOR_ROZ); reuse `resolveCorrectedKsefNumber` for the advance/original reference. Accept foreign currency for OSS corrections.
- New helper modules `lib/resolve-fa3-advance.ts` and `lib/resolve-fa3-settlement.ts` (or branches in the existing resolver) keep the dispatch readable.

### Validators (`data/validators.ts` — modify)
- Replace the `kind !== 'VAT' && kind !== 'KOR'` reject (107–113) with per-kind requirements: `ZAL`/`KOR_ZAL` require the `order` block (FaWiersz optional); `ROZ` requires `advanceInvoiceRefs` (FaWiersz required); `UPR` allows a NIP-only buyer and enforces the simplified-invoice threshold against `totalGross`; `KOR_ZAL`/`KOR_ROZ` require the correction block + `preCorrectionPaymentAmount`.
- Replace the `currencyCode !== 'PLN'` reject (131–137) with: accept non-PLN when an `fxRate`/`P_14_xW` source is present; still reject non-PLN with no rate. Allow an OSS line without `P_12` but with `ossRate` + `Procedura=WSTO_EE`; keep rejecting truly-unmapped Polish rates.
- Add `fa3OrderLineSchema`, `fa3OrderSchema`, `fa3AdvancePaymentSchema`, `fa3AdvanceRefSchema`; extend `fa3CorrectionSchema` with `preCorrectionPaymentAmount`/`preCorrectionFxRate`; extend `fa3LineSchema` with `ossRate`/`procedure`/`fxRate`; extend `fa3AnnotationsSchema` with `selfBilling`/`reverseCharge`; make `fa3PartySchema` UPR-aware (name/address optional when the kind is UPR).

### GTU / JPK markings (capture-only; pure-JPK)
- New constants module `lib/jpk-markings-codes.ts`: `GTU_CODES` (`GTU_01..GTU_13`), `JPK_PROCEDURE_MARKINGS` (the 12 codes), `JPK_TYP_DOKUMENTU` (`RO|WEW|FP`) — single source of truth for the entity, the API zod schema, the widget, and the future export.
- `api/ksef/invoice-meta/route.ts`: extend `invoiceMetaPutSchema` (line 67) + **both** GET projections (lines ~46–57 and the PUT response ~163–169) additively with `gtuCodes`, the procedure-marking booleans (or a `procedureMarkings` object), `typDokumentu`, `selfBilling`, `reverseCharge`, `ossProcedure`, `consumptionCountryCode`; apply each only when `!== undefined` (the `mppRequired` pattern); dedupe `gtuCodes`; keep the optimistic-lock + mutation-guard flow.
- `widgets/injection/pl-vat-meta-fields/widget.client.tsx`: a GTU checkbox grid, a procedure-marking checkbox group, a TypDokumentu select, and self-billing/OSS toggles, using existing primitives (`SwitchField` + a select), keeping the self-contained load→PUT pattern.

### Configuration (`config.ts` — modify)
- `EU_STANDARD_VAT_RATES` (country ISO → standard rate, the 27-row table), `EU_VAT_RATES_AS_OF = '2026-01'`, and an `OM_KSEF_EU_VAT_RATES` env override so a mid-year rate change can be patched without a release. Reconcile Greece `EL`/`GR`. Reduced rates are out of scope (trust the per-line sales rate; the table validates/falls back).

## Data Models

**No new entity. `sales` untouched.** New columns on `SalesInvoicePlMeta` (`data/entities.ts`, table `financial_pl_invoice_meta`), all nullable or defaulted (additive, §27):

| Column (snake_case) | Type | Purpose |
|---|---|---|
| `invoice_kind` | text, default `'vat'` | Explicit document-kind signal (`vat|zal|roz|upr|kor_zal|kor_roz`). Replaces the non-existent `document_type` read. |
| `self_billing` | boolean, default `false` | Self-billing (art. 106d) → FA(3) `P_17`. |
| `reverse_charge` | boolean, default `false` | Reverse charge → FA(3) `P_18` (feeds the existing annotation path). |
| `oss_procedure` | boolean, default `false` | OSS/WSTO_EE marker (explicit). |
| `consumption_country_code` | text, nullable | OSS destination/consumption country (ISO alpha-2). |
| `exchange_rate` | text, nullable | FX rate to PLN (when `sales` does not carry it). |
| `exchange_rate_date` | date, nullable | FX rate date (art. 31a: last working day before the tax point). |
| `advance_payments` | json, default `'[]'` | ZAL received-payment snapshots `[{ receivedDate, amount, fxRate? }]` → `ZaliczkaCzesciowa`. |
| `advance_refs` | json, default `'[]'` | ROZ prior-advance references `[{ ksefNumber?, invoiceNumber? }]` → `FakturaZaliczkowa`. |
| `order_snapshot` | json, nullable | ZAL/KOR_ZAL order data `{ totalValue, lines: [...] }` → `Zamowienie`. |
| `gtu_codes` | json, default `'[]'` | Pure-JPK: array of `GTU_01..GTU_13`. |
| `wsto_ee`, `ied`, `tp`, `tt_wnt`, `tt_d`, `mr_t`, `mr_uz`, `i_42`, `i_63`, `b_spv`, `b_spv_dostawa`, `b_mpv_prowizja` | boolean, default `false` | Pure-JPK procedure markings (one per code). |
| `doc_type` | text, nullable | Pure-JPK `TypDokumentu` (`RO|WEW|FP`). |

Migration: one additive MikroORM migration generated via `yarn db:generate` (SQL + `.snapshot-open-mercato.json`), never hand-written; no change to the `financial_pl_invoice_meta_invoice_unique` index.

## API Contracts

External (KSeF v2, consumed): unchanged — the same `/sessions/online/*` send path; the new document kinds are conveyed entirely in the FA(3) XML body.

Internal (this module — additive):
| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/ksef/invoice-meta` | `GET`/`PUT` | `financial_pl.manage` | Extended with `invoiceKind`, `selfBilling`, `reverseCharge`, `ossProcedure`, `consumptionCountryCode`, `exchangeRate`/`exchangeRateDate`, `advancePayments`/`advanceRefs`/`orderSnapshot`, `gtuCodes`, the 12 procedure booleans, `typDokumentu`. Org/tenant-scoped, zod-validated, optimistic-locked (existing flow). |

The send routes (`…/ksef/submissions/from-invoice`, `…/from-credit-memo`) are unchanged; the document kind is resolved from PL-meta, transparent to callers.

## Internationalization (i18n)
New keys (en + pl + de + es, mirroring the existing set, sorted per the `i18n:check-sync` gate):
- Errors: `financial_pl.errors.advance_data_required`, `financial_pl.errors.settlement_refs_required`, `financial_pl.errors.upr_threshold_exceeded`, `financial_pl.errors.oss_country_required`, `financial_pl.errors.oss_rate_required`, `financial_pl.errors.exchange_rate_required`, `financial_pl.errors.precorrection_amount_required`.
- Field labels + help text (brochure-sourced): `financial_pl.fields.invoiceKind`, `…fields.selfBilling`, `…fields.reverseCharge`, `…fields.ossProcedure`, `…fields.consumptionCountry`, `…fields.gtu.GTU_01`…`GTU_13`, `…fields.procedure.WSTO_EE`…`B_MPV_PROWIZJA`, `…fields.typDokumentu`.

## UI/UX
No new pages. The existing `pl-vat-meta-fields` injection widget on the sales-invoice page gains: an `invoiceKind` select; self-billing / reverse-charge / OSS toggles; a consumption-country select (shown when OSS); a GTU checkbox grid; a procedure-marking checkbox group; a TypDokumentu select. Advance/settlement snapshots are set by the issuing flow (operator-facing UI for the ZAL→ROZ chain builder is a follow-up; the API accepts the snapshots now). The invoice PDF (SPEC-008) already labels KOR_ZAL/KOR_ROZ as a correction (`invoice-pdf-model.ts:105`); a follow-up can add advance/settlement-specific labels.

## Configuration
No new required env vars. New optional: `OM_KSEF_EU_VAT_RATES` (JSON override for the EU standard-rate table). New per-invoice PL-meta fields (above). The EU rate table ships with `EU_VAT_RATES_AS_OF = '2026-01'` and a maintenance note to re-verify each fiscal year.

## Migration & Compatibility
One additive, defaulted migration on `financial_pl_invoice_meta` (generated). Backward-compatible: `invoice_kind` defaults to `'vat'`, so every existing invoice follows the unchanged VAT path; all new flags default false/empty; the `superRefine` change only *widens* acceptance (previously-rejected kinds/currencies now resolve) and keeps rejecting genuinely-unsupported combinations with a clearer, localized 422. The serializer changes are purely additive emissions gated on the new optional model fields — a VAT/KOR document serializes byte-identically to today. No public API field is removed or renamed.

## Implementation Plan

### Phase 1 — Data model + capture (no FA(3) change)
1. `SalesInvoicePlMeta` new columns; `yarn db:generate` (migration + snapshot, reviewed).
2. `lib/jpk-markings-codes.ts` constants; extend `api/ksef/invoice-meta/route.ts` (schema + both projections); extend the `pl-vat-meta-fields` widget; i18n field keys.
3. Unit tests for the meta API + widget payload.

### Phase 2 — Self-billing + FA(3)-native annotations
1. `renderAnnotations` P_17 from `selfBilling`; `buildAnnotations` maps `self_billing`/`reverse_charge`; `fa3AnnotationsSchema` extended.
2. Serializer + mapping unit tests.

### Phase 3 — Advanced document types (ZAL/ROZ/UPR/KOR_ZAL/KOR_ROZ)
1. Serializer: new render fns + XSD-order threading + UPR `renderParty` + correction-tail `P_15ZK`/`KursWalutyZK`; relax the zero-line throw for ZAL.
2. Mapping: `buildZamowienie`/`buildAdvancePayments`/`buildAdvanceRefs`, UPR `buildBuyer` branch.
3. Validators: per-kind requirements; new sub-schemas; UPR threshold.
4. Resolvers: dispatch on `invoice_kind`; `resolveFa3Advance`/`resolveFa3Settlement`; KOR_ZAL/KOR_ROZ in the credit-memo resolver.
5. Unit tests: each block + XSD order; the advance→settlement netting (`P_15` residual = full gross − Σ advances); UPR NIP-only + threshold; **flip** the existing `resolve-fa3-from-invoice.test.ts` expectation that ZAL/ROZ are rejected.

### Phase 4 — Full OSS / WSTO_EE + foreign currency
1. `config.ts` EU rate table + `asOf` + env override.
2. Serializer: OSS line (`P_12_XII`/`Procedura`/omit `P_12`), OSS summary bucket (`P_13_5`/`P_14_5`, no `W`), FX `P_14_xW` + per-line `KursWaluty`.
3. Mapping: OSS bucket key + FX `P_14_xW` math.
4. Resolvers + validators: OSS dispatch (explicit marker), FX acceptance with rate.
5. Unit tests: pure-OSS EUR invoice, mixed PL+OSS invoice (both summary buckets in XSD order), FX `P_14_xW` rounding, OSS-without-marker rejection.

### Phase 5 — Live verification
Extend `lib/__tests__/ksef-live.test.ts` (env-gated): a ZAL round-trip, a ROZ referencing the accepted ZAL, a UPR, a self-billed invoice, and an OSS EUR invoice; capture KSeF numbers + UPO.

### File Manifest
| File | Action | Purpose |
|------|--------|---------|
| `data/entities.ts` | Modify | New `SalesInvoicePlMeta` columns (invoice_kind, self/reverse/OSS/FX, advance snapshots, GTU/procedures/doc_type). |
| `migrations/*` + `migrations/.snapshot-open-mercato.json` | Create (generated) | Additive migration via `yarn db:generate`. |
| `lib/fa3.ts` | Modify | New render fns + XSD-order threading; OSS line/summary; P_17 self-billing; correction-tail P_15ZK/KursWalutyZK; UPR NIP-only party; relax zero-line throw. |
| `lib/fa3-mapping.ts` | Modify | `buildZamowienie`/`buildAdvancePayments`/`buildAdvanceRefs`; UPR `buildBuyer`; OSS bucket + FX `P_14_xW`; `buildAnnotations` self/reverse. |
| `lib/resolve-fa3-from-invoice.ts` | Modify | Dispatch on `invoice_kind`; OSS + FX acceptance; ZAL/ROZ/UPR. |
| `lib/resolve-fa3-advance.ts`, `lib/resolve-fa3-settlement.ts` | Create | ZAL / ROZ resolution helpers. |
| `lib/resolve-fa3-from-credit-memo.ts` | Modify | KOR_ZAL/KOR_ROZ + OSS corrections. |
| `data/validators.ts` | Modify | Per-kind requirements; OSS/FX; new sub-schemas; UPR-aware party. |
| `lib/jpk-markings-codes.ts` | Create | GTU/procedure/TypDokumentu constants. |
| `config.ts` | Modify | EU standard-rate table + `asOf` + `OM_KSEF_EU_VAT_RATES`. |
| `api/ksef/invoice-meta/route.ts` | Modify | Extend schema + both projections. |
| `widgets/injection/pl-vat-meta-fields/widget.client.tsx` | Modify | GTU/procedure/TypDokumentu + kind/OSS/self-billing UI. |
| `i18n/{en,pl,de,es}.json` | Modify | Error + field keys (4 locales). |
| `lib/__tests__/*`, `data/__tests__/*` | Create/Modify | Serializer/resolver/validator/mapping unit coverage; flip the ZAL/ROZ-rejected expectation. |
| `__integration__/TC-KSEF-007.spec.ts` | Create | Advanced doc-types + self-billing + OSS + GTU/JPK HTTP contract. |
| `lib/__tests__/ksef-live.test.ts` | Modify | ZAL→ROZ chain, UPR, self-billing, OSS live round-trips (env-gated). |

## Risks & Impact Review

### Data Integrity Failures
- **OSS misclassification** (domestic billed as OSS or vice-versa) → wrong VAT field (`P_13_5/P_14_5` vs `P_13_x`), wrong return. **Severity: High → mitigated** by an explicit `oss_procedure` marker (never inference) + per-line `P_12_XII` from the sales rate validated against the EU table. Residual: operator must set the marker correctly.
- **Wrong P_15 on ZAL/ROZ** (paid amount vs residual) → mis-stated amount due. **Severity: High → mitigated** by computing both with the existing BigInt money math and a reconciliation invariant (`ROZ P_15 = full gross − Σ advances`; `ZAL P_15 = Σ P_15Z`) asserted in unit tests.
- **FX PLN-conversion mismatch** (`P_14_xW`) → KSeF 450/validation rejection. **Severity: Medium → mitigated** by reusing the BigInt helpers + a deterministic resolved rate; rounding to 2dp.
- **UPR over threshold with NIP-only buyer** → substantively incorrect invoice. **Severity: Medium → mitigated** by enforcing the ≤ 450 PLN / 100 EUR threshold in the validator before emitting NIP-only.

### Cascading Failures & Side Effects
- **XSD sequence drift** when threading new blocks → 450 rejection. **Severity: High → mitigated** by serializer tests asserting exact element order; the document is re-validated against the XSD before a production send.
- **Stale EU rate table** → wrong `P_12_XII` if used as the source. **Severity: Medium → mitigated** by trusting the per-line sales rate first; table is dated config with override + mismatch warning.

### Tenant & Data Isolation Risks
- All new reads/writes are `(tenantId, organizationId)`-scoped via the query engine and the meta API's existing scope guards; PL-meta is FK-id-linked only (no cross-module ORM relation). No cross-org surface.

### Migration & Deployment Risks
- Additive defaulted columns only; `invoice_kind='vat'` default makes existing orgs unaffected. No narrowing.

### Operational Risks
- The advance→settlement chain depends on operator-supplied snapshots; an incomplete snapshot fails the per-kind validator with a localized 422 rather than a malformed filing.

### Risk Register

#### OSS classified incorrectly
- **Severity**: High → mitigated.
- **Mitigation**: explicit `oss_procedure` + `consumption_country_code`; never inferred from buyer country + numeric rate; per-line rate validated against the EU table.
- **Residual**: operator-set marker correctness; surfaced via the meta widget.

#### Advance/settlement netting wrong (P_15)
- **Severity**: High → mitigated.
- **Mitigation**: BigInt money math; reconciliation invariants asserted in unit tests; FaWiersz shows full values on ROZ, residual nets through P_15.
- **Residual**: None material once snapshots are correct.

#### XSD sequence rejection (new blocks)
- **Severity**: High → mitigated.
- **Mitigation**: serializer tests pin element order; XSD re-validation before production send; KSeF records (not masks) any 450.
- **Residual**: Full proof requires the live round-trip (handoff item).

#### Stale EU VAT-rate table
- **Severity**: Medium → mitigated.
- **Mitigation**: dated config + `OM_KSEF_EU_VAT_RATES` override; per-line sales rate trusted first; mismatch warning.
- **Residual**: rate must be re-verified each fiscal year (documented).

#### Foreign-currency rate sourcing
- **Severity**: Medium → mitigated (with an open question).
- **Mitigation**: accept FX only when a rate is resolvable (PL-meta `exchange_rate` or a future NBP fetch) and `P_14_xW` is computable; reject otherwise with `exchange_rate_required`.
- **Residual**: the authoritative rate source is an Open Question for the owner.

## Final Compliance Report — 2026-06-28

### AGENTS.md Files Reviewed
- `AGENTS.md` (root, official-modules) · `.ai/specs/AGENTS.md` · `ARCHITECTURE.md` (§11 UMES, §27 BC, §31 checklist) · core `packages/core/.../sales` (read-only, for the query-engine entity ids).

### Compliance Matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | PL-meta extension is FK-id only; sales read via query engine. |
| root AGENTS.md | Filter by organization_id (+ tenant) | Compliant | All reads/writes org+tenant-scoped. |
| root AGENTS.md | Never modify core packages | Compliant | `sales`/core read-only; all changes in `financial_pl`. |
| root AGENTS.md | Never hand-write migrations | Compliant | One generated migration (`yarn db:generate`). |
| root AGENTS.md | zod-validate all API inputs | Compliant | Meta API + FA(3) schema zod-validated. |
| root AGENTS.md | No `any` / no hardcoded user strings | Compliant | `z.infer` types; i18n keys in 4 locales. |
| ARCHITECTURE §27 | Backward-compatibility (additive only) | Compliant | Defaulted columns; `superRefine` only widens; serializer additive. |
| ARCHITECTURE §11 | UMES injection for cross-module UI | Compliant | Meta fields via the existing field-injection widget. |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | New PL-meta columns back the meta API + the resolver dispatch. |
| API contracts match UI/UX | Pass | Meta widget surfaces every captured field. |
| Risks cover all write operations | Pass | Doc-type emission, OSS, FX, netting, capture covered. |
| Commands/serializer defined for all kinds | Pass | All seven `RodzajFaktury` values resolvable + serializable. |

### Verdict
- **Compliant** — approved for implementation pending the spec-stage cross-model jury.

## Integration Test Coverage
- **TC-KSEF-007** (new, Playwright): `…/ksef/invoice-meta` PUT/GET round-trip for `invoiceKind`, `selfBilling`, `ossProcedure`/`consumptionCountryCode`, `gtuCodes`, the procedure-marking booleans, `typDokumentu` (401 anon, 403 without `manage`, 400 invalid GTU/kind, 200 shape with the new fields echoed); `…/submissions/from-invoice` for an OSS-marked and a ZAL-marked invoice (validation contract: accepted-shape or a clear 422 with the new error codes, no live KSeF).
- **Unit:** `fa3.test.ts` (each new block + exact XSD order; OSS line/summary; P_17; correction-tail), `fa3-mapping.test.ts` (Zamowienie/advance/OSS bucket/FX `P_14_xW`/UPR buyer), `validators.test.ts` (per-kind requirements; OSS-without-marker; UPR threshold; FX-without-rate), `resolve-fa3-from-invoice.test.ts` (dispatch; ZAL/ROZ no-longer-rejected; netting invariant), `resolve-fa3-from-credit-memo.test.ts` (KOR_ZAL/KOR_ROZ), invoice-meta API test (new fields).
- **Live (`ksef-live.test.ts`, env-gated):** ZAL → ROZ chain, UPR, self-billed, OSS EUR round-trips (user-supplied TEST credentials).

## Open Questions
1. **OSS country-rate maintenance source.** Is the authoritative per-line OSS rate the sales module's computed rate, or must the connector own/refresh the EU standard-rate table (and from where — Tax Foundation, an MF feed, a tenant-maintained list)? The spec trusts the sales rate first with the dated table as fallback/validation, but the maintenance owner of the table must be decided.
2. **Simplified-invoice (UPR) threshold currency.** 450 PLN vs 100 EUR — which applies, and for an EUR invoice is the threshold compared in EUR (≤ 100) or PLN-converted? The connector currently only fully supports PLN; the EUR path arrives with OSS FX.
3. **Foreign-currency exchange-rate source.** Does the `sales` invoice carry the rate, or must the connector fetch NBP table A (art. 31a: last working day before the tax point)? `KursWaluty` + `P_14_xW` both depend on a deterministic rate.
4. **ZAL→ROZ data source.** Confirm the snapshot approach (operator/issuing-flow sets `advance_payments`/`advance_refs`/`order_snapshot` on PL-meta) vs querying `sales_payments`/`sales_order_line` — the latter has no "advance" flag today, so a product decision is needed on whether to add an issuing-flow UI/command that builds the snapshots.
5. **Submission `document_kind` enum for ZAL/ROZ.** `KsefSubmission.documentKind` is `'invoice' | 'credit_memo'`; do ZAL/ROZ submit under `'invoice'` (recommended — they are not corrections) or need new kinds for reporting?
6. **OSS corrections (KOR with P_13_5/P_14_5 difference).** In scope via KOR_ROZ/KOR_ZAL FX, or a dedicated follow-up?

## Spec-stage cross-model review — 2026-06-28
Jury run on this spec (artifact mode, spec-review rubric). **DeepSeek V4 Pro (max): fail — 2 High**, both reconciled into binding design deltas; **Codex (gpt-5.5) & Kimi K2.7: skipped** (CLI not installed). `cross-model (spec): confirmed (deepseek); codex + kimi skipped (CLI absent)`.

1. **(High) FX requirement over-restricts pure OSS → RESOLVED.** A non-PLN invoice requires a resolvable exchange rate **only when it carries Polish-rate (domestic) buckets** that need the PLN-converted `P_14_xW` (art. 106e ust. 11). A **pure-OSS** foreign-currency invoice (no domestic-rate lines) needs **no** exchange rate and MUST be accepted without one. Validator/resolver: require `exchange_rate` iff `(currency ≠ PLN) AND (any non-OSS/Polish-rate bucket present)`; otherwise accept FX without a rate.
2. **(High) OSS corrections were an open question → now IN SCOPE.** A KOR correcting an OSS invoice flows through the existing credit-memo resolver carrying the OSS line fields (`P_12_XII`, `Procedura=WSTO_EE`), the OSS summary buckets (`P_13_5`/`P_14_5`), and FX — i.e. the OSS serialization is shared by the invoice and the KOR path. `resolve-fa3-from-credit-memo.ts` reads the OSS PL-meta of the corrected invoice (or the credit memo's own meta) and emits negated OSS differences; `KOR_ZAL`/`KOR_ROZ` additionally carry the correction-tail. OSS corrections are covered by the standard KOR path, not deferred.

Notes folded in: per-document-type **full-XML snapshot tests** (assert the entire generated `<Fa>` for VAT/ZAL/ROZ/UPR/OSS, not just field presence) to lock XSD sequence order; **UPR threshold = 450 PLN** (an EUR/OSS invoice is PLN-converted via the resolved rate for the threshold check, or compared ≤100 EUR when no rate is resolvable for a pure-OSS EUR document); the credit-memo `invoiceKind` is derived from the corrected original's PL-meta kind and a 422 (`original_not_accepted`/`original_ksef_number_unknown`) is raised when the original is absent/non-accepted (existing `resolveCorrectedKsefNumber` guard); `invoice_kind` stays a `text` column validated at the zod/API boundary (consistent with the existing text columns; no DB-level enum); GTU/procedure cross-field constraints are enforced at JPK-export time (out of scope) with the capture API rejecting only structurally-invalid codes.

## Changelog
### 2026-06-28 — SPEC-009 initial
- Added FA(3) advanced document types (ZAL/ROZ/UPR/KOR_ZAL/KOR_ROZ incl. the advance→settlement chain), self-billing via `Adnotacje/P_17`, full OSS/WSTO_EE (`P_12_XII`, `P_13_5`/`P_14_5`, `Procedura=WSTO_EE`, foreign currency with `KursWaluty`/`P_14_xW`), and GTU_01..13 + the JPK procedure markings + TypDokumentu as pure-JPK PL-meta fields. One additive PL-meta migration; the seven-value `invoiceKind` enum gates lifted from blanket-reject to per-kind checks; no core change, no `sales` change, backward-compatible (`invoice_kind` defaults to `vat`).
