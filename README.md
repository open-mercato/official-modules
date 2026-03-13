# Official Modules

Phase-one scaffold for the Open Mercato official modules monorepo.

## Structure

- `apps/sandbox` contains the standalone sandbox app used to validate published-style module consumption.
- `packages/_template` defines the package contract for new official modules.
- `packages/n8n-integration` is the first reference package following that contract.

## Commands

- `yarn build` builds publishable module packages.
- `yarn typecheck` type-checks publishable module packages.
- `yarn test` runs placeholder package-level test targets.
- `yarn sandbox:generate` runs `mercato generate all` in the sandbox app.
- `yarn sandbox:dev` starts the sandbox app.
- `yarn sandbox:build` builds the sandbox app.

