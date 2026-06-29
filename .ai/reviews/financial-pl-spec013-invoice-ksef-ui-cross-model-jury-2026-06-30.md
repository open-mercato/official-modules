# Cross-model review record — SPEC-013 (financial_pl invoice + KSeF backoffice)

- **Date:** 2026-06-30 · **Branch:** `feat/financial-pl-ksef` · **Scope:** `git diff c305637..HEAD` (financial_pl)
- **Jury:** Claude fresh-reviewer (mandatory) + Codex gpt-5.5 xhigh + Kimi K2.7 Thinking + DeepSeek V4 Pro max. Spec-stage (design) + code-stage (2 rounds).

## Spec-stage (Phase 3) — on the SPEC artifact
- Claude: ready. Codex `fail` (4), DeepSeek `fail` (1), Kimi `fail` (1). All reconciled into SPEC-013 before coding (lines read/write split, composed permissions, server-side immutability interceptor, KOR via verified core credit-memos API, deeper tests, **remove** dead injection wiring). `cross-model: confirmed (codex + kimi + deepseek)`.

## Code-stage round 1
- **Claude** `request_changes` — invoice-meta lock fail-open; DELETE `?id=` interceptor bypass; CorrectionForm wrong field; CorrectionForm negative quantity.
- **Codex** `fail` — invoice-meta fail-open; CorrectionForm field; PlVatMetaForm missing `orderSnapshot`.
- **DeepSeek** `fail` — `orderSnapshot` missing; stale currency in lines; CorrectionForm missing currencyCode/issueDate.
- **Kimi** `fail` — inverted `hasAllFeatures` (certificates page); inconsistent import; notes (params-as-Promise; currencyCode).
- **Reconciled (all fixed):** server-side invoice-meta 409 guard; interceptor resolves DELETE `?id=` from the URL; CorrectionForm reads `creditMemoId`, positive quantities, sends currencyCode+issueDate; `orderSnapshot` editor added (full `invoiceMetaPutSchema`); flat→InvoiceMeta edit prefill + reactive currency; `hasAllFeatures(granted,required)` standardized; tests strengthened (TC-UI-002 meta+DELETE 409, TC-UI-004 real payload).

## Code-stage round 2
- **Claude** `pass` (9/9 round-1 blockers confirmed resolved). **DeepSeek** `pass`. **Codex** `fail` (3) / **Kimi** `fail` (3).
- **Reconciled (all fixed):** `kodUrzedu` (+ contextNip) in the JPK generate UI (resolver requires it — Kimi+Codex); Issue-offline gated on `financial_pl.manage` (Codex); invoice-meta PUT composed gate (Kimi); CorrectionForm currency default PLN (Claude note).
- **Not a blocker:** Kimi optimistic-lock (the helper is additive — no header ⇒ no enforcement). **Codex `[id]` params-as-Promise: empirically refuted** (route returned 404 not 400). The real param bug was in the *pages* (catch-all → `useParams()` gave the slug array) — **found via the sandbox preview and fixed** (read `props.params.id`).

## Verification
- build:packages PASS · generate PASS · module jest **377 passed / 10 skipped** · i18n:check-sync PASS · our-source `tsc` **0 errors**.
- Sandbox preview on released core (DB `om_fpl_spec013`): nav + list + create + detail + JPK + certificates render; create→list→detail + KSeF badge/number + accepted-edit-lock + KOR form verified live.
- Pre-existing platform gaps (not this feature; also break the merged `forms` module / whole sandbox): vendored `@open-mercato/ui` `DataTable.tsx` type errors; `build:app` needs `@mdxeditor/editor` + `@radix-ui/react-scroll-area` (missing from the stale install).

**Verdict: ready (stop-before-PR).** Final round-2-remainder fixes verified by gate + preview (not re-juried).
