# SPEC-006: Community Module Development Workflow (CLI + yalc, no in-repo sandbox)

**Date:** 2026-08-06
**Status:** Draft — largely implemented on a working branch; this spec formalizes it for Core review
**Scope:** OSS — developer workflow and tooling for the official/community modules repository
**Author:** Open Mercato Team
**Supersedes:** SPEC-001 — its **in-repo sandbox app** and **local development mode** only (its package-naming and deep-export contract stays in force); **SPEC-002** (verdaccio prototyping) in full.

---

## 📝 TLDR

Community modules are now developed against an **external standalone consumer app** linked with **yalc**, instead of an application that lives inside the modules repository. An **internal modules CLI** exposes a `module` command namespace with three subcommands — `build`, `watch`, `dev` — shaped 1:1 to the core `mercato` CLI so they can later merge into `mercato module …` alongside `add|enable|eject`. `module dev` runs the full inner loop: build → publish the package into the consumer via yalc → watch → re-publish on every change, with the consumer hot-reloading like any installed dependency. Build/watch/dev logic is centralized in the CLI; packages keep only thin script entries plus an optional per-package build-config for special cases. The in-repo sandbox app and the local-registry (verdaccio) prototyping stack are removed.

---

## Decisions (resolved from the Open Questions gate)

| # | Decision |
|---|----------|
| 1 | **Supersede** the sandbox-app + local-dev-mode of SPEC-001 and all of SPEC-002. |
| 2 | The internal modules CLI is a **transitional stand-in**; its `module build\|watch\|dev` are intended to land in the **core `mercato` CLI**. |
| 3 | **yalc** is the sanctioned primary local-linking mechanism (reversing SPEC-001's rejection of `npm link`-style linking). |
| 4 | The dev consumer is a **freshly scaffolded standalone app** (via the create-app flow), **installed separately** by the developer and attached to the package via yalc. Recommended, not bundled in the modules repo. |
| 5 | Per-package special build needs are declared in a **per-package build-config module** (kept as-is, not folded into a manifest key). |
| 6 | **Production publishing is out of scope.** The local verdaccio stack **and the CI/release + npm publish scripts** were removed as redundant/unused on the branch; the go-forward npm publish path is intentionally not defined here. |
| 7 | **One cohesive spec.** |

---

## 📝 Overview

SPEC-001 established the modules repository as a monorepo of publishable packages and mandated an **in-repo sandbox app** as the development and CI harness, plus a stable-npm-by-default dependency strategy. SPEC-002 added a local **verdaccio** registry for preview installs. In practice the sandbox app is a full application to maintain (thousands of files, its own lifecycle) and the local registry adds moving parts (container, registry auth scripts) for what is fundamentally an "edit module → see it in an app" loop.

This spec keeps SPEC-001's **package contract** (npm package name vs snake_case module ID, source + built output shipped, deep subpath exports) and replaces only the **development harness and inner loop**: the consumer is an external standalone app, linking is done with yalc, and a single internal CLI centralizes the build/watch/dev tooling that packages previously duplicated.

---

## 📝 Problem Statement

1. **The in-repo sandbox app is heavy and off-contract.** It is a complete application maintained inside the modules repo; it couples the repo to an app's lifecycle and does not represent real consumption any better than installing the package into a separate app does.
2. **The local-registry prototyping stack is redundant for the inner loop.** A container-hosted registry plus auth/ping scripts is a lot of machinery to preview a local change that yalc can deliver directly.
3. **Slow, multi-step inner loop.** Prior guidance was: edit source → build → update the package inside the in-repo sandbox → run generation → run the app. Authors need: edit source → change appears in a running consumer with hot reload — no registry, no in-repo app.
4. **Duplicated per-package tooling.** Each package carried its own build and watch scripts; there was no single command surface, and drift was easy (one package even declared a watch script with no backing file).
5. **A real packaging failure.** When a package is linked locally, the consumer resolves the package's **built output**. Without an explicit manifest allow-list, the built-output directory (commonly git-ignored) is **not shipped** by the local-link tooling, so the consumer resolves missing runtime files and fails. The workflow must close this class of failure.
6. **Ongoing maintenance is fragile (observed).** Keeping the bundled app current depends on a platform-sync step that has failed in practice — including yarn install / lockfile errors — and the repository must continuously be held in a state where the in-repo app still builds. This recurring toil (keeping "always a working app" inside the repo) is exactly what the external-consumer model removes: the modules repo no longer owns an application to keep alive.

---

## 📝 Proposed Solution

- **Remove the in-repo sandbox app** and the local-registry prototyping stack. The development consumer is an **external standalone app**, scaffolded fresh via the create-app flow and installed separately by the developer.
- **Link with yalc.** The package is published into the consumer's dependencies as a local copy; the consumer runs its normal dev server and sees the package as an ordinary installed dependency. yalc is chosen over symlink-style linking because it copies a publish-shaped snapshot (closer to real consumption, fewer duplicate-dependency hazards).
- **Introduce an internal modules CLI** with one `module` command namespace and three subcommands:
  - `module build [package…]` — build one or all packages into their built output; per-package special needs come from a declarative build-config; no argument builds all.
  - `module watch [package…]` — rebuild built output on source change via a consolidated multi-package watcher; **no** distribution step.
  - `module dev <package>` — the yalc loop: initial build → publish into the consumer → watch → re-publish on every change; runs until interrupted.
- **Command-shape parity with the core CLI.** Each subcommand is expressed as the core CLI's command shape (a `{ command, run(argv) }` record), and the `module` namespace mirrors the built-in `module add|enable|eject` dispatch, so `build|watch|dev` can later be added as siblings and invoked as `mercato module …`.
- **Centralize the tooling.** Build, watch, consolidated-watch, the yalc loop, and the shared esbuild output-rewriting plugin live once inside the CLI. Packages keep only thin script entries that call the CLI, plus an **optional per-package build-config** for special cases.
- **Fix packaging correctness.** Packages declare an explicit manifest allow-list so the built output (plus source and README) is always shipped to a local-link or npm consumer.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| External consumer app instead of in-repo sandbox | Removes a full app from the repo; matches real consumption; decouples repo from an app lifecycle |
| yalc as the primary link | Copies a publish-shaped snapshot; avoids duplicate-peer hazards of symlink linking; no registry needed |
| Single `module` CLI namespace | One command surface; ends per-package script duplication; ports cleanly to the core CLI |
| Core-CLI command shape | The three subcommands drop into `mercato module …` without rewriting logic |
| Declarative per-package build-config | Keeps special cases (extra loaders, asset copy, post-build hooks) out of shared code and out of every package that does not need them |
| Explicit manifest allow-list for shipped files | Closes the "built output not shipped" failure for both yalc and npm consumers |

### Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| Keep the in-repo sandbox app | High maintenance; couples repo to an app; no better fidelity than an external consumer |
| Symlink-style linking (`npm link` / portal) | SPEC-001 rejected it as environment-sensitive; duplicate-peer hazards; the built-output snapshot yalc produces is closer to real installs |
| Local registry (verdaccio) for the inner loop | Container + auth machinery for something yalc delivers directly; kept only value was preview installs, which the external consumer covers |
| Per-package build/watch scripts (status quo) | Duplication and drift; no unified command surface; blocks the CLI-port goal |
| Build options under a manifest key | Post-build hooks are imperative code; a build-config module expresses them naturally without bloating the manifest |

> **Market Reference:** Modeled on established ecosystem patterns — yalc for testing a package in an external app exactly as published, consolidated single-process package watchers for low idle cost, and source-owning distribution (ship both source and built output). Adopted: external-consumer development, local publish-shaped linking, one CLI surface. Rejected: symlink-first linking, an in-repo application harness, and a local registry as the inner-loop transport.

---

## 📝 Architecture

### Components

- **Internal modules CLI** — a small dispatcher (bin name `mercato-modules`) that resolves the first argument to a command record and runs it. Today it registers one command, the `module` namespace.
- **`module` command** — dispatches `build`, `watch`, `dev` (and `help`), each backed by centralized library code.
- **CLI library** — package discovery + per-package build-config loading; the build routine; the single-package watch routine; the consolidated multi-package watcher and its scope/selection helpers; the yalc dev loop; and the shared esbuild plugin that rewrites relative imports to add explicit extensions in the built output.
- **Package build-config (optional, per package)** — a module that default-exports a `build` options object; only packages with special needs ship it.
- **External standalone consumer app** — scaffolded separately by the developer; consumes the package via yalc; runs its own dev server and hot-reload.
- **yalc** — the transport: publishes a publish-shaped snapshot of the package into the consumer's dependencies and re-pushes on demand.

### Reused vs. new

- **Reused (from SPEC-001):** the package contract — kebab-case npm name vs snake_case module ID, shipping both source and built output, deep subpath exports for cross-module import rewriting.
- **New:** the CLI command surface; the yalc inner loop; the per-package build-config convention; the explicit manifest allow-list; centralized tooling.
- **Removed:** the in-repo sandbox app; the local-registry prototyping stack; per-package build/watch script files.

### Data flow — `module dev <package>`

1. Resolve the package (by name, short name, or the current package).
2. Load its optional build-config.
3. **Initial build** of the package's built output (applying the build-config).
4. **Publish** the package into every consumer that has added it (yalc push).
5. Start the **watcher**: on any source change, rebuild the built output.
6. A debounced watch on the built-output directory triggers a **re-publish** after each rebuild.
7. The consumer's dev server observes the updated dependency and hot-reloads.
8. The loop stays alive until interrupted; on interrupt it stops the watchers and exits.

### Command-shape parity and the port

Each subcommand is the core CLI's command record shape. The `module` namespace mirrors the built-in `module add|enable|eject` handling, so the port to the core CLI is additive: register `build|watch|dev` as further `module` subcommands. Until then, the internal CLI is the stand-in and carries identical behavior.

---

## 📝 Data Models

No application entities. The contracts are repository/package-level.

### Package manifest contract (per module package)

- **`main`** points at the built entry.
- **`files`** is an explicit allow-list that includes the **built output**, the **source**, and the README — guaranteeing the built output ships to yalc and npm consumers alike. *(This is the fix for the missing-built-output failure.)*
- **`scripts`** delegate to the CLI: a build script, a watch script, and a yalc-dev script, each invoking the CLI's `module build|watch|dev` for the current package. *(Invocation form and its constraint are in API Contracts.)*
- **`exports`** keep SPEC-001's deep subpath pattern (source for types, built output for runtime).

### Per-package build-config (optional)

A module that default-exports:

```
{ build: { extraIgnore?, loaders?, assetGlobs?, afterBuild? } }
```

- **`extraIgnore`** — extra source globs excluded from entry points (e.g. integration fixtures).
- **`loaders`** — extra esbuild loaders (e.g. treat font files as inlined data URIs).
- **`assetGlobs`** — non-code assets copied verbatim into the built output, mirroring the source tree.
- **`afterBuild`** — an async hook run after emit (e.g. generate base64 font modules the templates import).

Only packages with special needs ship this file; everything else builds with defaults.

### Root repository manifest

- **`bin`** exposes the `mercato-modules` entry.
- **`dev`** runs the consolidated watcher via the CLI.
- **`build:packages`** builds all packages (task runner invoking each package's build script, which calls the CLI).
- The sandbox/registry/publish/i18n-drift scripts of the prior model are **removed**.

---

## 📝 API Contracts (commands)

### CLI commands

| Command | Behavior |
|---------|----------|
| `module build [package…]` | Build the named packages, or **all** if none named. Applies each package's build-config. |
| `module watch [package…]` | Consolidated watcher; rebuild built output on change. **No** publish. |
| `module dev <package>` | yalc loop for one package: initial build → publish → watch → re-publish per change. Stays alive until interrupted. |
| `module help` | Usage. |

### Package selectors

A selector is a **full package name**, a **short name**, or **`.`** (the package in the current working directory). **No selector** means **all packages**. Unknown selectors fail fast with the available list.

### Invocation forms and a known constraint

- **From the repository root:** the `mercato-modules` bin resolves and is the intended human entry (e.g. build/dev a named package, or watch all).
- **From inside a package:** the package's own `build` / `watch` / `dev:yalc` scripts run the loop for that package.
- **Constraint (documented, handled):** under the repo's package manager, the root-level bin is **not** on `PATH` for a workspace package's own scripts (invoking the bin by name there fails). Therefore **package scripts invoke the CLI entry directly through Node**, not through the bin name; the bin name is used from the repository root. This is a deliberate, tested accommodation, not a bug.

### Consumer side

- The developer scaffolds a standalone app separately, then **adds** the package with yalc.
- Running `module dev <package>` keeps the consumer's copy fresh; the consumer runs its normal dev server.

### Developer walkthrough (example)

Developing a module package against an external standalone app:

1. **One-time — consumer app.** Scaffold a standalone app via the create-app flow and install it (done once, outside the modules repo).
2. **Modules repo — start the dev loop.** From the package: `yarn dev:yalc`. Equivalently from the repo root: `yarn mercato-modules module dev <package>`. This builds the package, publishes it into every consumer that added it, then watches and re-publishes on each change. It stays running.
3. **Consumer app — link once.** `yalc add <package-name>` (uses the package's published name, not a path), then start the app's dev server: `yarn dev`.
4. **Edit and see it live.** Change the module's source; the loop rebuilds the built output and re-pushes; the app hot-reloads the updated dependency.
5. **Stop.** Interrupt the dev loop (Ctrl-C); the watchers shut down.

Notes: the first `module dev` run performs the initial build + publish, so the consumer resolves real runtime files immediately; subsequent pushes are incremental. For a compile-only loop with no publishing, use `module watch` instead.

### Port target

The same three verbs are intended to exist as `mercato module build|watch|dev`, siblings of `mercato module add|enable|eject`, using the identical command record shape.

---

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behavior / handling |
|----------|--------------------|
| Built output not shipped by the linker | Closed by the manifest `files` allow-list; the consumer always resolves real runtime files. |
| `module dev` exits right after the first publish | The dev loop must **keep the process alive** until interrupted; otherwise the CLI's normal exit tears down the watchers. (Encountered and fixed during implementation.) |
| Bin name unavailable inside package scripts | Package scripts call the CLI entry through Node directly; the bin name is used only from the repo root. |
| yalc uses copy, not symlink | Each change re-copies the built output into the consumer; acceptable (sub-second even for asset-heavy packages) and closer to real installs. |
| Package with special build (fonts/assets) | Declared in the per-package build-config (`loaders`, `assetGlobs`, `afterBuild`); default builds are unaffected. |
| Fresh clone with no prior build | Building is an explicit step; a package's built output is produced by `module build`/`module dev` before a consumer can resolve it. *(A future `prepare`-on-install hook is a candidate; see Risks.)* |
| Multiple consumers of the same package | yalc pushes to every consumer that added the package. |

---

## 📝 Risks & Impact Review

### Publish and CI positioning deferred

- **Scenario:** The local publish stack (and the in-repo CI smoke it fed) was removed, and no go-forward publish/CI path is defined here.
- **Severity:** Medium · **Area:** release / CI confidence.
- **Mitigation:** explicitly **out of scope (Decision 6)**; external-scaffold integration already installs the package and is the natural replacement signal. Must be settled in a dedicated spec before release automation depends on it. **Residual:** Medium — flagged for the Core team.

### Divergence between the internal CLI and the core CLI

- **Scenario:** The stand-in CLI and the core CLI drift before the port lands.
- **Severity:** Medium · **Area:** maintainability.
- **Mitigation:** identical command record shape and namespace semantics; the port is additive. **Residual:** Low.

### yalc as the sanctioned link (reversal of SPEC-001)

- **Scenario:** SPEC-001 rejected local linking as environment-sensitive; this workflow adopts yalc.
- **Severity:** Low · **Area:** developer environments.
- **Mitigation:** yalc copies a publish-shaped snapshot rather than symlinking, matching real consumption without duplicate-peer hazards. **Residual:** Low.

---

## 📋 Phasing

| Phase | Content | Status |
|-------|---------|--------|
| **1 — Remove sandbox, local registry, publish/CI** | Delete the in-repo sandbox app, the verdaccio/registry prototyping stack, and the CI/release + npm publish scripts; rewire root scripts | **Implemented** on the working branch |
| **2 — Internal modules CLI** | `module build\|watch\|dev` over centralized build/watch/dev logic; thin package scripts | **Implemented** |
| **3 — Packaging + per-package config** | Manifest `files` allow-list; per-package build-config convention | **Implemented** |
| **4 — Port + publish positioning** | Merge `build\|watch\|dev` into core `mercato module …`; define go-forward publish path | **Open** (Decisions 2 & 6) |

## 📋 Implementation Plan

Each step leaves the repo working. Steps marked ✅ exist on the working branch and can be cross-checked by Core.

### Phase 1 — Remove sandbox, local registry, and publish/CI stack
1. ✅ Remove the in-repo sandbox app and its sandbox-only scripts.
2. ✅ Remove the local-registry (verdaccio) stack, its scripts, and the platform-sync/config it depended on.
3. ✅ Remove the CI and release workflows and the npm publish/pack/build scripts and quality-gate scripts they invoked (go-forward publish path deferred — Decision 6).
4. ✅ Incidental slimming: drop repo-housekeeping scripts no longer used (clean helpers, quality gates) and the bundled skills-install script — skills are now installed via `npx skills add open-mercato/skills --skill '*'`.
5. ✅ Rewire root scripts so build/dev/test operate on packages only; drop app-coupled scripts.

### Phase 2 — Internal modules CLI
1. ✅ Add the CLI dispatcher (bin `mercato-modules`) and the `module` namespace.
2. ✅ Centralize build, single-package watch, consolidated multi-package watch, and the yalc dev loop into CLI library code.
3. ✅ Implement `module build|watch|dev` with package selectors (name / short name / `.` / all).
4. ✅ Keep the dev loop alive until interrupted (fix the premature-exit failure).

### Phase 3 — Packaging + per-package config
1. ✅ Add the manifest `files` allow-list so built output ships to yalc/npm consumers.
2. ✅ Introduce the per-package build-config convention; migrate the special-build package (fonts/assets) to it.
3. ✅ Replace per-package build/watch script files with thin CLI-invoking scripts; add the missing watch entry.

### Phase 4 — Port + publish positioning (open)
1. ⬜ Add `build|watch|dev` as `mercato module …` subcommands in the core CLI, reusing the command records.
2. ⬜ Decide and document the go-forward npm publish path (separate spec).
3. ⬜ Decide the CI signal that replaces the former in-repo smoke (external-scaffold integration is the candidate).

### Testing strategy
- Build one/all packages via the CLI (unit/build check).
- `module dev` against an external consumer: initial publish, stay-alive, and re-publish on source change (integration check).
- Consolidated `module watch` discovers and rebuilds every package (integration check).
- Manifest allow-list verified by resolving the package's built entry from a consumer.

---

## Final Compliance Report — 2026-08-06

### AGENTS.md files reviewed
- root `AGENTS.md`
- specs-folder agent rules

### Compliance matrix

| Rule source | Rule | Status | Notes |
|-------------|------|--------|-------|
| specs-folder agent rules | Non-trivial spec includes full structure | Compliant | TLDR, Overview, Problem, Solution, Architecture, Data Models, API Contracts, Risks, Compliance, Changelog present |
| specs-folder agent rules | Implementation-accurate; no stale assumptions | Compliant | Grounded in the working branch (CLI, `files`, per-package build-config, removed sandbox/registry) |
| SPEC-001 | Package contract (name vs module ID, source+built output, deep exports) | Compliant | Explicitly preserved; only harness/dev-mode superseded |
| SPEC-002 | Local registry prototyping | Superseded | Removed as redundant with yalc (Decision 1/6) |
| root `AGENTS.md` | Keep repo/package concerns cleanly separated | Compliant | Tooling centralized in the CLI; packages carry thin scripts |

### Internal consistency check

| Check | Status | Notes |
|-------|--------|-------|
| Supersession scope is explicit | Pass | SPEC-001 dev-mode/sandbox + SPEC-002 only |
| Commands map to the core CLI shape | Pass | `{ command, run(argv) }`; `module` namespace parity |
| Failure modes documented | Pass | Missing built output, premature dev exit, bin-on-PATH constraint |
| Out-of-scope items flagged | Pass | Publish path and CI signal deferred (Decisions 2 & 6) |

### Verdict
**Compliant** — ready for Core review as the developer-workflow successor to SPEC-001's harness/dev-mode and to SPEC-002.

---

## Out of Scope

- The go-forward npm publish/release path (Decision 6).
- End-user module install/enable/eject UX (owned by the core CLI).
- The concrete standalone consumer app (external, scaffolded separately; not part of this repo).
- Any change to the SPEC-001 package **contract** beyond the `files` allow-list.

---

## Changelog

### 2026-08-06
- Initial spec formalizing the implemented CLI + yalc development workflow.
- Records supersession of SPEC-001 (sandbox app + local dev mode) and SPEC-002 (verdaccio).
- Captures the seven resolved gate decisions; marks Phases 1–3 implemented and Phase 4 (core-CLI port + publish positioning) open.
- Records removal of the CI/release + npm publish stack (go-forward publish deferred) and incidental repo slimming (skills now installed via the skills CLI, not a bundled script).
- Adds observed maintenance-fragility motivation to the Problem Statement (platform-sync / yarn install failures; the toil of keeping an always-building in-repo app).
