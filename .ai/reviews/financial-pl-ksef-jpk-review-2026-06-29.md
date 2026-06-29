# Code Review: `@open-mercato/financial-pl` — KSeF 2.0 e-invoicing + JPK_V7 VAT export

_Reviewed branch `feat/financial-pl-ksef` (financial-pl scope only; the upstream `forms` module merge from PR #23 is out of scope). 149 net-new files, ~28.4k insertions. Method: om-code-review skill + 9-dimension multi-agent review with per-finding adversarial verification and an end-to-end completeness critic (43 agents). Date: 2026-06-29._

> ## ✅ Remediation status — ALL 32 findings fixed (2026-06-29)
> Every finding below (7 High, 12 Medium, 13 Low) has been remediated, plus 2 latent bugs surfaced while writing tests. Verification gate after fixes: **typecheck PASS · build PASS (82 entry points) · jest PASS (346 passed / 10 skipped, was 306 — +40 tests) · i18n:check-sync PASS**.
>
> **High** — H1 snapshot rebuilt + the missing partial-unique `@Index` added to the `JpkVatFiling` entity so `db:generate` stays in sync (flag: confirm with a real `db:generate` in a consuming app, since no DB was available here); H2 export split into manage-gated `POST` (generate) + view-gated `GET` (stream-only, 422 when ungenerated); H3 V7K — `Deklaracja` now emitted only on the month-3 file and aggregates the whole quarter, months 1-2 are evidence-only; H4 `context_nip` threaded through the filing schema/command/unique-index (`coalesce(context_nip,'')`)/resolver queries/Podmiot1; H5 list reads use `findAndCountWithDecryption`; H6 + H7 tests added (resolver unit suite + `TC-KSEF-004` Playwright spec).
> **Medium** — M1 `closeOnlineSession` wrapped non-fatal; M2 header-only FX fallback now emits `P_14_xW`; M3 draft/void credit memos gated out of the register; M4 correction reports the memo's OWN `NrKSeF`; M5 mutation-guard registry wired on JPK writes; M6 duplicate filing → clean 409; M7 inline validators moved to `data/validators.ts`; M8 real `retryLastMutation` wired; M9 missing i18n key added (4 locales); M10/M11/M12 validator/command/subscriber tests added.
> **Low** — L1 `z.unknown()`; L2 status param validated; L3 GET no longer mutates; L4 generate guards a `submitted` filing; L5 retry routes to repoll when both refs present; L6 OSS destination-rate invariant documented; L7 `correctionScope` cross-field refine; L8 `TerminPlatnosci`/`DataZaplaty` made mutually exclusive; L9 `self_assessed_rate` threaded through (derives VAT when absent); L10 4 dead i18n keys removed; L11 `index.ts` re-exports `features`; L12 `REDME.md`→`README.md`; L13 one-letter vars renamed in the XML builder.
> **Bonus bugs found via the new tests** — (a) `optionalMoneySchema` rejected `''` despite its comment promising tolerance (a cleared form field would 422) — regex fixed; (b) `deletePurchaseRecordCommand` used `.pick()` on a `.refine()`-wrapped schema, which throws in zod v4 so the DELETE endpoint always 500'd — replaced with a standalone `jpkPurchaseRecordDeleteSchema`.

## Summary

A large, well-structured, genuinely impressive Polish e-invoicing connector: KSeF 2.0 submission flow, XAdES signing, certificate enrollment, FA(3) mapping (incl. corrections, credit memos, advances, OSS), offline mode, invoice PDF, and a new JPK_V7M/V7K VAT export. **Tenant isolation and cryptography are solid — no cross-tenant leak was found end to end, and no raw-`em.find`-on-encrypted-entity data exposure reaches a response.** The residual risk is concentrated in the **newest, still-uncommitted JPK export subsystem**, which has two correctness defects (V7K quarterly aggregation; multi-NIP aggregation), a migration-snapshot omission that breaks downstream `db:generate`, an authorization gap on the export route, and essentially no test coverage for its orchestrator/routes/validators. No blocker is a security/data-leak issue; the High items are correctness + tooling + missing-coverage. Recommend addressing the 7 High findings before this JPK work is committed/merged.

**Verdict: Request changes** (7 High, 12 Medium, 13 Low; 0 Critical). 1 reviewer finding was rejected as a false positive (spec naming — see end).

## CI/CD Verification

Runner: **local** (no dev Docker stack present — only a Verdaccio registry). Gate run scoped to the changed package (`@open-mercato/financial-pl`); other workspace packages are unchanged on this branch.

| Gate | Status | Notes |
|------|--------|-------|
| `build` (`node build.mjs`) | ✅ PASS | 82 entry points built |
| `typecheck` (`tsc --noEmit`) | ✅ PASS | |
| `test` (`jest`) | ✅ PASS | 306 passed, 10 skipped, 1 suite skipped (32/33 suites) |
| `i18n:check-sync` | ✅ PASS | all 4 locales (en/pl/de/es) in sync |
| `i18n:check-usage` | ⚠️ WARN | advisory/non-blocking; surfaces M9 (missing key) + L11 (4 dead keys) |
| `generate` / `build:app` | n/a | these map to `yarn workspace sandbox …`; financial-pl is not installed in the sandbox app, so the package-scoped gates above are the meaningful CI mirror for this change |

## Findings

### Critical
_None._

### High

**H1 — Stale ORM snapshot: both new JPK tables are missing from `.snapshot-open-mercato.json`.**
`migrations/Migration20260629120000_financial_pl_jpk.ts` creates `financial_pl_jpk_purchase_record` and `financial_pl_jpk_filing` (with their indexes + the partial unique index `financial_pl_jpk_filing_active_unique`), but the committed snapshot still contains only `financial_pl_invoice_meta` and `financial_pl_ksef_submissions`. (Confirmed directly: snapshot table list has 0 JPK hits; the SPEC-009/010 additive columns _were_ folded in, so this is an isolated omission from the latest work.) The snapshot is the baseline `db:generate` diffs against, so the next generate on any consumer re-emits a duplicate `CREATE TABLE` for both tables (or fails on already-existing objects). _Fix:_ regenerate the snapshot (`yarn mercato db:generate` / the module snapshot-update step) and commit it — do not hand-edit. `migrations/.snapshot-open-mercato.json`.

**H2 — JPK export `GET` performs a DB write but is gated by the read-only `financial_pl.view` feature.**
`api/ksef/jpk/export/route.ts:15` declares `GET: { requireFeatures: ['financial_pl.view'] }`, yet the handler unconditionally runs `commandBus.execute('financial_pl.jpk.generate', …)` (`route.ts:62-66`), which builds + persists the encrypted `generated_xml`, flips `status → 'generated'`, and sets `generatedAt` (`commands/jpk.ts:238-242`). `setup.ts:37` grants `employee: ['financial_pl.view']`, while every other write requires `financial_pl.*`/manage — so a view-only user can generate/persist XML and mutate a filing's lifecycle via a GET. (Also a REST GET-with-side-effect; see L3/L4.) _Fix:_ either gate the export with the manage feature, or split generation (manage-gated `POST`) from download (view-gated `GET` that only streams an already-generated filing, 422 when none). `api/ksef/jpk/export/route.ts:14-16,62-66`.

**H3 — V7K quarterly declaration is computed wrong (two facets of one defect).**
For a quarterly JPK_V7K filing: (a) `resolveJpkFiling` reads evidence for exactly one `(year, month)` and computes the `Deklaracja` from that single month, so the month-3 file understates `P_37/P_38/P_48/P_51` by the first two months of the quarter (`lib/jpk/resolve-jpk-filing.ts:269-371`); and (b) emission is driven only by `correctionScope`, never by `variant`+month-in-quarter, so months 1-2 _also_ emit a `Deklaracja` instead of being evidence-only (`lib/jpk/build-jpk-xml.ts:201-202`, `resolve-jpk-filing.ts:405-408`). Net: a V7K quarter currently files three declarations where the law expects one (month-3, whole quarter). XSD-valid but legally wrong. _Fix:_ branch on `variant==='V7K'`: suppress `Deklaracja` when `month % 3 !== 0`, and on the month-3 file aggregate all three months' evidence into the `P_*` totals. Add a V7K-quarter compute test (assert `P_38` = sum across 3 months) and a V7K-month-1 emit test (evidence-only).

**H4 — Multi-NIP: the JPK filing and resolver never scope by `context_nip`, so one filing aggregates every NIP in the org+tenant under a single `<NIP>`.**
`resolveJpkFiling` aggregates sales (by issue-date) and purchases (`em.find(PurchaseVatRecord, { organizationId, tenantId, year, month })`, `resolve-jpk-filing.ts:331-337`) with **no `context_nip` predicate**, while `Podmiot1.NIP` is stamped from `filing.contextNip ?? deps.contextNip` (`:374`). Compounding: `jpkFilingUpsertSchema` (`data/validators.ts:521-535`) omits `contextNip` entirely (so `JpkVatFiling.context_nip` is never populated and the fallback credential NIP always wins), and the unique index `financial_pl_jpk_filing_active_unique` is `(org, tenant, variant, year, month, cel_zlozenia)` **without `context_nip`** — a multi-NIP org cannot even create separate filings per NIP. Every entity carries a `context_nip` column precisely because one org+tenant can host multiple NIP contexts. _Fix:_ either document + enforce a single-NIP-per-(org,tenant) invariant, or thread `context_nip` through the filing schema/command, the unique index, and every resolver query filter. _(Surfaced only by the end-to-end critic — invisible per-layer because each layer is individually "correct".)_

**H5 — List endpoints read encrypted entities via raw `em.findAndCount` instead of the decryption helper.**
`api/ksef/jpk/filings/route.ts:70` (`JpkVatFiling.generated_xml` encrypted) and `api/ksef/submissions/route.ts:80` (`KsefSubmission.invoice_xml`/`upo_xml` encrypted) use raw finds. The checklist's anti-pattern table classifies raw `em.find`/`em.findOne` on encrypted entities as High regardless of projection. **Runtime data-exposure risk here is nil** — `toRow` deliberately projects the encrypted columns out, and the export path correctly uses `findOneWithDecryption` — so this is a convention/consistency issue, not a live leak. _Fix:_ switch list reads to `findWithDecryption({ organizationId, tenantId })`, or explicitly document the project-out carve-out so future readers don't treat it as an oversight.

**H6 — `resolve-jpk-filing.ts` (the entire JPK end-to-end pipeline) has zero direct test coverage.**
The 17 KB orchestrator that joins every JPK builder — pending-skip, OSS-exclusion, proforma/immutable gate, credit-memo sign-negation + `TypDokumentu`-drop + meta-keyed-by-original-invoice, `PurchaseVatRecord` self-assessment threading, `KodUrzedu` throw — has no test (`grep` confirms no test imports it). Its direct analogue `resolve-fa3-from-credit-memo.ts` _is_ thoroughly tested, underlining the gap; a marking/sign error here corrupts a filed VAT return. _Fix:_ add `lib/jpk/__tests__/resolve-jpk-filing.test.ts` reusing the in-memory `makeQueryEngine()` harness + a stub `em`; cover the 8 branches listed in the workflow output (pending-skip, NrKSeF node, OSS-exclude, credit-memo negate/inherit-marking-not-TypDokumentu, proforma-skip, WNT self-assessment, KodUrzedu throw, V7K Kwartal derivation).

**H7 — The three new JPK API routes (`export` / `filings` / `purchase-records`) have no route-level/integration test.**
Integration suite covers `TC-KSEF-001..008` (submissions, certs, PDF, meta, offline) but not a single JPK route. These carry the exact tenant-isolation contract flagged as risk-heavy (`filterIds===[]` fail-closed, cross-org `filingId → 404`, org-scoped narrowing) plus the view-vs-manage gates, the 422 "no generated XML" path, and the soft-delete DELETE — all untested. _Fix:_ add `__integration__/TC-KSEF-004.spec.ts` (the missing number) / the specced `TC-JPK-001`: 401 unauth, 403 without manage, cross-org `filingId → 404`, two-org list returns only caller-org rows, 422 on ungenerated filing, `application/xml` attachment on success, DELETE soft-deletes.

### Medium

**M1 — Unguarded `closeOnlineSession` can discard a successful send.** After a successful send, `lib/submission-flow.ts:123` calls `await client.closeOnlineSession(...)` with no try/catch (and not wrapped in `pace`) _before_ the status poll. A transient close failure throws the whole `submitInvoiceToKsef` before the `sessionReference`+`invoiceReference` are returned; the consumer (`subscribers/ksef-submit.ts:83-95`) then resets to `queued` without those refs, disabling the no-duplicate `repoll` recovery and forcing a re-send (only saved by KSeF 440 content-dedup). Session close is best-effort. _Fix:_ wrap close in non-fatal try/catch, or move it after the poll.

**M2 — Header-only FX fallback omits the PLN-converted `P_14_xW`.** In `buildVatBreakdown`, the `buckets.size === 0` header-derived fallback never sets `vatPln` even when `opts.fxRate` is supplied (`lib/fa3-mapping.ts:364-374`); only the line-based branch computes it (`:378-394`). A line-less foreign-currency invoice routed through the fallback files a `P_14_x` with no statutory `P_14_xW` (art. 106e ust. 11) and passes validation. _Fix:_ compute `vatPln` in the fallback using the same `vatScaled * fxScaled / 10000n` math when an FX rate is present.

**M3 — Credit memos enter the JPK register with no status/immutability gate.** Sales invoices are gated to issued/immutable, non-proforma rows, but credit memos are pulled by issue-date range only (`lib/jpk/resolve-jpk-filing.ts:307-328`) — `SalesCreditMemo` has no `is_immutable` column — so a draft/voided memo issued in-period is included as a negative correction, understating output VAT. (Same ungated pattern in `sendFromCreditMemoCommand`.) _Fix:_ add a finalized/non-draft status gate for memos; cover with a resolver test that a draft memo is excluded.

**M4 — Correction row reports the original invoice's NrKSeF, not the credit memo's own.** For `sign === -1` the KSeF node is resolved from the corrected original invoice id (`resolve-jpk-filing.ts:223-225`), so the `SprzedazWiersz` correction carries the original's KSeF number rather than the memo's own `credit_memo` submission number. Marker/OSS inheritance from the original is correct; only the reported NrKSeF is wrong. _Fix:_ resolve NrKSeF from the memo's own accepted submission, falling back to the original's marking only when absent.

**M5 — JPK `filings`/`purchase-records` writes bypass the mutation-guard registry every sibling route uses.** `filings/route.ts:83-115` (POST) and `purchase-records/route.ts:97-160` (POST/DELETE) call `commandBus.execute` directly with no guard validation / after-success hook, unlike submissions + invoice-meta + certificate routes. Writes are still tenant-scoped (not an isolation hole), but any registered guard/optimistic-lock/conflict policy for the JPK resource kinds is silently bypassed. _Fix:_ wire the guard registry (`runMutationGuards`) around the upsert/delete commands, or document the exemption in SPEC-012.

**M6 — Duplicate JPK filing/purchase POST returns a raw 500 instead of a clean 409.** `commands/jpk.ts:200` (filing) and `:128` (record) `persist().flush()` with no `isUniqueViolation`/23505 catch, unlike `ksef-submission.ts:237-250` which catches the race and returns the winner. With `financial_pl_jpk_filing_active_unique`, a normal operator double-click on the same period throws a Postgres 23505 mapped to a generic 500. _Fix:_ catch the unique violation and return the existing filing / a 409; add a duplicate-period POST test. _(Critic.)_

**M7 — Request validators defined inline in 3 routes instead of `data/validators.ts`.** `enrollBodySchema`/`revokeBodySchema` (certificates enroll/revoke) and the full `invoiceMetaPutSchema` (+ nested `advancePayment`/`advanceRef`/`orderSnapshot`/`orderLine`/`procedureMarkings` schemas) live inline. Inputs _are_ validated (no security gap), but AGENTS.md + checklist §2/§4 require schemas in `data/validators.ts`; the other 12 routes comply. _Fix:_ move them into `data/validators.ts` with `z.infer` types.

**M8 — PL VAT meta panel passes a non-functional `retryLastMutation` stub.** `widgets/injection/pl-vat-meta-fields/widget.client.tsx:91` destructures only `{ runMutation }` and `:173` passes `context: { retryLastMutation: async () => false }` — a hard-coded no-op — while sending an optimistic-lock header (`:161`). On a 409 conflict the AppShell `RecordConflictBanner`'s retry is wired to a function that can never succeed. Canonical core pages pass the real `retryLastMutation`. _Fix:_ destructure `{ runMutation, retryLastMutation }` and pass the real function through (add to the `handleSave` dep array).

**M9 — i18n key `financial_pl.status.offline_overdue` is missing from all 4 locales.** Referenced at `widgets/injection/ksef-status-column/widget.client.tsx:97,100` (tooltip + badge) but absent from en/pl/de/es. Hardcoded fallbacks keep `check-sync` green, but PL/DE/ES users always see English, and the two call sites pass _different_ fallbacks ("Overdue: …past the statutory deadline" vs "Overdue") so label and tooltip diverge. _Fix:_ add `financial_pl.status.offline_overdue` to all 4 locales; if the long tooltip needs localizing, add a separate `…_hint` key.

**M10 — New JPK Zod validators have no direct unit-test coverage.** `validators.test.ts` exhaustively covers FA(3) schemas but never imports `jpkPurchaseRecordUpsertSchema` / `jpkFilingUpsertSchema` / `jpkGenerateSchema`, leaving the cross-field `NrKSeF`-requires-`nrKsef` refine, the structural KSeF-number refine, the 4-digit `KodUrzedu` regex, the year≥2026/month/quarter bounds, and `optionalMoneySchema` unverified (`data/validators.ts:479-540`). A regression loosening the NrKSeF/nrKsef coupling would build an XSD-invalid row undetected. _Fix:_ add a "JPK validators" describe block (cases enumerated in the workflow output). _(Consolidates two reviewer findings.)_

**M11 — JPK commands' cross-org/tenant 404 guards are untested.** All four JPK commands scope `findOne` by `{ id, organizationId, tenantId, deletedAt:null }` and throw 404 on miss (`commands/jpk.ts:108-155`) — the core cross-tenant guard — but no test instantiates any JPK command, so a future refactor dropping org/tenant from a find would pass CI and allow cross-org overwrite/delete of VAT evidence. _Fix:_ add `commands/__tests__/jpk.test.ts` (cross-org → 404 for each; generate without NIP → 409 `credentials_missing`).

**M12 — `ksef-repoll` and `ksef-send-offline` subscribers have no isolation test for their state-machine resets.** The two most idempotency-critical retry-driven handlers are untested directly (`subscribers/ksef-repoll.ts:40-148`, `ksef-send-offline.ts`). Untested branches carry real lost-update/double-send risk if regressed (missing-creds reset+re-emit, transient-error rethrow-without-write, non-terminal reset). The proven sibling `ksef-submit` + reconcile worker _are_ covered (hence Medium). _Fix:_ add `__tests__` for both asserting the CAS claim / claim-lost bail / reset-and-rethrow paths.

### Low

**L1 — `declarationInputs: z.record(z.string(), z.any())`** accepts arbitrary unvalidated values (the only `any`-shaped escape hatch in the data layer). Use `z.unknown()` (matches the entity's `Record<string, unknown>`) or enumerate the supported override keys. `data/validators.ts:534`.

**L2 — `submissions` GET casts the unvalidated `status` query param** via `as KsefSubmission['status']` instead of using `ksefSubmissionListQuerySchema` (`api/ksef/submissions/route.ts:65-66`). Not an injection (parameterized equality → empty result), but an invalid value should 400, not silently match nothing.

**L3 — JPK export uses `GET` for a state-mutating operation** (`api/ksef/jpk/export/route.ts:28-66`) — caching proxies/prefetchers/link-followers may trigger generation. Facet of H2; move generation to POST.

**L4 — `generateCommand` unconditionally overwrites `status`/`generatedXml`** with no guard against a terminal (`submitted`) filing (`commands/jpk.ts:238-242`). Currently unreachable (nothing transitions to `submitted` yet), but once a submit-to-MF path exists, an export GET would clobber it. _Fix:_ guard `if (status === 'submitted') throw 409`, or short-circuit when already generated (also makes the GET idempotent).

**L5 — `retryCommand` can re-queue an actively-processing submission** (`commands/ksef-submission.ts:276-284`) — blocks only `accepted`. Mitigated by optimistic lock + 440 dedup, but the retry path and the reconcile worker make _opposite_ recovery decisions for a `processing` row with both references (worker re-polls, retry forces re-send). _Fix:_ align retry with `chooseRecovery` — if both refs present, emit `repoll`/409 instead of resetting to `queued`. _(Also raised by the critic.)_

**L6 — OSS destination rate taken verbatim from the line's stored `tax_rate`** (`lib/resolve-fa3-from-invoice.ts:113-121`, same in credit-memo resolver) — correct only if upstream stored the consumption-country rate; a Polish rate would file a wrong `P_12_XII`, and OSS lines bypass the domestic rate-reconcile guard. _Fix:_ validate against the destination-country table or document the invariant.

**L7 — `correctionScope` not bound to `celZlozenia=2`** (`data/validators.ts:521-535`) — a primary filing (`celZlozenia=1`) with scope `declaration`/`evidence` passes validation and emits a partial primary file. _Fix:_ `superRefine` rejecting `correctionScope !== 'both'` when `celZlozenia === 1`.

**L8 — `buildSprzedazRow` can emit both `TerminPlatnosci` and `DataZaplaty`** (`lib/jpk/build-sprzedaz.ts:96-111`), violating the XSD `choice` (exactly one). Unreachable from production paths today (resolver never populates `korekta`), but the builder offers no guard. _Fix:_ make the two mutually exclusive; add a builder test.

**L9 — `self_assessed_rate` is silently dropped on the write path.** The column exists (`entities.ts:438-439`) and SPEC-012 defines it, but it's absent from `jpkPurchaseRecordUpsertSchema`, the command `fields`, and the resolver — so it's permanently unsettable. _Fix:_ add it to schema+command+builder, or remove the dead column. _(Critic.)_

**L10 — 4 dead i18n keys.** `financial_pl.actions.send`/`.retry`/`.invoiceIssuedOffline`/`.offlineInvoiceSent` have zero source references and aren't built dynamically (verified — not `check-usage` false positives). _Fix:_ remove from all 4 locales, or wire to their intended call sites. `i18n/*.json`.

**L11 — `index.ts` doesn't re-export `features`.** AGENTS.md's template and all 3 sibling modules do `export { features } from './acl'`; financial_pl omits it (`index.ts:1-11`). **No runtime effect** — the generator reads `acl.ts` by path — purely a consistency nit. _Fix:_ add the re-export.

**L12 — `.ai/specs/README.md`** was a misspelled `REDME.md` (transposed). Pre-existing on `main` (not introduced by this work) but flagged as requested. _Fix:_ `git mv` to `README.md` and update links.

**L13 — One-letter accumulator/object variables in the JPK XML builders** (`s`/`n`/`p`/`e` in `lib/jpk/build-jpk-xml.ts:65,74-103,131-175`). Tight local helpers, minimal impact. _Fix (optional):_ `xml`/`node`/`header`/`party`; leave conventional loop indices.

## Backward Compatibility

Module is **net-new** vs `main` — no existing contract surface is removed/renamed, so the BC checklist is largely N/A. Forward-looking note: the new event IDs, widget injection spot IDs, API route URLs, DI names, ACL feature IDs, and DB columns become **frozen contract surfaces** from here on. One real BC-adjacent design gap to settle _before_ release: the JPK filing unique index and schema lack `context_nip` (H4) — fixing it later is a schema/contract change.

- [x] No contract surface removed or renamed (net-new module)
- [x] No event IDs / spot IDs / route URLs / DB columns removed
- [ ] **Settle multi-NIP filing identity before freezing the JPK schema/index (H4)**

## Checklist

- [x] No raw-`em.find`-on-encrypted-entity reaches a response (decryption helpers used for actual reads; list reads project encrypted cols out — see H5 for the convention nit)
- [x] All API routes export `openApi` and `metadata` with `requireAuth`/`requireFeatures`
- [x] Tenant isolation: every query filters by `organization_id`/`tenant_id` (no cross-tenant leak found end to end)
- [ ] **JPK export write is gated by a read feature (H2)**
- [x] Validators use zod + `z.infer`; no non-test `: any`/`as any` (one `z.any()` — L1)
- [ ] **Validators in `data/validators.ts`** — 3 routes inline (M7)
- [x] Events declared in `events.ts` via `createModuleEvents` before emit; subscribers/workers export `metadata`; worker concurrency ≤ 20
- [x] No cross-module ORM relationships; cross-module via FK IDs + extensions + enrichers; DI via Awilix; optional peers resolved defensively
- [x] ACL features use object form `{ id, title, module }` and are mirrored in `setup.ts` `defaultRoleFeatures`
- [ ] **Migration snapshot reflects post-migration schema (H1)**
- [x] Migration SQL is scoped to financial_pl tables only (no unrelated churn)
- [ ] **Behavior covered by tests** — JPK resolver/routes/validators/commands + repoll/offline subscribers lack coverage (H6, H7, M10, M11, M12)
- [x] No empty `catch` blocks; subscribers/workers idempotent via CAS claims (KSeF path); commands undoable with snapshots
- [ ] **i18n: one missing key + 4 dead keys (M9, L10)**
- [x] UI uses `useGuardedMutation`/`apiCall`/`flash` — except the no-op `retryLastMutation` stub (M8)
- [x] Spec filenames follow this repo's `SPEC-{n}-{date}-{slug}.md` convention (see note below)

## Notes — false positive filtered out

One reviewer flagged the new specs (`SPEC-011…`, `SPEC-012…`) for not using `{YYYY-MM-DD}-{slug}.md`. **Rejected:** the `official-modules` repo has its own authoritative convention in `.ai/specs/AGENTS.md` — `SPEC-{number}-{date}-{title}.md` — which the new files follow correctly (sequential 011/012). The `{date}-{slug}` rule comes from a _different_ repo's skill; renaming would violate this repo's standard. No action.

---
_Generated by om-code-review (9 dimensions, adversarial per-finding verification, completeness critic). The KSeF submission/crypto/tenant-isolation core is in good shape; focus remediation on the JPK export subsystem (H1–H7) before committing the staged work._
