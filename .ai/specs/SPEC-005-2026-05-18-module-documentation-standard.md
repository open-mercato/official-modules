# SPEC-005: Module Documentation Standard

## TLDR

**Key Points:**
- Documentation follows a three-level hierarchy: repo root README (module table) → `packages/<name>/README.md` (shortened module docs) → `packages/<name>/docs/*.md` (extended documentation split into files).
- `packages/<name>/README.md` contains real content (not just navigation) — a short module overview, quick start, screenshots, and links to extended docs.
- The reference implementation is `packages/pdf-generators` on the `feat/pdf-generators` branch — its `docs/README.md` should be split into separate files following this standard.
- CI blocks PRs if required files are missing.

**Scope:**
- Three-level README hierarchy: repo → package → docs/
- Content standard for `packages/<name>/README.md` (shortened docs)
- Required files in `docs/` (extended documentation)
- GitHub Actions validation — blocks merge when required files are missing

**Concerns:**
- `carrier-inpost` has no documentation at all — needs to be written from scratch
- Duplicate SPEC-004 in `.ai/specs/` — out of scope for this specification

---

## Overview

Every module in `offical-modules` is an external extension installed by developers building applications on Open Mercato. Documentation quality directly impacts adoption — a module without a README is a module nobody will install without reading the source.

This specification defines the **required minimum documentation set** for each package and the **directory structure**, so authors know exactly what to write and reviewers and CI know what to check before merging.

> **Market Reference**: Modeled on the approach used by Shopify Polaris, Medusa.js, and shadcn/ui — each project has a consistent per-package structure with documentation split into thematic files (installation, api, contributing). Monolithic wiki models (Confluence, Notion) were rejected as fragile and disconnected from the code. A single large README.md was also rejected — for modules as complex as pdf-generators it quickly becomes unreadable.

## Problem Statement

Current state of the repository:

| Package | Root README | docs/ | Status |
|---------|-------------|-------|--------|
| `pdf-generators` | missing | `docs/README.md` (monolithic) | Partial — no root README, no file split |
| `carrier-inpost` | missing | missing | No documentation |
| `test-package` | missing | missing | Placeholder — excluded from scope |

The lack of a standard causes:
1. **npm shows an empty page** for the package — `packages/<name>/README.md` is required by `npm publish`
2. **Authors don't know what to write** — everyone invents their own structure or writes nothing
3. **Reviewers have no checklist** — PRs can be merged without documentation
4. **External contributors cannot onboard** — no contributing guide

## Proposed Solution

Documentation is organized in three levels:

**Level 1 — Repo root `README.md`**
A table of all available modules with a short description and a link to `packages/<name>/README.md`. Maintained by repository maintainers.

**Level 2 — `packages/<name>/README.md`**
The main module documentation — shortened but containing real content: what it does, how to install it, screenshots, the most important usage examples. Includes a section with links to `docs/` for those who need more detail. This is what users see on npmjs.com.

**Level 3 — `packages/<name>/docs/*.md`**
Extended documentation split into thematic files. Linked from Level 2.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `packages/<name>/README.md` contains real content, not just navigation | npm renders the root README — an empty file with only links is poor UX for potential package users |
| `docs/` with separate files instead of a single `docs/README.md` | Each file has a single responsibility; enables deep-linking to specific sections; easier PR review |
| Repo root README as a module table | Single entry point to the entire ecosystem; GitHub renders it automatically |
| CI blocks PRs | Enforcement without CI is just a "suggestion" — documentation is always pushed off until later |

## User Stories / Use Cases

- **A developer evaluating a module** wants to see a short description and links to documentation on npmjs.com so they can assess the module without reading the source.
- **A developer integrating a module** wants to open `docs/api.md` and find a complete API reference with examples without searching the entire repository.
- **A contributor** wants to open `docs/contributing.md` and know how to run the module locally and how to add new functionality.
- **A PR reviewer** wants CI to fail with a clear error if required documentation is missing.

## Architecture

Documentation is a static repository artifact. It requires no new Medusa modules, entities, or endpoints. The "components" are: the file structure, the content standard, and the CI script.

### Directory Structure

```
README.md                          ← LEVEL 1 — repo root: table of all modules

packages/<package-name>/
├── README.md                      ← LEVEL 2 — main module docs (shortened, with content)
├── docs/
│   ├── installation.md            ← LEVEL 3 — step by step: install, register, generate
│   ├── usage.md                   ← LEVEL 3 — external integration, examples
│   ├── api.md                     ← LEVEL 3 — REST endpoints + TypeScript exports
│   ├── contributing.md            ← LEVEL 3 — local setup, package structure
│   └── screenshots/               ← OPTIONAL — PNGs referenced in README or docs
└── skill/
    └── SKILL.md                   ← OPTIONAL (REQUIRED when the module has an extensible API)
```

### Module Skill (`skill/SKILL.md`)

Any module that exposes an **extensible API** — meaning another module can add its own content to it (templates, adapters, handlers, providers) — should ship a skill that automates that process for consumers.

A skill is a Markdown file installed by `yarn install-skills` into the developer's LLM environment. It lets a developer type e.g. `scaffold pdf templates for my module` instead of manually creating files by following the documentation.

**When a skill is required:**

- The module exports a base class to extend (e.g. `BaseDocumentService`)
- The module uses a convention file pattern (e.g. `pdf-generators.ts`, `carrier-rates.ts`)
- The module has a precise file schema that consumers must replicate

**When a skill is optional:**

- The module has no public extensible API (works standalone)
- Integration is limited to configuration in `src/modules.ts`

**Required content of `skill/SKILL.md`:**

```markdown
---
name: <skill-name>          # kebab-case, e.g. scaffold-pdf-templates
description: <description>  # one-sentence description + trigger keywords
---

# <skill-name>

What the skill does and when to use it.

## Inputs
What variables to ask the user before generating files.

## Steps
What files to generate and in what order — with full code templates.
```

Reference: `packages/pdf-generators` on the `feat/pdf-generators` branch ships the `scaffold-pdf-templates` skill, which generates a `DocumentService`, a React-PDF component, and a convention file in one step.

### Level 1 — Repo root `README.md`

The existing module table (already in the repo). Must be updated when a new module is added:

```markdown
## Available modules

| Module | Description | Docs |
|--------|-------------|------|
| [`@open-mercato/pdf-generators`](packages/pdf-generators/README.md) | PDF generation framework | [Docs](packages/pdf-generators/README.md) |
| [`@open-mercato/carrier-inpost`](packages/carrier-inpost/README.md) | InPost carrier integration | [Docs](packages/carrier-inpost/README.md) |
```

### Level 2 — `packages/<name>/README.md` — template

Contains real, shortened content. Standard sections:

```markdown
# @open-mercato/<name>

<2-3 sentences: what the module does, for whom, what it provides out-of-the-box.>

---

## Screenshots

<At least 1 screenshot if the module has UI — referenced from docs/screenshots/>

---

## Quick start

\`\`\`bash
yarn mercato module add @open-mercato/<name>
\`\`\`

<The most important usage example — 1 code block or flow description.>

---

## Documentation

- [Installation](docs/installation.md)
- [Usage & Integration](docs/usage.md)
- [API Reference](docs/api.md)
- [Contributing](docs/contributing.md)

---

## License

MIT
```

Target size: **roughly 50–150 lines**. If the "Quick start" section grows beyond one example — move it to `docs/usage.md` and leave only a link.

---

## Required File Contents

### `docs/installation.md`

Required elements:

1. **Requirements** — Open Mercato version, peer dependencies (if non-obvious)
2. **Step-by-step installation** — `mercato module add`, registration in `src/modules.ts`, `yarn generate`, migrations, verification
3. **Permissions** — if the module adds new ACL features, how to sync them with roles
4. **Verification** — what to check to confirm the module is working

### `docs/usage.md`

Required elements:

1. **Overview** — what the module does from the user's perspective
2. **Core use cases** — with code examples or screenshots
3. **External integration** — how to extend the module from another module (convention files, extension points)

Optional:

- **Built-in defaults** — when the module ships ready-made templates / configurations to override
- **Configuration** — env vars, runtime settings

### `docs/api.md`

Required elements (if the module exposes an API):

1. **REST Endpoints** — for each endpoint: method + path, description, request body, response shape, error codes
2. **TypeScript exports** — public classes, functions, and types exported from the package with descriptions

The section may be empty (with a note) if the module exposes no API.

### `docs/contributing.md`

Required elements:

1. **Local setup** — how to run the module in watch mode + sandbox
2. **Package structure** — `src/` directory tree with a description of each file/folder
3. **How to add new functionality** — workflow for the most common extension case (e.g. a new template, a new carrier)

---

## Implementation Plan

### Phase 1: Standard and infrastructure

1. Finalize this specification (done)
2. Update root `AGENTS.md` — add a "Documentation Requirements" section with a link to this specification
3. Update the `scaffold-module` skill — generate empty templates for required docs files when scaffolding a new package
4. Add a GitHub Actions workflow `.github/workflows/docs-check.yml` — on every PR, checks whether all required files (`README.md`, `docs/installation.md`, `docs/usage.md`, `docs/api.md`, `docs/contributing.md`) exist in changed packages; blocks merge if any are missing

### Phase 2: Documentation for existing packages

Every existing package in `packages/` must be brought up to the required docs structure. Each package is a separate PR.

For `carrier-inpost`:
1. Add `packages/carrier-inpost/README.md` (shortened docs)
2. Create `packages/carrier-inpost/docs/installation.md`
3. Create `packages/carrier-inpost/docs/usage.md`
4. Create `packages/carrier-inpost/docs/api.md`
5. Create `packages/carrier-inpost/docs/contributing.md`
6. Update repo root `README.md` — add a link to `carrier-inpost` in the module table

### File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `AGENTS.md` | Modify | Add Documentation Requirements section |
| `.github/workflows/docs-check.yml` | Create | CI validation of required files |
| `packages/carrier-inpost/README.md` | Create | Shortened module docs (level 2) |
| `packages/carrier-inpost/docs/installation.md` | Create | — |
| `packages/carrier-inpost/docs/usage.md` | Create | — |
| `packages/carrier-inpost/docs/api.md` | Create | — |
| `packages/carrier-inpost/docs/contributing.md` | Create | — |
| `README.md` | Modify | Update module table with link to carrier-inpost docs |

---

## Risks & Impact Review

### Technical debt — carrier-inpost

#### No knowledge of the carrier-inpost module
- **Scenario**: The required documentation must be written by someone who understands the module — if the original author is unavailable, the maintainer must read the source from scratch
- **Severity**: Medium
- **Affected area**: `packages/carrier-inpost`
- **Mitigation**: Phase 2 explicitly assigns creating docs for carrier-inpost; scaffold-module generates templates with placeholder content as a starting point
- **Residual risk**: Quality of carrier-inpost documentation depends on author availability

### CI template drift

#### Required structure changes without updating CI
- **Scenario**: Someone decides `docs/api.md` is not required for simple modules with no API, but CI still requires it and blocks PRs
- **Severity**: Low
- **Affected area**: All new PRs adding modules
- **Mitigation**: The list of required files in CI is managed as an array in a single place in the workflow YAML — trivial to edit
- **Residual risk**: Acceptable — a simple change in one file

---

## Final Compliance Report — 2026-05-18

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | Packages in `packages/<name>/` | Compliant | Applies only to docs files — no code added outside packages/ |
| root AGENTS.md | Must not modify core packages | Compliant | Spec does not touch any core package |
| root AGENTS.md | Check `.ai/specs/` before starting | Compliant | Checked — no existing spec on documentation |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| File Manifest covers all packages from Problem Statement | Pass | carrier-inpost |
| Implementation Phases are executable without blocking each other | Pass | Phase 1 and 2 are independent |
| CI scope matches required files from Architecture | Pass | Checks exactly the 5 files from the list |

### Verdict

**Fully compliant** — Approved, ready for implementation.

---

## Changelog

### 2026-05-18
- Full specification after resolving Open Questions
- Architecture changed to three-level: repo root → `packages/<name>/README.md` (shortened content) → `docs/*.md` (extended)
- `packages/<name>/README.md` contains real content, not just navigation
- Added `skill/SKILL.md` requirement for modules with extensible APIs
- CI blocks PRs when required files are missing
