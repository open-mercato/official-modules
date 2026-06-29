# SPEC-008 — `financial_pl`: KSeF invoice PDF visualization (wizualizacja)

- **Date:** 2026-06-28
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Builds on:** [SPEC-005](./SPEC-005-2026-06-26-financial-pl-ksef-connector.md), [SPEC-006](./SPEC-006-2026-06-27-financial-pl-ksef-corrections-jpk.md), [SPEC-007](./SPEC-007-2026-06-27-financial-pl-ksef-cert-auth-reliability.md)
- **Status:** Draft → for implementation (same branch as SPEC-007).

## TLDR
**Key Points:**
- Every Polish invoicing product (wFirma, inFakt, SaldeoSMART, Comarch) lets a user **download/print an invoice as PDF**. The `financial_pl` connector is send-only (FA(3) **XML** → KSeF) and has **no PDF**. This spec adds a **PDF visualization** (*wizualizacja faktury ustrukturyzowanej*) of the invoice.
- Under KSeF the **structured XML in KSeF is the legal invoice**; the PDF is explicitly a **visualization**, annotated with the **KSeF number** when assigned and a **KOD I verification QR** (per the official `kody-qr` spec): `https://qr[-env].ksef.mf.gov.pl/invoice/{NIP}/{DD-MM-YYYY}/{base64url(SHA-256 of the FA(3) XML)}`, labelled with the KSeF number or `OFFLINE`.
- Rendered with **`pdf-lib` + `@pdf-lib/fontkit`** (pure-JS, no native deps — the same engine the `forms` module uses) and a bundled **LiberationSans** font (OFL) so Polish diacritics (ł ż ó ą ę ć ń ś ź) render correctly. The QR is produced with `qrcode`.
- Exposed as `GET …/ksef/invoice-pdf?salesInvoiceId=` (returns `application/pdf`) + a "Download PDF" widget on the sales-invoice view.

**Scope (this spec):**
- A pure invoice-display model + a `pdf-lib` renderer for a standard Polish **Faktura VAT** layout (header, Sprzedawca/Nabywca, line table, VAT summary, totals, KSeF block + KOD I QR, "visualization" footer).
- KOD I verification-URL builder (hash of the FA(3) XML, base64url) + QR generation.
- Bundled OFL font; per-environment QR hosts in config.
- Download route + invoice-view widget; unit + integration tests.

**Concerns / boundaries:**
- **KOD II** (issuer-certificate QR, offline mode) is **out of scope** — it requires the offline KSeF certificate (SPEC-007 roadmap). Only **KOD I** is rendered.
- The PDF is a **visualization, not the legal document** (stated on the PDF). For an accepted invoice the display is sourced consistently with the send path; if an invoice is edited after acceptance, the KSeF number on the PDF still points to the authoritative KSeF copy (residual noted).
- Non-PLN currency / advance (ZAL/ROZ) invoices inherit the connector's existing out-of-scope status.

## Problem Statement
Users cannot produce a human-readable/printable invoice from the product. The connector only emits FA(3) XML for KSeF. Accountants, buyers, and archives need a PDF — the universal expectation set by every competitor.

## Proposed Solution
Add a KSeF-aware invoice PDF generator **inside `financial_pl`**, additively (no core change, no DB migration, no `sales` schema change). The generation core is **pure** (no DB/DI) so it is fully unit-testable; the route wires it to the existing invoice-resolution + submission-state reads.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| `pdf-lib` + `@pdf-lib/fontkit` (not `@react-pdf/renderer`) | Pure-JS, no native deps, already used by `forms`; `pdf-lib` is already in the tree. A server PDF route needs deterministic, dependency-light rendering. |
| Bundle **LiberationSans** (OFL) as base64 in a committed `.ts` | StandardFonts (Helvetica/WinAnsi) cannot render Polish Extended-A glyphs. base64-in-TS is self-contained (works in dev/jest/dist; `build.mjs` only runs esbuild, no asset copy). OFL permits redistribution (license shipped). |
| Render display from the **resolved FA(3) model** (reuse `resolveFa3FromInvoice`) | The PDF shows exactly the data the connector files to KSeF — single source of truth, no second mapping. |
| Compute the **KOD I hash from the stored `invoice_xml`** when an accepted submission exists (else from `buildFa3Xml(model)`) | The QR must hash the **exact bytes registered in KSeF** to be verifiable; the stored XML is those bytes (byte-stable, serialize-once per SPEC-005/007). |
| Source the KSeF number / hash / status from the **latest _accepted_ `document_kind='invoice'` submission** — not merely the latest (resolved from the spec-stage jury — DeepSeek) | A later **rejected** re-submission must not mask a prior accepted one: that would wrongly show `OFFLINE` and hash unregistered bytes (a QR that fails verification). Pick the newest row with `status='accepted'` (and `invoice_xml`); display still uses the current resolved model. |
| KOD I only; KOD II deferred | KOD II needs the offline certificate (roadmap). KOD I covers online + offline verification per the official spec. |
| Generation core is **pure** (`buildInvoicePdfModel`, `buildKodIUrl`, `renderInvoicePdf(model, {fontBytes, qrPng})`) | Unit-testable offline; the route is the only impure seam (resolver + submission read). |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Import `@open-mercato/pdf-generators` (SPEC-004, `@react-pdf/renderer`) | Not in this repo; heavier (react-pdf + fonts pipeline); a KSeF-specific visualization (number + KOD QR + FA fidelity) is better owned by `financial_pl`. (Revisit if a cross-module branded-template system is wanted.) |
| Render from a fresh resolve only (ignore stored XML) | The KOD I hash would not match the bytes in KSeF if the invoice changed post-send. Use the stored XML for the hash. |
| StandardFonts (Helvetica) | Cannot render Polish diacritics — unacceptable for a PL invoice. |
| HTML→PDF via Playwright/Chromium | Native/browser dep, heavy, non-deterministic in a server route. |

## User Stories
- **An accountant** downloads a PDF of an issued invoice (with its KSeF number + verification QR) to email a buyer or archive it.
- **A buyer** scans the KOD I QR to verify the invoice against KSeF.
- **A user** prints a not-yet-sent invoice as a draft visualization (labelled `OFFLINE`, no KSeF number).

## Architecture
### Pure core (`lib/`)
- `lib/invoice-pdf-model.ts` — `buildInvoicePdfModel(fa3Model, { ksefNumber?, ksefStatus, issuedOutsideKsef? }) → InvoicePdfModel` (header: number/issue date/sale date; seller+buyer with NIP/address; lines: Lp, nazwa, ilość, j.m., cena netto, wartość netto, stawka VAT, kwota VAT, wartość brutto; VAT summary grouped by rate; totals: razem netto/VAT/brutto + "do zapłaty"; KSeF block: number or OFFLINE + status). Pure.
- `lib/ksef-qr.ts` — `buildKodIUrl({ environment, sellerNip, issueDate, invoiceXml }) → string` = `${qrHost(environment)}/invoice/${nip}/${dd-mm-yyyy(issueDate)}/${base64url(sha256(utf8(invoiceXml)))}`. `qrHost` from config. Pure (reuses `crypto.sha256`; adds base64url).
- `lib/invoice-pdf.ts` — `renderInvoicePdf(model, { fontBytes, qrPng? }) → Promise<Uint8Array>` lays out the model with `pdf-lib` (registers `@pdf-lib/fontkit`, embeds the font, draws the table + the QR PNG when present). Pure.
- `lib/fonts/liberation-sans-regular.font.ts` — `INVOICE_FONT_BASE64` + `loadInvoiceFontBytes(): Uint8Array`. (OFL; license shipped as `assets/LICENSE_LIBERATION`.)
- `lib/invoice-qr.ts` (thin) — `generateQrPng(url): Promise<Uint8Array>` via `qrcode` (error-correction M). Isolated so the renderer stays sync-pure on bytes.

### Route + widget
- `api/ksef/invoice-pdf/route.ts` — `GET ?salesInvoiceId=` (feature `financial_pl.view`, org/tenant scoped, 400 if no scope/id, 404 unknown invoice). Resolves the FA(3) model (`resolveFa3FromInvoice`); reads the **latest _accepted_ `document_kind='invoice'` submission** (ksefNumber/status/invoice_xml) — falling back to `SalesInvoicePlMeta.ksef_number` — so a later rejected re-submission never masks an accepted one; builds the KOD I url (hash from the accepted submission's stored XML, else from `buildFa3Xml(model)` with an `OFFLINE` label), generates the QR, renders, returns `application/pdf` with `Content-Disposition: attachment; filename="<invoiceNumber>.pdf"`. Read-only (no mutation guard needed).
- `widgets/injection/ksef-invoice-pdf/{widget.ts,widget.client.tsx}` — a "Download PDF / Pobierz PDF" action on the sales-invoice view (mirrors `ksef-send-action`), linking to the route.

### Config
`config.ts` gains per-environment QR hosts: `qr-test` `https://qr-test.ksef.mf.gov.pl`, `qr-demo` `https://qr-demo.ksef.mf.gov.pl`, prod `https://qr.ksef.mf.gov.pl` + a `resolveKsefQrHost(environment)`.

## Data Models
**No new entity, no migration.** Reads the existing `KsefSubmission` (ksefNumber/status/invoice_xml) + `SalesInvoicePlMeta` + the resolved sales invoice. No `sales` change.

## API Contracts
| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/ksef/invoice-pdf` | `GET` | `financial_pl.view` | `?salesInvoiceId=` → `application/pdf` visualization. 400 (no scope/id), 404 (unknown invoice), 422 (invoice not serializable to FA(3) — same guards as the send path, e.g. unsupported currency/issue-date-missing). |

## Internationalization (i18n)
New keys (en+pl+de+es, sorted): `financial_pl.actions.downloadInvoicePdf` ("Download invoice PDF" / "Pobierz fakturę PDF"), `financial_pl.pdf.visualizationNotice` ("This is a visualization of a structured invoice; the source document is the invoice in KSeF." / "Wizualizacja faktury ustrukturyzowanej; dokumentem źródłowym jest faktura w KSeF."), `financial_pl.pdf.offline` ("OFFLINE"). Static FA-layout labels (Sprzedawca, Nabywca, NIP, Lp., Nazwa, Ilość, j.m., Cena netto, Wartość netto, Stawka VAT, Kwota VAT, Wartość brutto, Razem, Do zapłaty, Numer KSeF) are Polish invoice terms rendered on the document (a Polish fiscal document is Polish-language by law) — kept as document constants, not UI i18n.

## UI/UX
A "Download PDF" button on the sales-invoice view (widget injection). No new page. The PDF: A4, header with invoice number + dates, two-column Sprzedawca/Nabywca, the line table, the VAT summary, totals, the KSeF block with the KOD I QR (right-aligned) + the number/`OFFLINE` label, and the visualization-notice footer.

## Configuration
No new env vars required. Optional `OM_KSEF_QR_HOST` override (per-environment default otherwise). New deps: `@pdf-lib/fontkit`, `qrcode` (`pdf-lib` already present).

## Migration & Compatibility
No DB migration; additive route + widget + config + deps. Fully backward-compatible.

## Risks & Impact Review
### Data Integrity
- **PDF/KSeF drift**: an invoice edited after acceptance would show current data while KSeF holds the original. Mitigation: the KSeF number on the PDF points to the authoritative KSeF copy; the KOD I hash is computed from the stored (registered) XML so the QR verifies the KSeF copy, not the edited display. Residual: display vs KSeF copy can differ post-edit — flagged; most invoices are immutable post-send.
- **Wrong KOD I hash/URL** → QR fails verification. Mitigation: hash the exact stored `invoice_xml` bytes; base64url per the official spec; unit-tested against a known vector; DD-MM-YYYY date format per spec.
### Tenant & Data Isolation
- The route is `(organizationId, tenantId)`-scoped (resolver + submission read both scoped); no cross-tenant surface.
### Operational
- Synchronous render; invoices are small (one page) so `renderToBuffer`-class latency is negligible. New deps are pure-JS (no native build). Font adds ~136 KB (base64 ~186 KB) to the bundle.
### Risk Register
- **Polish glyphs missing** → unprofessional/incorrect PDF. **Eliminated**: a Unicode TTF (LiberationSans) is embedded via fontkit; a unit test renders a string with all Polish diacritics.
- **KOD I correctness** → Medium. Mitigated by the official-spec URL format + a hash unit test; full verification is a live scan against `qr-test` (handoff).

## Final Compliance Report — 2026-06-28
| Rule | Status | Notes |
|------|--------|-------|
| No core-package edits | Compliant | All in `financial_pl`. |
| Org+tenant scoping | Compliant | Route scoped via resolver + submission read. |
| zod-validate inputs | Compliant | `salesInvoiceId` validated. |
| No `any` / no hardcoded user strings | Compliant | i18n for UI; document constants are Polish fiscal labels by law. |
| Additive / BC (§27) | Compliant | New route/widget/config/deps; no removed surface; no migration. |
| Font license | Compliant | LiberationSans under OFL; `LICENSE_LIBERATION` shipped + attributed. |
| Hand crypto only where mandated (§16) | Compliant | Reuses `crypto.sha256`; only adds base64url formatting. |

## Integration Test Coverage
- **Unit (run locally):** `invoice-pdf-model.test.ts` (mapping, VAT summary, totals, accepted vs OFFLINE label), `ksef-qr.test.ts` (base64url SHA-256 vector + URL format + DD-MM-YYYY), `invoice-pdf.test.ts` (renders a valid `%PDF`, embeds the font so a Polish string lays out, embeds the QR when provided).
- **Integration TC-KSEF-006:** `…/invoice-pdf` → 401 anon, 400 (no id/scope), 404 (unknown invoice), 200 `application/pdf` for a known invoice.
- **Live (handoff):** scan the KOD I QR of an accepted invoice against `qr-test.ksef.mf.gov.pl` to confirm verification.

## Spec-stage cross-model review — 2026-06-28
DeepSeek V4 Pro (max): **fail → reconciled.** High: submission selection ambiguity (a later rejected re-submission could mask a prior accepted one → wrong `OFFLINE` + unverifiable hash) → fixed to source number/hash/status from the **latest accepted** invoice submission. Notes folded in: zero-padded DD-MM-YYYY (a `ksef-qr` test vector confirms), stored-XML byte-stability (guaranteed by the serialize-once design), and a multi-submission TC-KSEF-006 scenario. Codex + Kimi skipped (CLI absent). `cross-model (spec): confirmed (deepseek); codex + kimi skipped`.

## Code-stage cross-model review — 2026-06-28
Mandatory Claude fresh-reviewer: **PASS-WITH-NITS** — confirmed KOD I correctness, the latest-accepted-submission selection, stored-XML hashing, BigInt money math, Unicode font embedding, and tenant scoping; full spec coverage. **DeepSeek V4 Pro: PASS.** Codex + Kimi skipped (CLI absent). Two real findings, both fixed:
- **(Claude, Medium)** the KOD I QR host was derived from the org's *current* credential environment, so an invoice accepted on test/demo then switched to prod would get a wrong-host QR (hash still correct). **Fixed:** the host now uses the **accepted submission's stored `environment`** (authoritative); the current credential environment is used only for the OFFLINE/not-yet-accepted path.
- **(DeepSeek, note)** Content-Disposition filename used the raw invoice number → header-injection risk. **Fixed:** the filename is sanitized (`\p{L}\p{N}._-` only, capped).

`cross-model (code): confirmed (deepseek pass; claude pass-with-nits — 2 findings fixed); codex + kimi skipped`.

## Changelog
### 2026-06-28 — SPEC-008 initial
- KSeF invoice PDF visualization in `financial_pl` via `pdf-lib` + `@pdf-lib/fontkit` (bundled LiberationSans/OFL); KOD I verification QR (`qrcode`) per the official `kody-qr` spec (hash of the registered FA(3) XML, base64url; KSeF number or `OFFLINE` label); `GET …/ksef/invoice-pdf` + invoice-view download widget; per-environment QR hosts. KOD II / offline issuer QR deferred (needs the offline certificate). No core change, no migration.
