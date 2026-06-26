# SPEC-007 — `@open-mercato/staff` Module Extraction (Phase 2)

**Date**: 2026-06-12
**Status**: Draft
**Owner**: Miguel Silva (@migsilva89)
**Phase**: 2 of 3 (see Sequencing below)

## TLDR

**Key Points:**
- Byte-copy the `staff` module (employees, teams, roles, leave requests, availability, timesheets) from `open-mercato@upstream/develop` `packages/core/src/modules/staff/` into a new publishable workspace package `packages/staff/` (`@open-mercato/staff`) in this repo.
- Zero behavior change: same module ID (`staff`), same DB tables, same API URLs, same ACL feature IDs, same event IDs, same i18n keys. Consumers switch the module source from `@open-mercato/core` to `@open-mercato/staff` — nothing else.
- Phase 1 (decouple core from staff) is DONE and merged ([open-mercato#1946](https://github.com/open-mercato/open-mercato/pull/1946), 2026-05-27). The decouple grep proof returns zero `core/modules/staff` imports outside the staff folder on current `upstream/develop`.
- Will be verified in the sandbox by swapping `{ id: 'staff', from: '@open-mercato/core' }` → `{ id: 'staff', from: '@open-mercato/staff' }`, plus a Verdaccio preview install into a scratch standalone app to prove the real `yarn mercato module add` story.

**Scope:**
- New package `packages/staff/` with the full module source (210 files at the pinned ref): entities, migrations + snapshots, commands, API routes, backend pages, components, lib (incl. timesheets), widgets, i18n (en/de/es/pl), ACL, setup, events, search, notifications, analytics, message types/objects, CLI commands, encryption maps, translations config, DI registrar, module `AGENTS.md`, unit tests, integration specs.
- Packaging scaffolding this repo does not have yet (first entity-bearing module here): `#generated` imports map, generated-entities build step, migrations shipping, deeper exports map.
- Sandbox verification + preview-registry install verification.
- Repo housekeeping: README module list, spec directory, package CHANGELOG.

**Out of Scope:**
- Phase 3: deleting `packages/core/src/modules/staff/` from open-mercato and consuming `@open-mercato/staff` from npm there. Separate spec in the open-mercato repo, only after this package is published and verified.
- Any feature work, refactors, or fixes to staff code. If a bug is found during verification, it is fixed upstream in open-mercato first, then re-copied (the pinned ref moves forward; the diff gate re-runs).
- Changes to planner, resources, customers, or any core module.
- The timesheets follow-up features from the upstream roadmap (`staff.timesheets.approve`, `staff.timesheets.lock`) — the placeholder ACL entries are byte-copied as-is, unimplemented. (Not to be confused with this spec's own phases 2.A–2.G.)
- Publishing the final (non-preview) npm release — done by the core team after PR review (blocked only by Q1, license).

**Concerns:**
- The copy MUST be taken from a pinned `upstream/develop` commit, never from a local working branch (during spec research the local open-mercato checkout was 663 commits behind — a copy from it would have silently dropped Phase 1 artifacts like `di.ts` and `lib/availabilityAccess.ts`).
- Exactly **three** production-code deviations from byte-copy are allowed (D1–D3 below), plus one test-only adaptation class confined to `__integration__/` (D4). A scripted diff gate proves nothing else changed.
- The npm-installed `@open-mercato/core` that the sandbox runs MUST already contain Phase 1 (#1946) and the timesheets carry-PR (#2309). **Verified**: both are first contained together in **`v0.6.4`** — the sandbox (pinned `0.6.0`) must bump before verification (Phase 2.A).
- Official-modules PR [#24](https://github.com/open-mercato/official-modules/pull/24) proposes removing the sandbox (subrepo direction). See Q2 — the verification checklist survives either way; only the host app changes.

## Open Questions — for the core team (resolved via GitHub PR comments, tracked here; neither blocks the copy/scaffold work)

- **Q1 — License & author fields** *(blocks npm publish)*. `staff/index.ts` `ModuleInfo` currently declares `author: 'Open Mercato Team'`, `license: 'Proprietary'`, while this repo is MIT. What should the extracted package declare in `ModuleInfo.license`, `ModuleInfo.author`, and `package.json` `license`/`author`? Publishing under MIT needs explicit core-team sign-off since the source is currently marked proprietary.
- **Q2 — Sequencing with official-modules PR [#24](https://github.com/open-mercato/official-modules/pull/24)** *(may redirect the verification host)*. PR #24 ("remove sandbox app and standalone-only infra", open since 2026-06-02) prepares this repo to live as a subrepository inside open-mercato and removes the sandbox + Verdaccio flow that this spec's Phase 2.E/2.G verification uses. Which lands first? **Contingency if #24 merges first**: Phase 2.E runs in the scaffolded standalone app that #24's CI keeps (`integration-test` job: scaffold app → install canary → `yarn generate` → migrate → Playwright), and Phase 2.G's Verdaccio step is replaced by the canary npm flow. The verification *checklist* is unchanged either way; only the host app differs.

### Resolved during spec research (no core-team decision needed)

- **Core version floor** — verified via `git tag --contains` on the merge commits: #1946 (`6366778…`) is contained in `v0.6.3`+; #2309 (`efea3eb…`) only in **`v0.6.4`**. Peer range floor: `>=0.6.4 <0.7.0`. The sandbox pins `0.6.0`, so the pre-flight platform bump is mandatory (Phase 2.A).
- **Versioning & publish flow** — start at `0.1.0` (repo convention; matches the current `ModuleInfo.version`). Per `README.md`, the core team reviews and publishes to npm after approval; this PR proves only the preview/canary flow.
- **`requires: ['planner', 'resources']`** — kept unchanged: planner and resources remain core modules (no extraction branch/PR/issue exists for either as of 2026-06-12, verified via `gh`). The `@open-mercato/core` peer dependency expresses the build-time side. Listed as an assumption to confirm in the PR description — if the core team later schedules their extraction, sequencing is coordinated then.

---

## Overview

The core team decided ([pkarw's approval in open-mercato#1111 comments](https://github.com/open-mercato/open-mercato/pull/1111#issuecomment-4354394013)) to extract `staff` from `@open-mercato/core` into `@open-mercato/staff`, published from this repo. Reasons: staff is business-case oriented rather than platform-essential, and official-modules placement gives visibility to the authoring agency.

Three-phase migration:

| Phase | Repo | Status |
|-------|------|--------|
| 1 — Decouple core from staff (DI resolver, route relocation, 308 redirect) | open-mercato | **Done** — [#1946](https://github.com/open-mercato/open-mercato/pull/1946) merged 2026-05-27; spec at `open-mercato:.ai/specs/implemented/2026-05-08-staff-decouple-from-core.md` |
| 2 — Create `@open-mercato/staff`, copy code, verify in sandbox | **official-modules (this spec)** | This spec |
| 3 — Delete staff from core; consume `@open-mercato/staff` from npm | open-mercato | Later, separate spec; only after Phase 2 is published & verified |

> **Market Reference**: This follows the same extract-to-plugin shape as Medusa's commerce-module packaging and Shopware's store plugins: the module keeps its identity (ID, tables, permissions) and only its *distribution channel* changes. We adopt the byte-copy discipline from the Phase 1 spec (drift between "moved" and "rewritten" code is the main source of regressions in extractions) and reject a rewrite-while-moving approach.

## Problem Statement

Staff currently ships inside `@open-mercato/core`, so every Open Mercato app carries ~210 files of employee/timesheet functionality whether it wants them or not, and the authoring agency cannot iterate or release independently of the core release train. Phase 1 removed all inbound dependencies (core no longer imports staff), but staff still physically lives in core. Until a standalone `@open-mercato/staff` package exists, is installable via `yarn mercato module add @open-mercato/staff`, and is proven in the sandbox, Phase 3 (deletion from core) cannot start.

This repo has never hosted a module of this shape: `test-package` and `carrier-inpost` ship no MikroORM entities, no migrations, no `#generated` imports, and no deep page/route paths. The packaging mechanics for an entity-bearing module exist in the framework (the CLI resolves per-package `migrations/` dirs and writes per-package `generated/entities.ids.generated.ts`) but are unexercised here — this spec must close those scaffolding gaps as part of the work.

## Proposed Solution

Create `packages/staff/` mirroring the proven packaging of `test-package`/`carrier-inpost`, extended with the entity-package mechanics copied from `packages/core`'s own build (compile `generated/**`, rewrite `#generated` imports, ship migrations). Byte-copy the module source from a pinned `upstream/develop` commit. Verify three ways: workspace build gates, sandbox runtime swap, and a preview-registry install into a scratch standalone app.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Copy strategy | Byte-copy from pinned `upstream/develop` SHA; scripted diff gate with an explicit 3-item deviation allowlist | Same discipline as Phase 1: drift is the regression source. Reviewer verifies the diff output, not 210 files. |
| Module ID | Stays `staff` | Frozen surfaces hang off it: ACL feature IDs (`staff.*`), event IDs, entity IDs (`staff:staff_team`…), the per-module migrations table `mikro_orm_migrations_staff`, i18n key namespace, `/api/staff/*` URLs, `/backend/staff/*` pages. Changing it would break every existing install at Phase 3. |
| DB tables & migrations | Byte-copy `migrations/` including both `.snapshot-*.json` files; no new migration | The framework tracks migrations **per module** (table `mikro_orm_migrations_staff`, resolved via the module's own `migrations/` dir — `packages/cli/src/lib/db/commands.ts`). Same module ID + same migration files ⇒ existing databases see zero schema work at Phase 3 switch-over. |
| `requires: ['planner', 'resources']` | Keep in `ModuleInfo`; add `@open-mercato/core` to `peerDependencies` | Two different contracts: `requires` is the *runtime module-registry* contract ("don't boot staff without planner/resources enabled"); the peer dependency is the *npm/build-time* contract ("staff's code imports core's exported APIs"). Both planner and resources remain core modules (verified — no extraction work exists for either), so both declarations stay. |
| `#generated/entities.ids.generated` imports | Keep the import specifier; give the package its own `imports` map + generated file, like core does | `yarn generate` writes a per-package `generated/entities.ids.generated.ts` into each workspace package that owns modules (`packages/cli/src/lib/generators/entity-ids.ts`, per-group output). The package's `package.json` `imports` block maps `#generated/*` to it, exactly mirroring `packages/core/package.json`. Published packages ship `generated/` + `dist/generated/`. |
| The one cross-group ID (`E.planner.planner_availability_rule`) | Replace with the literal string `'planner:planner_availability_rule'` (deviation D1) | The per-package generated `E` map contains only the package's own modules; planner's IDs live in core's. Entity ID strings are a frozen contract surface, so the literal is stable. This is the single `E.<other-module>.*` usage in staff (`commands/leave-requests.ts:37`). |
| Where integration tests run | Port the module's `__integration__/` suite into the package; discovered by this repo's Playwright harness (`.ai/qa/tests/playwright.config.ts` + `discoverIntegrationSpecFiles`) | Open-mercato's core exports its integration helpers (`@open-mercato/core/testing/integration`, `./helpers/integration/*` in core's exports map), so specs can keep their imports. Harness differences are handled in Phase 2.F, with an explicit minimum-viable subset if a spec can't be ported 1:1. |
| Sandbox entry | Permanently switch `apps/sandbox/src/modules.ts` staff entry to `from: '@open-mercato/staff'` (the swap *is* the module-enable step) | The sandbox is the workspace test bed; consuming the workspace package is exactly what `test_package` already does. Keeping the swap in the PR is the verification artifact. **Contingency (Q2)**: if PR #24 removes the sandbox first, the swap artifact becomes the scaffolded standalone app's `modules.ts` instead. |
| Bug handling during verification | Fix upstream in open-mercato, advance the pinned SHA, re-copy, re-run the diff gate | Keeps a single source of truth until Phase 3 flips it. Patches landing only in the copy would be lost at the next re-copy and would diverge the two codebases pkarw explicitly asked not to maintain in parallel. |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| Rewrite/clean up while moving (rename module to `employees`, split timesheets out, drop Phase-2 ACL placeholders) | Every rename breaks a frozen surface (feature IDs, tables, URLs). Cleanups belong in upstream PRs before the copy, or post-Phase-3 releases — never inside the move. |
| Replace `#generated` imports with literal entity-ID strings everywhere | Touches dozens of files (vs 1 for D1), defeats the generated-types DX (`KnownEntities`), and diverges from how core itself packages modules. |
| Squash the 8 migrations into one fresh initial migration | Breaks Phase 3 for every existing install: `mikro_orm_migrations_staff` already records the 8 names; a new initial migration would re-run `CREATE TABLE` on populated databases. |
| Keep sandbox consuming staff from core and only test via Verdaccio | The workspace swap is cheaper to iterate on and is the repo's documented validation flow; Verdaccio/scratch-app is kept as the *additional* end-to-end proof. |
| Copy from the local open-mercato checkout's working branch | It was 663 commits behind `upstream/develop` and missing all Phase 1 artifacts. Pinned-remote-ref copy is mandatory. |

## User Stories

- A **standalone-app developer** runs `yarn mercato module add @open-mercato/staff`, applies migrations, and gets the full Employees + Timesheets feature set — identical to what core shipped — without forking anything.
- A **developer who wants to customize staff** runs `yarn mercato module add @open-mercato/staff --eject` and owns the source locally (`ejectable: true` is preserved).
- An **existing Open Mercato app** (Phase 3, later) swaps the module source and keeps all data: same tables, same migration history, same role/ACL assignments, same URLs.
- The **authoring agency** releases staff fixes/features on its own cadence from this repo.
- A **core maintainer** reviews one diff-gate output + one verification checklist instead of 210 copied files.

---

## Source Inventory (what moves)

Source of truth: `open-mercato` `upstream/develop` — **pinned SHA recorded at copy time** (at spec time: `170077434ecf6da11af7ac000e376099bf2b60b5`; Phase 2.A re-pins). Module root: `packages/core/src/modules/staff/` — **210 files**. Destination: `packages/staff/src/modules/staff/`.

| Category | Contents (counts at spec-time pin) |
|----------|------------------------------------|
| Module conventions (top level) | `index.ts` (ModuleInfo: `name: 'staff'`, `requires: ['planner','resources']`, `ejectable: true`), `acl.ts` (18 features incl. 2 timesheets Phase-2 placeholders), `setup.ts` (role features for admin/employee + dashboard-widget seeding), `events.ts` (~35 event IDs, emit-only — staff has no subscribers/workers), `search.ts` (4 searchable entities), `notifications.ts` (3 leave-request types), `analytics.ts`, `message-types.ts`, `message-objects.ts` (5 object types), `cli.ts` (3 commands incl. `seed-examples`), `ce.ts` (StaffTeamMember custom-entity spec), `encryption.ts` (encryption map: `staff:staff_leave_request` → `note`, `decision_comment`, `unavailability_reason_value`), `translations.ts`, `di.ts` (**Phase 1 artifact** — registers `availabilityAccessResolver`), `AGENTS.md` (**Phase 1 artifact** — public contract surfaces) |
| `data/` | `entities.ts` (12 entity classes — see Data Models), `validators.ts` (20+ zod schemas), `enrichers.ts` (StaffTimeProject response enricher) |
| `migrations/` | 8 migrations (`Migration20260121082330` … `Migration20260511112759`) + `.snapshot-open-mercato.json` + `.snapshot-openmercato.json` |
| `api/` | 31 files: CRUD routes for teams/team-roles/team-members/addresses/comments/activities/job-histories/leave-requests (all `makeCrudRoute` + Command pattern), custom actions (leave accept/reject, member self, tag assign/unassign), `team-members/assignable/` (**Phase 1 artifact**), `timesheets/*` (time-entries + bulk + timer start/stop + segments, time-projects + members, my-projects, project KPIs), `openapi.ts`, `helpers.ts`, `guards.ts`, `interceptors.ts` |
| `commands/` | 13 command files (all mutations are commands with undo) |
| `backend/` | 43 files (~22 page routes under `/backend/staff/...`: teams, team-roles, team-members, profile, leave-requests, my-leave-requests, my-availability, timesheets + projects) |
| `components/` | Form/detail components + adapters (12+ files) |
| `lib/` | crud, customFields, leaveRequestHelpers, memberSchedule, scheduleSwitch, messageObjectPreviews, seeds, staffMemberResolver, `availabilityAccess.ts` (**Phase 1 artifact** — DI contract impl), `timesheets-projects/`, `timesheets-projects-ui/`, `timesheets-ui/` |
| `widgets/` | `injection-table.ts` + `injection/timer-sidebar-indicator/` (slot `backend:sidebar:nav:footer`), dashboard widgets `timesheets-time-reporting/` + `timesheets-hours-by-project/` |
| `i18n/` | `en.json`, `de.json`, `es.json`, `pl.json` — 1,158 keys each |
| Unit tests (13 files, jest) | `__tests__/di.test.ts`, `api/team-members/assignable/__tests__/route.test.ts`, `api/timesheets/time-entries/__tests__/timer-segment-atomic-write.test.ts`, `commands/__tests__/job-histories.optimistic-locking.test.ts`, `components/__tests__/TeamMemberForm.{tagsHeading,teamPrefill}.test.tsx`, `data/__tests__/validators.test.ts`, `lib/__tests__/{leaveRequestHelpers,scheduleSwitch}.test.ts`, `lib/timesheets-projects/__tests__/{computeProjectsKpis,dateBuckets,listProjectMembersPreview}.test.ts`, `lib/timesheets-ui/__tests__/colors.test.ts` |
| Integration specs (30 files) | `__integration__/TC-STAFF-001…016`, `TC-STAFF-020…026` (+ `-edit-select-prefill` variants), `TC-STAFF-CRUDFORM-001`, `TC-STAFF-REDO-KEEPS-ID`, `TC-LOCK-OSS-035`, `TC-LOCK-OSS-036`, `TC-INT-006`, `meta.ts` |

**What does NOT move** (stays in open-mercato, Phase 3 cleanup): the customers `308` redirect route, planner's DI-consuming wrapper in `planner/api/access.ts`, `'staff.nav.group'` string references in nav/layouts, staff fixtures used by `planner/__integration__/TC-PLAN-003`, and `apps/mercato` module registration.

### Import surface (why each peer dependency exists)

Staff imports, by package: `@open-mercato/shared` (~30 subpaths: commands, crud factory, DI container, encryption find, i18n, events, registry, setup, search, dashboard widgets, notifications types…), `@open-mercato/core` (auth entities + RbacService, dashboards `role-widgets`, dictionaries components/utils, directory `organizationScope`, entities module helpers, planner components + `PlannerAvailabilityRuleSet` type, notifications lib, translations components — all legitimate *outbound* deps; Phase 1 only removed *inbound* ones), `@open-mercato/ui` (backend primitives: CrudForm, DataTable, Page, FilterBar, schedule, inputs, utils…), and third-party: `@mikro-orm/core`/`@mikro-orm/postgresql`/`@mikro-orm/migrations`, `awilix`, `zod`, `lucide-react`, `@tanstack/react-table`, `next/*`, `react`/`react-dom`, `uuid`. Phase 2.C re-derives the exact third-party list with a grep before finalizing `package.json`.

---

## Architecture

### Package layout

```
packages/staff/
├── package.json              # @open-mercato/staff — see contract below
├── tsconfig.json             # extends ../../tsconfig.base.json, noEmit (copy test-package)
├── build.mjs                 # test-package base + core's generated/** build + #generated import rewrite
├── watch.mjs                 # copy test-package
├── jest.config.cjs           # test-package base; jsdom for the two .tsx component tests
├── CHANGELOG.md
├── generated/                # output of `yarn generate` (entities.ids.generated.ts, entities/*, entity-fields-registry)
└── src/
    ├── index.ts              # export { metadata } from './modules/staff/index'
    └── modules/staff/        # byte-copied module (210 files, deviations D1–D4 only)
```

### `package.json` contract

- `name: "@open-mercato/staff"`, `version: "0.1.0"` (repo convention; matches `ModuleInfo.version`), `type: "module"`, `main: "./dist/index.js"`, `publishConfig.access: "public"`, `license` pending Q1.
- **`imports` block — mirrors `packages/core/package.json`** (this is what makes `import { E } from '#generated/entities.ids.generated'` resolve inside the package):
  ```json
  "imports": {
    "#generated/entities.ids.generated": {
      "types": "./generated/entities.ids.generated.ts",
      "default": "./dist/generated/entities.ids.generated.js"
    },
    "#generated/entity-fields-registry": {
      "types": "./generated/entity-fields-registry.ts",
      "default": "./dist/generated/entity-fields-registry.js"
    },
    "#generated/entities/*": {
      "types": "./generated/entities/*/index.ts",
      "default": "./dist/generated/entities/*/index.js"
    }
  }
  ```
  (Exact `entity-fields-registry` target verified against what `yarn generate` emits into the package — core uses a `src/generated-shims/` indirection; Phase 2.B confirms which shape applies here.)
- **`exports` map**: test-package's pattern (`.json` passthrough from `src/`, `types` from `src/`, runtime from `dist/`), **extended to staff's maximum subpath depth**. Staff's deepest discovered files are 8–9 segments below `src/` (e.g. `modules/staff/backend/staff/timesheets/projects/[id]/edit/page.tsx`, `modules/staff/api/timesheets/time-entries/[id]/segments/[segmentId]/...`); test-package's map stops at 4 levels and content's at 5. Node's subpath-pattern `*` can span `/`, but this repo's convention (and TS resolution behavior across tooling) enumerates levels explicitly — so enumerate to 9 levels. The Phase 2.D gate (build + generate + typecheck of the sandbox) proves every generated registry import resolves.
- **`peerDependencies`**: `@open-mercato/core`, `@open-mercato/shared`, `@open-mercato/ui` at `>=0.6.4 <0.7.0` (verified floor — `v0.6.4` is the first release containing both #1946 and #2309; mirror them in `devDependencies` at the sandbox's pinned version for local builds), `react` / `react-dom` `^19`, `@mikro-orm/postgresql` (carrier-inpost precedent). Third-party runtime deps that apps don't universally hoist (`lucide-react`, `@tanstack/react-table`, `uuid` if used) go to `dependencies`; `next` and `zod` are provided by the host app (same treatment as test-package/carrier-inpost). Final list from the Phase 2.C import grep; `yarn check:dep-versions` guards major drift.

### `build.mjs`

test-package's esbuild script (compile `src/**/*.{ts,tsx}` → `dist/`, add `.js` extensions, exclude tests) **plus** the two mechanisms from `packages/core/build.mjs`:
1. Compile `generated/**/*.ts` → `dist/generated/` (separate entry-point glob, `outbase: 'generated'`).
2. Rewrite `#generated/<name>` import specifiers in emitted JS to relative paths into `dist/generated/` (core's plugin, lines 11–48 of core's `build.mjs`).

Note: `migrations/*.ts` live under `src/modules/staff/migrations/`, so the existing `src/**` glob already compiles them into `dist/`; the `.snapshot-*.json` files are reachable via the `*.json` exports passthrough. The CLI's `getMigrationsPath` resolves a package module's migrations from its dist/pkg base (`packages/cli/src/lib/db/commands.ts:208–221`) and tracks them in `mikro_orm_migrations_staff`.

### Generated entity IDs

`yarn generate` (runs in the sandbox workspace) writes per-package outputs for every workspace package that owns enabled modules: `packages/staff/generated/entities.ids.generated.ts` with `E`/`M` for the `staff` group only, plus per-entity field files and the fields registry (`packages/cli/src/lib/generators/entity-ids.ts`, per-group section). This mechanism is proven in the open-mercato monorepo but **unexercised in this repo** — Phase 2.D explicitly gates on the file appearing and containing all 9 `E.staff.*` IDs the module references. `generated/` is committed or gitignored to match whatever convention `yarn generate` + CI expect (decided in Phase 2.B by checking core's treatment; npm publish must include it either way via `files`/no-ignore).

### Byte-copy deviation allowlist (complete)

| # | File | Change | Why |
|---|------|--------|-----|
| D1 | `src/modules/staff/commands/leave-requests.ts` (line 37 at pin) | `E.planner.planner_availability_rule` → literal `'planner:planner_availability_rule'` (with a comment pointing at this spec) | Per-package generated `E` contains only staff's own IDs; entity-ID strings are a frozen surface so the literal is stable. Single occurrence (verified by `git grep "E\.planner" -- packages/core/src/modules/staff`). |
| D2 | `src/modules/staff/index.ts` | `author`/`license` fields per Q1; everything else (name, title, version, description, `requires`, `ejectable`) unchanged | License decision is the core team's (Q1). |
| D3 | `src/modules/staff/AGENTS.md` | Fix repo-relative links (they point at open-mercato paths like `../../../../../BACKWARD_COMPATIBILITY.md`); update the "slated for extraction" framing to "published from this repo". Contract tables (DI surface, route, frozen ACL IDs) unchanged. | Links must resolve in this repo; the contract content is the point of the file. |
| D4 | `src/modules/staff/__integration__/**` only | Import-specifier and harness-wiring adaptations needed to run under this repo's Playwright discovery (Phase 2.F). Assertions stay byte-identical. | Test-only; diffed and reported separately from the production-code gate (see diff gate below). |

**Diff gate** (run in Phase 2.C and re-run before merge). `OM` = open-mercato clone path, `OFM` = this repo's path:

```bash
mkdir -p /tmp/staff-pin
git -C "$OM" archive <PINNED_SHA> packages/core/src/modules/staff \
  | tar -x -C /tmp/staff-pin --strip-components=5
diff -r --exclude='__integration__' /tmp/staff-pin "$OFM/packages/staff/src/modules/staff"
diff -r /tmp/staff-pin/__integration__ "$OFM/packages/staff/src/modules/staff/__integration__"
```

Expected output: the first diff shows differences in exactly the three D1–D3 files, nothing else. The second diff shows only D4 (test-only harness adaptations, see allowlist). Both outputs are pasted into the PR description.

### Sandbox wiring

`apps/sandbox/src/modules.ts`: replace `{ id: 'staff', from: '@open-mercato/core' }` with `{ id: 'staff', from: '@open-mercato/staff' }`. Planner, resources, dashboards, dictionaries, notifications, translations, customers stay enabled from core (staff's `requires` + outbound imports are satisfied). During the Phase 2→3 window, core's npm package still contains a staff folder — harmless: module registration is driven by `modules.ts`, one entry per module ID, and nothing else imports core's copy (that's exactly what Phase 1 proved). Under the Q2 contingency (PR #24 merged), the same swap and reasoning apply to the scaffolded standalone app's `modules.ts`, which also hosts the `yarn generate` runs that Phase 2.D depends on.

### Events / Commands / DI

No new events, commands, or DI keys; no renames. The `availabilityAccessResolver` DI registration moves with `di.ts` — once the sandbox consumes staff from the package, planner (still in core) resolves the resolver registered *by the package*, proving the Phase 1 contract works across the npm boundary. The existing `__tests__/di.test.ts` (asserts registration) is byte-copied and must pass in the package.

---

## Data Models

**No schema changes.** 12 entity classes byte-copied; tables and the per-module migration table (`mikro_orm_migrations_staff`) keep their names because the module ID is unchanged.

| Entity | Table | Cross-module references (scalar FK IDs only — no cross-module `@ManyToOne`) |
|--------|-------|------------------------------------------------------------------------------|
| `StaffTeam` | `staff_teams` | — |
| `StaffTeamRole` | `staff_team_roles` | — |
| `StaffTeamMember` | `staff_team_members` | `userId` → auth, `availabilityRuleSetId` → planner |
| `StaffLeaveRequest` | `staff_leave_requests` | (intra-module `@ManyToOne` → StaffTeamMember) |
| `StaffTeamMemberComment` | `staff_team_member_comments` | (intra-module) |
| `StaffTeamMemberActivity` | `staff_team_member_activities` | (intra-module) |
| `StaffTeamMemberJobHistory` | `staff_team_member_job_histories` | (intra-module) |
| `StaffTeamMemberAddress` | `staff_team_member_addresses` | (intra-module) |
| `StaffTimeEntry` | `staff_time_entries` | `customerId`, `dealId`, `orderId` → customers/sales |
| `StaffTimeEntrySegment` | `staff_time_entry_segments` | (intra-module scalar `timeEntryId`) |
| `StaffTimeProject` | `staff_time_projects` | `customerId` → customers, `ownerUserId` → auth |
| `StaffTimeProjectMember` | `staff_time_project_members` | (intra-module scalars) |

All entities carry `id`/`organization_id`/`tenant_id`/`created_at`/`updated_at` per platform convention (byte-copied, including every existing tenant-scope filter). Encryption map for `staff:staff_leave_request` fields is byte-copied — the package's `encryption.ts` is discovered like any module convention file.

## API Contracts

**No URL, schema, RBAC, or response changes.** All 31 API files keep their `metadata` (auth + features) and `openApi` exports byte-for-byte. Route inventory (all under `/api/staff/...`): CRUD for teams, team-roles, team-members, addresses, comments, activities, job-histories, leave-requests; actions `leave-requests/accept|reject`, `team-members/self`, `team-members/tags/assign|unassign`, `team-members/assignable` (Phase 1 route — the canonical target of core's `308` redirect, which stays in core); timesheets: `time-entries` (+ `bulk`, `[id]/timer-start`, `[id]/timer-stop`, `[id]/segments[...]`), `time-projects` (+ members), `my-projects[...]`, `projects/kpis`. Auto-discovery (`api/<METHOD>/<path>.ts → /api/<path>`) works identically for package-sourced modules — proven by `test_package` in the sandbox today.

## Internationalization

4 locales × 1,158 keys byte-copied to `src/modules/staff/i18n/`. This repo's CI enforces them: `yarn i18n:check-sync:packages` (key parity vs `en`) must pass; `yarn i18n:check-usage:packages` is continue-on-error in CI but is run locally and any findings are listed in the PR (keys resolved dynamically — e.g. notification/ACL titles — can false-positive; do not delete keys to satisfy the checker).

## UI / UX

No changes. The ~22 backend page routes, widgets, and components render identically; nav placement comes from the byte-copied `page.meta.ts` files (`pageGroup: 'Employees'`). The `'staff.nav.group'` string handling in core nav/layouts is untouched (Phase 3 cleanup item there).

## Configuration

No new env vars or feature toggles. Sandbox `.env` unchanged.

---

## Migration & Backward Compatibility

### Contract surfaces

| Surface | Treatment |
|---------|-----------|
| Module ID `staff` | Unchanged — anchors ACL, events, entity IDs, i18n namespace, migrations table |
| ACL feature IDs (`staff.*`, 18) | FROZEN — byte-copied; `setup.ts` role seeding identical, so existing role configurations remain valid |
| API route URLs (`/api/staff/*`) | Unchanged; core's deprecated `/api/customers/assignable-staff` `308` redirect still points at the staff route, which now answers from the package |
| DB tables + migration history | Unchanged names; same 8 migration files ⇒ `mikro_orm_migrations_staff` continuity — fresh installs run all 8, existing installs (Phase 3) run none |
| DI key `availabilityAccessResolver` | Same key, same shape, registered by the package's `di.ts`; planner's `allowUnregistered: true` fail-soft (`403 staff_module_not_loaded`) keeps working when staff isn't installed |
| Event IDs (~35) / notification types / search entity IDs / message types | Byte-copied, unchanged |
| npm import paths | **New** surface: `@open-mercato/staff/modules/staff/...`. The old `@open-mercato/core/modules/staff/...` paths still exist until Phase 3; Phase 1 guarantees no in-tree consumer uses them. Phase 3's spec owns the external-consumer deprecation note. |

### Rollout & sequencing

1. **This PR** (against `develop` of official-modules): package + module-source swap (sandbox, or the Q2 contingency host) + verification evidence. Preview/canary publish via the existing CI (`publish-canary` + scaffolded-app `integration-test` job) proves `yarn mercato module add @open-mercato/staff@<canary>`.
2. **npm release** by the core team once Q1 (license) is resolved — versioning starts at `0.1.0`; publish flow per `README.md` (core team publishes after review).
3. **Phase 3** (open-mercato repo, separate spec): delete `packages/core/src/modules/staff/`, switch `apps/mercato` + `create-app` template to the npm package, clean up the deferred string references and test fixtures. Hard precondition: this package published and verified. Until Phase 3 merges, upstream changes to core's staff folder MUST be mirrored here by re-running the pin → copy → diff-gate cycle (coordinate with the core team to freeze staff feature work in core during the window — to be raised in the PR, per pkarw's "I'd rather not keep the same module in official modules and the core at the same time").
4. **Rollback**: this PR is additive to this repo (new package + one module-source line in the host app). Reverting that line restores core-sourced staff; no data migration in either direction because schema and module ID are identical.

---

## Implementation Plan

Each phase ends with a verification gate; a phase does not start until the previous gate passes.

### Phase 2.A — Pre-flight: pin, prove, version-check

1. Re-pin: `git fetch upstream && git rev-parse upstream/develop` in the open-mercato clone → record `<PINNED_SHA>` in the PR description and in this spec's changelog.
2. Re-run the decouple proof at the pin:
   ```bash
   git grep -n "core/modules/staff" <PINNED_SHA> -- 'packages/core/src/modules' ':!packages/core/src/modules/staff' | grep -vE '__tests__|__integration__'
   ```
   MUST be empty (test fixtures are Phase 3 cleanup, excluded as in Phase 1).
3. Confirm Phase 1 artifacts exist at the pin: `staff/di.ts`, `staff/lib/availabilityAccess.ts`, `staff/api/team-members/assignable/route.ts`, `staff/AGENTS.md`.
4. Platform bump (floor already verified at spec time: `v0.6.4` is the first release containing both #1946 and #2309, via `git tag --contains` on the merge commits): bump sandbox platform deps (`core`/`shared`/`ui`) from `0.6.0` to `0.6.4` or the latest `0.6.x`, and get the sandbox green *before* any staff work. If the pin from step 1 advanced past `v0.6.4`'s cut, re-run the tag-ancestry check against the newest tag.
5. Check the status of official-modules PR [#24](https://github.com/open-mercato/official-modules/pull/24) (Q2): if merged, switch the host for Phases 2.D (the `yarn generate` runs), 2.E, and 2.G to the scaffolded-standalone-app contingency before proceeding.
6. **Gate**: SHA + grep output + version matrix recorded; sandbox (or contingency host) boots clean on the chosen platform version with staff still from core.

### Phase 2.B — Scaffold `packages/staff/`

1. Run the `scaffold-module` skill for package name `staff` / module ID `staff` to produce the standard skeleton (package.json, tsconfig, build.mjs, watch.mjs, jest.config.cjs, src/index.ts barrel).
2. Apply the entity-package extensions from Architecture: `imports` block, exports map to 9 levels, build.mjs `generated/**` + `#generated`-rewrite additions, peer/dev dependency set, jsdom config for `.tsx` tests.
3. **Gate**: `yarn workspace @open-mercato/staff build && yarn workspace @open-mercato/staff typecheck` pass on the skeleton; `yarn check:dep-versions` passes.

### Phase 2.C — Byte-copy + deviations

1. Copy from the pin (never from a working tree):
   ```bash
   cd /path/to/open-mercato && git archive <PINNED_SHA> packages/core/src/modules/staff \
     | tar -x -C <official-modules>/packages/staff/src/modules --strip-components=4
   ```
2. Apply D1 (planner entity-ID literal), D2 (ModuleInfo author/license per Q1 — if unresolved, keep upstream values and mark the PR as publish-blocked), D3 (AGENTS.md links).
3. Re-derive the third-party dependency list — first-pass heuristic: `grep -rhoE "from ['\"][^.'\"][^'\"]*['\"]" packages/staff/src | sort -u`, then manually drop `@open-mercato/*` / `next` / node built-ins and cross-check side-effect (`import 'x'`) and dynamic (`import('x')`) forms — and finalize `package.json`.
4. **Gate**: the scripted diff (see Architecture) shows exactly D1–D3; output pasted into the PR.

### Phase 2.D — Build, generate, typecheck, unit tests

1. Swap the sandbox `modules.ts` staff entry to `from: '@open-mercato/staff'` **first** — the entity-ids generator only emits per-package output for *enabled* modules, so the swap must precede `yarn generate`.
2. `yarn build:packages` — staff compiles, including `dist/modules/staff/migrations/*.js`.
3. `yarn generate` — verify `packages/staff/generated/entities.ids.generated.ts` exists and exports all 9 referenced `E.staff.*` IDs; verify the sandbox's `.mercato/generated/` registry now imports staff pages/routes/entities from `@open-mercato/staff/...` specifiers.
4. `yarn build:packages` again (post-generate, mirrors CI), then `yarn typecheck`.
5. `yarn workspace @open-mercato/staff test` — all 13 byte-copied unit test files pass (includes `di.test.ts` and the assignable route test).
6. **Gate**: all commands green. If the per-package generated output does not appear (first entity-bearing package in this repo), debug the resolver/generator wiring and record the fix as a scaffolding note in the PR — do not work around it by hand-writing the generated file.

### Phase 2.E — Sandbox runtime verification

(The `modules.ts` swap already happened in Phase 2.D step 1.)

1. Fresh DB: `docker compose down -v && docker compose up -d`, `yarn generate`, `yarn mercato db:migrate`, `yarn initialize` — verify `mikro_orm_migrations_staff` contains exactly the 8 migration names and all 12 `staff_*` tables exist.
2. `yarn dev` + manual smoke checklist (each item ticked in the PR):
   - Teams / team-roles / team-members CRUD incl. custom fields, tags, dictionaries-backed activity & address types; undo/redo on a team-member edit.
   - Leave requests: employee submits (`my-leave-requests`), manager sees pending notification, accept + reject paths, decision comment (encrypted field) round-trips.
   - My Availability: edit own schedule as non-admin employee — this exercises `availabilityAccessResolver` registered *by the package* and consumed by core's planner.
   - Assignable staff: `GET /api/staff/team-members/assignable` returns members; legacy `GET /api/customers/assignable-staff` still `308`s to it.
   - Timesheets: timer start/stop from the sidebar indicator widget, manual entry + bulk, segments edit, time-projects CRUD + member assignment, my-projects, projects KPIs endpoint, both dashboard widgets render with data.
   - Search returns staff teams/members/roles/time-projects; locale switch to pl/de/es renders staff pages translated.
   - CLI: `yarn mercato staff seed-examples --tenant <t> --org <o>` seeds examples.
3. **Gate**: checklist complete; zero console/server errors attributable to module resolution. (Integration tests run in Phase 2.F, which gates separately.)

### Phase 2.F — Integration test port

1. The 30 `__integration__` files arrive with the byte-copy. Verify their helper imports (`@open-mercato/core/testing/integration`, `./meta`) resolve against the npm core; adapt only import specifiers/config wiring — assertions stay byte-identical. These adaptations are deviation class D4 (see allowlist) and surface in the second, `__integration__`-only diff of the gate.
2. Wire them into this repo's Playwright discovery (`discoverIntegrationSpecFiles` scans the repo; confirm package `__integration__` paths are picked up, extend the discovery helper if not).
3. If a spec cannot run under this harness (e.g. open-mercato-only fixtures), it is skipped with a linked TODO; the **minimum non-skippable set** is: TC-STAFF-001…004 (core CRUD), one leave-request flow spec, one timesheets timer spec, TC-STAFF-REDO-KEEPS-ID (undo contract), and TC-INT-006 (cross-module).
4. New package-level specs (this repo):
   - `PKG-STAFF-001` — module registry: staff loads from `@open-mercato/staff`, `requires` satisfied, `container.hasRegistration('availabilityAccessResolver') === true`.
   - `PKG-STAFF-002` — fresh-DB migration apply from the package records 8 entries in `mikro_orm_migrations_staff`.
5. **Gate**: `yarn test:integration` green locally; skip list (if any) justified in the PR.

### Phase 2.G — Preview install proof, housekeeping, PR

1. Verdaccio end-to-end: `yarn registry:up && yarn publish:preview`; scaffold a scratch app (`create-mercato-app` against the preview registry, or rely on the CI `integration-test` job which scaffolds a standalone app and installs the canary), then `yarn mercato module add @open-mercato/staff@<tag-or-version>` — confirm first which dist-tag `publish:preview` actually publishes under (`preview` assumed; otherwise use the exact preview version), `yarn generate && yarn mercato db:migrate && yarn dev`, repeat the short smoke (teams CRUD, timer, my-availability). Also verify `--eject` copies the source cleanly.
2. Housekeeping: README "Module List" row for `@open-mercato/staff`; `packages/staff/CHANGELOG.md` initial entry; `.ai/specs/REDME.md` directory row; this spec's changelog updated with the final pin.
3. PR against `develop` containing: pinned SHA, decouple grep output, diff-gate output, Phase 2.E checklist, integration results, preview-install evidence, link to pkarw's approval comment, Q1/Q2 called out for core-team resolution, and the planner/resources-stay-in-core assumption stated for confirmation.
4. **Gate**: CI fully green (build, dep-versions, i18n sync, typecheck, unit, canary integration test).

### Integration Test Coverage (consolidated list)

| Spec | Covers |
|------|--------|
| TC-STAFF-001…004 | Teams / team-roles / team-members core CRUD + RBAC |
| TC-STAFF-005…009 | Member detail sections (addresses, comments, activities, job histories) |
| TC-STAFF-010…016 | Leave requests: submit, accept, reject, my-leave-requests, notifications |
| TC-STAFF-020…026 (+ edit-select-prefill variants) | Timesheets: entries, timer, segments, projects, my-projects, form prefill |
| TC-STAFF-CRUDFORM-001 | CrudForm behavior on staff forms |
| TC-STAFF-REDO-KEEPS-ID | Undo/redo command contract preserves entity IDs |
| TC-LOCK-OSS-035 / 036 | Optimistic-locking behavior on staff mutations |
| TC-INT-006 | Cross-module integration (staff ↔ core module) |
| PKG-STAFF-001 (new) | Package-sourced module load + DI registration |
| PKG-STAFF-002 (new) | Package-sourced migrations apply on fresh DB |
| CI `integration-test` job (existing) | Canary `module add` into a scaffolded standalone app |

---

## Risks & Impact Review

### Data Integrity

#### Risk: migrations not discovered from the package → missing tables on fresh installs
- **Scenario**: the CLI resolves the module's migrations dir differently for npm packages than for core; a scaffolded app installs staff and `db:migrate` silently applies nothing.
- **Severity**: High. **Affected**: every new install.
- **Mitigation**: Phase 2.E step 2 asserts the 8 rows in `mikro_orm_migrations_staff` and the 12 tables on a fresh DB; Phase 2.G repeats it through the real `module add` path; build gate confirms `dist/.../migrations/*.js` exist.
- **Residual**: Low.

#### Risk: migration-history discontinuity at Phase 3
- **Scenario**: file renames or a squashed initial migration make existing installs re-run DDL on populated DBs.
- **Severity**: High. **Affected**: every existing install at Phase 3.
- **Mitigation**: byte-copy of all 8 migrations + both snapshots; module ID (and thus the migrations table name) unchanged; the diff gate covers `migrations/`.
- **Residual**: None if the gate passes.

### Cascading Failures & Side Effects

#### Risk: copy taken from a stale source
- **Scenario**: copy from a local branch (observed 663 commits behind during research) drops Phase 1 artifacts; planner's DI resolution finds no registrar → all self-availability writes return `403 staff_module_not_loaded`.
- **Severity**: High. **Mitigation**: Phase 2.A pin + artifact checklist; Phase 2.C copies via `git archive <PINNED_SHA>`; `di.test.ts` + PKG-STAFF-001 + the My Availability smoke all assert the registration.
- **Residual**: Low.

#### Risk: upstream staff changes during the Phase 2→3 window
- **Scenario**: a staff fix lands in core after the pin; package and core diverge — exactly what pkarw asked to avoid.
- **Severity**: Medium. **Mitigation**: re-pin + re-copy + re-diff before merge; PR asks the core team to freeze staff feature work in core until Phase 3; Phase 3 spec re-verifies parity.
- **Residual**: Medium until Phase 3 lands — flagged in the PR.

#### Risk: D1 literal drifts from planner's entity ID
- **Scenario**: planner renames `planner:planner_availability_rule`. **Severity**: Low — entity IDs are a frozen platform surface; a rename would be a platform-wide breaking change, not a staff problem. **Mitigation**: comment at the literal links here. **Residual**: Negligible.

### Tenant & Data Isolation

- No query, scope argument, or encryption map changes — byte-copy + diff gate is the mitigation, identical in spirit to Phase 1's "diff the scope arguments line-by-line" rule. Existing tenant-isolation assertions inside TC-STAFF specs run unchanged. Residual: None beyond pre-existing behavior.

### Migration & Deployment

#### Risk: `#generated`/exports resolution fails at depth in consumer apps
- **Scenario**: deep page/route subpaths (8–9 segments) or `#generated` imports resolve in the workspace (symlinks, src fallback) but not from the published tarball.
- **Severity**: High. **Mitigation**: exports map enumerated to max depth; build rewrites `#generated` to relative dist paths (core's proven plugin); Phase 2.G installs the *packed* preview tarball into a scratch app — the publish-shaped proof.
- **Residual**: Low.

#### Risk: peer version skew
- **Scenario**: copied staff code calls core APIs newer than the installed core — a real window, because the pin is `upstream/develop` HEAD, which is *ahead* of any released `0.6.x` (or the floor is set too low and `module add` succeeds into an incompatible app).
- **Severity**: Medium. **Mitigation**: the floor `v0.6.4` only guarantees #1946+#2309 are present; pin-vs-release compatibility is proven by the Phase 2.D build/typecheck/unit gates, which run the copied code against the npm-installed core. `check:dep-versions` guards majors.
- **Residual**: Low.

### Operational

#### Risk: i18n CI failures at scale
- **Scenario**: 4×1,158 keys trip `i18n:check-sync:packages` (parity) or flood `check-usage` with dynamic-key false positives.
- **Severity**: Low (CI blocks merge, no runtime impact). **Mitigation**: keys are byte-copied from a repo whose CI enforces the same parity; usage check findings reviewed, not auto-deleted.
- **Residual**: Negligible.

#### Risk: integration harness mismatch leaves staff under-tested here
- **Scenario**: TC specs depend on open-mercato-only fixtures and get skipped wholesale.
- **Severity**: Medium. **Mitigation**: Phase 2.F's non-skippable minimum set; new PKG specs; CI canary install test.
- **Residual**: Low–Medium; skip list is reviewable in the PR.

### Anti-Pattern Checks

| Check | Result |
|-------|--------|
| Cross-module ORM links introduced | No — byte-copy preserves scalar-FK pattern; intra-module relations only |
| Undoability skipped | No — command layer byte-copied; TC-STAFF-REDO-KEEPS-ID ported |
| MVP mixed with speculative phases | No — Phase 3 explicitly out of scope; upstream-roadmap timesheets ACL placeholders copied untouched, not implemented |
| Domain logic into `@open-mercato/shared` | None added |
| Rewrite disguised as a move | Guarded by the 3-item deviation allowlist + scripted diff gate |
| Core packages modified | None — this repo's cardinal rule holds; the package uses existing extension/discovery mechanisms only |

---

## Final Compliance Report — 2026-06-12

### Guides reviewed
Root `AGENTS.md`, `README.md` (Package Conventions, Building a Module), `CONTRIBUTING.md` (Spec Driven Development), `.ai/specs/AGENTS.md`, `.ai/specs/REDME.md`, spec-writing skill + checklist, sandbox `AGENTS.md`, open-mercato Phase 1 spec (implemented), staff module `AGENTS.md` (upstream), `packages/cli` db/generator sources (upstream), `packages/{test-package,carrier-inpost,core,content}` packaging.

### Compliance matrix

| Rule | Status | Notes |
|------|--------|-------|
| Modules use UMES extension points; MUST NOT modify core | ✅ | Pure addition; staff already conforms (Phase 1 removed the one inbound coupling) |
| Package name kebab-case / module ID snake_case | ✅ | `@open-mercato/staff` / `staff` (single word — identical) |
| Peer deps on shared/ui (+core precedent from carrier-inpost) | ✅ | See package contract; floor `>=0.6.4` verified via tag ancestry |
| Exports map follows test-package | ✅ | Extended to 9 levels for staff's depth — documented as a scaffolding gap being closed |
| `ejectable: true` preserved | ✅ | Byte-copied |
| Spec naming `SPEC-{number}-{date}-{title}.md` + directory update | ✅ | SPEC-007 — 005 and 006 are reserved by open PRs [#21](https://github.com/open-mercato/official-modules/pull/21)/[#22](https://github.com/open-mercato/official-modules/pull/22), and two SPEC-004 files already exist; REDME.md updated |
| Required sections (TLDR, Problem, Solution, Architecture, Data Models, API Contracts, Risks & Impact, Final Compliance, Changelog) | ✅ | Present |
| Migration & Backward Compatibility section | ✅ | Present, with Phase 3 sequencing |
| No hand-written migrations | ✅ | Migrations byte-copied (originally generated by `db:generate`); none authored |
| Zod validation / `organization_id` scoping / auth guards / `openApi` exports / pageSize ≤ 100 / entity standard columns (incl. `deleted_at`/`is_active` where present) / command transaction boundaries | ✅ | All pre-existing in the copied code; unchanged by construction (diff gate) |
| Checklist: phases testable & incrementally deliverable | ✅ | Gates 2.A–2.G |
| Checklist: risks with severity/mitigation/residual | ✅ | 10 concrete scenarios |

### Internal consistency
- Inventory ↔ package layout ↔ diff gate cover the same 210-file set. D-list is closed (D1–D3 production + D4 test-only) and machine-checkable via the two-part diff gate. Q1 gates only the npm publish; Q2 gates only *where* verification runs, not whether. No section assumes Phase 3 work.

### Verdict
**Compliant — ready for implementation. Q1 (license) must be resolved before npm publish; Q2 (PR #24 sequencing) is checked at Phase 2.A and switches the verification host if needed.**

---

## References

- Phase 1 spec (implemented): `open-mercato:.ai/specs/implemented/2026-05-08-staff-decouple-from-core.md`
- Phase 1 PR: <https://github.com/open-mercato/open-mercato/pull/1946> · Timesheets carry-PR: <https://github.com/open-mercato/open-mercato/pull/2309>
- Extraction approval: <https://github.com/open-mercato/open-mercato/pull/1111#issuecomment-4354394013>
- Staff module contract surfaces: `open-mercato:packages/core/src/modules/staff/AGENTS.md` (byte-copied as D3)
- Packaging references: `packages/test-package/`, `packages/carrier-inpost/`, `open-mercato:packages/core/{package.json,build.mjs}`
- Framework mechanics: `open-mercato:packages/cli/src/lib/db/commands.ts` (per-module migrations), `open-mercato:packages/cli/src/lib/generators/entity-ids.ts` (per-package generated IDs)

## Changelog

### 2026-06-12
- Initial spec. Source pinned for inventory purposes at `upstream/develop` = `170077434ecf6da11af7ac000e376099bf2b60b5` (210 files; re-pinned at Phase 2.A). Inventory, packaging mechanics (per-package `#generated` output, per-module migrations table, exports depth), and the three-item deviation allowlist derived from direct inspection of `upstream/develop` and this repo's `test-package`/`carrier-inpost`/CI.
- Same-day revision after duplicate-work / freshness check:
  - Renumbered SPEC-005 → **SPEC-007** (005/006 reserved by open PRs [#21](https://github.com/open-mercato/official-modules/pull/21)/[#22](https://github.com/open-mercato/official-modules/pull/22)).
  - Confirmed no one else is working on the staff extraction (no branches/PRs/issues in official-modules mention staff).
  - Resolved the core-version-floor question by research instead of asking the core team: #1946 in `v0.6.3`+, #2309 only in `v0.6.4` (via `gh pr view --json mergeCommit` + `git tag --contains`) → peer floor `>=0.6.4 <0.7.0`; sandbox bump from `0.6.0` made a mandatory pre-flight step.
  - Demoted versioning/publish-flow and planner/resources-residency from open questions to resolved decisions/assumptions.
  - Added new Q2: sequencing with official-modules PR [#24](https://github.com/open-mercato/official-modules/pull/24) (sandbox removal / subrepo direction), with a verification-host contingency.
- Fresh-eyes architectural review pass (same day) applied:
  - **H1**: fixed the diff-gate snippet (missing `mkdir`, off-by-one `--strip-components`, relative-path bug) and split it into a production diff (D1–D3, `__integration__` excluded) + a test-only diff (D4).
  - **H2**: moved the `modules.ts` swap from Phase 2.E to Phase 2.D step 1 — the entity-ids generator only emits per-package output for *enabled* modules, so the swap must precede `yarn generate`.
  - **H3**: removed the integration-test run from Phase 2.E's gate (it belonged to Phase 2.F, violating the phase-ordering rule).
  - **H4**: promoted the test-only `__integration__` adaptations to an explicit D4 allowlist row, reconciling the "exactly three deviations" claims.
  - **M5**: propagated the Q2/PR-#24 contingency to the Sandbox-entry decision, Sandbox wiring, Rollout, Rollback, and Phase 2.D's generate-host dependency.
  - **M6**: corrected the peer-skew mitigation — the `v0.6.4` floor only proves #1946/#2309 containment; pin-vs-release compatibility is proven by the Phase 2.D gates.
  - **L7–L13**: stale "(see Open Questions)" pointer → Q1; TLDR future tense; compliance row extended with standard columns + transaction boundaries; dependency-grep labeled a first-pass heuristic and fixed; "timesheets Phase 2" renamed to upstream-roadmap wording; page-count wording unified (~22); preview dist-tag flagged for confirmation.
