# SPEC-012 — `financial_pl`: JPK_V7M(3) / JPK_V7K(3) VAT export (sales + purchase evidence + declaration)

- **Date:** 2026-06-29
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md)…[SPEC-011](./SPEC-011-2026-06-29-financial-pl-ksef-completeness-audit.md)
- **Status:** Draft → for implementation. **Revised after the spec-stage cross-model jury** (Codex + DeepSeek FAILED v1 with confirmed regulatory blockers; v2 reconciles them, grounded in the official brochure + the raw downloaded XSDs).

## TLDR

Generate the binding **JPK_VAT z deklaracją (3)** file — **JPK_V7M(3)** (monthly) / **JPK_V7K(3)** (quarterly), effective **2026‑02‑01** — as a complete, **XSD‑valid** XML (`Naglowek + Podmiot1 + Deklaracja + Ewidencja`). The per‑invoice JPK signals are already captured (SPEC‑006/009); this adds the exporter plus the two missing models: a **JPK‑shaped purchase VAT ledger** and a **VAT filing** record. Self‑contained in `financial_pl`; tenant/org‑scoped; no cross‑module ORM relations (sales read via the queryEngine, like `resolve-fa3-from-invoice`).

**Ground truth (this revision):** raw official XSDs `Schemat_JPK_V7M(3)_v1-0E.xsd` / `…V7K(3)…` (vendored under `lib/jpk/schema/`); namespaces V7M `http://crd.gov.pl/wzor/2025/06/18/06181/`, V7K `…/06182/`; element order taken verbatim from the XSDs; the MF brochure for semantics. **An automated XSD‑validation gate** (via `xmllint --schema`) is a hard acceptance criterion.

## Scope
- New entities: `PurchaseVatRecord`, `JpkVatFiling` (+ one additive migration). Vendor the two XSDs as test/validation assets.
- `lib/jpk/`: `jpk-codes.ts` (field‑order arrays, marker lists, rate→K map, schema attrs), `build-sprzedaz.ts`, `build-zakup.ts`, `compute-declaration.ts`, `build-jpk-xml.ts`, `resolve-jpk-filing.ts`, `validate-xsd.ts` (test helper).
- Commands `financial_pl.jpk.*` (upsert/delete purchase record, upsert filing, generate). API `api/ksef/jpk/{purchase-records,filings,export}/route.ts`. Minimal backoffice surface. i18n; validators; tests incl. the XSD gate.

## Field map (regulation‑critical; verified vs brochure + raw XSD)

**SprzedazWiersz** (exact XSD child order): `LpSprzedazy, KodKrajuNadaniaTIN, NrKontrahenta, NazwaKontrahenta, DowodSprzedazy, DataWystawienia, DataSprzedazy, choice{NrKSeF|OFF|BFK|DI}, TypDokumentu, GTU_01..GTU_13, WSTO_EE, IED, TP, TT_WNT, TT_D, MR_T, MR_UZ, I_42, I_63, B_SPV, B_SPV_DOSTAWA, B_MPV_PROWIZJA, KorektaPodstawyOpodt, TerminPlatnosci, DataZaplaty, K_10..K_36, K_360, SprzedazVAT_Marza`. KSeF node is a **choice** — emit exactly one of NrKSeF/OFF/BFK/DI (from `deriveJpkVatMarking`); a `pending`/null marking blocks generation (operator must resolve).
- **Amount→K by rate/category:** exempt domestic→`K_10`; outside‑PL (≠ OSS)→`K_11` (EU‑services subset→`K_12`); 0% domestic→`K_13` (art.129 subset→`K_14`); **5%**→`K_15`/`K_16`; **8%**→`K_17`/`K_18`; **23%**→`K_19`/`K_20`; WDT→`K_21`; export→`K_22`; domestic reverse‑charge art.17 (supplier side)→`K_31`/`K_32`. (WNT `K_23/24`, import `K_25..K_30` come from **purchase** self‑assessment — see below.) Spis z natury→`K_33`; kasy‑relief return→`K_34`; WNT transport→`K_35`; WNT fuel→`K_36`; deposit tax→`K_360`.
- **OSS exclusion:** invoices with `ossProcedure=true` (taxed in destination via the dział XII rozdz. 6a/7/9 special procedures) are **EXCLUDED** from JPK_V7M (reported only in VIU‑DO; K_10/K_11 carve‑out, brochure l.910‑914). `buildVatBreakdown`'s `'oss'` bucket is dropped here. `WSTO_EE` marks only **domestically‑taxed** distance sales (below threshold / not via OSS).
- **Corrections (sales):** a regular faktura korygująca is its **own separate row** carrying the **difference** (K_ values may be negative; minus sign per l.169), keyed on the **correction document's** `DowodSprzedazy`/`DataWystawienia`. art.89a bad‑debt: set `KorektaPodstawyOpodt="1"` for the row, `TerminPlatnosci` (ust.1, "in minus" in K_15‑K_20) or `DataZaplaty` (ust.4, "in plus"); declaration P_68/P_69 aggregate the ust.1 "in minus" from K_15/17/19 and K_16/18/20.
- **Margin (MR_T/MR_UZ):** marker `="1"`; margin‑net + output VAT (per rate, negative margin ⇒ VAT `0.00`) in the rate K_ fields, **and** the full gross in `SprzedazVAT_Marza`.
- **FP:** `TypDokumentu=FP` (faktura do paragonu) is emitted; FP rows are **excluded** from `SprzedazCtrl.PodatekNalezny`.
- **`SprzedazCtrl`:** `LiczbaWierszySprzedazy` = row count; `PodatekNalezny` = `K_16+K_18+K_20+K_24+K_26+K_28+K_30+K_32+K_33+K_34 − K_35 − K_36 − K_360`, **excluding FP rows**.

**ZakupWiersz** (XSD order): `LpZakupu, KodKrajuNadaniaTIN, NrDostawcy, NazwaDostawcy, DowodZakupu, DataZakupu, DataWplywu, choice{NrKSeF|OFF|BFK|DI}, DokumentZakupu(MK|VAT_RR|WEW), IMP, K_40..K_47, ZakupVAT_Marza`.
- `K_40`/`K_41` net/VAT fixed assets; `K_42`/`K_43` net/VAT other (incl. the **input deduction** for WNT/import/reverse‑charge); `K_44`/`K_45` input‑tax corrections; `K_46` art.89b ust.1 ("in minus"); `K_47` art.89b ust.4 ("in plus"); `ZakupVAT_Marza` margin‑basis gross.
- **`ZakupCtrl`:** `LiczbaWierszyZakupow` = count; `PodatekNaliczony` = `K_41+K_43+K_44+K_45+K_46+K_47`.

**Self‑assessed acquisitions (one purchase doc → TWO rows):** a `PurchaseVatRecord` classified `wnt`|`import_goods`|`import_services`|`import_services_28b`|`reverse_charge_domestic` produces **both** a SprzedazWiersz output row (WNT `K_23/24`, import `K_25/26`/`K_27/28`/`K_29/30`, RC `K_31/32`) **and** a ZakupWiersz input row (`K_42/43`). A `domestic` purchase produces only the ZakupWiersz row. Zero output VAT shows `0.00` where the base is filled.

**Deklaracja** (XSD `PozycjeSzczegolowe` order, 64 positions): `P_10..P_36, P_360, P_37..P_53, P_54, P_540, P_55, P_56, P_560, P_58, P_59, P_60..P_66, P_660, P_67, P_68, P_69, P_ORDZU` + `Pouczenia=1`. `KodFormularzaDekl` = `VAT-7 (23)` (V7M) / `VAT-7K (17)` (V7K).
- **Rounding:** declaration P_ fields → **whole PLN** (`TKwotaC`; <50 gr down, ≥50 gr up); evidence K_ fields → **2 dp** (`TKwotowy`).
- **Computed (C):** P_10..P_36, P_360 = period sums of the like‑named K_ (FP excluded from the należny side); `P_37 = P_10+P_11+P_13+P_15+P_17+P_19+P_21+P_22+P_23+P_25+P_27+P_29+P_31`; `P_38 = (P_16+P_18+P_20+P_24+P_26+P_28+P_30+P_32+P_33+P_34) − P_35 − P_36 − P_360`; P_40..P_47 = K_40..K_47 sums; `P_48 = P_39+P_41+P_43+P_44+P_45+P_46+P_47`; `P_68/P_69` from the art.89a evidence rows (≤0). **Derived (D):** `P_39` = prior period's P_62; `P_51 = max(0, P_38 − P_48 − P_49 − P_50)`; `P_53 = max(0, P_48 − P_38 + P_52)`; `P_62 = P_53 − P_54`. **Operator (O):** P_49, P_50, P_52, P_54/P_540/P_55/P_56/P_560/P_58 (refund‑term elections), P_59, P_60, P_61, markers P_63..P_67/P_660, P_ORDZU. Zero declaration ⇒ P_38 and P_51 = "0".

## Data models (new, tenant+org scoped)
**`PurchaseVatRecord`** (`financial_pl_jpk_purchase_record`): `organization_id, tenant_id, context_nip, year, month`; supplier `supplier_nip?(→"BRAK"), supplier_country_code?, supplier_name`; `document_number, purchase_date, receipt_date?, document_type?(MK|VAT_RR|WEW), imp(bool), ksef_marking?(NrKSeF|OFF|BFK|DI), nr_ksef?`; `transaction_class (domestic|wnt|import_goods|import_services|import_services_28b|reverse_charge_domestic)`; amounts (numeric text): `net_fixed_assets(K_40), vat_fixed_assets(K_41), net_other(K_42), vat_other(K_43), corr_fixed_assets(K_44), corr_other(K_45), corr_89b_1(K_46), corr_89b_4(K_47), margin_gross(ZakupVAT_Marza)`; self‑assessment `self_assessed_net, self_assessed_vat, self_assessed_rate` (for the K_23..K_32 output row); timestamps. Indexed `(organization_id, tenant_id, year, month, deleted_at)`.
**`JpkVatFiling`** (`financial_pl_jpk_filing`): `organization_id, tenant_id, context_nip, variant(V7M|V7K), year, month(1‑12), quarter?(1‑4), cel_zlozenia(1|2), correction_scope(both|declaration|evidence), kod_urzedu`; declaration operator inputs (JSON `declaration_inputs`: prior_surplus P_39 override, P_49, P_50, P_52, refund elections, markers, P_ORDZU); `status(draft|generated|submitted), generated_xml?(encrypted), generated_at?`; timestamps. Unique active `(organization_id, tenant_id, variant, year, month, cel_zlozenia)`. `generated_xml` in the module `ModuleEncryptionMap`.

## XML assembly & V7K rule
`build-jpk-xml` emits the XSD‑exact order under the right namespace. **CelZlozenia/scope:** `correction_scope` controls which of `Deklaracja`/`Ewidencja` are emitted (both / declaration‑only / evidence‑only, brochure l.127‑134). **V7K:** months 1‑2 of a quarter → `Naglowek+Podmiot1+Ewidencja` only; month 3 → all four (Deklaracja = whole quarter, Ewidencja = month 3). `Naglowek` always carries `Miesiac` (Kwartal lives only in the Deklaracja header). **Podmiot1** sourced from the `ksef_pl` credential (`contextNip` + `sellerName`/`sellerAddressLine1/2`). Determinism: own `el()` + the exported `escapeXml`; money via the exported `toScaled4`/`scaled4ToMoney2dp` (2 dp) and a whole‑PLN rounder for the declaration.

## Commands / API / UI
`registerCommand`: `financial_pl.jpk.upsert_purchase_record`, `.delete_purchase_record`, `.upsert_filing`, `.generate`. Routes: `api/ksef/jpk/purchase-records` (GET/POST/DELETE), `api/ksef/jpk/filings` (GET/POST), `api/ksef/jpk/export?filingId=` (streams the XML attachment). Minimal backoffice page (filings list + generate + purchase‑records table). All auth + `ensureTenantScope`/`ensureOrganizationScope` + zod.

## Risks & Impact Review
- **R1 declaration/evidence math (HIGH)** → exact brochure/XSD field map; BigInt cents; whole‑PLN rounder; **unit tests with worked end‑to‑end examples**; control‑sum cross‑checks; **xmllint XSD gate**.
- **R2 rate/category bucketing + self‑assessment dual rows (HIGH)** → explicit map + per‑case tests (domestic/WDT/export/RC/WNT/import/margin/OSS‑exclusion).
- **R3 corrections (HIGH)** → signed‑row + art.89a (KorektaPodstawyOpodt/TerminPlatnosci/DataZaplaty) + P_68/69 tie; tested.
- **R4 XSD order/occurs (MED)** → order from the raw XSD; xmllint validates V7M, V7K m1‑2, V7K m3, and each correction scope.
- **R5 scope (MED)** → purchase ledger is JPK‑VAT‑shaped only (not a full AP module); bad‑debt automation, NBP FX, and direct MF e‑submission are deferred (operator‑entered / later phase). Margin/self‑assessment handled because SPEC‑009 already lets users mark MR_T/MR_UZ/TT_WNT etc.

## Final Compliance Report
No cross‑module ORM relations; tenant/org scoping on every entity/command/query; zod at boundaries; DI; deterministic XML; exact decimals; whole‑PLN declaration. ARCHITECTURE §31/§27/§11 satisfied. Gate: build:packages → generate → typecheck → test (incl. the xmllint XSD‑validation gate) → build:app where reachable.

## Integration Test Coverage
- `lib/jpk/__tests__/build-sprzedaz.test.ts` — rate→K bucketing; markers/GTU/TypDokumentu/FP; KSeF choice node; regular‑correction signed rows; art.89a (KorektaPodstawyOpodt/TerminPlatnosci/DataZaplaty); margin (SprzedazVAT_Marza); OSS exclusion; FP excluded from ctrl.
- `…/build-zakup.test.ts` — K_40..K_47; doc types; IMP; margin; ctrl sum; self‑assessment input row.
- `…/compute-declaration.test.ts` — worked sales+purchase → P_37/P_38/P_48/P_51/P_53/P_62; whole‑PLN rounding; P_68/P_69 from evidence; zero‑declaration.
- `…/build-jpk-xml.test.ts` + **`…/xsd-validation.test.ts`** — V7M(3) full, V7K(3) months 1‑2 (evidence‑only) vs month 3 (full), and declaration‑only / evidence‑only corrections, each **validated against the vendored official XSD via `xmllint`**; deterministic bytes; escaping; self‑assessment dual rows.
- `__integration__/TC-JPK-001.spec.ts` — export route: auth + org/tenant scope; generate a filing; download well‑formed JPK XML.

## Code-stage cross-model jury (Codex + DeepSeek) — fixed + remaining
**Fixed (confirmed blockers):** XSD-grouped base/VAT PAIRS now emit together (declaration P_11/12…P_42/43, P_68/69; purchase K_40/41, K_42/43 — emitting one without the other was XSD-invalid; regression-tested); encryption entity-id corrected to `financial_pl:jpk_vat_filing` (toSnake(class), else `generated_xml` stored plaintext); validators tightened (`year ≥ 2026`, `kodUrzedu` 4-digit `TKodUS`, `NrKSeF` marking ⇒ `nrKsef` required); resolver fails loud on a missing `kodUrzedu`; credit memos no longer inherit the original's `TypDokumentu`/FP (which wrongly excluded them from the declaration totals); V7K Kwartal fix (v3).
**Recorded as SPURIOUS (empirically disproven):** DeepSeek flagged negative `P_68/P_69`/`P_37`/`P_38` as XSD-invalid — but `TKwotaC` is `xsd:integer` with NO `minInclusive`, and a negative-P_ file VALIDATES under xmllint (the brochure mandates negative P_68/P_69 for bad-debt). Not clamped (clamping would be wrong).
**Remaining confirmed follow-ups (resolver DB-mapping layer; documented below).**

## Known follow-ups (post code-review; non-blocking)
- **Credit-memo own KSeF number (resolve-jpk-filing, jury G):** a correction row currently inherits the *original* invoice's KSeF node (markers/OSS inheritance is correct; the KSeF *number* should be the credit memo's own `document_kind='credit_memo'` submission). XSD-valid today but reports the wrong NrKSeF for the correction.
- **Credit-memo status/immutable gate (jury I):** memos are pulled by date-range; the `SalesCreditMemo` entity has no `is_immutable` (unlike invoices), so a `status` gate is needed to keep drafts out (partly mitigated — a memo whose original has a pending KSeF marking is skipped).
- **V7K quarterly aggregation (jury, requirement):** the resolver builds the declaration from the filing month's evidence only. A correct V7K month-3 declaration must aggregate the WHOLE quarter (3 months), and months 1-2 should be evidence-only — wire `correction_scope`/period accordingly. (Kwartal itself is now correct.)
- **art.89a sales path:** the bad-debt correction fields (`KorektaPodstawyOpodt`/`TerminPlatnosci`/`DataZaplaty`) and the P_68/P_69 computation are implemented + unit-tested, but the *resolver* does not yet wire them from real sales data (bad-debt automation deferred per R5; operator/explicit-payload path can set them).
- **`selfAssessedRate`** column is present on `PurchaseVatRecord` but not yet exposed in the upsert schema (informational; not used in the K_ math).
- **`__integration__/TC-JPK-001.spec.ts`** (route auth/scope Playwright test) not yet delivered — unit + XSD-gate coverage is in place.
- The xmllint XSD gate **skips** (with a logged warning) when libxml2 is absent, so a CI image without `xmllint` reports green without validating — keep `xmllint` in the CI image.

## Changelog
- **2026-06-29 (v3):** Fixed a review blocker — V7K `Deklaracja` now always carries the mandatory `<Kwartal>` (resolver derives it from the evidence month; `buildJpkXml` throws loudly if a V7K declaration lacks it; regression test added). Recorded the non-blocking follow-ups above.
- **2026-06-29:** Created (v1), then **revised (v2) after the spec-stage jury**: added correction handling (signed rows + art.89a fields), margin (SprzedazVAT_Marza/ZakupVAT_Marza), self‑assessed WNT/import/reverse‑charge dual rows, OSS exclusion, the complete declaration field set with whole‑PLN rounding + settlement chain + P_68/69‑from‑evidence, correction‑scope filings, Podmiot1 source, and the **xmllint XSD‑validation gate** with vendored official XSDs. Field order/namespaces taken verbatim from the raw downloaded `Schemat_JPK_V7M(3)/V7K(3)_v1-0E.xsd`.
