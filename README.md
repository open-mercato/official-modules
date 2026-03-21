<p align="center">
  <img src="https://raw.githubusercontent.com/open-mercato/open-mercato/main/apps/mercato/public/open-mercato.svg" alt="Open Mercato logo" width="120" />
</p>

# Open Mercato Official Modules

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-openmercato.com-1F7AE0.svg)](https://docs.openmercato.com/)
[![Core Repo](https://img.shields.io/badge/core-open--mercato-24292F.svg)](https://github.com/open-mercato/open-mercato)
[![Docs](https://img.shields.io/badge/docs-modules.openmercato.com-1F7AE0.svg)](https://modules.openmercato.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](https://github.com/open-mercato/official-modules/issues)

A community monorepo for publishing ready-to-install `@open-mercato/*` modules that extend [Open Mercato](https://github.com/open-mercato/open-mercato) without touching its core.

Install and operations docs for the published modules live at [modules.openmercato.com](https://modules.openmercato.com/).

## What this is

Open Mercato ships with a module system that lets you add features to your app without forking or modifying the platform. **This repo is where the community publishes those features.**

If you're looking for the main Open Mercato application and the core framework code, see the [Open Mercato core repository](https://github.com/open-mercato/open-mercato).

Every module here:

- 🔌 **Installs in one command** — no manual wiring, no config files to edit
- 🔒 **Stays isolated** — each module is its own npm package that hooks into the platform through declared extension points, never by patching core code
- 🧬 **Is ejectable** — run `--eject` to copy the module into your app and own it fully
- 🤝 **Gets reviewed** — every submission goes through core team review before reaching npm

Whether you're adding a small UI widget or shipping a full vertical feature with its own entities, API routes, and admin pages — if it runs on Open Mercato, it belongs here.

## How it works

Modules are published under `@open-mercato/*` and installed into any standalone Open Mercato app via the `mercato` CLI:

```bash
# Install and activate in one step
yarn mercato module add @open-mercato/<module-name>

# Install it and copy the source locally if you want to modify the module yourself
yarn mercato module add @open-mercato/<module-name> --eject

# If it is already installed, copy it locally now so you can start modifying it
yarn mercato module enable @open-mercato/<module-name> --eject
```

Running `module add` fetches the package from npm, auto-discovers the module it contains, registers it in your app's `src/modules.ts`, and runs the code generators. Apply migrations and you're live.

Each package integrates through [UMES extension points](https://docs.openmercato.com/framework/modules/overview): widget injection, event subscribers, response enrichers, API interceptors, and custom entities. Core packages stay untouched and upgradeable.

## 🚀 Getting Started

Clone the repo and spin up the sandbox environment to start building:

```bash
git clone https://github.com/open-mercato/official-modules.git
cd official-modules

cp apps/sandbox/.env.example apps/sandbox/.env

docker compose up --build -d

yarn install

yarn generate

yarn initialize

yarn dev
```

Navigate to `http://localhost:3000/backend` and sign in with the credentials printed by `yarn initialize`.

The sandbox is a full Open Mercato app wired to all workspace packages. Any package you build under `packages/` is immediately available to it — no registry publish required.

## Platform Sync

This repo follows one branch rule:

- `develop` validates against Open Mercato `develop`
- `main` validates against Open Mercato `latest`

After switching branches, align the repo with:

```bash
yarn platform:sync
```

You can force a channel explicitly when needed:

```bash
yarn platform:sync --channel develop
yarn platform:sync --channel latest
```

CI verifies the same state without mutating files:

```bash
yarn platform:sync --check
```

`platform:sync` rewrites only the sandbox app's exact platform pins, workspace package `devDependencies`, and `yarn.lock`. Published compatibility still lives in each package's `peerDependencies`, which must stay on stable ranges.

## 🧩 Module List

| Package | Description | Author |
|---------|-------------|--------|
| — | *No modules yet. Be the first to contribute!* | — |

## ⚡ Installing a Module

Modules are installed into your standalone Open Mercato app using the `mercato` CLI.

**Install and register in one step:**

```bash
yarn mercato module add @open-mercato/<module-name>
```

**Apply database migrations and start:**

```bash
yarn generate
yarn mercato db:migrate
yarn dev
```

**Install a specific version or tag:**

```bash
yarn mercato module add @open-mercato/<module-name>@preview
```

**Install it and copy the source locally if you want to modify the module yourself:**

```bash
yarn mercato module add @open-mercato/<module-name> --eject
```

When added with `--eject`, the module is copied into your `src/modules/<moduleId>/` directory. You own the code — edit it freely while the rest of the platform stays on npm.

**If the package is already in `node_modules` and only needs activating:**

```bash
yarn mercato module enable @open-mercato/<module-name>
```

**If the package is already installed, copy it locally now so you can start modifying it:**

```bash
yarn mercato module enable @open-mercato/<module-name> --eject
```

Full CLI reference: [docs.openmercato.com/cli/module-add](https://docs.openmercato.com/cli/module-add)

## 🏗️ Building a Module

Community modules live in `packages/<module-name>/` and are published under the `@open-mercato/` scope. Before starting module work, first complete the [Getting Started](#-getting-started) setup above. Once your local environment is ready, the recommended workflow is:

```
spec-writing  →  scaffold-module  →  implement-spec
```

### Step 1 — Write a spec

Before writing code, document your module in `.ai/specs/SPEC-XXX-YYYY-MM-DD-<title>.md`. This is the design document that `implement-spec` reads to know what to build.

Minimum sections: TLDR · Problem Statement · UMES extension points used · Data models · API contracts · Phases.

### Step 2 — Scaffold the package

Use the `scaffold-module` skill (in `.ai/skills/scaffold-module/SKILL.md`) to generate the complete package skeleton from your spec. It produces all required files — `package.json`, build config, `acl.ts`, `setup.ts`, a placeholder backend page — ready to build immediately.

```bash
# After scaffold, verify it builds cleanly
yarn workspace @open-mercato/<your-module> build
yarn workspace @open-mercato/<your-module> typecheck
```

### Step 3 — Implement the spec

Use the `implement-spec` skill to fill in the business logic phase by phase: entities, validators, API routes, UI pages, events, widget injection. Every phase must pass the code-review compliance gate before moving to the next.

### Step 4 — Validate in the sandbox

The sandbox is a workspace sibling — no registry publish needed. Add your module to `apps/sandbox/src/modules.ts`:

```ts
{ id: '<module_id>', from: '@open-mercato/<module-name>' },
```

Then build and start:

```bash
yarn build:packages                         # build the package first
yarn generate                               # regenerate sandbox registry
yarn mercato db:migrate                     # apply any new migrations
yarn dev                                    # open localhost:3000/backend
```

Navigate to `/backend/<module-name>` and confirm the module loads, pages render, and APIs respond. Remove the entry from `modules.ts` before opening a PR.

### Step 5 — Open a pull request

Open a PR against `develop`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full checklist. The core team will review and, once approved, publish to npm.

## 📦 Package Conventions

- Package name: `@open-mercato/<module-name>` (kebab-case)
- Module ID inside the package: `snake_case` (e.g. `my_module`) — derived by replacing `-` with `_`
- Peer dependencies: declare stable compatibility ranges for required `@open-mercato/*` host packages; do not use sync-managed exact pins there
- Development pins: keep required `@open-mercato/*` build/test dependencies in `devDependencies`; `yarn platform:sync` owns their exact versions
- Exports: follow the export map in `packages/test-package/package.json` exactly
- `ejectable: true` in `index.ts` metadata if you want consumers to be able to take source ownership
- Every module MUST use UMES extension points — it MUST NOT modify core packages

## 🔗 Resources

- [Open Mercato core repo](https://github.com/open-mercato/open-mercato)
- [Official modules documentation](https://modules.openmercato.com/)
- [Module development guide](https://docs.openmercato.com/framework/modules/overview)
- [CLI reference](https://docs.openmercato.com/cli/overview)
- [Discord community](https://discord.gg/f4qwPtJ3qA)

## Contributing

We welcome modules of all sizes — from thin UI extensions to full vertical feature sets.

1. Fork [open-mercato/official-modules](https://github.com/open-mercato/official-modules) and create a branch: `feat/<module-name>`.
2. Follow the [Getting Started](#-getting-started) guide to set up your local environment.
3. Write a spec in `.ai/specs/`, scaffold the package, implement the spec — see [AGENTS.md](AGENTS.md) for the full agentic workflow.
4. Open a PR against `develop` with a description of what the module does, screenshots or a short demo, and the testing you performed.

The core team reviews all submissions. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full branching conventions and PR checklist.
Open Mercato is proudly supported by [Catch The Tornado](https://catchthetornado.com/).

<div align="center">
  <a href="https://catchthetornado.com/">
    <img src="https://raw.githubusercontent.com/open-mercato/open-mercato/main/apps/mercato/public/catch-the-tornado-logo.png" alt="Catch The Tornado logo" width="96" />
  </a>
</div>

## License

MIT — see `LICENSE` for details.
