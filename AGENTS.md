# Agents Guidelines — Official Modules

This repo is the community module registry for [Open Mercato](https://github.com/open-mercato/open-mercato). Each package under `packages/` is a publishable `@open-mercato/*` npm workspace. Every module is an **external extension** — it uses UMES extension points and MUST NOT modify core packages.

## Before Writing Code

1. Check the Task Router below and read **all** matching guides.
2. Check `.ai/specs/` for an existing spec before starting.
3. Enter plan mode for non-trivial tasks (3+ steps or architectural decisions).
4. If no scaffold exists yet, run the `scaffold-module` skill before `om-auto-implement-spec`.

## Task Router

| Task | Guide |
|------|-------|
| Scaffold a new module package from scratch | `.ai/skills/scaffold-module/SKILL.md` |
| Write or review a spec for a new module | Installed `om-spec-writing` skill |
| Implement a spec into a scaffolded package | Installed `om-auto-implement-spec` skill |
| Test a module in the sandbox | `apps/sandbox` — use `yarn *` commands from root |
| Publish a preview build to local Verdaccio | `yarn registry:up && yarn publish:preview` |

## Typical Agentic Workflow

```
om-spec-writing  →  scaffold-module  →  om-auto-implement-spec
```

1. **`om-spec-writing`** — design the module in `.ai/specs/`; commit to module name, feature set, and API surface before writing code.
2. **`scaffold-module`** — create the buildable package skeleton under `packages/<name>/`.
3. **`om-auto-implement-spec`** — fill in entities, API routes, UI pages, events, and tests on top of the skeleton.

---

## Framework Reference

Community modules are built on top of the Open Mercato framework. This section tells the agent **what to write** when implementing a module.

### Package Layout

```
packages/<package-name>/
├── package.json              # @open-mercato/<package-name>, publishable
├── tsconfig.json             # extends ../../tsconfig.base.json
├── build.mjs                 # esbuild build script (copy from test-package)
├── watch.mjs                 # watch mode wrapper
├── jest.config.cjs           # jest + ts-jest config
└── src/
    ├── index.ts              # barrel: export { metadata } from './modules/<moduleId>/index'
    └── modules/
        └── <moduleId>/       # snake_case — this is the module ID
            ├── index.ts      # ModuleInfo metadata + re-exports
            ├── acl.ts        # Feature definitions
            ├── setup.ts      # Tenant initialization
            ├── di.ts         # DI registrar (optional)
            ├── events.ts     # Typed event declarations (optional)
            ├── notifications.ts          # Notification types (optional)
            ├── notifications.client.ts   # Client notification renderers (optional)
            ├── translations.ts           # Translatable field declarations (optional)
            ├── search.ts                 # Search indexing config (optional)
            ├── ai-tools.ts               # MCP AI tool definitions (optional)
            ├── data/
            │   ├── entities.ts           # MikroORM entities
            │   ├── validators.ts         # Zod validation schemas
            │   ├── extensions.ts         # Entity extensions / cross-module links
            │   └── enrichers.ts          # Response enrichers
            ├── api/
            │   ├── interceptors.ts       # API route interception hooks
            │   └── <method>/
            │       └── <path>.ts         # API route handler
            ├── backend/
            │   └── <path>/
            │       ├── page.tsx          # React page component ('use client')
            │       └── page.meta.ts      # Page metadata (auth, features, title)
            ├── subscribers/
            │   └── <name>.ts             # Event subscriber
            ├── workers/
            │   └── <name>.ts             # Background worker
            └── widgets/
                ├── injection/
                │   └── <widget-name>/
                │       └── widget.ts     # Injection widget definition
                ├── injection-table.ts    # Widget-to-slot mappings
                └── components.ts         # Component replacement definitions
```

### Auto-Discovery Paths

The framework auto-discovers files by path convention — no manual registration needed:

| Path | Discovered as | URL |
|------|--------------|-----|
| `backend/<path>.tsx` | Backend admin page | `/backend/<path>` |
| `backend/page.tsx` | Module index page | `/backend/<moduleId>` |
| `api/<METHOD>/<path>.ts` | API route | `/api/<path>` (matched by HTTP method) |
| `subscribers/*.ts` | Event subscriber | Auto-wired on module load |
| `workers/*.ts` | Background worker | Auto-wired on module load |

### Module Convention Files

#### `src/modules/<moduleId>/index.ts`
```ts
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: '<moduleId>',
  title: '<Human Title>',
  description: '<One sentence>',
  ejectable: true,   // optional — allows consumers to eject source
}

export { features } from './acl'
export default metadata
```

#### `src/modules/<moduleId>/acl.ts`
```ts
export const features = [
  { id: '<moduleId>.view',   title: 'View ...',   module: '<moduleId>' },
  { id: '<moduleId>.create', title: 'Create ...', module: '<moduleId>' },
  { id: '<moduleId>.edit',   title: 'Edit ...',   module: '<moduleId>' },
  { id: '<moduleId>.delete', title: 'Delete ...', module: '<moduleId>' },
]
export default features
```

Feature naming: `<moduleId>.<action>` — singular, lowercase.

#### `src/modules/<moduleId>/setup.ts`
```ts
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['<moduleId>.view', '<moduleId>.create', '<moduleId>.edit', '<moduleId>.delete'],
    admin:      ['<moduleId>.view', '<moduleId>.create', '<moduleId>.edit'],
  },
}
export default setup
```

MUST declare `defaultRoleFeatures` for every feature in `acl.ts`.

### MikroORM Entities

```ts
// src/modules/<moduleId>/data/entities.ts
import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: '<module_id>_<entities>' })  // plural snake_case table name
@Index({ properties: ['organization_id'] })
export class MyEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ type: 'string' })
  organization_id!: string

  @Property({ type: 'string' })
  tenant_id!: string

  @Property()
  created_at: Date = new Date()

  @Property({ onUpdate: () => new Date() })
  updated_at: Date = new Date()

  @Property({ nullable: true })
  deleted_at?: Date

  @Property({ default: true })
  is_active: boolean = true

  // FK to another module — IDs only, NO @ManyToOne across modules
  @Property({ type: 'string', nullable: true })
  customer_id?: string
}
```

**Rules:**
- Table names: plural snake_case (`loyalty_cards`, `loyalty_card_transactions`)
- Standard columns: `id` (UUID PK), `organization_id`, `tenant_id`, `created_at`, `updated_at`
- Optional standard columns: `deleted_at`, `is_active`
- Cross-module links: FK string ID only — NEVER `@ManyToOne` to an entity from another module
- NEVER hand-write migrations. For a **package** module, `yarn mercato db:generate` is skipped in this standalone repo (it only targets `@app` modules) — instead run the repo generator from the root: `yarn module:db:generate <module-name>` (e.g. `pdf-generators`; wired to `scripts/generate-module-migration.ts`). It writes `Migration<ts>_<module_id>.ts` + `.snapshot-open-mercato.json` into `src/modules/<module_id>/migrations/` (commit both). Requires Node 24 + a running Postgres (`DATABASE_URL` from `apps/sandbox/.env`). It's a root-level dev tool — do NOT add a `db:generate` script to the module's `package.json`. See README "Step 3b — Generate entity migrations".

### Zod Validators

```ts
// src/modules/<moduleId>/data/validators.ts
import { z } from 'zod'

export const createMyEntitySchema = z.object({
  name: z.string().min(1).max(255),
  customerId: z.string().uuid().optional(),
})

export const updateMyEntitySchema = createMyEntitySchema.partial()

// Derive TS types from zod — NEVER write separate interfaces
export type CreateMyEntityInput = z.infer<typeof createMyEntitySchema>
export type UpdateMyEntityInput = z.infer<typeof updateMyEntitySchema>
```

### API Routes

```ts
// src/modules/<moduleId>/api/GET/my-entities.ts
import { makeCrudRoute } from '@open-mercato/core/lib/crud/makeCrudRoute'

export const metadata = {
  method: 'GET' as const,
  path: '/api/my-entities',
  requireAuth: true,
  requireFeatures: ['<moduleId>.view'],
}

export const openApi = {
  summary: 'List my entities',
  tags: ['<moduleId>'],
}

export default makeCrudRoute({ ... })
```

**Rules:**
- MUST export `openApi` (required for documentation generation)
- MUST export `metadata` with `requireAuth` and `requireFeatures`
- MUST use `makeCrudRoute` with `indexer: { entityType }` for query-indexed CRUD
- Write operations MUST use the Command pattern
- Never expose cross-tenant data — always filter by `organization_id`

### Backend Pages

```tsx
// src/modules/<moduleId>/backend/<path>/page.tsx
'use client'

import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export default function MyPage() {
  const t = useT()
  return (
    <Page>
      <PageHeader title={t('<moduleId>.page.title', 'My Module')} />
      <PageBody>
        {/* content */}
      </PageBody>
    </Page>
  )
}
```

```ts
// src/modules/<moduleId>/backend/<path>/page.meta.ts
export const metadata = {
  requireAuth: true,
  requireFeatures: ['<moduleId>.view'],
  pageTitle: 'My Module',
  pageTitleKey: '<moduleId>.page.title',
  pageGroup: 'My Module',
  pageGroupKey: '<moduleId>.page.group',
  pageOrder: 900,
  breadcrumb: [{ label: 'My Module', labelKey: '<moduleId>.page.title' }],
} as const
export default metadata
```

**UI rules:**
- Always `'use client'` at top of page components
- Use `CrudForm` for forms, `DataTable` for tables
- Use `LoadingMessage` / `ErrorMessage` from `@open-mercato/ui/backend/detail`
- Use `apiCall` / `apiCallOrThrow` — never raw `fetch`
- Use `flash()` for feedback — never `alert()`
- Every dialog: `Cmd/Ctrl+Enter` submit, `Escape` cancel
- `pageSize` ≤ 100

### Events

```ts
// src/modules/<moduleId>/events.ts
import { createModuleEvents } from '@open-mercato/shared/modules/events'

export const eventsConfig = createModuleEvents('<moduleId>', {
  '<moduleId>.<entity>.<past_tense>': {
    schema: z.object({ id: z.string().uuid(), organizationId: z.string() }),
    clientBroadcast: false,  // true to push to browser via SSE
  },
} as const)
```

Event ID format: `<moduleId>.<entity>.<past_tense>` — all singular, dot-separated.

### Event Subscribers

```ts
// src/modules/<moduleId>/subscribers/on-customer-created.ts
import type { EventSubscriberMetadata } from '@open-mercato/shared/modules/events'

export const metadata: EventSubscriberMetadata = {
  event: 'customers.customer.created',
  id: '<moduleId>.on-customer-created',
  persistent: true,
}

export default async function handler(event: unknown) {
  // react to core events here
}
```

### Widget Injection

Inject UI into existing pages without modifying them:

```ts
// src/modules/<moduleId>/widgets/injection/<widget-name>/widget.ts
import type { InjectionDataTableWidget } from '@open-mercato/shared/modules/widgets/injection'

export default {
  metadata: { id: '<moduleId>.injection.<widget-name>', features: ['<moduleId>.view'] },
  columns: [/* DataTable column definitions */],
} satisfies InjectionDataTableWidget
```

```ts
// src/modules/<moduleId>/widgets/injection-table.ts
export const injectionTable = {
  'data-table:customers.people': { widgetId: '<moduleId>.injection.<widget-name>', priority: 50 },
}
```

Available injection slot types: `InjectionDataTableWidget`, `InjectionMenuItemWidget`, `InjectionCrudFormWidget`, `InjectionRowActionWidget`, `InjectionBulkActionWidget`.

Available menu slots: `menu:sidebar:main`, `menu:sidebar:settings`, `menu:topbar:actions`, `menu:topbar:profile-dropdown`.

### Response Enrichers

Attach extra data to another module's API response:

```ts
// src/modules/<moduleId>/data/enrichers.ts
import type { ResponseEnricher } from '@open-mercato/shared/lib/crud/response-enricher'

export const enrichers: ResponseEnricher[] = [
  {
    entityType: 'customers.person',
    async enrich(records, { em, organizationId }) {
      // attach module data to customer records
    },
  },
]
```

### API Interceptors

Modify existing API routes before/after handler execution:

```ts
// src/modules/<moduleId>/api/interceptors.ts
import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'

export const interceptors: ApiInterceptor[] = [
  {
    route: '/api/customers/people',
    method: 'GET',
    async before({ query }) {
      // Narrow results by rewriting query.ids
    },
  },
]
```

### Key Imports

| Need | Import |
|------|--------|
| Module metadata type | `import type { ModuleInfo } from '@open-mercato/shared/modules/registry'` |
| Module setup type | `import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'` |
| Client i18n | `import { useT } from '@open-mercato/shared/lib/i18n/context'` |
| Server i18n | `import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'` |
| API call (UI) | `import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'` |
| CRUD form | `import { CrudForm } from '@open-mercato/ui/backend/crud'` |
| Page primitives | `import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'` |
| DataTable | `import { DataTable } from '@open-mercato/ui/backend/DataTable'` |
| Loading/Error | `import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'` |
| Injection position | `import { InjectionPosition } from '@open-mercato/shared/modules/widgets/injection-position'` |
| Event declarations | `import { createModuleEvents } from '@open-mercato/shared/modules/events'` |
| API interceptor type | `import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'` |
| Response enricher type | `import type { ResponseEnricher } from '@open-mercato/shared/lib/crud/response-enricher'` |
| Boolean parsing | `import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'` |

---

## Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Package name (npm) | kebab-case | `loyalty-cards` |
| Module ID (folder) | snake_case | `loyalty_cards` |
| Entity class | PascalCase singular | `LoyaltyCard` |
| DB table | snake_case plural | `loyalty_cards` |
| DB column | snake_case | `customer_id` |
| Feature ID | `<moduleId>.<action>` | `loyalty_cards.view` |
| Event ID | `<moduleId>.<entity>.<past_tense>` | `loyalty_cards.card.redeemed` |
| API route | `/api/<module>/<resource>` | `/api/loyalty-cards/cards` |
| i18n key | `<moduleId>.<context>.<key>` | `loyalty_cards.page.title` |
| JS/TS fields | camelCase | `customerId`, `createdAt` |

## Security Rules

- MUST validate all inputs with zod; place schemas in `data/validators.ts`
- MUST filter every query by `organization_id` — no exceptions
- MUST NOT expose data from other tenants
- MUST use `findWithDecryption` / `findOneWithDecryption` if any PII fields exist
- MUST use declarative guards: `requireAuth`, `requireFeatures` in page/route metadata
- MUST hash passwords with bcryptjs (cost ≥ 10); never log credentials
- MUST NOT return sensitive data in error messages

## Code Quality Rules

- No `any` types — use zod schemas with `z.infer`
- No hardcoded user-facing strings — use `useT()` / locale files
- No raw `fetch` — use `apiCall`/`apiCallOrThrow`
- No hand-written migrations — update entities, run `yarn mercato db:generate`
- No `em.find` / `em.findOne` without decryption on encrypted tables
- No `alert()` — use `flash()`
- No cross-module `@ManyToOne` ORM relationships
- Import `@open-mercato/<pkg>/...` paths for cross-package imports

## Key Commands

```bash
yarn build:packages                                  # Build all packages
yarn workspace @open-mercato/<name> build            # Build one package
yarn workspace @open-mercato/<name> typecheck        # Type-check one package
yarn workspace @open-mercato/<name> test             # Test one package
yarn registry:up                                     # Start Verdaccio on :4873
yarn publish:preview                                 # Publish preview builds
yarn dev                                     # Start sandbox app
yarn mercato module add @open-mercato/<name>@preview  # Install in sandbox
yarn mercato db:migrate                      # Apply migrations in sandbox
yarn generate                                # Re-run generators in sandbox
yarn typecheck                                       # Type-check all packages
yarn test                                            # Test all packages
```
