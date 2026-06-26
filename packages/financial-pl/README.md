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
- **UI**: KSeF status badge + "Send to KSeF" / "Retry" actions and PL-VAT meta fields injected
  into the core sales-invoice host via UMES widget injection.

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
