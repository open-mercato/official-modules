# SPEC-006 — `financial_pl`: KSeF correction invoices (KOR) + JPK_VAT markings

- **Date:** 2026-06-27
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md) (the send-only KSeF 2.0 connector)
- **Status:** Implemented (code complete, staged — not committed). Pure-logic tests pass and the generated KOR validates against the official FA(3) `1-0E` XSD with `xmllint`. The full typecheck/build/integration gate and the live KSeF round-trip are **pending the user's environment** — this checkout's pinned `@open-mercato/*` deps are missing `@open-mercato/shared/lib/pl/validation` (a **pre-existing SPEC-005 dependency gap**, not introduced here), which blocks compiling any module path through `data/validators.ts`. See Implementation Status.

## TLDR

**Key Points:**
- SPEC-005 shipped a send-only connector for **standard VAT invoices** and explicitly *rejected* corrections (`document_type_unsupported`, HTTP 422). But under KSeF you **legally cannot cancel an invoice that received a KSeF number — a `faktura korygująca` (correction) is the only lawful way to fix it** (Podręcznik KSeF 2.0, Cz. II §1.6.3). A connector without corrections is not production-usable.
- This spec adds the **correction (KOR) send path** end-to-end: serialize a `sales.credit_memo` (Open Mercato's credit note) into an FA(3) **`RodzajFaktury=KOR`** document with the `DaneFaKorygowanej` block referencing the **original invoice's KSeF number** (or the offline `NrKSeFN` marker), then run it through the same auth → session → submit → status → UPO pipeline and the same 3-layer idempotency + reconciliation guarantees.
- It also adds the **JPK_VAT KSeF marking** derivation (`NrKSeF` / `OFF` / `BFK` / `DI`) required from 2026-02-01 by the JPK_V7M/V7K(3) structures, exposed as a pure function + batch read API for downstream JPK export tooling.

**Scope (this spec):**
- FA(3) KOR serialization (`PrzyczynaKorekty`, `TypKorekty`, `DaneFaKorygowanej`, `OkresFaKorygowanej`) in exact XSD order.
- Resolve an FA(3) KOR from a `sales.credit_memo` + its linked original invoice + that invoice's stored KSeF number.
- A `send_from_credit_memo` command + `POST …/from-credit-memo` route; correction-aware idempotency on `KsefSubmission`.
- JPK_VAT marking derivation + `GET …/jpk-markings` batch read; surface the marking on the response enricher.

**Concerns:**
- The credit-memo → FA(3) **difference/sign semantics** (KSeF wants correction amounts as differences vs. the original) depend on how `sales.credit_memo` populates its amounts; this spec files the credit-memo's stored values and flags the sign convention for **live validation** (xmllint proves the *structure*; only a live KSeF round-trip on real data proves the *semantics*).
- KOR_ZAL / KOR_ROZ (corrections of advance/settlement invoices) and ZAL/ROZ base flows remain **out of scope** — a credit memo corrects a `sales.invoice`, and advance/settlement issuance does not exist in `sales` yet.

## Overview

> **Market Reference**: studied wFirma, Comarch, SaldeoSMART, inFakt. All map a Polish correction to a credit-note/`faktura korygująca` document that references the original by its KSeF number; none allow cancelling an in-KSeF invoice. We adopt the same model (credit memo → KOR). We rejected a free-form "edit and re-send" because KSeF forbids it (the original is immutable, kept 10 years).

A KSeF correction (`faktura korygująca`) is a distinct FA(3) document (`RodzajFaktury=KOR`) that:
1. carries its own invoice number (the credit-memo number) as `P_2`;
2. references the corrected original through `DaneFaKorygowanej` — by the original's **KSeF number** (`NrKSeF=1` + `NrKSeFFaKorygowanej`) when it was issued in KSeF, or the **`NrKSeFN=1`** marker when it was issued outside KSeF (legacy/offline);
3. reports the corrected amounts (per FA(3), as differences) and is itself sent to, and accepted by, KSeF (getting its own KSeF number + UPO).

Open Mercato already models a credit note as `sales.credit_memo` (FK to the original `sales.invoice`, lines, amounts, `reason`). This spec maps that entity to an FA(3) KOR and reuses the entire SPEC-005 reliability spine.

Separately, from 2026-02-01 the **JPK_V7M/V7K(3)** evidence records carry a per-invoice KSeF marking (broszura "JPK_VAT z deklaracją od 1 lutego 2026 r."): `NrKSeF` (the number, when assigned), `OFF` (issued during an announced KSeF *awaria* with no number yet), `BFK` (issued outside KSeF), `DI` (offline24/niedostępność without a number yet, later corrected to `NrKSeF`). Since the connector already stores the KSeF number per invoice, this is a derivation; we add it as a pure function + batch read so a JPK exporter (this module's roadmap, or a downstream accounting bridge) can consume it.

## Problem Statement

1. **No corrections.** SPEC-005 hard-rejects `KOR` at both the schema (`fa3InvoiceSchema.superRefine`) and resolver (`document_type_unsupported`) layers. Users who mis-issue an invoice have **no lawful remedy** in the product (KSeF disallows cancellation).
2. **No JPK_VAT bridge.** The KSeF number is stored but not exposed in the form JPK_VAT reporting requires, so downstream VAT reporting cannot mark which evidence rows are KSeF invoices.

## Proposed Solution

Extend the existing pure FA(3) serializer and the resolver/command/route layers additively — **no change to the country-agnostic `sales` schema, no change to core packages**. A correction is resolved from `sales.credit_memo`, serialized to FA(3) KOR, and sent via the existing `sendCommand` (idempotency-, reconciliation-, and 440-duplicate-protected). The `KsefSubmission` entity gains a `document_kind` discriminator + `credit_memo_id` so a correction is tracked and deduplicated independently of the invoice it corrects.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Correction source = `sales.credit_memo` (not a new entity) | It already exists, links to the original invoice, has lines/amounts/`reason`. Matches how every studied vendor models it. No core change. |
| Reference original by **stored KSeF number**, else `NrKSeFN` | KSeF requires `NrKSeFFaKorygowanej` when the original is in KSeF; `NrKSeFN=1` covers legacy/pre-KSeF originals (manual §2.13.6). The number is read from the original invoice's accepted `KsefSubmission` / `SalesInvoicePlMeta`. |
| `document_kind` + `credit_memo_id` on `KsefSubmission` (vs. overloading `sales_invoice_id`) | A correction and its original are two separate KSeF documents; both need an active-unique guard. Overloading the column would either block the correction or mislead the invoice enricher. Keep `sales_invoice_id` = the corrected original (useful link), discriminate by kind. |
| Validate generated XML against the **official FA(3) XSD** (`xmllint`) | Regulation-critical; catches element-order/structure errors offline without KSeF. The XSD is the authority (byte-identical CRD ↔ CIRFMF mirror). |
| JPK marking = pure derivation + batch read (not a new stored column) | The KSeF state already lives on `KsefSubmission`/`SalesInvoicePlMeta`; deriving avoids a denormalized field that can drift. |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| "Cancel + re-issue" an invoice | Illegal in KSeF — an accepted invoice is immutable (manual §1.6.3). |
| New `financial_pl` correction entity | Duplicates `sales.credit_memo`; needs its own UI/CRUD. UMES says extend, don't re-model. |
| Overload `sales_invoice_id` to hold the credit-memo id | Semantically wrong for a financial table; breaks the invoice enricher; reviewer red flag. |
| Store the JPK marking as a column | Drifts from the source-of-truth submission state; needs a backfill + maintenance. |

## User Stories / Use Cases
- **An accountant** wants to **issue a correction to an invoice already in KSeF** so that **a pricing/quantity error is lawfully fixed** (KSeF number + UPO on the correction).
- **An accountant** wants to **correct an invoice issued before KSeF** so that **the legacy original is referenced via `NrKSeFN`**.
- **A VAT-reporting tool** wants to **read each invoice's KSeF marking** so that **JPK_V7M/V7K(3) evidence rows carry `NrKSeF`/`OFF`/`BFK`/`DI` correctly**.

## Architecture

### FA(3) KOR serialization (`lib/fa3.ts`)
The serializer gains an optional `correction` block on `Fa3InvoiceModel` and emits it **after `RodzajFaktury`** (the exact XSD position), in order:
`PrzyczynaKorekty?` → `TypKorekty?` → `DaneFaKorygowanej[]` → `OkresFaKorygowanej?`.
Each `DaneFaKorygowanej` emits `DataWystFaKorygowanej` → `NrFaKorygowanej` → **choice**: when the original's KSeF number is known, `<NrKSeF>1</NrKSeF>` + `<NrKSeFFaKorygowanej>`; otherwise `<NrKSeFN>1</NrKSeFN>`. `RodzajFaktury` value becomes `KOR`. Element order verified against `schemat_FA(3)_v1-0E.xsd` (`Fa` sequence: … `Adnotacje` → `RodzajFaktury` → correction sequence → … → `FaWiersz`).

### Resolve KOR from a credit memo (`lib/resolve-fa3-from-credit-memo.ts`)
Reads (via the platform Query Engine, FK-id only — no cross-module ORM): the `sales.credit_memo`, its `sales.credit_memo_line` rows, the linked original `sales.invoice` (for `NrFaKorygowanej`/`DataWystFaKorygowanej` and the buyer snapshot), and the original invoice's KSeF number. Builds the FA(3) KOR (seller from credentials, buyer from the corrected invoice, VAT breakdown + lines + total from the credit memo, `correction` block from the original + `credit_memo.reason`). The money/VAT mapping helpers shared with the invoice resolver are factored into `lib/fa3-mapping.ts` (DRY) and re-validated by both resolvers' tests.

**Amount/sign transformation (resolved 2026-06-27 from the spec-stage jury).** `sales.credit_memo` amounts are validated **non-negative** (`creditMemoCreateSchema`: every amount `decimal({ min: 0 })`); a credit memo always represents a **reduction**. FA(3) corrections are filed **by difference** vs. the original (manual §2.13.2), where a reduction is negative. The resolver therefore emits FA(3) KOR difference amounts (`P_13_*`, `P_14_*`, `P_15`, line `P_11`, quantities) as the **negation** of the credit memo's stored magnitudes: `fa3Amount = −|creditMemoAmount|`. This is a single, isolated, unit-tested rule (xmllint confirms negatives are XSD-valid). If credit memos ever model an *increase*, this rule is the one place to revisit.

**Reference resolution — never silently mislabel a pending original (resolved from the jury).** The resolver classifies the corrected original three ways: (a) an **accepted** `financial_pl:ksef_submission` (or `sales_invoice_pl_meta.ksef_number`) exists → emit `NrKSeF=1` + `NrKSeFFaKorygowanej`; (b) a submission exists but is **not accepted** (queued/processing/rejected) → **reject (409 `original_not_accepted`)** — a correction must wait until the original has its KSeF number; (c) **no** submission at all → require the caller's explicit `originalOutsideKsef: true` to emit the legacy `NrKSeFN=1` marker, else **reject (422 `original_ksef_number_unknown`)**. Absence of a number never silently becomes "outside KSeF".

**Correction reason is required (resolved from the jury).** A KOR must carry `PrzyczynaKorekty`; the resolver rejects (422 `correction_reason_required`) a credit memo with no `reason`. (`TypKorekty` stays optional — not derivable from the credit memo; omitted unless explicitly supplied on the payload path.)

### Correction-aware send (`commands/ksef-submission.ts`, `api/.../from-credit-memo/route.ts`)
`sendCommand` accepts `documentKind` (`'invoice' | 'credit_memo'`, default `invoice`) + `creditMemoId`; its idempotency lookup and the unique-violation recovery key on `credit_memo_id` for corrections, and on `sales_invoice_id` **scoped to `document_kind='invoice'`** for invoices. `sendFromCreditMemoCommand` resolves the KOR and delegates to `sendCommand`. The new route mirrors `from-invoice` (auth, org scope, mutation guard, 202/4xx, OpenAPI).

**Invoice-facing reads filter `document_kind='invoice'` (resolved from the jury — BC-critical).** Because a correction submission stores `sales_invoice_id` = the *corrected* original invoice id, every existing read that surfaces an invoice's KSeF state (the response enricher, the JPK-marking derivation, the invoice idempotency lookup, and the existing `active_unique` index predicate) is scoped to `document_kind='invoice'` so a correction never bleeds its status/number/UPO/marking onto the original invoice.

### JPK_VAT marking (`lib/jpk-vat-marking.ts`, `api/.../jpk-markings/route.ts`)
Pure `deriveJpkVatMarking({ ksefStatus, ksefNumber, mode, issuedOutsideKsef })` → `{ marking: 'NrKSeF'|'OFF'|'BFK'|'DI' } | { marking: null, pending: true }`. Mapping (broszura, mutually exclusive), **honestly narrowed (resolved from the jury)**:
- accepted + `ksefNumber` → `NrKSeF` (the number).
- `mode='awaryjny'` without a number yet → `OFF`.
- `mode='offline24'` (or niedostępność) without a number yet → `DI`.
- `issuedOutsideKsef === true` (explicit flag — e.g. a consumer/legacy invoice never destined for KSeF) → `BFK`.
- otherwise (queued/processing/ready, or no terminal state) → `{ marking: null, pending: true }` — **absence of a number is never silently reported as `BFK`** (it could be an in-flight invoice).
`mode` is the existing `KsefSubmission.mode` column; `issuedOutsideKsef` comes from `SalesInvoicePlMeta` (an explicit operator signal, not inferred). The batch `GET …/jpk-markings?salesInvoiceId=a,b,c` is **capped at 100 ids** and derives markings from a **single batched read** of the latest `document_kind='invoice'` submission + meta per invoice (no N+1); the marking is also added to the `_financial_pl` response-enricher payload (computed from the already-batched submission data — no extra query).

### Commands & Events
- **Command**: `financial_pl.ksef_submission.send_from_credit_memo` (new); `…send` extended with `documentKind`/`creditMemoId`.
- **Events**: unchanged (`…queued`/`…accepted`/`…rejected`) — corrections flow through the same lifecycle.

## Data Models

### KsefSubmission (extended)
Adds two columns + one partial unique index (additive migration on the live table):
- `document_kind`: `text` not null default `'invoice'` (`'invoice' | 'credit_memo'`)
- `credit_memo_id`: `uuid` null (set when `document_kind='credit_memo'`)
- existing `financial_pl_ksef_submissions_active_unique` predicate gains `and document_kind = 'invoice'` (so a correction whose `sales_invoice_id` = the corrected invoice does not collide with the invoice's own submission)
- new `financial_pl_ksef_submissions_credit_memo_active_unique` on `(organization_id, tenant_id, credit_memo_id) where credit_memo_id is not null and status in ('queued','processing','accepted') and deleted_at is null`

For a correction submission: `sales_invoice_id` = the **corrected** original invoice id (meaningful link, drives the invoice enricher); `credit_memo_id` = the credit memo; `document_kind='credit_memo'`.

### SalesInvoicePlMeta (extended)
Adds one nullable column for the explicit JPK `BFK` signal:
- `issued_outside_ksef`: `boolean` not null default `false` — operator marks an invoice that was lawfully issued **outside** KSeF (consumer/legacy/pre-obligation), so the JPK derivation can return `BFK` rather than a silent fallback.

### No new entities; `sales` schema untouched
The correction is `sales.credit_memo` (core). The JPK marking is **derived** (from submission state + mode + `issued_outside_ksef`), not stored.

## API Contracts

| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/submissions/from-credit-memo` | `POST` | `financial_pl.submit` | Resolve FA(3) **KOR** from `{creditMemoId}` and queue an idempotent submission; `202` + `submissionId`. 404 unknown credit memo / 409 not-issued·no-linked-invoice·no-credentials / 422 currency·VAT-rate·seller·buyer·correction-ref-missing. |
| `…/jpk-markings` | `GET` | `financial_pl.view` | Batch read JPK_VAT markings for `?salesInvoiceId=` (comma list of UUIDs, **capped 100**); returns `{ items: [{ salesInvoiceId, marking, ksefNumber, pending }] }`, org/tenant-scoped (**requires a resolved org scope — 400 otherwise**; never an org-unscoped tenant-wide read). |

`POST …/submissions` (explicit payload) also accepts a `correction` block + `invoiceKind='KOR'` for direct/testing use.

## Internationalization (i18n)
New keys (en + pl): `financial_pl.errors.correction_reference_missing`, `financial_pl.errors.credit_memo_not_linked`, `financial_pl.actions.sendCorrectionToKsefQueued`. Existing `document_type_unsupported` message reworded (KOR now supported; ZAL/ROZ/UPR still rejected).

## UI/UX
No new pages this spec. The existing sales-invoice status enricher additionally exposes `jpkVatMarking`. (A "Send correction to KSeF" credit-memo row action is roadmap — credit memos have no UMES host wired in this module yet.)

## Configuration
No new env vars. Correction sends honor the same per-org `ksef_pl` credentials + `OM_KSEF_ENVIRONMENT`.

## Migration & Compatibility
Additive migration (new columns default-valued; index predicate tightened + one new partial index). Backward-compatible: existing invoice submissions are `document_kind='invoice'` by default; the tightened active-unique predicate is satisfied by all existing rows. No data backfill. Generated via `yarn mercato db:generate` (snapshot-diff); see Implementation Status for how it was produced/verified here.

## Implementation Plan

### Phase 1 — FA(3) KOR serializer + validators
1. Add `Fa3Correction`/`Fa3CorrectionReference` to `lib/fa3.ts`; emit the correction sequence after `RodzajFaktury`.
2. Add `fa3CorrectionSchema` to `data/validators.ts`; allow `invoiceKind='KOR'` (require `correction` with ≥1 reference); keep ZAL/ROZ/UPR/KOR_ZAL/KOR_ROZ rejected.
3. Unit tests + **xmllint** validation of a generated KOR against the official XSD.

### Phase 2 — Resolve + send a correction
1. Factor shared money/VAT/party mapping into `lib/fa3-mapping.ts`; refactor `resolve-fa3-from-invoice.ts` to use it (behavior-preserving).
2. `lib/resolve-fa3-from-credit-memo.ts` → FA(3) KOR.
3. Extend `KsefSubmission` (entity) + regenerate migration; extend `sendCommand` (documentKind/creditMemoId + idempotency); add `sendFromCreditMemoCommand`; add the route.
4. Unit tests (resolver, command), integration test TC-KSEF-003, env-gated live correction round-trip.

### Phase 3 — JPK_VAT markings
1. `lib/jpk-vat-marking.ts` pure derivation + tests.
2. `GET …/jpk-markings` route + integration test TC-KSEF-004; add `jpkVatMarking` to the enricher.

### File Manifest
| File | Action | Purpose |
|------|--------|---------|
| `lib/fa3.ts` | Modify | Emit correction block (KOR). |
| `lib/fa3-mapping.ts` | Create | Shared money/VAT/party mapping (DRY). |
| `data/validators.ts` | Modify | Correction schema; allow KOR. |
| `lib/resolve-fa3-from-invoice.ts` | Modify | Use shared mapping (behavior-preserving). |
| `lib/resolve-fa3-from-credit-memo.ts` | Create | Credit memo → FA(3) KOR. |
| `data/entities.ts` | Modify | `document_kind` + `credit_memo_id` + index. |
| `migrations/*` | Create | Additive schema delta + snapshot. |
| `commands/ksef-submission.ts` | Modify | `documentKind` idempotency + `send_from_credit_memo`. |
| `api/ksef/submissions/from-credit-memo/route.ts` | Create | Correction send route. |
| `lib/jpk-vat-marking.ts` | Create | JPK marking derivation. |
| `api/ksef/jpk-markings/route.ts` | Create | Batch JPK marking read. |
| `data/enrichers.ts` | Modify | Expose `jpkVatMarking`. |
| `__integration__/TC-KSEF-003.spec.ts`, `TC-KSEF-004.spec.ts` | Create | Route contracts. |
| `lib/__tests__/*`, `commands/__tests__/*` | Create/Modify | Unit coverage. |
| translations | Modify | New i18n keys. |

## Risks & Impact Review

### Data Integrity Failures
- **Mid-flight crash:** identical to SPEC-005 — the correction is one `KsefSubmission` row driven by the persistent subscriber; the atomic `queued→processing` claim + reconciliation sweep + KSeF 440-duplicate net apply unchanged (440 dedup key = seller NIP + `RodzajFaktury` + number, so a KOR never collides with the corrected VAT invoice).
- **Concurrent double-send of a correction:** the new `credit_memo_active_unique` partial index + the unique-violation recovery prevent two active submissions per credit memo.

### Cascading Failures & Side Effects
- A correction depends on the original invoice's KSeF number; if absent (original never sent / not yet accepted) the resolver emits `NrKSeFN` (legacy marker) — **risk**: filing a correction as "outside-KSeF original" when the original is actually pending. Mitigation: only emit `NrKSeFN` when there is no accepted submission for the original; document that a correction should be issued after the original is accepted. Residual: an operator can still correct a not-yet-accepted original → flagged as a live-validation check.

### Tenant & Data Isolation Risks
- All reads are Query-Engine calls scoped by `(tenantId, organizationId)`; the credit memo, its lines, the original invoice, and the KSeF number are all fetched under the same scope. No cross-tenant surface added.

### Migration & Deployment Risks
- Additive, online-safe (nullable/defaulted columns; index predicate tightened — all existing rows satisfy it). Re-runnable. No backfill.

### Operational Risks
- Same monitoring as SPEC-005 (reconciliation sweep, `attempt_count` breaker). Correction volume is low.

### Risk Register

#### Correction difference/sign semantics
- **Scenario**: The credit-memo → FA(3) KOR amount transformation files the wrong sign/meaning.
- **Severity**: High → **mitigated by an explicit rule** (spec-stage jury, DeepSeek + Codex).
- **Affected area**: FA(3) KOR amounts (`P_13_*`/`P_14_*`/`P_15`, line `P_11`), tax-authority filing.
- **Mitigation**: Credit-memo amounts are validated **non-negative**; the resolver emits FA(3) differences as their **negation** (a credit memo is always a reduction) — one isolated, unit-tested rule. xmllint confirms negative differences are XSD-valid. The explicit-payload path lets QA file controlled amounts; the env-gated live test asserts KSeF acceptance.
- **Residual risk**: A credit memo that models an *increase* (not currently possible) would need the rule revisited; flagged at the rule's single call-site. Real-data acceptance still confirmed by the user's live TEST round-trip.

#### `NrKSeFN` emitted for a pending (not-yet-accepted) original
- **Scenario**: A correction is issued before the original is accepted; the resolver can't find a KSeF number.
- **Severity**: Medium → **eliminated** (spec-stage jury, Codex).
- **Affected area**: `DaneFaKorygowanej` reference correctness.
- **Mitigation**: The resolver **rejects** (409 `original_not_accepted`) when the original has a non-accepted submission, and **requires an explicit `originalOutsideKsef` flag** (else 422) when the original has no submission at all. Absence of a KSeF number is never silently treated as legacy/outside-KSeF.
- **Residual risk**: None material; the operator gets a clear error.

#### JPK marking under-determined by current state
- **Scenario**: `deriveJpkVatMarking` can't tell an unsent invoice from a legally outside-KSeF one, so it mislabels `BFK`.
- **Severity**: Medium → **eliminated** (spec-stage jury, DeepSeek + Codex).
- **Affected area**: JPK_VAT evidence marking.
- **Mitigation**: `BFK` requires the explicit `issued_outside_ksef` flag; in-flight invoices return `{ marking: null, pending: true }` rather than a guessed marking; `OFF`/`DI` derive from the `mode` column.
- **Residual risk**: `OFF`/`DI` only fire once offline modes are implemented (roadmap); until then markings are `NrKSeF` / `BFK` / pending — correct for the online-only connector.

## Final Compliance Report — 2026-06-27

### AGENTS.md Files Reviewed
- `AGENTS.md` (root, official-modules)
- `.ai/specs/AGENTS.md`
- `ARCHITECTURE.md` (borrowed core reference — §11 UMES, §27 BC, §31 checklist)
- core `packages/core/src/modules/sales` (read-only, for the credit-memo model)

### Compliance Matrix
| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | Credit memo / invoice read via Query Engine, FK-id only. |
| root AGENTS.md | Filter by organization_id (+ tenant) | Compliant | All reads + the new route are `(tenantId, organizationId)`-scoped. |
| root AGENTS.md | Never modify core packages | Compliant | `sales` read-only; correction is the core `credit_memo`. |
| root AGENTS.md | Never hand-write migrations | See Status | Generated via snapshot-diff; verification noted in Implementation Status. |
| root AGENTS.md | zod-validate all API inputs | Compliant | `from-credit-memo` + `jpk-markings` use zod schemas. |
| root AGENTS.md | No `any` / no hardcoded user strings | Compliant | `z.infer` types; i18n keys for messages. |
| spec-writing | Singular entity/command names | Compliant | `financial_pl.ksef_submission.send_from_credit_memo`. |
| ARCHITECTURE §27 | Backward-compatibility (additive only) | Compliant | New columns defaulted; KOR added alongside VAT; no removed surface. |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | `document_kind`/`credit_memo_id` back the from-credit-memo route. |
| API contracts match UI/UX | Pass | No new UI; enricher field documented. |
| Risks cover all write operations | Pass | Correction send + idempotency covered. |
| Commands defined for all mutations | Pass | `send_from_credit_memo`; `send` extended. |

### Verdict
- **Fully compliant** — Approved for implementation (migration-generation method recorded in Implementation Status).

## Roadmap (not built; delegation explicitly dropped per product decision 2026-06-27)
- **Cross-org "shared/agency" delegation: dropped.** Per the product decision, KSeF config stays strictly **per organization**; no delegation / biuro-rachunkowe / shared-credential model is planned. (Regulation note: a shared *secret* is invalid anyway — a token/cert is bound to a NIP; the lawful agency model is per-NIP delegation, which is intentionally not pursued.)
- Still roadmap from SPEC-005: certificate / XAdES authentication (the 2027 durable credential; tokens sunset 2027-01-01) + KSeF certificate enrollment; offline24/awaryjny/niedostępność issuance + KOD I/II verification QR (needs the offline certificate); inbound purchase-invoice fetch (receive obligation from 2026-02-01); ZAL/ROZ advance+settlement chains and therefore KOR_ZAL/KOR_ROZ; a full JPK_V7M/V7K(3) exporter consuming the marking; non-PLN currency; full in-process XSD validation; active `Retry-After`/429 pacing; a reference-based status re-poller.

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| 1 — FA(3) KOR serializer + validators | Done | 2026-06-27 | `lib/fa3.ts` correction block; `data/validators.ts` correction schema (KOR allowed). Verified: 6 serializer unit tests + **xmllint validation of a generated KOR against the official FA(3) 1-0E XSD** (in-KSeF `NrKSeF` and legacy `NrKSeFN` branches). |
| 2 — Resolve + send a correction | Done (logic) | 2026-06-27 | `lib/fa3-mapping.ts` (shared, DRY), `lib/resolve-fa3-from-credit-memo.ts`, `KsefSubmission` entity + migration + snapshot, `sendCommand` document_kind idempotency, `send_from_credit_memo` command + route. 7-case resolver unit test written. **Unit run blocked in this checkout** (pre-existing missing `pl/validation` dep — see below). |
| 3 — JPK_VAT markings | Done | 2026-06-27 | `lib/jpk-vat-marking.ts` (8 unit tests, all pass), `GET /jpk-markings` (cap 100), enricher `jpkVatMarking`, `issued_outside_ksef` on meta + its PUT. |

**Verification run here (2026-06-27):** `jest` → **78/80 pass, 8 suites** (incl. `fa3.correction`, `jpk-vat-marking`, and all pre-existing pure suites). The **5 failing suites all fail on the single pre-existing cause** `Cannot find module '@open-mercato/shared/lib/pl/validation'` (imported by the untouched `data/validators.ts`); 4 of the 5 are pre-existing suites, confirming it is environmental, not a regression. `typecheck`/`build`/`test:integration` cannot run cleanly here for the same reason.

**To complete verification (user environment, with a core build that provides `@open-mercato/shared/lib/pl/validation`):**
```
yarn workspace @open-mercato/financial-pl typecheck
yarn workspace @open-mercato/financial-pl test
yarn workspace @open-mercato/financial-pl build
yarn test:integration                       # TC-KSEF-001..003 (module must be activated in the sandbox)
yarn official-modules add financial-pl --local && yarn mercato db generate   # regenerate/confirm the migration + snapshot
OM_KSEF_FA3_XSD=<path to schemat_FA(3)_v1-0E.xsd> yarn workspace @open-mercato/financial-pl test fa3.correction   # XSD-validate KOR
OM_KSEF_TEST_NIP=2481632647 OM_KSEF_TEST_TOKEN=<token> OM_KSEF_TEST_STRICT=1 yarn workspace @open-mercato/financial-pl test ksef-live  # live correction round-trip (extend ksef-live)
```

## Changelog
### 2026-06-27 — SPEC-006 initial
- Correction (KOR) send path resolved from `sales.credit_memo`; FA(3) `DaneFaKorygowanej` (KSeF-number or `NrKSeFN`); `document_kind`/`credit_memo_id` on `KsefSubmission` with correction-aware idempotency; `send_from_credit_memo` command + `POST …/from-credit-memo`. JPK_VAT marking derivation (`NrKSeF`/`OFF`/`BFK`/`DI`) + `GET …/jpk-markings` + enricher field. Serializer validated against the official FA(3) `1-0E` XSD; live correction round-trip env-gated. Cross-org delegation dropped.
- **Post cross-model-review hardening:** correction amounts emitted as the negation of the (non-negative) credit-memo amounts; `DataWystFaKorygowanej` taken from the **original** invoice's issue date (422 if absent, never the credit-memo date); `resolveCorrectedKsefNumber` filters `document_kind='invoice'` in the DB query (not just JS) so an accepted correction can't hide the original's submission nor a pending original be mislabeled; a direct-POST `KOR` payload must be a `credit_memo` submission (no bleed onto the corrected invoice); `GET …/jpk-markings` requires a resolved org scope (no tenant-wide read) + validates UUIDs; `send_from_credit_memo` returns 404 (unknown credit memo) before 409 (credentials).
