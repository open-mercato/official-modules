# @open-mercato/financial-pl

Complete Polish **KSeF 2.0** e-invoicing & VAT-compliance module for Open Mercato — issue and send
**FA(3)** invoices to the Krajowy System e-Faktur, receive inbound invoices, generate and file
**JPK_V7**, render compliant PDFs, and cover offline issuance, corrections, VAT margin and NBP FX —
all layered onto the OSS `sales` invoices via the sanctioned extension seams.

> Developed & maintained by **[Omdyo](https://www.omdyo.com)** · License: **MIT** — fully open source · Module id: `financial_pl` · Provider id: `ksef_pl`.

## Features

A complete Polish e-invoicing stack that talks **directly to the Ministry of Finance KSeF 2.0 REST API** — no third-party middleware, no external e-invoicing SaaS in the path. Conformed to the live TEST OpenAPI **v2.6.1** and the official **FA(3) `1-0E`** schema, and verified end-to-end against the real KSeF test environment (auth → send → status → UPO).

### 📤 KSeF connectivity

| Capability | What you get |
|------------|--------------|
| **Submit invoices to KSeF** | Structured **FA(3)** documents over an interactive online session |
| **Batch (*wsadowa*) submission** | Many invoices in one encrypted ZIP package, single batch session |
| **Status polling + KSeF number** | Automatic poll to `accepted`, capturing the official KSeF reference number |
| **UPO retrieval** | The full signed *Urzędowe Poświadczenie Odbioru* XML receipt — not just a link |
| **Inbound receiving** | Query, download & sync invoices issued **to** you, and materialize them into a JPK purchase record |
| **Environments** | **test / demo / prod** endpoints, with prod never selected implicitly |
| **Payload encryption** | RSA-OAEP symmetric-key wrap + AES-256-CBC content, exactly as KSeF requires |
| **Rate-limit aware** | Honors `Retry-After`; surfaces KSeF limits |

### 🔐 Authentication

| Capability | What you get |
|------------|--------------|
| **KSeF token auth** | RSA-encrypted challenge/response |
| **Certificate (XAdES) auth** | Qualified-signature authentication — the successor credential after the token sunset |
| **Automatic cutover** | `authMethod: auto` moves an org from token to certificate with no workflow change |
| **Credential health monitoring** | Alerts for token sunset (2026-12-31) and certificate expiry |

### 🧾 FA(3) invoice content

| Capability | What you get |
|------------|--------------|
| **Multi-rate VAT** | 23 / 8 / 5 / 0 / ZW / NP, grouped into the FA(3) rate summaries |
| **Payment block (*Płatność*)** | Payment method, due term, and bank account |
| **Sale vs. issue date** | Separate `P_1` / `P_6` handling with smart defaults |
| **Per-line discounts (*rabat*)** | FA(3) `P_10` |
| **Gross-price entry** | Enter gross and derive net (`P_9B` / `P_11A`) |
| **VAT margin (*marża*)** | Travel / used goods / art / collectibles via `PMarzy` + `P_13_11` |
| **Foreign currency + NBP FX** | Table-A mid-rate for the correct tax-point business day (art. 31a) |
| **Corrections & credit memos** | *Faktura korygująca* and credit-memo → KSeF |
| **Statutory annotations** | MPP / split payment, self-billing, reverse charge, OSS, GTU & procedure markings, VAT-exemption basis |
| **Counterparty autofill** | Buyer **NIP look-up** against the MF *Wykaz podatników VAT* (Biała lista) — name, address & VAT status, no API key |

### 📴 Offline & QR codes

| Capability | What you get |
|------------|--------------|
| **Offline issuance** | `offline24` / `awaryjny` / `niedostępność` modes with a statutory send-deadline calculator (PL public-holiday aware) |
| **KOD I QR** | Online invoice-verification QR |
| **KOD II QR** | Offline certificate-signed QR for invoices issued during KSeF unavailability |
| **ZBP payment QR** | 2D bank-transfer QR on unpaid PLN invoice PDFs |

### 📊 JPK (VAT ledgers & filing)

| Capability | What you get |
|------------|--------------|
| **JPK_V7M / JPK_V7K** | Full generation against the official XSD — sales register, purchase register, and declaration part |
| **e-submission to MF** | Upload to the Ministry gateway with status tracking and its own UPO |
| **GTU / procedure markings** | Applied across the sales register |
| **Bad-debt relief** | *Ulga na złe długi* support |

### 🖨️ Documents & backoffice

| Capability | What you get |
|------------|--------------|
| **Polish invoice PDF** | A4 *Faktura VAT* with full diacritics and embedded KOD I/II QR |
| **Certificate management** | Enrollment (PKCS#10 CSR), inventory, revocation, and limit reporting |
| **Tabbed invoice editor** | *Faktura / Podatki-KSeF / Dodatkowe*, with customer & product pickers and VAT-rate / unit quick-picks |
| **KSeF panel per invoice** | Status badge, Send, Retry, Download UPO/PDF, Issue offline, Issue correction |
| **Dedicated pages** | Invoices (month view + net/gross summary), JPK_V7, Received invoices, KSeF certificates |

### 🛡️ Reliability

| Capability | What you get |
|------------|--------------|
| **Per-invoice idempotency** | Resolve-first guard + partial-unique index + atomic `queued → processing` claim — no double sends |
| **440-duplicate recovery** | Recovers the original KSeF number + UPO if the invoice was already registered |
| **Reconciliation sweep** | A worker re-drives submissions stuck in `queued` / `processing` so nothing silently fails to reach KSeF |
| **Fail-closed edit lock** | Server-side conditional-409 blocks editing a KSeF-`accepted` invoice |
| **Encryption at rest** | Per-org encrypted credential store; invoice XML, UPO and JPK payloads encrypted in the database |

## How it works

- **KSeF 2.0 send flow** (`lib/`): public-key fetch → challenge → KSeF token or certificate
  (XAdES) auth → open online session → AES-256-CBC encrypted FA(3) submission → status poll →
  UPO + KSeF number retrieval.
  Conformed to the live TEST OpenAPI v2.6.1 and the official FA(3) `1-0E` XSD.
- **FA(3) document** built from a real `sales` invoice (buyer/seller, per-rate VAT summary,
  `Adnotacje` — MPP on `P_18A`, VAT-exemption basis), via QueryEngine + FK-id (no cross-module
  ORM relations).
- **Reliability**: per-invoice idempotency (resolve-first guard + partial-unique index + an
  atomic `queued → processing` CAS claim), KSeF 440-duplicate handling (recovers the original
  number + UPO), and a periodic **reconciliation sweep worker** that re-drives submissions stuck
  in `queued`/`processing` so no invoice silently fails to reach KSeF.
- **Per-organization configuration**: NIP, auth method (`token` / `certificate` / `auto`), KSeF
  token or XAdES certificate credential, environment, and seller identity are
  stored per-org in the encrypted `integrations` credential store (`ksef_pl` provider) and
  edited at `/backend/integrations/ksef_pl`.
- **Operator backoffice** (module-owned backend pages under `/backend/financial/*`, SPEC-008):
  Invoices list / create / detail / edit, an invoice **KSeF panel** (status, Send, Retry, Download
  UPO/PDF, Issue offline, Issue correction), the full **PL-VAT metadata editor**, plus **JPK** and
  **Certificates** pages. Works standalone on released `@open-mercato/core` (no injection host
  required). Editing a KSeF-`accepted` invoice is blocked **server-side** by a fail-closed API
  interceptor on core `sales.invoices` `PUT`/`DELETE` (an additive conditional-409 — part of the
  module's effective contract once installed).
- **Commercial-grade invoice editor** (SPEC-008): a **Buyer (Nabywca)** section persisted to the
  core invoice `metadata.buyerSnapshot` (the exact keys the FA(3) `buildBuyer` resolver reads, so
  the buyer flows straight into `Podmiot2`); a **"Look up" by NIP** that autofills the buyer's name +
  working address + VAT status from the Ministry of Finance *Wykaz podatników VAT* (Biała lista)
  register via `GET /api/financial_pl/ksef/company-lookup`. That route is a **read-only, fail-open
  server proxy** to `wl-api.mf.gov.pl` (no API key; bounded timeout; only the public NIP being
  invoiced leaves the system; bank-account numbers are not exposed) — if MF is unreachable the
  editor silently falls back to manual entry. Plus inline NIP-checksum / date-order / amount /
  buyer-required validation, line **VAT-rate** (23/8/5/0 + custom) and **unit** pickers, and
  searchable **GTU / procedure-marking** and **OSS consumption-country** fields.
- **Mid-market invoicing features**: per-line discounts (rabat) with FA(3) `P_10`, gross-price
  entry (`P_9B` / `P_11A`), VAT marża procedures for travel / used goods / art / collectibles
  with `PMarzy` + `P_13_11`, and a ZBP payment QR on unpaid PLN invoice PDFs. For VAT marża JPK,
  `marginPurchaseCost` lets the module decompose the positive margin into K-fields; when it is
  not provided, the module emits `SprzedazVAT_Marza` / MR marking and leaves the VAT register
  completion to the operator.

## Configuration

Configure per organization under **Backend → Integrations → KSeF** (`/backend/integrations/ksef_pl`):

| Field | Notes |
|-------|-------|
| Environment | `test` / `demo` / `prod` (base URL selection; `OM_KSEF_ENVIRONMENT` is the process default) |
| Context NIP | the seller's 10-digit tax id |
| Auth method | `token`, `certificate`, or `auto` (certificate successor with token fallback/cutover) |
| KSeF token | the authorization token (stored encrypted; masked in the UI; sunset 2026-12-31) |
| KSeF certificate | Authentication certificate + private key for XAdES auth (stored encrypted) |
| Seller name / address | used for the FA(3) `Podmiot1` block |

The reconciliation sweep is registered automatically per organization (15-minute interval) when
the `scheduler` module is present. Tunables: `OM_KSEF_RECONCILE_STALE_MINUTES` (default 15),
`OM_KSEF_RECONCILE_MAX_ATTEMPTS` (default 6).

Certificate enrollment and certificate inventory live under `/backend/financial/certificates`.
Offline certificates are used for KOD II offline QR signing in the module-owned offline issuance
flow.

### Authentication note

KSeF symmetric tokens sunset on **2026-12-31**. Certificates are the successor credential for
online XAdES authentication and offline issuance. The module ships `credential-health` monitoring
for token sunset / certificate expiry and supports `authMethod: "auto"` so organizations can cut
over to certificate auth without changing invoice workflows.

## Live TEST verification

A CI-safe (skipped) live smoke test exercises the full auth → send → status → UPO round-trip
against `api-test.ksef.mf.gov.pl`:

```bash
OM_KSEF_TEST_NIP=<fictional test NIP> \
OM_KSEF_TEST_TOKEN=<KSeF token for that NIP> \
OM_KSEF_TEST_STRICT=1 \
yarn workspace @open-mercato/financial-pl test ksef-live
```

`OM_KSEF_TEST_STRICT=1` requires an `accepted` status with a KSeF number and a non-empty UPO.

## Installation

Install into any standalone Open Mercato app (on `@open-mercato/core` **≥ 0.6.6**) with the `mercato` CLI:

```bash
# Fetch from npm, auto-register in src/modules.ts, and run the code generators
yarn mercato module add @open-mercato/financial-pl

# Apply the module's migrations and start
yarn generate
yarn mercato db:migrate
yarn dev
```

Prefer to own the source? `--eject` copies the module into your `src/modules/financial_pl/`:

```bash
yarn mercato module add @open-mercato/financial-pl --eject
```

If the package is already in `node_modules` and only needs activating:

```bash
yarn mercato module enable @open-mercato/financial-pl
```

Then configure it per organization under **Backend → Integrations → KSeF** — see [Configuration](#configuration).

## Maintainers

<p align="center">
  <a href="https://www.omdyo.com">
    <img src="https://www.omdyo.com/assets/omdyo-logo.svg" alt="Omdyo" width="240" />
  </a>
</p>

<p align="center">
  <strong>Developed and maintained by <a href="https://www.omdyo.com">Omdyo</a></strong> — an Open&nbsp;Mercato agency building digital systems for real operations.<br/>
  Commercial support, custom KSeF / JPK work, and issues for this module → <a href="https://www.omdyo.com"><strong>www.omdyo.com</strong></a>
</p>

<p align="center"><sub>A contribution to the Open Mercato ecosystem · MIT-licensed</sub></p>

---

<p align="center"><sub>Built on <a href="https://github.com/open-mercato/open-mercato">Open Mercato</a> · Polish e-invoicing for KSeF 2.0</sub></p>
