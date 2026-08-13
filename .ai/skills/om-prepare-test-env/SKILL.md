---
name: om-prepare-test-env
description: Start or reuse the official-modules Open Mercato QA sandbox.
---

# Official Modules QA environment

Run from the repository root:

```sh
sh .ai/scripts/test-env-up.sh
```

The entrypoint prepares dependencies and generated artifacts when its fingerprint changes,
starts isolated PostgreSQL, Redis, and Meilisearch services, migrates and initializes the
sandbox, verifies an authenticated round trip, and writes `.ai/qa/test-env.json`.

Use `--force` to restart, or `--force-rebuild` to invalidate the preparation cache. Stop the
runtime without deleting its QA data with:

```sh
sh .ai/scripts/test-env-down.sh
```

KSeF tokens, private keys, and certificate material must remain under `.ai/qa/secrets/`, which
is ignored. Never add them to the descriptor or logs.
