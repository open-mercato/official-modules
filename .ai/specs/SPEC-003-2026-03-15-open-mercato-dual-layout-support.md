# SPEC-003: Open Mercato Dual Layout Support

**Date:** 2026-03-15
**Status:** Draft
**Scope:** OSS core repo — source-level support for both monorepo apps and standalone/single-repo apps
**Author:** Open Mercato Team
**Related:** downstream validation in `official-modules`, existing local Yarn patches for `@open-mercato/cli`

---

## TLDR

**Key Points:**
- Open Mercato source code currently contains layout assumptions that break when the app is installed in both supported shapes:
  - core monorepo / workspace app
  - standalone app / single repo
- The fix belongs in the upstream source repo, not as downstream Yarn patches
- The required changes are concentrated in `packages/cli` and `packages/ai-assistant`

**Must Change:**
- `packages/cli/src/lib/resolver.ts`
- `packages/cli/src/mercato.ts`

**Also Change for Full Parity:**
- `packages/cli/src/lib/testing/integration.ts`
- `packages/cli/src/lib/testing/integration-discovery.ts`
- `packages/cli/src/lib/testing/__tests__/integration-discovery.test.ts`
- `packages/ai-assistant/src/modules/ai_assistant/cli.ts`

**Do Not Solve This By:**
- adding more downstream Yarn patches
- hardcoding another app path
- treating only one install shape as canonical

---

## Overview

Open Mercato needs to work correctly in two real installation layouts:

1. **Monorepo / workspace app**
   Example shape:
   - app lives under `apps/<name>/`
   - shared packages are available from workspace root
   - `node_modules` may be hoisted
   - packages may be symlinks or real directories

2. **Standalone / single-repo app**
   Example shape:
   - app root is the project root
   - Open Mercato packages are installed under local `node_modules/@open-mercato/*`
   - no `apps/` or `packages/` workspace layout is required

Today the codebase mostly handles:
- monorepo with workspace-style package resolution
- standalone app when all paths are local and simple

But it breaks or becomes brittle when:
- `node_modules` are hoisted to a workspace root while the app lives below that root
- runtime code hardcodes `apps/mercato`
- runtime code assumes `@open-mercato/app`
- integration discovery scans only workspace folders and ignores standalone layouts

This spec defines exactly what must change in upstream source code so both layouts are first-class.

---

## Problem Statement

The current behavior fails in four places:

1. **Resolver ambiguity**
   The CLI resolver can identify the package root but still derive the wrong app directory, or assume a workspace layout too aggressively.

2. **Binary lookup for `next` and `mercato`**
   `server dev` and `server start` assume a single `node_modules` base, but in practice binaries may live:
   - next to the app
   - at a hoisted workspace root

3. **Integration tooling remains monorepo-biased**
   Integration runtime and test discovery assume:
   - `apps/mercato`
   - `packages/core`
   - `packages/ui`
   - workspace root scripts such as `build:packages`

4. **AI assistant bootstrap path is hardcoded**
   `ai_assistant mcp:serve` resolves bootstrap through a static `apps/mercato/src/bootstrap.ts` path, which is invalid for standalone apps.

As long as these assumptions stay in source, downstream consumers will keep patching published packages locally.

---

## Goals

- `mercato generate`, `mercato init`, `mercato server dev`, and `mercato server start` must work in both layouts
- hoisted `node_modules` must work even when workspace packages are real directories, not only symlinks
- integration test discovery must find module integration specs in both layouts
- `ai_assistant mcp:serve` must bootstrap from the actual app location, not from a hardcoded path

## Non-Goals

- redesigning package publishing
- changing Open Mercato module contracts
- changing app bootstrap architecture beyond path resolution
- solving every documentation mention of `apps/mercato`

---

## Required Source Changes

### 1. `packages/cli/src/lib/resolver.ts`

This file is the primary source of truth for:
- project root
- app root
- package root
- monorepo vs standalone detection

#### Required behavior

- Detect `nodeModulesRoot` separately from `monorepoRoot`
- Compute `rootDir` as:
  - `monorepoRoot ?? nodeModulesRoot ?? cwd`
- Add a guard so workspace app auto-detection only happens when it is actually needed

#### Required rule

Do **not** always probe `apps/*` just because such a folder exists.

Instead, only resolve app-from-root when one of these is true:
- a real monorepo/workspace mode was detected
- `nodeModulesRoot` is different from `cwd`, which means the app is below the package installation root

#### Reason

Without that guard, a normal standalone repo that happens to have an `apps/` directory can be misdetected as a workspace root.

#### Implementation intent

The resolver should explicitly separate:
- where packages are installed (`rootDir`)
- where the app lives (`appDir`)

These are not always the same directory.

---

### 2. `packages/cli/src/mercato.ts`

This file contains `server dev` and `server start`.

#### Required behavior

- Add a helper that resolves installed binaries from multiple candidate bases
- Resolve both:
  - `next/dist/bin/next`
  - `@open-mercato/cli/bin/mercato`
- Search in:
  - `resolver.getRootDir()`
  - `resolver.getAppDir()`

#### Reason

In real installs:
- workspace root may own the binaries
- or the app may own them locally

The CLI must work in both cases.

#### Constraint

This must be source-level logic in `mercato.ts`, not a downstream patch.

---

### 3. `packages/cli/src/lib/testing/integration.ts`

This file must be treated as runtime code, not just test glue. It currently contains hardcoded workspace assumptions.

#### Remove hardcoded assumptions

Replace assumptions about:
- `apps/mercato`
- `packages/core`
- `packages/ui`
- `@open-mercato/app`

#### Required behavior

- Derive app location from `resolver.getAppDir()`
- Derive package roots from:
  - `resolver.getPackageRoot('@open-mercato/core')`
  - `resolver.getPackageRoot('@open-mercato/ui')`
- Build artifact paths and input tracking paths from resolved locations, not static workspace folders
- App scripts such as:
  - `initialize`
  - `generate`
  - `build`
  - `start`
  must run from `appDir`
- Root-only scripts such as `build:packages` must run from project root
- `build:packages` must be optional:
  - run it only if it exists in root `package.json`
  - skip it in standalone apps that do not define it

#### Reason

The current integration runtime assumes a specific workspace name and folder layout. That makes standalone support impossible and makes non-standard workspace repos brittle.

---

### 4. `packages/cli/src/lib/testing/integration-discovery.ts`

This file currently discovers tests only from workspace-oriented folders.

#### Required behavior

Discovery must include:
- standalone app modules in `src/modules/*/__integration__/`
- workspace app modules in `apps/*/src/modules/*/__integration__/`
- workspace packages in `packages/*/src/modules/*/__integration__/`
- installed package modules in `node_modules/@open-mercato/*/src/modules/*/__integration__/`

Enabled module collection must also include:
- standalone app modules under `src/modules`
- installed package modules under `node_modules/@open-mercato/*/src/modules`

#### Reason

Without this, standalone apps can run, but integration tooling still behaves as if only the monorepo layout exists.

---

### 5. `packages/cli/src/lib/testing/__tests__/integration-discovery.test.ts`

This file must gain explicit coverage for standalone layouts.

#### Add tests for:

- standalone app integration tests discovered from `src/modules`
- installed package integration tests discovered from `node_modules/@open-mercato/*/src/modules`
- existing monorepo discovery behavior staying intact

#### Reason

The current coverage is too workspace-oriented and does not protect the standalone behavior that this spec adds.

---

### 6. `packages/ai-assistant/src/modules/ai_assistant/cli.ts`

This file currently hardcodes the bootstrap path.

#### Required behavior

- Resolve the app bootstrap dynamically
- First try `findAppRoot()`
- If that fails, use a workspace fallback such as `findAllApps()`
- Resolve bootstrap as:
  - `<resolved app dir>/src/bootstrap.ts`
- Keep the old relative fallback only as a last-resort safety net if needed

#### Reason

`ai_assistant mcp:serve` must not assume `apps/mercato/src/bootstrap.ts`. That path is invalid for standalone apps and for workspace apps whose app folder is not named `mercato`.

---

## Optional Refactoring

This is optional but recommended:

- centralize app/bootstrap resolution helpers in shared utility code instead of duplicating layout fallback logic in multiple packages

This is not required for the first implementation, but it would reduce drift between:
- CLI
- AI assistant
- any future runtime helpers

---

## Acceptance Criteria

The implementation is complete when all of the following are true.

### Runtime

- `mercato generate` works in a standalone app where the app root is the project root
- `mercato generate` works in a workspace app under `apps/<name>/` with hoisted `node_modules`
- `mercato server dev` works in both layouts
- `mercato server start` works in both layouts

### Bootstrap

- `ai_assistant mcp:serve` successfully resolves and imports the real app bootstrap in both layouts

### Integration Tooling

- integration discovery finds app-owned tests in standalone repos
- integration discovery still finds workspace app and package tests in monorepos
- integration runtime does not require `@open-mercato/app`
- integration runtime does not require `apps/mercato`
- integration runtime does not fail solely because root `build:packages` is absent

### Regression Safety

- existing monorepo behavior remains unchanged for the canonical core repo layout
- standalone repos with an unrelated `apps/` folder are not falsely reclassified as workspace apps

---

## Suggested Validation Matrix

Validate in these environments:

1. **Canonical core monorepo**
   - app under `apps/mercato`
   - workspace packages
   - existing dev flow must still work

2. **Workspace app with hoisted real `node_modules`**
   - app under `apps/<custom-name>`
   - packages installed at workspace root
   - resolver must separate `rootDir` from `appDir`

3. **Standalone app**
   - app root is repository root
   - dependencies only in local `node_modules`
   - no workspace root scripts like `build:packages`

---

## Implementation Notes For The Agent

- Edit source files only
- If the core repo commits build output, regenerate the corresponding `dist/*` artifacts after source changes
- Do not implement this as an app-specific workaround
- Do not special-case only one folder name
- Prefer resolver-derived paths over hardcoded path joins
- Treat standalone support as a first-class supported install shape, not as fallback behavior

---

## Explicit File List

If the upstream repo layout is the standard Open Mercato monorepo, the agent must inspect and likely edit:

- `packages/cli/src/lib/resolver.ts`
- `packages/cli/src/mercato.ts`
- `packages/cli/src/lib/testing/integration.ts`
- `packages/cli/src/lib/testing/integration-discovery.ts`
- `packages/cli/src/lib/testing/__tests__/integration-discovery.test.ts`
- `packages/ai-assistant/src/modules/ai_assistant/cli.ts`

If the repo layout differs, edit the equivalent source files in the packages that provide:
- CLI resolution
- CLI server startup
- integration test runtime
- integration test discovery
- AI assistant bootstrap

