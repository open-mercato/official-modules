# SPEC-006: Prettier + lint-staged for the official-modules monorepo

## TLDR

**Key Points:**
- Add Prettier as the canonical code formatter for the entire `official-modules` monorepo
- Enforce formatting on commit via lint-staged and in CI via a `format:check` script

**Scope:**
- `.prettierrc` at repo root
- `.prettierignore` at repo root
- `lint-staged` config in root `package.json`
- `format` and `format:check` scripts in root `package.json`
- CI workflow step: fail PR if formatting is inconsistent
- One-time bulk format of all existing source files

**Out of scope:**
- ESLint rule changes
- Per-package Prettier overrides
- Automatic format-on-save IDE config (left to contributors)

---

## Overview

`official-modules` currently has no enforced code style. Every contributor formats TypeScript differently — spacing, quote style, trailing commas, semicolons. TypeScript catches type errors but ignores whitespace. The result is inconsistent diffs, wasted code review cycles, and a higher barrier for new contributors who must infer style from context.

Prettier solves this with an opinionated, zero-config formatter that produces deterministic output regardless of who wrote the code. lint-staged ensures formatting is applied automatically at commit time, so the CI `format:check` step becomes a safety net rather than the primary enforcement mechanism.

> **Market Reference**: Prettier is the de-facto standard in TypeScript monorepos (Turborepo starter, Next.js, shadcn/ui all ship it at root). Adopted: root-level config with lint-staged. Rejected: per-package config overrides (adds maintenance overhead for negligible benefit in a single-language repo).

---

## Problem Statement

1. **No baseline style** — three packages in the repo already show inconsistent spacing, quote styles, and trailing comma usage. As the module count grows, divergence compounds.
2. **Code review noise** — reviewers waste attention on whitespace when they should focus on logic.
3. **New contributor friction** — no formatter means no automated feedback; contributors must read existing code to infer conventions that are never written down.
4. **i18n-check-sync already enforces one style rule** (alphabetical key order) via CI — formatting deserves the same treatment.

---

## Proposed Solution

Add Prettier at the monorepo root with a minimal, explicit config. Wire it into the commit lifecycle via lint-staged (formats staged files before each commit) and into CI (fails if any file diverges from Prettier's output).

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single root `.prettierrc` | All packages use TypeScript + React — no need for per-package overrides |
| `lint-staged` on commit | Formats automatically; developer never has to think about it |
| CI `format:check` (not auto-fix) | CI should fail loudly; auto-fix on CI creates hidden commits |
| `printWidth: 120` | Existing codebase has lines up to ~130 chars; 120 is a practical compromise |
| `singleQuote: true` | Majority of existing code already uses single quotes |
| `semi: false` | Majority of existing code omits semicolons |
| `trailingComma: 'all'` | Reduces multi-line diff noise; aligns with TypeScript community default |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| ESLint `@typescript-eslint/stylistic` | More complex setup; overlaps with Prettier; Prettier is simpler and faster |
| Per-package Prettier configs | Unnecessary complexity for a single-language repo |
| Biome (Rome successor) | Fewer ecosystem integrations; most contributors expect Prettier |

---

## Implementation Plan

### Phase 1: Add Prettier tooling

**Steps:**

1. Add `prettier` and `lint-staged` to root `devDependencies`:
   ```bash
   yarn add -D prettier lint-staged
   ```

2. Create `.prettierrc` at repo root:
   ```json
   {
     "printWidth": 120,
     "tabWidth": 2,
     "useTabs": false,
     "semi": false,
     "singleQuote": true,
     "quoteProps": "as-needed",
     "trailingComma": "all",
     "bracketSpacing": true,
     "bracketSameLine": false,
     "arrowParens": "always"
   }
   ```

3. Create `.prettierignore` at repo root:
   ```
   # Build outputs
   dist/
   **/dist/
   *.tsbuildinfo

   # Dependencies
   node_modules/
   **/node_modules/

   # Lock files and generated artifacts
   yarn.lock
   **/generated/

   # Sandbox
   apps/sandbox/.next/
   apps/sandbox/data/

   # Scripts (shell)
   scripts/**/*.sh
   ```

4. Add `lint-staged` config to root `package.json`:
   ```json
   "lint-staged": {
     "**/*.{ts,tsx,json,md}": "prettier --write"
   }
   ```

5. Add scripts to root `package.json`:
   ```json
   "format": "prettier --write .",
   "format:check": "prettier --check ."
   ```

6. Add `prepare` script (installs git hooks via husky, or use `simple-git-hooks` — see note below):

   > **Note on git hooks runner**: If the repo already uses `husky` (check root `package.json`), wire lint-staged through it. If not, use `simple-git-hooks` (lighter, no install step, single JSON config):
   ```json
   "simple-git-hooks": {
     "pre-commit": "yarn lint-staged"
   }
   ```

7. Run one-time bulk format:
   ```bash
   yarn format
   ```
   Commit the result as a single standalone commit: `chore: apply initial Prettier formatting`.

8. Add `format:check` step to CI workflow (`.github/workflows/test.yml`):
   ```yaml
   - name: Check formatting
     run: yarn format:check
   ```
   Place it after `yarn install`, before `typecheck`.

### File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `.prettierrc` | Create | Prettier config |
| `.prettierignore` | Create | Exclusions |
| `package.json` | Modify | Add `format`, `format:check` scripts; `lint-staged` config; devDeps |
| `.github/workflows/test.yml` | Modify | Add `format:check` CI step |

---

## Risks & Impact Review

### Data Integrity Failures
Not applicable — this change affects tooling only, no database or runtime state.

### Cascading Failures & Side Effects

- **Bulk format commit creates a large diff** — git blame becomes noisy for all formatted files. Mitigation: use `.git-blame-ignore-revs` to exclude the bulk commit from `git blame` output.
- **lint-staged slows down commits** — Prettier on staged files typically runs in <2s. Acceptable.
- **CI step adds ~5s** — `prettier --check` on the full repo is fast. Acceptable.

### Tenant & Data Isolation Risks
Not applicable.

### Migration & Deployment Risks

- **Existing branches get merge conflicts** after the bulk format commit. All open PRs (including `feat/pdf-generators`) must rebase or merge from `develop` after the bulk format lands. Mitigation: merge this PR before other large feature PRs, and communicate to all contributors.
- **Breaking change for contributors with auto-format on save** — their editors will now format consistently rather than diverging. This is a feature, not a risk.

### Operational Risks
None. Prettier failure in CI blocks PR merge but does not affect production.

### Risk Register

#### Large diff from bulk format
- **Scenario**: The one-time `yarn format` produces a multi-thousand-line diff that obscures real changes in `git log`
- **Severity**: Low
- **Affected area**: Git history readability
- **Mitigation**: Isolated standalone commit with message `chore: apply initial Prettier formatting`; add commit SHA to `.git-blame-ignore-revs`
- **Residual risk**: Minimal — standard practice for formatter introduction

#### Open PRs need rebase
- **Scenario**: Contributors with open branches get conflicts after bulk format commit lands
- **Severity**: Medium
- **Affected area**: All open PRs at time of merge
- **Mitigation**: Merge this PR first, communicate to all contributors to rebase immediately after
- **Residual risk**: Minor inconvenience; one-time cost

---

## Final Compliance Report

## Final Compliance Report — 2026-05-18

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | External extension only — no core modifications | Compliant | Tooling-only change, no packages/core touched |
| root AGENTS.md | Use zod for all inputs | N/A | No runtime code |
| root AGENTS.md | No `any` types | N/A | No runtime code |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| Config matches stated design decisions | Pass | printWidth 120, singleQuote, no semi, trailingComma all |
| CI step matches `format:check` script | Pass | Both use `prettier --check` |
| `.prettierignore` covers all generated/binary paths | Pass | dist/, node_modules/, yarn.lock, .next/, data/ |

### Non-Compliant Items
None.

### Verdict
**Fully compliant** — ready for implementation.

---

## Changelog

### 2026-05-18
- Initial specification
