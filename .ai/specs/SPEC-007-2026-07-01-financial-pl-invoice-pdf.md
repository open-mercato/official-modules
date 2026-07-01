# SPEC-007 — `financial_pl`: KSeF invoice PDF visualization (wizualizacja) — paginated FA(3) rendering + KOD I/KOD II dual QR

- **Date:** 2026-07-01
- **Module:** `financial_pl` · **Package:** `@open-mercato/financial-pl` · **License:** MIT
- **Status:** Implemented · live-verified against KSeF TEST (KOD I scan against `qr-test.ksef.mf.gov.pl`; KOD II unit- and structure-verified, live acceptance env-gated).
- **Thematic siblings (this is one of four consolidated `financial_pl` specs):**
  - [SPEC-005 — KSeF connector & submission](./SPEC-005-2026-07-01-financial-pl-ksef-connector-submission.md) — transport, sessions, status/UPO, idempotency + reconciliation, **offline24/awaryjny issuance mechanics + Offline-certificate enrollment**, batch, inbound receiving, credentials, `KsefSubmission` data model.
  - [SPEC-006 — FA(3) documents, corrections & JPK](./SPEC-006-2026-07-01-financial-pl-fa3-documents-corrections-jpk.md) — the FA(3) serializer (`resolveFa3FromInvoice`, `buildFa3Xml`), all doctypes, corrections, OSS, NBP FX, JPK_V7 + `SalesInvoicePlMeta`.
  - [SPEC-008 — invoice authoring UI](./SPEC-008-2026-07-01-financial-pl-invoice-authoring-ui.md) — the operator backoffice (list/create/detail/edit, JPK, certificates), the tabbed invoice editor and its download action.
- **This spec owns:** the human-readable invoice **PDF** (`lib/invoice-pdf.ts`, `lib/invoice-pdf-model.ts`, `lib/invoice-qr.ts`, `lib/ksef-qr.ts`, `lib/ksef-qr-cert.ts` *rendering* consumption, `lib/fonts/*`), the `…/ksef/invoice-pdf` download route, paginated A4 layout, and the dual verification QR (KOD I + KOD II) **as rendered on the PDF**.

## TLDR

**Key Points:**
- Every Polish invoicing product (wFirma, inFakt, SaldeoSMART, Comarch, Fakturownia) lets a user **download/print an invoice as PDF**. `financial_pl` emits the FA(3) **XML** that is the legal document in KSeF; this spec adds the **PDF visualization** (*wizualizacja faktury ustrukturyzowanej*) that every competitor ships.
- Under KSeF the **structured XML in KSeF is the legal invoice**; the PDF is explicitly a **visualization**, annotated with the **KSeF number** when assigned and a verification **QR**. Two QR codes are supported per the official `kody-qr` spec:
  - **KOD I** (verification QR, always rendered): `https://qr[-env].ksef.mf.gov.pl/invoice/{NIP}/{DD-MM-YYYY}/{base64url(SHA-256 of the FA(3) XML)}`, labelled with the KSeF number or `OFFLINE`.
  - **KOD II** (cert-signed offline QR, rendered for offline-issued invoices when an **Offline** KSeF certificate is configured): `…/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}/{signature}`, labelled `CERTYFIKAT`. The KOD II URL + signature are built by the offline/connector layer (`lib/ksef-qr-cert.ts`, SPEC-005); this spec **renders** it as the second QR.
- Rendered with **`pdf-lib` + `@pdf-lib/fontkit`** (pure-JS, no native deps — the same engine the `forms` module uses) and a bundled **LiberationSans** font (OFL) so Polish diacritics (ł ż ó ą ę ć ń ś ź) render correctly. QR PNGs are produced with `qrcode` (ECC-M).
- The line table **paginates**: invoices with more than ~45 line items spill onto additional A4 pages with a repeated table header and a "page n / m" footer; the VAT summary, totals and QR block always render on the **final** page. A ≤ ~45-line invoice is **byte-identical** to the pre-pagination single-page output (a locked regression invariant).
- Exposed as `GET …/ksef/invoice-pdf?salesInvoiceId=` (returns `application/pdf`) + a "Download PDF" action on the invoice detail/edit surface (SPEC-008).

**Scope (this spec):**
- A pure invoice-display model + a paginated `pdf-lib` renderer for a standard Polish **Faktura** layout (header, Sprzedawca/Nabywca, multi-page line table, VAT summary, totals, KSeF block + QR(s), "visualization" footer).
- The KOD I verification-URL builder (hash of the registered FA(3) XML, base64url) + QR PNG generation, and the **rendering** of the pre-built KOD II URL.
- Bundled OFL font; per-environment QR hosts in config.
- Download route + invoice-detail download action; unit + integration tests.

**Concerns / boundaries:**
- **KOD II *issuance* mechanics** — Offline-certificate enrollment, the RSA-PSS / ECDSA-P1363 signing of the KOD II URL fragment, the offline24/awaryjny lifecycle, and the persisted `kod_i_url`/`kod_ii_url`/`offline_certificate_serial` columns — live in **SPEC-005**. This spec consumes the resulting URL and draws the QR; the crypto is not re-specified here.
- The FA(3) **document construction** (`resolveFa3FromInvoice`, `buildFa3Xml`, doctypes, FX, corrections) lives in **SPEC-006**; the PDF renders that model, it does not build FA(3).
- The PDF is a **visualization, not the legal document** (stated on the PDF). For an accepted invoice the QR hash is computed from the **registered** XML so the QR verifies the authoritative KSeF copy; if an invoice were edited after acceptance, the display could differ from the KSeF copy while the QR still verifies the registered copy (residual, noted).

## Overview

> **Market reference**: wFirma, inFakt, Comarch, Fakturownia and SaldeoSMART all produce a downloadable/printable invoice PDF; the offline-capable ones (wFirma, inFakt, Comarch) render the **dual QR** (KOD I + the cert-signed KOD II) on offline24/awaryjny invoices and label them per the MF `kody-qr` convention. This spec matches that baseline.

The `financial_pl` connector files structured FA(3) XML to KSeF (SPEC-005/006). The XML is the legal invoice, but accountants, buyers and archives need a human-readable **PDF** — the universal expectation set by every competitor. This spec adds a KSeF-aware PDF generator **inside `financial_pl`**, additively (no core change, no DB migration, no `sales` schema change). The generation core is **pure** (no DB/DI) so it is fully unit-testable; the download route is the only impure seam, wiring the resolver + the submission-state reads to the pure renderer.

Two aspects distinguish a KSeF visualization from a generic invoice PDF:
1. It carries the **KSeF number** (once assigned) or the `OFFLINE` label, plus a **verification QR** a buyer can scan to check the document against KSeF.
2. For invoices issued **outside KSeF at issue time** (offline24 / tryb awaryjny — see SPEC-005), it additionally carries the **cert-signed KOD II QR**, so the buyer holds a self-verifiable document before the invoice has ever reached KSeF.

## Problem Statement

1. **No PDF.** The connector emits only FA(3) XML for KSeF. There is no way to produce a human-readable/printable invoice from the product, unlike every mainstream Polish competitor.
2. **Polish glyphs.** `pdf-lib` `StandardFonts` (Helvetica / WinAnsi) cannot render Polish Extended-A diacritics; a Polish fiscal document that mangles `ł ż ó ą ę ć ń ś ź` is unacceptable.
3. **Verification QR.** A KSeF visualization must carry the official KOD I verification QR whose hash matches the **exact bytes registered in KSeF**, or the QR fails verification.
4. **Offline dual QR.** An offline-issued invoice (SPEC-005) is handed to the buyer *before* it reaches KSeF; it must carry the cert-signed **KOD II** QR so the buyer can verify it against the issuer certificate in the interim. Rendering the second QR is the missing PDF-side piece.
5. **Single-page overflow.** A naïve single-page renderer overflows/clips past ~45 line items; a real invoice can have hundreds of lines.

## Proposed Solution

Add a KSeF-aware, **paginated** invoice PDF generator inside `financial_pl`. Keep the generation core pure (`buildInvoicePdfModel`, `buildKodIUrl`, `renderInvoicePdf`) and expose it through a single read-only download route. Render display from the **resolved FA(3) model** (reuse `resolveFa3FromInvoice`) so the PDF shows exactly the data filed to KSeF — one source of truth, no second mapping. Compute the KOD I hash from the **stored registered XML** of the latest *accepted* invoice submission so the QR verifies the KSeF copy. Draw the KOD II QR whenever the invoice is offline-issued and an Offline certificate is configured, using the URL the offline layer already built.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `pdf-lib` + `@pdf-lib/fontkit` (not `@react-pdf/renderer`, not HTML→PDF) | Pure-JS, no native deps, already used by `forms`; `pdf-lib` is already in the tree. A server PDF route needs deterministic, dependency-light rendering. |
| Bundle **LiberationSans** (OFL) as base64 in a committed `.ts` | StandardFonts cannot render Polish Extended-A glyphs. base64-in-TS is self-contained (works in dev/jest/dist; `build.mjs` only runs esbuild, no asset-copy step). OFL permits redistribution (license shipped as `assets/LICENSE_LIBERATION`). |
| Render display from the **resolved FA(3) model** (reuse `resolveFa3FromInvoice`) | The PDF shows exactly the data the connector files to KSeF — single source of truth, no second mapping. |
| Compute the **KOD I hash from the stored `invoice_xml`** of an accepted submission (else from `buildFa3Xml(model)`) | The QR must hash the **exact bytes registered in KSeF** to verify; the stored XML is those bytes (byte-stable, serialize-once per SPEC-005/006). |
| Source number/hash/status from the **latest _accepted_ `document_kind='invoice'` submission** — not merely the latest | A later **rejected** re-submission must not mask a prior accepted one (that would wrongly show `OFFLINE` and hash unregistered bytes → a QR that fails verification). Pick the newest row with `status='accepted'` (and a stored `invoice_xml`); display still uses the current resolved model. |
| KOD I QR host derived from the **accepted submission's stored `environment`** (not the org's current credential environment) | An invoice accepted on test/demo then switched to prod would otherwise get a wrong-host QR (hash still correct). The stored environment is authoritative; the current credential environment is used only for the `OFFLINE`/not-yet-accepted path. |
| **KOD II is render-only here**; its URL + signature are built by `lib/ksef-qr-cert.ts` (SPEC-005) | KOD II signs the **URL fragment** with **RSA-PSS** / ECDSA-P1363 using the **Offline** certificate — that crypto and the offline lifecycle belong to the connector/offline layer. The PDF layer only needs the finished URL string to render the second QR. Keeps this spec free of signing concerns. |
| Paginate the line table; totals + QR on the **final** page; single-page output byte-stable | Real invoices exceed one page. Pagination engages only past the single-page line threshold, so a ≤ ~45-line invoice is byte-identical to the pre-pagination output (locked by a regression test). |
| Generation core is **pure** (`buildInvoicePdfModel`, `buildKodIUrl`, `renderInvoicePdf(model, {fontBytes, qrPng, qrIiPng?})`) | Unit-testable offline; the route is the only impure seam (resolver + submission read). |
| Content-Disposition filename **sanitized** (`\p{L}\p{N}._-` only, capped) | The raw invoice number in the header would be a header-injection vector. |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Import a cross-module `@react-pdf/renderer` generator | Not in this repo; heavier (react-pdf + font pipeline); a KSeF-specific visualization (number + KOD QR + FA fidelity) is better owned by `financial_pl`. (Revisit if a cross-module branded-template system is wanted.) |
| Render from a fresh resolve only (ignore stored XML) | The KOD I hash would not match the bytes in KSeF if the invoice changed post-send. Use the stored registered XML for the hash. |
| `StandardFonts` (Helvetica) | Cannot render Polish diacritics — unacceptable for a PL fiscal document. |
| HTML→PDF via Playwright/Chromium | Native/browser dep, heavy, non-deterministic in a server route. |
| Re-implement KOD II signing in the PDF layer | The signing (RSA-PSS/ECDSA, Offline cert) is a connector concern; the PDF only needs the built URL. Duplicating crypto here would fork the signer. |

## User Stories / Use Cases

- **An accountant** downloads a PDF of an issued invoice (with its KSeF number + verification QR) to email a buyer or archive it.
- **A buyer** scans the KOD I QR to verify the invoice against KSeF.
- **A buyer of an offline-issued invoice** scans the cert-signed **KOD II** QR to verify the document against the issuer certificate before the invoice has reached KSeF.
- **A user** prints a not-yet-sent invoice as a draft visualization (labelled `OFFLINE`, no KSeF number).
- **An accountant** downloads a **100-line** invoice and gets a clean multi-page PDF with a repeated table header and the totals + QR on the last page.

## Architecture

### Pure core (`lib/`)

- **`lib/invoice-pdf-model.ts`** — `buildInvoicePdfModel(fa3Model, { ksefNumber?, ksefStatus, issuedOutsideKsef?, ksefCert?, hasKodII? }) → InvoicePdfModel`.
  Builds the display model:
  - **Header:** invoice number, issue date, sale date.
  - **Parties:** Sprzedawca + Nabywca with NIP + address.
  - **Lines:** `Lp`, nazwa, ilość, j.m., cena netto, wartość netto, stawka VAT, kwota VAT, wartość brutto.
  - **VAT summary:** grouped by rate.
  - **Totals:** razem netto / VAT / brutto + "do zapłaty".
  - **KSeF block:** the KSeF number, or `OFFLINE` when none (`label: number ?? 'OFFLINE'`), + status.
  - **QR affordances:** the KOD I fields, plus optional KOD II fields (`hasKodII`, `qrCertyfikatLabel`, `ksefCert`) so the model can carry a second QR when the invoice is offline-issued. Pure; money math uses BigInt to avoid float drift.

- **`lib/ksef-qr.ts`** — the KOD I URL builder + shared QR helpers:
  - `buildKodIUrl({ environment, sellerNip, issueDate, invoiceXml }) → string` = `${resolveKsefQrHost(environment)}/invoice/${nip}/${dd-mm-yyyy(issueDate)}/${base64url(sha256(utf8(invoiceXml)))}`. Zero-padded `DD-MM-YYYY` per the `kody-qr` spec. Pure (reuses `crypto.sha256`; adds base64url).
  - `ksefInvoiceHashBase64Url(invoiceXml)` + `toBase64Url(bytes)` — the base64url SHA-256 helpers shared with the KOD II builder in `lib/ksef-qr-cert.ts` (SPEC-005), so both QRs hash the invoice identically.
  - `resolveKsefQrHost(environment)` — the per-environment QR host resolver (see Configuration).

- **`lib/ksef-qr-cert.ts`** (owned by SPEC-005; **consumed** here) — `buildKodIIUrl(...)` returns the full signed KOD II URL (`…/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}/{signature}`). `signKodII` is its internal helper. This spec calls only the public `buildKodIIUrl` export (or reads the persisted `kod_ii_url`) and renders the result.

- **`lib/invoice-pdf.ts`** — `renderInvoicePdf(model, { fontBytes, qrPng, qrIiPng? }) → Promise<Uint8Array>`.
  Lays out the model with `pdf-lib`: registers `@pdf-lib/fontkit`, embeds the LiberationSans font, draws the two-column Sprzedawca/Nabywca block, the **paginated** line table, the VAT summary, totals, the KSeF block, and the QR(s). Renders the second (KOD II) QR **only when `qrIiPng` is present** (byte-stable single-QR otherwise); labels KOD I `OFFLINE` and KOD II `CERTYFIKAT` for offline invoices. Pure (bytes in → bytes out).
  - **Pagination:** when the line-items table exceeds the page body height, emit additional A4 pages, each repeating the table header, with a **"page n / m"** footer; the VAT summary / totals / QR block render **once, on the final page**. Byte-stability is preserved for the single-page case — no layout change for ≤ ~45 lines. The deterministic clock/font handling is unchanged.

- **`lib/fonts/liberation-sans-regular.font.ts`** — `INVOICE_FONT_BASE64` + `loadInvoiceFontBytes(): Uint8Array`. LiberationSans (OFL), ~136 KB raw / ~186 KB base64, license shipped as `assets/LICENSE_LIBERATION`.

- **`lib/invoice-qr.ts`** (thin) — `generateQrPng(url): Promise<Uint8Array>` via `qrcode` (error-correction M). Isolated so the renderer stays byte-pure; called once per QR (KOD I, and KOD II when present).

### Route

- **`api/ksef/invoice-pdf/route.ts`** — `GET ?salesInvoiceId=` (feature `financial_pl.view`, `(organizationId, tenantId)`-scoped, `400` if no scope/id, `404` unknown invoice, `422` if the invoice is not serializable to FA(3) — same guards as the send path, e.g. unsupported currency / issue-date-missing). It:
  1. Resolves the FA(3) model (`resolveFa3FromInvoice`).
  2. Reads the **latest _accepted_ `document_kind='invoice'` submission** (ksefNumber / status / `invoice_xml` / `environment`), falling back to `SalesInvoicePlMeta.ksef_number`, so a later rejected re-submission never masks an accepted one.
  3. Builds the **KOD I** URL — hashing the accepted submission's stored `invoice_xml` (host from that submission's stored `environment`); else from `buildFa3Xml(model)` with an `OFFLINE` label (host from the current credential environment). Generates the KOD I QR PNG.
  4. **KOD II (offline):** when the invoice was **issued offline** (no KSeF number yet) **and** an **Offline (type-2) certificate** is configured, builds the KOD II URL via `lib/ksef-qr-cert.ts` `buildKodIIUrl` (or reads the persisted `kod_ii_url`), renders it to a PNG, and passes it as `qrIiPng` (label `CERTYFIKAT`) beside KOD I (label `OFFLINE`). **Falls back gracefully to KOD I only** when no Offline cert is configured.
  5. Renders and returns `application/pdf` with `Content-Disposition: attachment; filename="<sanitized invoiceNumber>.pdf"`. Read-only (no mutation guard needed).

### Config

`config.ts` provides per-environment QR hosts + a resolver:
- `qr-test` → `https://qr-test.ksef.mf.gov.pl`
- `qr-demo` → `https://qr-demo.ksef.mf.gov.pl`
- prod → `https://qr.ksef.mf.gov.pl`
- `resolveKsefQrHost(environment)` returns the host; `OM_KSEF_QR_HOST` overrides it (used by **both** KOD I and KOD II).

## Data Models

**No new entity, no migration in this spec.** The PDF reads existing state:
- The resolved sales invoice (via `resolveFa3FromInvoice`, SPEC-006).
- `KsefSubmission` (`financial_pl_ksef_submissions`) — reads `status`, `ksef_number`, `invoice_xml`, `environment`, `document_kind`, and, for offline invoices, `kod_i_url` / `kod_ii_url` / `offline_certificate_serial` (all persisted by SPEC-005's offline issuance).
- `SalesInvoicePlMeta` (`financial_pl_invoice_meta`) — `ksef_number` fallback + `issued_outside_ksef` (SPEC-006).

No `sales` change. The offline QR columns and the Offline-certificate credential fields are **defined in SPEC-005**; this spec only reads them.

## API Contracts

| Route | Methods | Feature | Purpose |
|---|---|---|---|
| `…/ksef/invoice-pdf` | `GET` | `financial_pl.view` | `?salesInvoiceId=` → `application/pdf` visualization. `400` (no scope/id), `404` (unknown invoice), `422` (invoice not serializable to FA(3) — same guards as the send path, e.g. unsupported currency / issue-date-missing). Response is `application/pdf` with a sanitized `Content-Disposition: attachment` filename. |

External (KSeF, consumed): none directly — the PDF route makes no KSeF API call. The KOD I/II QR **hosts** are the public verification hosts (`qr[-env].ksef.mf.gov.pl`), not the API base.

## Internationalization (i18n)

New UI keys (en + pl + de + es, sorted per `i18n:check-sync`):
- `financial_pl.actions.downloadInvoicePdf` — "Download invoice PDF" / "Pobierz fakturę PDF".
- `financial_pl.pdf.visualizationNotice` — "This is a visualization of a structured invoice; the source document is the invoice in KSeF." / "Wizualizacja faktury ustrukturyzowanej; dokumentem źródłowym jest faktura w KSeF."
- QR labels: `financial_pl.labels.qrOffline` (`OFFLINE`), `financial_pl.labels.qrCertyfikat` (`CERTYFIKAT`) — rendered under the respective QR on offline invoices.

The static FA-layout labels (Sprzedawca, Nabywca, NIP, Lp., Nazwa, Ilość, j.m., Cena netto, Wartość netto, Stawka VAT, Kwota VAT, Wartość brutto, Razem, Do zapłaty, Numer KSeF) are Polish invoice terms rendered on the document itself — a Polish fiscal document is Polish-language by law — so they are kept as **document constants**, not UI i18n. The `OFFLINE`/`CERTYFIKAT` QR captions are drawn from the localized labels above so the download action and any surrounding UI stay translated.

## UI/UX

A **"Download PDF"** action on the invoice detail/edit surface (owned by SPEC-008's backoffice) links to `…/ksef/invoice-pdf?salesInvoiceId=`. No new page in this spec.

The PDF: A4, header with invoice number + dates, two-column Sprzedawca/Nabywca, the (paginated) line table, the VAT summary, totals, the KSeF block with the QR(s) right-aligned + the number/`OFFLINE` label, and the visualization-notice footer. For an **offline-issued** invoice with an Offline cert, **two** QRs render side by side: KOD I labelled `OFFLINE` and KOD II labelled `CERTYFIKAT`. Multi-page invoices repeat the table header per page and carry a "page n / m" footer; totals + QR(s) appear once on the last page.

## Configuration

No new required env vars. Optional `OM_KSEF_QR_HOST` overrides the per-environment QR host (applies to both KOD I and KOD II). Dependencies: `@pdf-lib/fontkit` and `qrcode` (`pdf-lib` already present) — all pure-JS, no native build.

## Migration & Compatibility

No DB migration in this spec; additive route + download action + config + deps. The pagination change is byte-stable for ≤ ~45-line invoices (regression-locked), so existing single-page output is unchanged. KOD II rendering engages only for offline-issued invoices with an Offline cert configured; every other invoice renders exactly as before (KOD I only). Fully backward-compatible.

## Risks & Impact Review

### Data Integrity
- **PDF/KSeF drift.** An invoice edited after acceptance would show current data while KSeF holds the original. **Mitigation:** the KSeF number on the PDF points to the authoritative KSeF copy; the KOD I hash is computed from the **stored registered** `invoice_xml`, so the QR verifies the KSeF copy, not the edited display. **Residual:** display vs KSeF copy can differ post-edit — flagged; most invoices are immutable post-send (SPEC-005/008 enforce KSeF immutability server-side).
- **Wrong KOD I hash/URL → QR fails verification.** **Mitigation:** hash the exact stored `invoice_xml` bytes; base64url + zero-padded `DD-MM-YYYY` per the official spec; unit-tested against a known vector; host from the accepted submission's stored `environment`. **Severity:** Medium → mitigated; final proof is a live scan against `qr-test` (done).
- **Wrong submission selected (later rejected masks accepted).** **Mitigation:** select the newest `status='accepted'` `document_kind='invoice'` row with a stored XML; unit-tested with a multi-submission fixture.
- **KOD II shown but signature invalid** (e.g. stale/expired Offline cert). **Mitigation:** the signature + validity checks are enforced at **issuance** (SPEC-005 rejects issuing with an invalid Offline cert); the PDF renders the persisted `kod_ii_url`. **Residual:** KSeF's verifier is the final authority (handoff, env-gated live).

### Tenant & Data Isolation
- The route is `(organizationId, tenantId)`-scoped (resolver + submission read both scoped); encrypted columns are never projected into the PDF beyond the intended KSeF number/URL; no cross-tenant surface.

### Operational
- Synchronous render; invoices are small (one page typical) so latency is negligible. Pagination bounds a large invoice to N deterministic pages. New deps are pure-JS (no native build). The font adds ~136 KB (base64 ~186 KB) to the bundle.

### Risk Register

| Risk | Severity | Mitigation | Residual |
|------|----------|-----------|----------|
| Polish glyphs missing → incorrect PDF | High → eliminated | LiberationSans (Unicode TTF) embedded via fontkit; a unit test lays out a string with all Polish diacritics. | None. |
| KOD I hash/URL incorrect → QR unverifiable | Medium → mitigated | Official-spec URL format + base64url SHA-256 hash unit test + zero-padded date; host from stored environment. | Live scan confirms (done, `qr-test`). |
| KOD II not rendered / mis-labelled on offline invoice | Medium → mitigated | Route builds/renders KOD II when offline + Offline cert; graceful KOD I-only fallback; unit test covers the render-when-offline branch. | KSeF verifier is final authority (env-gated live). |
| Pagination regresses the byte-stable single-page output | Low → mitigated | The multi-page branch only engages past the single-page line threshold; a regression test asserts a ≤ ~45-line invoice is byte-identical to the prior output. | Low. |
| Content-Disposition header injection via invoice number | Medium → eliminated | Filename sanitized to `\p{L}\p{N}._-`, capped. | None. |

## Final Compliance Report — 2026-07-01

| Rule | Status | Notes |
|------|--------|-------|
| No core-package edits | Compliant | All in `financial_pl`; `sales`/core read-only. |
| Org + tenant scoping | Compliant | Route scoped via resolver + submission read. |
| zod-validate inputs | Compliant | `salesInvoiceId` validated. |
| No `any` / no hardcoded user strings | Compliant | i18n for UI actions/QR captions; document constants are Polish fiscal labels by law. |
| Additive / BC (§27) | Compliant | New route/action/config/deps; pagination byte-stable ≤ ~45 lines; KOD II render is opt-in on offline+Offline-cert; no removed surface; no migration. |
| Font license | Compliant | LiberationSans under OFL; `LICENSE_LIBERATION` shipped + attributed. |
| Hand crypto only where mandated (§16) | Compliant | Reuses `crypto.sha256` + base64url for KOD I; KOD II signing is owned by SPEC-005 (`ksef-qr-cert.ts`), not re-implemented here. |

## Integration Test Coverage

- **Unit (jest, run locally):**
  - `invoice-pdf-model.test.ts` — mapping, VAT summary, totals (BigInt money math), accepted-vs-`OFFLINE` label, KOD II model fields present when offline.
  - `ksef-qr.test.ts` — base64url SHA-256 vector + KOD I URL format + zero-padded `DD-MM-YYYY`.
  - `invoice-pdf.test.ts` — renders a valid `%PDF`; embeds the font so a Polish string lays out; embeds the KOD I QR; embeds the **KOD II** QR when `qrIiPng` is provided; **pagination** (a 100-line invoice produces multiple pages with the totals/QR on the last page); **byte-stable single-page regression** (a ≤ ~45-line invoice is byte-identical to the pre-pagination output).
  - `ksef-qr-cert.test.ts` — the KOD II canonical signed string + signature verification (owned by SPEC-005; the PDF layer reuses it for the render-when-offline path).
- **Integration `TC-KSEF-006`** — `…/invoice-pdf`: `401` anon, `400` (no id/scope), `404` (unknown invoice), `200 application/pdf` for a known invoice; a multi-submission scenario asserts the accepted submission (not a later rejected one) drives the QR.
- **Live (handoff, done):** scanned the KOD I QR of an accepted TEST invoice against `qr-test.ksef.mf.gov.pl` → verified. The KOD II signature is unit-proven against the Offline cert (RSA-PSS saltLength 32 + ECDSA P1363) and confirmed structurally; full KSeF-verifier acceptance is env-gated (`OM_KSEF_TEST_OFFLINE_CERT_PEM`/`KEY`).

## Cross-model review history (consolidated)

- **KOD I / PDF (from SPEC-008):** spec-stage DeepSeek V4 Pro flagged the submission-selection ambiguity (a later rejected re-submission masking a prior accepted one) → resolved to source number/hash/status from the latest **accepted** submission; code-stage found + fixed two issues — the QR host now uses the accepted submission's **stored `environment`** (not the current credential env), and the Content-Disposition filename is **sanitized**. Result: KOD I correctness, latest-accepted selection, stored-XML hashing, Unicode font embedding and tenant scoping all confirmed.
- **KOD II render + pagination (from SPEC-010 / SPEC-015):** the KOD II QR was found to already be accepted by `renderInvoicePdf` (`deps.qrIiPng` + `model.ksefCert`); the real gap was the **route** not building/passing it — wired to `buildKodIIUrl` with a graceful KOD I-only fallback. Pagination was the "PDF byte-stability" jury item (4 voters): the multi-page branch engages only past the single-page threshold and a ≤ ~45-line regression assertion locks byte-identity. Full record: `.ai/reviews/financial-pl-spec015-compliance-cross-model-jury-2026-06-30.md`.

## Changelog

### 2026-07-01
- Consolidated from SPEC-008 (KSeF invoice PDF visualization + KOD I QR), SPEC-010 (KOD II dual-QR rendering on the offline invoice PDF), and SPEC-015 F3/F7 (KOD II route-wiring + PDF multi-page pagination) into this thematic spec; reflects final implemented state. The PDF layer is implemented and the KOD I QR is live-verified on KSeF TEST (`qr-test.ksef.mf.gov.pl`).
- Superseded framing dropped from the body (recorded here only): SPEC-008's original "connector is send-only / has no PDF / KOD II out of scope" TLDR is obsolete — the PDF ships, and KOD II is rendered for offline-issued invoices with an Offline certificate. The "KOD II deferred (needs the offline certificate)" boundary is resolved: the Offline-certificate enrollment + KOD II *signing* now live in the SPEC-005 connector/offline layer; this spec renders the resulting QR.
- Routing note (for orchestrator seam reconciliation): the **KOD II URL builder + signer** (`lib/ksef-qr-cert.ts`, RSA-PSS/ECDSA-P1363), the **Offline-certificate enrollment** + `offlineCertificate*` credential fields, the **offline24/awaryjny issuance lifecycle**, the statutory **deadline calculator**, and the persisted `kod_i_url`/`kod_ii_url`/`offline_certificate_serial` columns are all deliberately routed to **SPEC-005** (connector/submission). This spec retains only the PDF-side **rendering** of both QRs. The FA(3) model construction (`resolveFa3FromInvoice`, `buildFa3Xml`, doctypes, FX) is routed to **SPEC-006**; the download action UI to **SPEC-008**.
