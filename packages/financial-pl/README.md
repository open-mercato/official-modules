# @open-mercato/financial-pl

Polish **KSeF 2.0** e-invoicing connector for Open Mercato — submit FA(3) invoices to the
Krajowy System e-Faktur, poll their status, and retrieve the signed UPO receipt, with
Polish VAT metadata layered onto the OSS `sales` invoices via the sanctioned extension seams.

> License: **MIT**. Module id: `financial_pl`. Provider id: `ksef_pl`.

## What it does

- **KSeF 2.0 send flow** (`lib/`): public-key fetch → challenge → KSeF-token auth → open online
  session → AES-256-CBC encrypted FA(3) submission → status poll → UPO + KSeF number retrieval.
  Conformed to the live TEST OpenAPI v2.6.1 and the official FA(3) `1-0E` XSD.
- **FA(3) document** built from a real `sales` invoice (buyer/seller, per-rate VAT summary,
  `Adnotacje` — MPP on `P_18A`, VAT-exemption basis), via QueryEngine + FK-id (no cross-module
  ORM relations).
- **Reliability**: per-invoice idempotency (resolve-first guard + partial-unique index + an
  atomic `queued → processing` CAS claim), KSeF 440-duplicate handling (recovers the original
  number + UPO), and a periodic **reconciliation sweep worker** that re-drives submissions stuck
  in `queued`/`processing` so no invoice silently fails to reach KSeF.
- **Per-organization configuration**: NIP, KSeF token, environment, and seller identity are
  stored per-org in the encrypted `integrations` credential store (`ksef_pl` provider) and
  edited at `/backend/integrations/ksef_pl`.
- **Operator backoffice** (module-owned backend pages under `/backend/financial/*`, SPEC-013):
  Invoices list / create / detail / edit, an invoice **KSeF panel** (status, Send, Retry, Download
  UPO/PDF, Issue offline, Issue correction), the full **PL-VAT metadata editor**, plus **JPK** and
  **Certificates** pages. Works standalone on released `@open-mercato/core` (no injection host
  required). Editing a KSeF-`accepted` invoice is blocked **server-side** by a fail-closed API
  interceptor on core `sales.invoices` `PUT`/`DELETE` (an additive conditional-409 — part of the
  module's effective contract once installed).
- **Commercial-grade invoice editor** (SPEC-014): a **Buyer (Nabywca)** section persisted to the
  core invoice `metadata.buyerSnapshot` (the exact keys the FA(3) `buildBuyer` resolver reads, so
  the buyer flows straight into `Podmiot2`); a **"Look up" by NIP** that autofills the buyer's name +
  working address + VAT status from the Ministry of Finance *Wykaz podatników VAT* (Biała lista)
  register via `GET /api/financial_pl/ksef/company-lookup`. That route is a **read-only, fail-open
  server proxy** to `wl-api.mf.gov.pl` (no API key; bounded timeout; only the public NIP being
  invoiced leaves the system; bank-account numbers are not exposed) — if MF is unreachable the
  editor silently falls back to manual entry. Plus inline NIP-checksum / date-order / amount /
  buyer-required validation, line **VAT-rate** (23/8/5/0 + custom) and **unit** pickers, and
  searchable **GTU / procedure-marking** and **OSS consumption-country** fields.

## Configuration

Configure per organization under **Backend → Integrations → KSeF** (`/backend/integrations/ksef_pl`):

| Field | Notes |
|-------|-------|
| Environment | `test` / `demo` / `prod` (base URL selection; `OM_KSEF_ENVIRONMENT` is the process default) |
| Context NIP | the seller's 10-digit tax id |
| KSeF token | the authorization token (stored encrypted; masked in the UI) |
| Seller name / address | used for the FA(3) `Podmiot1` block |

The reconciliation sweep is registered automatically per organization (15-minute interval) when
the `scheduler` module is present. Tunables: `OM_KSEF_RECONCILE_STALE_MINUTES` (default 15),
`OM_KSEF_RECONCILE_MAX_ATTEMPTS` (default 6).

### Authentication note

The connector uses the KSeF **symmetric token**, which is valid for online sending throughout the
mandatory period and until tokens are discontinued (1 Jan 2027). Certificate / XAdES authentication
(the KSeF Type-1 authentication + Type-2 offline certificates) is the planned durable credential for
the 2027 period and is a documented additive follow-up.

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

## Activation

```bash
yarn official-modules add financial-pl --local
yarn install
yarn mercato configs cache structural --all-tenants
yarn generate
```
