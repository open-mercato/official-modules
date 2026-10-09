> **Archived (October 2026).** Official modules now live in the [open-mercato](https://github.com/open-mercato/open-mercato). A CLI for publishing your own modules to npm or GitHub is coming.

<p align="center">
  <img src="https://raw.githubusercontent.com/open-mercato/open-mercato/main/apps/mercato/public/open-mercato.svg" alt="Open Mercato logo" width="120" />
</p>

# Open Mercato Official Modules

[![Status: deprecated](https://img.shields.io/badge/status-deprecated-red.svg)](#deprecated)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-openmercato.com-1F7AE0.svg)](https://docs.openmercato.com/)
[![Core Repo](https://img.shields.io/badge/core-open--mercato-24292F.svg)](https://github.com/open-mercato/open-mercato)
[![Docs](https://img.shields.io/badge/docs-modules.openmercato.com-1F7AE0.svg)](https://modules.openmercato.com/)

<a id="deprecated"></a>

## ⚠️ Deprecated / Archived

> **This repository is deprecated and no longer actively maintained.**
>
> We are migrating every module that lives here into
> [Open Mercato Core](https://github.com/open-mercato/open-mercato), one by one.
> Once a module has moved, its code is removed from this repo and Core becomes
> the only place it is developed, released, and supported.
>
> **What this means for you:**
>
> - 🚫 **No new modules are accepted here.** Contribute to
>   [open-mercato/open-mercato](https://github.com/open-mercato/open-mercato) instead.
> - 🧊 **No new features, and no support, for what is still here.** The remaining
>   packages are frozen until they are migrated; expect only migration commits.
> - 📦 **Already-published npm packages keep working**, but they will not be
>   updated past the platform line they currently pin. Move to the Core
>   equivalent when your module's migration lands.
> - 🗂️ **This repo will be archived** once the last module has moved.
>
> See [Migration status](#migration-status) for what has already moved and where
> it went.

<a id="migration-status"></a>

## 🚚 Migration status

Modules are migrated into Open Mercato Core one at a time. When a migration PR
merges, the module's package is deleted from this repo and the row below is the
pointer to its new home.

### Already migrated

| Module | Migrated into | Migration PR |
|--------|---------------|--------------|
| `forms` | [Open Mercato Core](https://github.com/open-mercato/open-mercato) | [open-mercato#6770](https://github.com/open-mercato/open-mercato/pull/6770) |

### Still awaiting migration

The packages remaining under `packages/` (see [Module List](#-module-list)) have
not moved yet. They are maintenance-only: no new features, bug fixes only where
a release is already in flight.

## What this was

Open Mercato ships with a module system that lets you add features to your app without forking or modifying the platform. **This repo used to be where those features were published separately from the platform.**

That split is being undone: the modules are moving into the
[Open Mercato core repository](https://github.com/open-mercato/open-mercato),
which is also where the main application and the framework code live. The module
system itself is unchanged — modules still install in one command, stay isolated
behind declared extension points, and remain ejectable. Only their home repo
changes.

If you want to build a module today, build it in
[open-mercato/open-mercato](https://github.com/open-mercato/open-mercato).

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

> ⚠️ **Deprecated.** This setup is kept only so the not-yet-migrated packages can
> still be built and released. Do not start a new module here — see
> [Deprecated / Archived](#deprecated).

Clone the repo and spin up the sandbox environment:

```bash
git clone https://github.com/open-mercato/official-modules.git
cd official-modules

cp apps/sandbox/.env.example apps/sandbox/.env

docker compose up --build -d

yarn install

yarn install-skills

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

Modules still hosted here, pending migration into Open Mercato Core. For modules
that have already moved, see [Migration status](#migration-status).

| Package | Description | Author | Status |
|---------|-------------|--------|--------|
| [`@open-mercato/carrier-inpost`](packages/carrier-inpost) | InPost shipping carrier — rate calculation, shipment creation, cancellation, and webhook tracking for InPost locker and courier services (Poland) | Open Mercato | Awaiting migration |

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

> ⚠️ **Do not start a new module in this repo.** It is deprecated and will be
> archived. New modules belong in
> [open-mercato/open-mercato](https://github.com/open-mercato/open-mercato); the
> workflow below is retained as reference, and because it still applies to the
> packages waiting to be migrated.

Community modules live in `packages/<module-name>/` and are published under the `@open-mercato/` scope. Before starting module work, first complete the [Getting Started](#-getting-started) setup above. Once your local environment is ready, the recommended workflow is:

```
spec-writing  →  scaffold-module  →  implement-spec
```

### Step 1 — Write a spec

Before writing code, document your module in `.ai/specs/SPEC-YYYY-MM-DD-<title>.md`. This is the design document that `implement-spec` reads to know what to build. You might (and probably shall) use the `spec-writing` skill - available in any of the LLM coding envs. you're using after running the `yarn install-skills`

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

For a new module, open the PR against
[open-mercato/open-mercato](https://github.com/open-mercato/open-mercato) — this
repo no longer accepts them. For migration or release-critical work on a package
still hosted here, open a PR against `develop`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full checklist.

**Note**: The `app/sandbox` changes should be limited to enabling your module, and potentially nothing more - as the users will be using your module without this app (with their own, created with the `create-mercato-app` command). 

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

**This repo is closed to new modules.** We still welcome modules of all sizes —
from thin UI extensions to full vertical feature sets — but they now go to
[open-mercato/open-mercato](https://github.com/open-mercato/open-mercato). Open
your PR there and follow that repo's contributing guide.

The only changes still accepted here are migration commits moving a package to
Core, and release-critical fixes for a package that has not migrated yet. If you
are doing one of those, read [CONTRIBUTING.md](CONTRIBUTING.md) for the branching
conventions and PR checklist.

Open Mercato is proudly supported by [Catch The Tornado](https://catchthetornado.com/).

<div align="center">
  <a href="https://catchthetornado.com/">
    <img src="https://raw.githubusercontent.com/open-mercato/open-mercato/main/apps/mercato/public/catch-the-tornado-logo.png" alt="Catch The Tornado logo" width="96" />
  </a>
</div>

## License

MIT — see `LICENSE` for details.
