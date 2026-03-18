---
name: scaffold-module
description: Scaffold a new community module package in the official-modules monorepo. Use when creating a new @open-mercato/* npm package from scratch, starting a new module, or when implement-spec needs a package skeleton before filling in business logic. Triggers on "scaffold module", "create module", "new module package", "new package", "add community module".
---

# scaffold-module

Scaffolds a complete, buildable `@open-mercato/<name>` package under `packages/<name>/` in this repo. The output matches the `test-package` reference exactly and is immediately ready for `yarn build`, sandbox testing, and `implement-spec` to fill in.

## Integration with Other Skills

- **After `spec-writing`**: extract `PACKAGE_NAME`, `MODULE_ID`, `MODULE_TITLE`, and `DESCRIPTION` from the spec TLDR and Problem sections, then run this skill.
- **Before `implement-spec`**: scaffold first. `implement-spec` adds entities, API routes, events, and UI pages on top of the skeleton this skill creates.
- **Typical flow**: `spec-writing` → `scaffold-module` → `implement-spec`

## Inputs

Before generating files, resolve these four values:

| Variable | Format | Example | Source |
|----------|--------|---------|--------|
| `PACKAGE_NAME` | kebab-case | `loyalty-cards` | spec title, user input |
| `MODULE_ID` | snake_case | `loyalty_cards` | PACKAGE_NAME with `-` → `_` |
| `MODULE_TITLE` | Title Case | `Loyalty Cards` | spec title or user input |
| `DESCRIPTION` | one sentence | `Manage customer loyalty programs.` | spec TLDR or user input |
| `OM_VERSION` | semver | `0.4.7` | read from `node_modules/@open-mercato/shared/package.json` → `version` at repo root |

**Derivation rules:**
- `MODULE_ID` = `PACKAGE_NAME.replace(/-/g, '_')`
- `OM_VERSION`: read `node_modules/@open-mercato/shared/package.json` at repo root and take the `version` field. Fall back to the version used in `packages/test-package/package.json` if node_modules is absent.

## Step 1 — Confirm Before Writing

State the resolved values to the user:

```
Package  : @open-mercato/PACKAGE_NAME
Module ID: MODULE_ID
Title    : MODULE_TITLE
OM ver   : OM_VERSION
```

If any value is ambiguous, ask before proceeding.

## Step 2 — Create File Tree

Create all files below. Replace every `{{placeholder}}` with the resolved value.

### `packages/{{PACKAGE_NAME}}/package.json`

```json
{
  "name": "@open-mercato/{{PACKAGE_NAME}}",
  "version": "0.1.0",
  "type": "module",
  "description": "{{DESCRIPTION}}",
  "main": "./dist/index.js",
  "scripts": {
    "build": "node build.mjs",
    "watch": "node watch.mjs",
    "test": "jest --config jest.config.cjs",
    "typecheck": "tsc --noEmit"
  },
  "exports": {
    ".": "./dist/index.js",
    "./*.ts": {
      "types": "./src/*.ts",
      "default": "./dist/*.js"
    },
    "./*.tsx": {
      "types": "./src/*.tsx",
      "default": "./dist/*.js"
    },
    "./*.json": "./src/*.json",
    "./*": {
      "types": [
        "./src/*.ts",
        "./src/*.tsx"
      ],
      "default": "./dist/*.js"
    },
    "./*/*.json": "./src/*/*.json",
    "./*/*": {
      "types": [
        "./src/*/*.ts",
        "./src/*/*.tsx"
      ],
      "default": "./dist/*/*.js"
    },
    "./*/*/*.json": "./src/*/*/*.json",
    "./*/*/*": {
      "types": [
        "./src/*/*/*.ts",
        "./src/*/*/*.tsx"
      ],
      "default": "./dist/*/*/**.js"
    },
    "./*/*/*/*.json": "./src/*/*/*/*.json",
    "./*/*/*/*": {
      "types": [
        "./src/*/*/*/*.ts",
        "./src/*/*/*/*.tsx"
      ],
      "default": "./dist/*/*/*/**.js"
    }
  },
  "dependencies": {
    "@open-mercato/ui": "{{OM_VERSION}}"
  },
  "peerDependencies": {
    "@open-mercato/shared": "{{OM_VERSION}}",
    "@open-mercato/ui": "{{OM_VERSION}}",
    "react": "^19.0.0"
  },
  "devDependencies": {
    "@open-mercato/shared": "{{OM_VERSION}}",
    "@open-mercato/ui": "{{OM_VERSION}}",
    "@types/jest": "^30.0.0",
    "esbuild": "^0.25.0",
    "glob": "^13.0.6",
    "jest": "^30.2.0",
    "ts-jest": "^29.4.6"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

### `packages/{{PACKAGE_NAME}}/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/__tests__/**"]
}
```

### `packages/{{PACKAGE_NAME}}/build.mjs`

Copy verbatim from `packages/test-package/build.mjs`, then change the final log line:

```js
console.log('{{PACKAGE_NAME}} built successfully')
```

### `packages/{{PACKAGE_NAME}}/watch.mjs`

```js
import { watch } from '../../scripts/watch.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
watch(__dirname)
```

### `packages/{{PACKAGE_NAME}}/jest.config.cjs`

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  watchman: false,
  rootDir: '.',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.(ts|tsx)'],
  passWithNoTests: true,
}
```

### `packages/{{PACKAGE_NAME}}/src/index.ts`

```ts
export { metadata } from './modules/{{MODULE_ID}}/index'
```

### `packages/{{PACKAGE_NAME}}/src/modules/{{MODULE_ID}}/index.ts`

```ts
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: '{{MODULE_ID}}',
  title: '{{MODULE_TITLE}}',
  description: '{{DESCRIPTION}}',
}

export { features } from './acl'
export default metadata
```

### `packages/{{PACKAGE_NAME}}/src/modules/{{MODULE_ID}}/acl.ts`

```ts
export const features = [
  {
    id: '{{MODULE_ID}}.view',
    title: 'View {{MODULE_TITLE}}',
    module: '{{MODULE_ID}}',
  },
]
export default features
```

### `packages/{{PACKAGE_NAME}}/src/modules/{{MODULE_ID}}/setup.ts`

```ts
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['{{MODULE_ID}}.view'],
    admin: ['{{MODULE_ID}}.view'],
  },
}

export default setup
```

### `packages/{{PACKAGE_NAME}}/src/modules/{{MODULE_ID}}/backend/{{PACKAGE_NAME}}/page.meta.ts`

```ts
export const metadata = {
  requireAuth: true,
  requireFeatures: ['{{MODULE_ID}}.view'],
  pageTitle: '{{MODULE_TITLE}}',
  pageTitleKey: '{{MODULE_ID}}.page.title',
  pageGroup: '{{MODULE_TITLE}}',
  pageGroupKey: '{{MODULE_ID}}.page.group',
  pageOrder: 900,
  breadcrumb: [
    { label: '{{MODULE_TITLE}}', labelKey: '{{MODULE_ID}}.page.title' },
  ],
} as const
export default metadata
```

### `packages/{{PACKAGE_NAME}}/src/modules/{{MODULE_ID}}/backend/{{PACKAGE_NAME}}/page.tsx`

```tsx
'use client'

import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export default function {{PascalModuleTitle}}Page() {
  const t = useT()

  return (
    <Page>
      <PageHeader
        title={t('{{MODULE_ID}}.page.title', '{{MODULE_TITLE}}')}
        description={t('{{MODULE_ID}}.page.description', '{{DESCRIPTION}}')}
      />
      <PageBody>
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-base font-semibold">
            {t('{{MODULE_ID}}.page.cardTitle', 'Module is wired correctly')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t(
              '{{MODULE_ID}}.page.cardDescription',
              'If this page renders, the package build, module discovery, and backend routing are working.',
            )}
          </p>
        </div>
      </PageBody>
    </Page>
  )
}
```

`{{PascalModuleTitle}}` = `MODULE_TITLE` with spaces removed and each word capitalized, e.g. `LoyaltyCards`.

## Step 3 — Post-Scaffold

Run in order:

```bash
# 1. Install workspace dependencies
yarn install

# 2. Build the new package to confirm it compiles
yarn workspace @open-mercato/{{PACKAGE_NAME}} build

# 3. Type-check
yarn workspace @open-mercato/{{PACKAGE_NAME}} typecheck
```

If any command fails, diagnose and fix before proceeding. Do not silently skip errors.

## Step 4 — Sandbox Smoke Test (optional but recommended)

The sandbox is a workspace sibling — no npm install or registry publish needed. Register the module directly in `apps/sandbox/src/modules.ts`:

```ts
// apps/sandbox/src/modules.ts
{ id: '{{MODULE_ID}}', from: '@open-mercato/{{PACKAGE_NAME}}' },
```

Then build and start:

```bash
yarn workspace @open-mercato/{{PACKAGE_NAME}} build   # build the package first
yarn generate                                  # regenerate sandbox registry
yarn mercato db:migrate                        # apply any new migrations
yarn dev                                       # start sandbox app
```

Navigate to `/backend/{{PACKAGE_NAME}}` and confirm the page renders.

When done testing, remove the entry from `apps/sandbox/src/modules.ts` before opening a PR.

## Step 5 — Update Module List in README

Add a row to the module table in `README.md`:

```md
| `@open-mercato/{{PACKAGE_NAME}}` | {{DESCRIPTION}} | [your-github](https://github.com/your-github) |
```

## Critical Rules

- MUST use snake_case for `MODULE_ID` (module folder name and feature IDs)
- MUST use kebab-case for `PACKAGE_NAME` (npm package name, backend page folder)
- MUST declare `defaultRoleFeatures` in `setup.ts` for every feature in `acl.ts`
- MUST NOT add `"private": true` to the package — it must be publishable
- MUST copy `build.mjs` exactly from `test-package`; only change the final log line
- MUST pin `@open-mercato/*` peer deps to the same version across all fields
- MUST keep `passWithNoTests: true` in jest.config.cjs so CI passes on an empty package
- Do NOT add MikroORM entities, API routes, or business logic here — that is `implement-spec`'s job
- Do NOT hardcode user-facing strings — all text in `page.tsx` must go through `useT()`
