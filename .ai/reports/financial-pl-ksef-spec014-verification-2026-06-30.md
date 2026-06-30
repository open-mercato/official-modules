# financial_pl — KSeF & commercial invoice editor: SPEC-014 verification, live testing & 4-model review

- **Date:** 2026-06-30
- **Branch:** `feat/financial-pl-ksef`
- **Module:** `@open-mercato/financial-pl` (`financial_pl`)
- **Scope of this session:** harden + verify the SPEC-014 commercial editor (staged, stop-before-PR) — bootstrap the harness in `official-modules`, re-confirm regulatory assumptions against the official KSeF 2.0 sources, live-test every invoice type + certificate auth on the KSeF TEST API, audit the commercial UX, run the full gate, and run the four-model review jury. **No new feature code was written this session beyond what SPEC-014 already staged** (the editor was already implemented + 2× code-juried in the prior session); this session is verification + the fresh jury.

## 1. Harness bootstrap in official-modules (first run here)
The dev-harness skills expect `ARCHITECTURE.md` + the `om-*` skills, which live in the open-mercato **core** repo, not here. They were already copied in and git-ignored as borrowed local-only files (verified, not re-done this session):
- `ARCHITECTURE.md` (core rules ref, 100 KB) — **git-ignored** (`/.gitignore` → `/ARCHITECTURE.md`), untracked. `AGENTS.md` is tracked (repo-native).
- `.ai/skills/{om-code-review,om-ds-guardian,om-backend-ui-design}/` + `.ai/ds-rules.md` + `.ai/ui-components.md` — borrowed, git-ignored.
- `.mcp.json` + `.serena/` — git-ignored.
- Serena MCP (hard harness requirement) present and initialised.

## 2. Regulatory re-verification (official KSeF 2.0 / JPK_VAT sources, as of 2026-06-30)
A research pass against `ksef.podatki.gov.pl` (integratorzy-it, wsparcie-dla-integratorow, certyfikaty-ksef, zakres-obowiazkowego-ksef, pliki-do-pobrania-ksef-20), `biznes.gov.pl/00239`, the MF JPK_VAT brochure, and the official MF `CIRFMF/ksef-docs`. **All of the module's regulatory assumptions are current:**
- **FA(3)** is the structured-invoice schema in force from **2026-02-01** (replacing FA(2)). Document types: VAT / KOR / ZAL / ROZ / UPR / KOR_ZAL / KOR_ROZ; self-billing via P_17; P_16/P_17/P_18/P_18A annotations; OSS/WSTO_EE. (FA(3) adds structured `Zalacznik`, expanded P_7, Podmiot3 employee role, VAT groups, IPKSeF/IdPlatnosci — none required for the issuing flow this module covers.)
- **Mandatory dates:** RECEIVING via KSeF in force for ALL taxpayers since **2026-02-01**; ISSUING since 2026-02-01 (>200 mln zł) / **2026-04-01** (everyone else) — so as of today essentially all non-micro taxpayers must issue via KSeF. Micro (≤10k zł/mo): 2027-01-01.
- **Auth cutover:** tokens accepted through **2026-12-31**; **certificate-only from 2027-01-01**. Certs issuable since 2025-11-01 (MCU), max validity **2 years**.
- **Cert subject must encode the NIP:** org seal → `organizationIdentifier (2.5.4.97) = VATPL-<NIP>`; natural person → `serialNumber (2.5.4.5)` with `TINPL-`/`PNOPL-`/`PESEL-`. Self-signed certs are accepted **only on the TEST environment**.
- **JPK_V7M(3)/V7K(3)** from the 2026-02 period (first filing due 2026-03-25), with new `NrKSeF`/`OFF`/`BFK`/`DI` ledger markings; the obligation is **direct e-submission to MF**, not just file generation.
- **Commercial NIP-autofill sources:** MF *Wykaz podatników VAT* (`wl-api.mf.gov.pl`, free, no key) + GUS REGON BIR (free but key-required). wFirma/inFakt/Saldeo/Fakturownia all autofill a contractor by NIP, validate the NIP checksum, offer a fixed VAT-rate list, and save contractors. The module's choice of MF Wykaz (no key → works with zero config) matches the market.

## 3. Live KSeF TEST-environment round-trip (token `…|nip-2481632647|…`, STRICT readiness gate)
`OM_KSEF_TEST_NIP=2481632647 OM_KSEF_TEST_TOKEN='<full bundle>' OM_KSEF_TEST_STRICT=1 yarn workspace @open-mercato/financial-pl test ksef-live` (the whole pipe-delimited bundle IS the token — splitting it 450s). 7 passed / 1 (cert) run separately:

| Document type | Result | KSeF number (TEST) | UPO |
|---|---|---|---|
| VAT (standard) | ✅ accepted | `2481632647-20260630-136440C00000-6B` | 5466 B |
| KOR correction (refs a real accepted original) | ✅ accepted | `2481632647-20260630-13667F400000-5B` | 5464 B |
| ZAL advance | ✅ accepted | `2481632647-20260630-1368C0C00000-B5` | 5464 B |
| UPR simplified (NIP-only buyer) | ✅ accepted | `2481632647-20260630-136AFF400000-37` | 5464 B |
| Self-billed VAT | ⛔ rejected 410 (guard validated — expected) | — *(„…nie może posiadać adnotacji 'samofakturowanie'")* | — |
| OSS EUR (WSTO_EE) | ✅ accepted | `2481632647-20260630-136EE3400000-7C` | 5464 B |

**Certificate (XAdES) auth — also accepted live:** KSeF number `2481632647-20260630-140DE3400000-2F`, UPO 5486 B.
- **Documented method (TEST):** generate a self-signed cert whose subject encodes the context NIP, set `OM_KSEF_TEST_CERT_PEM`/`_KEY` (+ `OM_KSEF_TEST_NIP`), run the `certDescribe` block. No `/testdata` onboarding needed on TEST.
- **Recipe correction found this session:** use a **pure org-seal subject** (`organizationIdentifier=VATPL-<NIP>` only) with a **current validity window**. Mixing in `serialNumber=TINPL-<NIP>` made KSeF reject the cert with `400 exceptionCode 21115 "Nieprawidłowy certyfikat"`. macOS LibreSSL 3.3 cannot encode OID 2.5.4.97; the cert was generated via Node `@peculiar/x509`.

## 4. Commercial-grade editor (SPEC-014) — UX audit & live-data verification
The editor now matches the wFirma/inFakt/Saldeo standard for **issuing** invoices. Verified by the passing integration suite (TC-KSEF-UI-006: company-lookup route auth/validation/fail-open + buyer round-trip), a live upstream check, and a component-code audit:
- **Buyer (Nabywca) section** — searchable customer combobox (free entry, backed by core `/api/customers/companies`), NIP field with inline checksum + **"Look up"**, address line 1/2, postal, city, country. Persists to `metadata.buyerSnapshot` with the exact `buildBuyer` keys; the async lookup fills only blank fields (stale-closure-safe) and the edit path merges into the loaded `metadata` without clobbering other keys.
- **"Grab company by NIP"** — `GET /api/financial_pl/ksef/company-lookup` → MF Wykaz. **Live-verified this session:** `5252344078` → "GOOGLE POLAND SP. Z O.O.", VAT status **Czynny**, address `RONDO IGNACEGO DASZYŃSKIEGO 2C, 00-843 WARSZAWA` (parsed into street/postal/city). Fail-open, ≤6 s, no `accountNumbers` exposed.
- **Inline validations** (block save before a KSeF 422): buyer + taxpayer NIP checksums, due ≥ issue, qty > 0, unit price ≥ 0, custom VAT numeric 0–100, buyer-required (non-UPR name+address; UPR NIP-only) — mirrors `buildBuyer`'s 422 rules.
- **Line pickers** — VAT rate 23/8/5/0 + "Other…"→numeric (scaled prefill matches the clean pick; `zw`/`np`/`oo` correctly NOT line options — exemptions live in the PL-VAT section); unit picker (common PL units + "Other…").
- **PL-VAT meta** — GTU codes + procedure markings searchable filter; OSS consumption-country searchable combobox.
- i18n in en/pl/de/es.

**Preview note:** the prior session ran a full browser preview pass on this exact build (DB `om_fpl_spec013`) — create form renders buyer + pickers + filters, NIP lookup end-to-end, create-with-buyer 201→edit, edit-prefill reads the buyer back, VAT picker shows a clean 23%. A browser re-drive this session was not possible because another running dev server holds port 3000 and two `next dev` instances cannot share the app's `.next`; the SPEC-014 server-side flows are instead covered by the passing integration suite + the live upstream/engine checks above.

## 5. Verification gate
- `build:packages` **PASS** · `i18n:check-sync` **PASS** · module **jest 400 passed / 10 skipped** · our-source `tsc` **0 errors**.
- The only `tsc` errors (18) are pre-existing, in the vendored `@open-mercato/ui/src/backend/DataTable.tsx` (published-core types) — NOT this change; documented in SPEC-013/014 (they also break the sandbox/forms `build:app`).
- Unrelated, NOT staged: `apps/sandbox/package.json` (`@mdxeditor/editor`, `@radix-ui/react-scroll-area`) + ~2160 lines of `yarn.lock` churn are dependency noise from the environment, not SPEC-014 — excluded from the reviewed diff (the jury reviewed `git diff --staged` only).

## 6. Gaps / what's still missing (none block SPEC-014; all separately tracked)
SPEC-014 makes the **issuing editor** commercial-grade and is complete for that goal. The mandatory-but-larger items remain open follow-ups (confirmed still in force by §2), tracked since the 2026-06-29 audit / SPEC-011:
- 🔴 **Inbound invoice RECEIVING** (mandatory 2026-02-01) — the connector is send-only; purchase records are manual upsert, not a KSeF pull.
- 🔴 **Direct JPK_V7 e-submission to MF** (mandatory 2026-02-01) — the module generates + downloads the XML but does not transmit it.
- 🟠 Offline (offline24/niedostępność/awaria) full issuance + KOD II QR on the offline PDF + auto-send scheduling.
- 🟠 Token→certificate cutover automation before 2027-01-01 + cert expiry monitoring.
- 🟡 NBP FX auto-sourcing; batch (wsadowa) session; PDF pagination (>~45 lines).
Editor-level (documented out-of-scope for SPEC-014, optional polish): product/line-catalog autocomplete; MF white-list bank-account / split-payment (MPP) verification; a country dropdown (currently free-text 2-char, defaults PL); buyer email.

## 7. Four-model review jury (Claude + Codex + Kimi + DeepSeek)
All four reviewers ran on `git diff --staged` (the SPEC-014 change; unrelated dep churn excluded). Reconciled over two fix rounds + a clean final round.

| Round | Claude (mandatory) | Codex gpt-5.5 xhigh | Kimi K2.7 | DeepSeek V4 Pro |
|---|---|---|---|---|
| 1 | ✅ pass | ⛔ fail ×2 | ⛔ fail ×1 | ✅ pass |
| 2 (after 3 fixes) | — | ⛔ fail ×1 (new) | parse-skip (gotcha) | — |
| Final (after 6 fixes + polish) | ✅ pass | ✅ pass (0/0) | ✅ pass (0/0)¹ | ✅ pass |

¹ Kimi's final verdict (`pass`, 0 blockers) was recovered from a direct raw-output run — the wrapper's auto-scraper hit the documented kimi-cli print-mode parse gotcha (it parsed cleanly in round 1, where it raised the blank-VAT blocker).

**Reproducible blockers found + fixed (6 total):** (1) blank "Other…" line VAT silently persisted as 0% (Codex + Kimi) → require non-empty numeric rate; (2) stale NIP-lookup response could fill against a changed NIP (Codex) → discard on NIP change; (3) `buyerToSnapshot` treated `{countryCode}`-only as non-empty (Kimi) → omit; (4) taxpayer `contextNip` persisted raw → 422 on a dashed NIP (Codex) → normalise in `buildMetaPayload`; (5) garbage NIP (`ABC`) silently dropped (Codex) → reject non-empty-but-invalid; (6) taxpayer NIP lacked inline feedback (DeepSeek) → added. No spurious blocker chased. **Code-stage cross-model: confirmed (claude + codex + deepseek + kimi) — all four reviewers `pass` on the final diff.**

Full detail: `.ai/reviews/financial-pl-spec014-commercial-editor-cross-model-jury-2026-06-30.md`.

## 8. PR description (paste into the PR body)

```markdown
## Summary

SPEC-014 raises the `financial_pl` invoice editor to a commercial-grade (wFirma/inFakt/Saldeo) standard for **issuing** Polish invoices, on top of SPEC-013's module-owned invoice + KSeF backoffice. It adds a Buyer (Nabywca) section persisted to the core `SalesInvoice.metadata.buyerSnapshot` (the exact keys the FA(3) resolver reads — so a UI-authored invoice no longer 422s `buyer_required` on Send-to-KSeF), a "grab company by NIP" autofill via the free MF *Wykaz podatników VAT* register, inline validations, VAT-rate/unit pickers, and searchable GTU/procedure/OSS-country selects. No new entity, no migration, no core change — one read-only proxy route + client UI + i18n.

## Changes

- Buyer section → `metadata.buyerSnapshot` (exact `buildBuyer` keys; merge preserves other metadata); searchable customer combobox (free entry).
- NIP company lookup: new `GET /api/financial_pl/ksef/company-lookup` proxying MF Wykaz (fail-open, ≤6 s, auth+feature gated, `accountNumbers` not exposed); autofills blank fields + VAT-status badge.
- Inline validations: buyer + taxpayer NIP checksum, due ≥ issue, qty > 0, unit price ≥ 0, line VAT rate required-numeric 0–100, buyer-required (non-UPR name+address; UPR NIP-only).
- Line pickers: VAT rate 23/8/5/0 + "Other…"→numeric; unit picker + "Other…". PL-VAT meta: searchable GTU/procedure filter + OSS consumption-country combobox.
- Tests: `lib/__tests__/{company-lookup,buyer-snapshot}.test.ts`, `__integration__/TC-KSEF-UI-006.spec.ts`; i18n en/pl/de/es; README updated.

## Specification

- [x] Yes
- [ ] No (created a new spec)
- [ ] N/A (minor change, no spec needed)

**Spec file path:** `.ai/specs/SPEC-014-2026-06-30-financial-pl-commercial-invoice-ux.md`

## Testing

- `yarn build:packages` — PASS · `yarn i18n:check-sync` — PASS
- `yarn workspace @open-mercato/financial-pl test` — **400 passed / 10 skipped** (incl. new unit + integration tests)
- Our-source typecheck (`tsc -p packages/financial-pl`) — **0 errors** (18 pre-existing errors are in the vendored `@open-mercato/ui/DataTable.tsx`, not this change).
- Live KSeF TEST (NIP 2481632647): VAT/KOR/ZAL/UPR/OSS accepted + UPO; self-billed rejected 410 (guard); certificate (XAdES) auth accepted. MF Wykaz NIP lookup live-verified.
- Four-model code-review jury (Claude + Codex + Kimi + DeepSeek), 2 fix rounds + a clean final round; 6 reproducible blockers fixed.

## Checklist

- [ ] This pull request targets `develop`. <!-- NOTE: official-modules' base is `main`; confirm the correct base for your repo before opening. -->
- [ ] I have read and accept the Open Mercato Contributor License Agreement (see `apps/docs/cla.md`). <!-- contributor to confirm -->
- [x] I updated documentation, locales, or generators if the change requires it. (README + i18n×4; `yarn generate` re-emits the route registry.)
- [x] I added or adjusted tests that cover the change. (unit + `TC-KSEF-UI-006` integration.)
- [x] I created or updated the spec in `.ai/specs/` with a changelog entry.

## Linked issues

N/A — no GitHub issue tracked for this change.
```
