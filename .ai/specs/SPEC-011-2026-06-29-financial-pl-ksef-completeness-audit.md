# SPEC-011 — `financial_pl`: KSeF completeness audit, live validation & self-billing guard

- **Date:** 2026-06-29
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md) … [SPEC-010](./SPEC-010-2026-06-28-financial-pl-offline-mode-kodii.md)
- **Status:** Draft → for implementation. The audit + live round-trip ran in this checkout (NIP 2481632647, TEST env, user token). One surgical code change (self-billing guard) + one test (zero-line ZAL) are in scope; everything else is documented as roadmap.

## TLDR

**Key Points:**
- **Completeness audit of the whole KSeF connector** (SPEC-005…010), validated **empirically against the live KSeF 2.0 TEST API** (`https://api-test.ksef.mf.gov.pl/v2`) with the user's token. Auth → open session → send → status(200) → UPO works end-to-end.
- **Live-accepted document types** (real KSeF numbers + signed UPO): **VAT**, **ZAL** (advance), **UPR** (simplified), **OSS EUR** (WSTO_EE), and a **real KOR correction** referencing an accepted original (`...3F8DD3400000-57` → KOR `...4011D3400000-63`). This proves *"wystawianie korekty faktury + KSeF"* and the new SPEC-009 document types round-trip live.
- **New finding (not in 005–010): self-billing is structurally un-submittable.** `sendCommand` enforces the invariant **`seller.nip === contextNip`** (the connector files every invoice as the authenticated taxpayer). Self-billing (*samofakturowanie*, art. 106d) is issued by the **buyer** on the seller's behalf, so it requires `issuer ≠ seller`. A self-billed invoice therefore always violates the invariant and is **rejected live by KSeF (HTTP 410** — *"Faktura wystawiania we własnym imieniu nie może posiadać adnotacji 'samofakturowanie'"*). The connector currently lets the operator queue it and only learns of the failure from KSeF.
- **Fix (this spec):** reject a self-billed payload at the `sendCommand` choke point with a clear, actionable error (`self_billing_unsupported`) instead of a late KSeF 410, plus a unit test. (The live-accepted zero-line ZAL shape is already covered by `lib/__tests__/fa3.test.ts:363` — no new test needed.)
- **Q1–Q4 are confirmed** (see SPEC-007): certificate auth + the two KSeF certificate types are implemented; multi-tenant config is per-`(organizationId, tenantId)`; reliability spine (3-layer idempotency + outbox + reconcile + byte-stable resend) holds; live integration done for the token path.

**Scope (this spec):**
- Self-billing submit guard in `commands/ksef-submission.ts` (`sendCommand`) + unit test.
- This audit document (findings + roadmap).

**Out of scope (documented roadmap — NOT built here):**
> ⚠️ **Compliance caveat (per the Kimi spec-stage note):** items 1 and 2 are **regulatorily mandated** obligations that this connector does **not** yet implement. "~95% feature-complete" refers to the **issuing + corrections + offline + PDF/QR + JPK-signals** scope; the connector is **not** yet fully compliant on the **receive** side or for **JPK_VAT filing**. These are the two largest completeness gaps and need their own specs.
1. **Inbound purchase-invoice receiving** — the connector is **send-only**; receiving structured invoices via KSeF is **mandatory for all taxpayers from 2026-02-01** (already in force). This is the single biggest completeness gap. Separate feature.
2. **JPK_V7M/V7K(3) export** — a **statutory VAT reporting obligation** (new structures effective 2026-02-01). All signals are captured (GTU, procedure markings, `NrKSeF/OFF/BFK/DI`, `TypDokumentu`); no exporter module yet.
3. **External-seller self-billing** — supporting a true `issuer ≠ seller` self-billed flow (relaxing the invariant + buyer-context + delegated permissions). Product decision.
4. **Shared / delegated multi-entity config** — biuro-rachunkowe model = KSeF `uprawnienia` delegation, not token sharing (see SPEC-007 Q2). Product decision.
5. **PDF multi-page pagination** — `lib/invoice-pdf.ts` is a deliberate byte-stable single-page renderer; invoices with >~45 line items overflow. Enhancement.
6. **Planned offline modes** `niedostępność` / total `awaria` — enum + deadline calculator exist; issuance path not wired (offline24 + awaryjny ARE wired).
7. **Auth-cert pre-flight validity check** — the Offline cert is validity-checked before KOD II signing; the Authentication cert is not pre-checked before a submission (KSeF auth rejects an invalid cert anyway). Hardening.
8. **NBP FX-rate auto-sourcing** — rates are operator-supplied / EU-table fallback; no automated NBP fetch.

## Overview

The connector (SPEC-005…010) is ~95% feature-complete for **issuing + corrections + offline + PDF/QR + JPK signals**, and is regulation-aligned (verified against the official KSeF 2.0 sources and the FA(3) schema). This spec records a full audit, captures the **live** evidence, and closes the one correctness gap the live run surfaced (self-billing). The larger adjacencies (inbound receive, JPK export) are real completeness gaps but are separate features, explicitly deferred.

## Problem Statement

1. **Self-billing produces guaranteed-rejected submissions.** `meta.self_billing=true` sets FA(3) `P_17='1'`. Because `sendCommand` requires `seller.nip === contextNip`, the issuer is always the seller, so KSeF rejects the invoice (410). The operator gets a late, opaque failure rather than an early, clear one — and a PDF visualisation may already carry the (invalid) self-billing annotation.

## Proposed Solution

### Self-billing submit guard (shared, applied at every submit-to-KSeF path)
Add a shared `assertNotSelfBilled(invoice)` guard that throws `CrudHttpError(422, { error, code: 'self_billing_unsupported' })` when `invoice.selfBilling === true` **or** `invoice.annotations?.selfBilling === true` (both channels feed FA(3) `P_17`), with a message explaining that self-billing requires the issuer to differ from the seller (pointing at the external-seller roadmap item). Apply it at **every** path that creates a submit-to-KSeF row:
- **`sendCommand`** — the online choke point (`send`, `send_from_invoice`, `send_from_credit_memo` all funnel through it), immediately after the `seller_nip_mismatch` invariant.
- **`issueOfflineCommand`** — the offline issuance path, immediately after the FA(3) payload is resolved and **before** the KOD II is built or an `offline_issued` row is persisted (its deferred send via `subscribers/ksef-send-offline.ts` bypasses `sendCommand`). This also prevents an offline invoice being "issued" with a printed certificate QR ahead of a late KSeF rejection.
`retryCommand` needs no separate guard: it only re-queues an **existing** submission, and because both creation paths are now guarded, no *new* self-billed row can be created to retry. (Per the DeepSeek spec-stage note: a self-billed row created **before** this guard — if any operator ever issued one — would still fail at KSeF on retry exactly as it does today; the guard prevents new ones. No migration is shipped because a freshly-deployed connector has no such rows; an operator resolves a historical row by clearing `self_billing` or cancelling the invoice.) Storing `self_billing` on PL meta for JPK record-keeping is unaffected — only **submitting** a self-billed invoice as the seller is blocked.

> **Spec-stage cross-model review (Codex, gpt-5.5):** flagged that `sendCommand` is not the only submit-to-KSeF path (`issueOfflineCommand` + the offline deferred-send subscriber bypass it). Reconciled by extracting the shared guard above and applying it at both creation paths — fixed in the design before/with the code.

## Architecture / Data Models / API Contracts
No schema, entity, migration, or API-route changes. `sendCommand` gains one validation branch returning the existing `CrudHttpError` shape with a new `code`. No backward-compatibility surface is touched (the rejected case previously failed later at KSeF; no caller relied on a self-billed send succeeding).

## Risks & Impact Review
- **Risk:** the guard blocks a legitimate future self-billing flow. **Severity:** low. **Affected:** `sendCommand`. **Mitigation:** the flow is *already* impossible (KSeF 410); the guard only improves the error. The external-seller flow is a documented roadmap item that would relax the guard together with the `seller.nip === contextNip` invariant. **Residual:** none (no capability removed).
- **Risk:** detection misses a self-billing channel. **Severity:** low. **Mitigation:** check both `selfBilling` and `annotations.selfBilling`; unit-tested. **Residual:** negligible.
- **Risk:** test brittleness on serializer ordering. **Severity:** very low. **Mitigation:** assert on element presence/order substrings as the existing ZAL tests do.

## Final Compliance Report
- No new dependencies; no cross-module ORM relationships; tenant scoping unchanged; zod validation unchanged; DI unchanged.
- Regulation alignment: self-billing per art. 106d requires buyer-as-issuer — the guard enforces this precondition rather than emitting an invalid annotation. FA(3) ZAL per the live-accepted schema.
- Verification: full gate (build:packages → generate → typecheck → test → build:app) + the module jest suite + the env-gated live test (token path executed; cert path requires an operator-enrolled cert).

## Changelog
- **2026-06-29:** Created. Completeness audit + live TEST round-trip evidence (VAT/ZAL/UPR/OSS/KOR accepted; self-billed 410; placeholder-ref KOR 450). Scoped the self-billing guard; deferred inbound-receive, JPK export, external-seller self-billing, shared/delegated config, PDF pagination, planned offline modes, auth-cert pre-flight, NBP FX as roadmap. Spec-stage Codex review surfaced the offline-path bypass → reconciled to a shared `assertNotSelfBilled` guard applied at both the online (`sendCommand`) and offline (`issueOfflineCommand`) creation paths.

## Integration Test Coverage
- `commands/__tests__/ksef-submission.test.ts`: new cases — (a) the shared `assertNotSelfBilled` guard rejects both the `selfBilling` and `annotations.selfBilling` channels with `422 self_billing_unsupported` and passes a non-self-billed payload; (b) `sendCommand` rejects a self-billed payload at queue time (online path wiring).
- `commands/__tests__/ksef-issue-offline.test.ts`: new case — `issueOfflineCommand` rejects a self-billed invoice with `422 self_billing_unsupported` **after** cert validation but **before** building the KOD II or persisting an `offline_issued` row (no row created), proving the offline path is guarded too (closes the fresh-reviewer + DeepSeek code-stage note).
- `lib/__tests__/fa3.test.ts:363` (pre-existing): zero-line ZAL (`lines: []` + order + advancePayments) already serialises to a valid ZAL FA(3) with no `FaWiersz` — the live-accepted shape; no new test required.
- `lib/__tests__/ksef-live.test.ts` (env-gated, executed this run): VAT/ZAL/UPR/OSS accepted; real KOR correction accepted; self-billed rejected (410, expected); placeholder-ref KOR rejected (450, expected).
