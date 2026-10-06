---
"@open-mercato/enrichment-treg": minor
---

Add `@open-mercato/enrichment-treg` — enrich CRM people and companies with data fetched through treg.to.

Adds an Enrichment tab to person and company detail pages: start a lookup, review proposed job title, LinkedIn URL and firmographics against current values, and apply selected fields through the customers API. Lookups run in a queue worker with a per-call cost ceiling and idempotency keys; results are stored per subject and encrypted at rest.

Company detail pages also get a Company signals section: refresh open roles and recent news for a company, stored without duplicates and listed newest first with links to the source.
