# Official Modules

Phase-one scaffold for the Open Mercato official modules monorepo.

## Structure

- `apps/sandbox` contains the standalone sandbox app used to validate published-style module consumption.
- `packages/test-package` is the current publishable reference module package.
- `scripts/` contains the registry, build, pack, and publish entrypoints used locally and later in CI.
- `docker-compose.yml` now includes both sandbox infrastructure services and a local Verdaccio registry.

## Commands

- `yarn build` builds publishable module packages.
- `yarn build:packages` runs the repo-owned package build wrapper used by publish flows.
- `yarn pack:packages` emits publishable tarballs into `.artifacts/packages/`.
- `yarn registry:up` starts the local Verdaccio registry on `http://localhost:4873`.
- `yarn registry:setup-user` creates or reuses a local Verdaccio login for preview publishing.
- `yarn publish:preview` builds, packs, rewrites preview versions, and publishes tarballs to Verdaccio.
- `DRY_RUN=true yarn publish:stable` exercises the stable publish path against packed artifacts without publishing.
- `yarn typecheck` type-checks publishable module packages.
- `yarn test` runs placeholder package-level test targets.
- `yarn sandbox:generate` runs `mercato generate all` in the sandbox app.
- `yarn sandbox:dev` starts the sandbox app.
- `yarn sandbox:build` builds the sandbox app.
