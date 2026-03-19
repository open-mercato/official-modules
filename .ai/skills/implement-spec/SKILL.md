---
name: implement-spec
description: Implement a specification (or specific phases) for a community module package in the official-modules repo. Handles multi-phase implementation with unit tests, sandbox verification, and code-review compliance. Use when the user says "implement spec", "implement SPEC-XXX", "implement phases", "build from spec", or "code the spec". Tracks progress by updating the spec with implementation status.
---

# Implement Spec — Community Modules

Implements a specification (or selected phases) end-to-end inside a `packages/<name>/` workspace. Every community module is an **external extension** — use UMES extension points exclusively. NEVER modify `packages/core`, `packages/ui`, `packages/shared`, or any other core package.

## Pre-Flight

1. **Identify the spec**: Locate the target spec file in `.ai/specs/`.
2. **Check scaffold**: Verify `packages/<name>/` exists and has been scaffolded (`package.json`, `build.mjs`, `src/modules/<moduleId>/index.ts`). If not, run the `scaffold-module` skill first.
3. **Load context**: Read the spec fully. Read `AGENTS.md` at repo root.
4. **Load code-review checklist**: Read `.ai/skills/implement-spec/references/code-review-compliance.md`.
5. **Scope phases**: If the user specifies phases (e.g. "phases 1-2"), implement only those. Otherwise implement all phases sequentially.

## Golden Rule

> Community modules NEVER modify core. They extend it.

Available UMES extension points:

| Extension Point | When to Use |
|-----------------|-------------|
| Widget injection (`widgets/injection/`) | Add UI into existing module pages (columns, row actions, form fields, menu items) |
| Event subscribers (`subscribers/*.ts`) | React to core events (order placed, customer created, etc.) |
| Response enrichers (`data/enrichers.ts`) | Attach extra data to existing API responses |
| API interceptors (`api/interceptors.ts`) | Modify requests/responses for existing routes |
| Custom entities (`data/entities.ts`) | Store module-specific data linked by FK to core entities |
| Custom fields (`ce.ts`) | Add dynamic fields to core entities without schema changes |
| Backend pages (`backend/<path>/page.tsx`) | New admin pages owned entirely by this module |
| API routes (`api/<method>/<path>.ts`) | New endpoints owned entirely by this module |
| Menu injection | Add navigation items via `widgets/injection/` + `injection-table.ts` |

## Implementation Workflow

For **each phase** in the spec, execute these steps in order:

### Step 1 — Plan the Phase

Read the phase from the spec. For each step:
- Identify files to create or modify inside `packages/<name>/`
- Map each file to the correct auto-discovery path (see AGENTS.md)
- Identify required imports (`@open-mercato/shared`, `@open-mercato/ui`, `@open-mercato/core`)
- Note cross-module interactions (which events to subscribe to, which widget slots to inject into)

Present a brief plan before writing code.

### Step 2 — Implement

Use subagents liberally to parallelize independent work:
- One subagent per independent file when files have no dependencies
- Sequential for dependent files (entity → validator → API route → backend page)

**Code-review rules to enforce inline:**

| Area | Rule |
|------|------|
| Types | No `any` — use zod + `z.infer` |
| Entities | Standard columns (`id`, `created_at`, `updated_at`, `organization_id`), snake_case, UUID PKs |
| Queries | Always filter by `organization_id`; use `findWithDecryption` if PII fields present |
| API routes | Export `openApi` and `metadata` with `requireAuth` + `requireFeatures` guards |
| Validators | Zod schemas in `data/validators.ts`; derive types with `z.infer` |
| UI | `CrudForm` for forms, `DataTable` for tables, `LoadingMessage`/`ErrorMessage` for states |
| HTTP | `apiCall`/`apiCallOrThrow` only — never raw `fetch` |
| Commands | `registerCommand`, undoable, `extractUndoPayload()` from shared |
| Events | `createModuleEvents()` with `as const`; subscribers export `metadata` |
| i18n | `useT()` client-side, `resolveTranslations()` server-side; no hardcoded strings |
| Mutations | `useGuardedMutation` when not using `CrudForm` |
| Dialogs | `Cmd/Ctrl+Enter` submit, `Escape` cancel |
| Naming | Module ID plural snake_case, events `module.entity.past_tense`, features `module.action` |
| Imports | `@open-mercato/<pkg>/...` for cross-package; relative `./` for same-folder |

### Step 3 — Unit Tests

For every new function or class:
- Create tests in `src/modules/<moduleId>/__tests__/`
- Test happy path + key edge cases + error paths
- Mock DI services and external dependencies
- Verify: `yarn workspace @open-mercato/<package-name> test`

### Step 4 — Sandbox Smoke Test

After each phase that adds API endpoints or UI pages:

```bash
# Validate the default installed flow
yarn registry:up
yarn publish:preview
yarn mercato module add @open-mercato/<package-name>@preview
yarn mercato db:migrate
yarn dev
```

If the package is intended to be ejectable, also validate `--eject`:

```bash
yarn mercato module add @open-mercato/<package-name>@preview --eject
```

Navigate to the relevant page and verify it renders and functions correctly.

### Step 5 — Documentation

- Add/update i18n locale files for new keys
- If new entities with user-facing text: create `src/modules/<moduleId>/translations.ts`
- Run `yarn generate` after adding new module convention files
- Update `README.md` module table entry if the description changed

### Step 6 — Self-Review (Code-Review Gate)

Before marking a phase complete, scan for violations:

```bash
# Inside packages/<name>/
grep -rn ": any" src/           # No `any` types
grep -rn "fetch(" src/          # No raw fetch
grep -rn "em\.find\b" src/      # Should be findWithDecryption
grep -rn "alert(" src/          # Should be flash()
grep -rn "<button" src/         # Should be Button/IconButton primitive
```

Fix all violations before proceeding.

### Step 7 — Update Spec with Progress

After completing each phase, append/update `## Implementation Status` in the spec:

```markdown
## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| Phase 1 — Foundation | Done | 2026-03-20 | Entities, ACL, setup |
| Phase 2 — API routes | In Progress | 2026-03-21 | GET done, POST pending |
| Phase 3 — UI pages | Not Started | — | — |
```

### Step 8 — Verification

After all targeted phases are complete:

```bash
yarn workspace @open-mercato/<package-name> build    # must pass
yarn workspace @open-mercato/<package-name> typecheck # must pass
yarn workspace @open-mercato/<package-name> test      # must pass
```

Report results. Fix any failures before declaring done.

## Subagent Strategy

| Task | Agent Type |
|------|-----------|
| Research existing UMES patterns in core repo | Explore |
| Implement independent files | general-purpose (parallel) |
| Run tests | Bash |
| Sandbox smoke test | Bash |

**Concurrency rule**: parallel subagents for independent files only; sequential for dependent chains.

## Rules

- MUST read the full spec before starting
- MUST check that scaffold exists before writing business logic
- MUST use UMES extension points — never modify core packages
- MUST enforce all code-review rules inline during implementation
- MUST pass self-review scan before marking a phase done
- MUST update the spec with implementation progress after each phase
- MUST run build + typecheck + test after final phase
- MUST NOT introduce `any` types, hardcoded strings, raw `fetch`, or `em.find` without decryption
- MUST NOT modify files in `packages/core/`, `packages/ui/`, `packages/shared/`
- MUST keep subagents focused — one task per subagent
