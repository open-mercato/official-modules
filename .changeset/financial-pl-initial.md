---
"@open-mercato/financial-pl": minor
---

Add `@open-mercato/financial-pl` — a complete Polish KSeF 2.0 e-invoicing & VAT-compliance module for Open Mercato, talking directly to the Ministry of Finance REST API (no middleware).

**KSeF connectivity:** FA(3) submission over online **and** batch (*wsadowa*) sessions, status polling with KSeF reference numbers, full signed UPO retrieval, inbound receiving/sync with materialization into JPK purchase records, RSA-OAEP + AES-256-CBC payload encryption, and test/demo/prod environments. **Auth:** KSeF token and certificate (XAdES) with automatic token→certificate cutover and credential-health monitoring. **Documents:** FA(3) with multi-rate VAT, payment block, per-line discounts, gross-price entry, VAT margin, NBP FX, corrections/credit memos, and statutory annotations; MF *Wykaz* (Biała lista) NIP autofill. **Offline & QR:** offline24/awaryjny/niedostępność issuance with statutory deadlines, KOD I/II QR, and ZBP payment QR. **JPK:** JPK_V7M/V7K generation and e-submission to the Ministry gateway. **PDF:** Polish *Faktura VAT* with embedded QR. **Reliability:** per-invoice idempotency, KSeF 440-duplicate recovery, and a periodic reconciliation sweep so no invoice silently fails to reach KSeF.

Ships per-organization encrypted credentials (`ksef_pl` provider), an operator backoffice (invoices, JPK, received invoices, certificates), UMES widget injection on the sales-invoice host, and integration tests. Conformed to the live TEST OpenAPI v2.6.1 and the official FA(3) `1-0E` / JPK_V7 XSDs. Requires `@open-mercato/core` ≥ 0.6.6.
