---
"@open-mercato/financial-pl": minor
---

Add `@open-mercato/financial-pl` — Polish KSeF 2.0 e-invoicing connector for Open Mercato.

Submits FA(3) invoices to the Krajowy System e-Faktur, polls their status, and retrieves the signed UPO receipt. Includes per-organization encrypted credentials (`ksef_pl` integration provider), per-invoice idempotency with KSeF 440-duplicate recovery, a periodic reconciliation sweep so no invoice silently fails to reach KSeF, UMES widget injection on the sales-invoice host (status badge, send/retry actions, PL-VAT meta fields), and integration tests (TC-KSEF-001/002). Conformed to the live TEST OpenAPI v2.6.1 and the FA(3) `1-0E` XSD.
