# SPEC-004: PDF Generators

## TLDR
**Key Points:**
- The `@open-mercato/pdf-generators` module is a **universal PDF generation engine** — any module in OpenMercato can inject a widget that generates PDFs from its own data.
- A user opens a PDF tab in any supported detail view, picks a template from a list, previews the PDF live, then downloads the final file.
- Quote/Sales and Orders are the first supported modules; any other entity can be added independently.

**Scope:**
- Universal template registry — class-based singleton, split into **internal** (built-in) and **external** (injected by other modules via code-gen) registries
- Template metadata hierarchy: `module` (top-level Medusa module, e.g. `'sales'`) → `entity` (e.g. `'quotes'` | `'orders'`) → `documentType` (e.g. `'offer'` | `'invoice'`)
- Widget passes raw `context.record` to the API — optional `fetchData` hook enriches data server-side (e.g. fetches line items via DI container); `toTemplateData` normalizes afterward
- `GET /api/pdf-generators/templates` — lists available templates (internal + external) for client-side consumption
- `POST /api/pdf-generators/generate` — accepts `{ template_id, data }`, runs `fetchData` → `toTemplateData` server-side, renders via `renderToBuffer`, returns PDF blob
- Live PDF preview via `<Preview>` (iframe with blob URL) — no `PDFViewer` client-side rendering
- Widget pattern: tab injection (`quote_pdf_tab`) rather than action button; widget filters by `{ entity: 'quotes' }` — single field, no redundancy
- Template folder convention: `templates/<module>/<entity>/templates/<template-name>/`
- Generator plugin (`generators.ts`) enabling other modules to register external templates via `mercato generate registry`

**Concerns:**
- `@react-pdf/renderer` operates server-side only (`renderToBuffer`) — fonts must be accessible on the server; solved via base64-encoded `*.generated.ts` font files
- Large documents may render slowly on the server — async queue may be needed in a later phase
- `QuotesDocumentService.fetchData` uses raw SQL for quote data (SalesQuote entity is not in DI); customer data is resolved separately via `CustomerEntity`

---

## Overview

The `pdf_generators` module extends OpenMercato with the ability to generate professional, branded PDF documents from any entity in the system. A "Generate PDF" button can be injected into any detail view — it opens a dialog: template selection → live preview → download.

Templates are defined as React components (JSX) inside the package, organized by module and entity: `templates/<module>/<entity>/templates/<template-name>/`. Each template defines its own data shape (`PdfDocumentData` in `types.ts`). Available templates are served via `GET /api/pdf-generators/templates` which reads two globalThis-backed registries: **internal** (registered at module init from `config/registry.ts`) and **external** (registered at bootstrap by code-generated `pdf-generators.generated.ts`). Each widget filters templates by a `TemplateFilter` (`category`, `tags`, `moduleId`) — not by explicit ID list.

The widget passes raw `context.record` directly to `POST /generate`. The server calls `loadTemplate(template_id, record)` which invokes `entry.normalizeRecord(record)` to normalize data before rendering. Each entity's normalizer lives in `templates/<module>/<entity>/data/normalize-record.ts` — co-located with the record types it transforms.

**Market Reference:** Pandadoc, Qwilr, Proposify are the category leaders. Adopted: live preview before generating, client data personalization. Rejected: drag-and-drop editor (excessive complexity for MVP), cloud storage (files returned directly as a stream).

---

## Problem Statement

OpenMercato does not offer native PDF document generation. Teams must manually create documents in external tools (Word, Canva, Pandadoc), which:
- breaks workflow continuity (data transcribed by hand from the system),
- prevents per-tenant branding,
- leaves no in-system record of generated documents,
- requires a separate integration per document type (quotes, orders, invoices, contracts).

---

## Proposed Solution

An external community module (`packages/pdf-generators/`) extending OpenMercato via UMES extension points:

1. **Tab widgets** — injected into any module's detail view via `injection-table.ts`. Each widget renders a `TemplatesList` component with `record` and `filter` props. Widget passes raw `context.record` — no client-side mapping.
2. **Backend page** `/backend/pdf-generators` — template overview.
3. **Three API routes**:
   - `GET /api/pdf-generators/templates` — returns `{ internal: TemplateMeta[], external: TemplateMeta[] }`
   - `POST /api/pdf-generators/preview` — accepts `{ template_id, data }`, renders PDF, returns stream; **zero side effects** — used by `PreviewPanel` iframe
   - `POST /api/pdf-generators/generate` — accepts `{ template_id, data, resource_kind?, resource_id?, resource_label? }`, renders PDF + triggers side effects (logging, events, Phase 5 persistence); used by download button
4. **Live preview** — `PreviewPanel` dialog renders a blob URL from `POST /preview` in a native `<iframe>` (`Preview` component); download button calls `POST /generate` separately — no client-side `PDFViewer`.
5. **Generator plugin** (`generators.ts`) — `pdf-generators.templates` plugin enables other modules to register external templates via `mercato generate registry`.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Templates as code (JSX), not database config | Git-versioned, full typographic control, no visual editor required |
| Data from `context.record`, not a fetch | Widget already receives full record from the framework — only `id` is strictly needed when `fetchData` is defined |
| `fetchData` hook per template (server-side) | Services that need data not available in the widget context (e.g. line items) override `fetchData` to query the DI container before normalization |
| Normalization via `toTemplateData` in `BaseDocumentService` subclass | Each entity's mapping lives in one class — adding a new entity = new service subclass, no changes to existing code |
| `PdfDocumentData` lives in `templates/<module>/<entity>/templates/<name>/types.ts` | Type is a contract between the normalizer and the template component, not a global concern |
| `Record<string, unknown>` in route and components | Route and UI components are template-agnostic; type safety lives at the normalizer→template boundary |
| Template folder convention `templates/<module>/<entity>/templates/<name>/` | Mirrors the domain hierarchy — adding a new module = new top-level folder, no changes elsewhere |
| `BaseDocumentService` base class for all document services | Centralizes `registerTemplate()`, `getEntries()`, and `formatDate()` — subclasses implement only `normalizeRecord()` and identity fields |
| `config/registry.ts` aggregates all internal services in one `registerInternal([...])` call | `registerInternal` replaces the array — multiple calls would clobber each other; all built-in services must be spread into a single call |
| globalThis-based dual registry (internal + external) | Decoupled: internal templates ship with the module; external templates are injected at bootstrap from generated code |
| `GET /api/pdf-generators/templates` endpoint | Client needs the list at runtime to filter and display available templates without bundling the registry |
| `generators.ts` plugin for code-gen | External modules declare templates in `pdf-generators.ts`; `mercato generate registry` produces the bootstrap glue |
| `moduleId` = target module, not source package | A template declares which module's data it consumes (`'quotes'`, `'sales'`) — not which package ships it. Widgets filter by `moduleId` to get only templates compatible with their data shape. |
| `fromRecord` in registry entry calls `toTemplateData` (server-side) | Template owns its normalization logic — widget is fully decoupled from data shape. Adding a new template for `quotes` requires zero changes to the widget. |
| No `enrichRecord` prop in widgets | Widget passes raw `record` only; all enrichment (data fetching + normalization) happens server-side via `fetchData` + `toTemplateData` |
| `filename` method on `BaseDocumentService` | Derives the PDF download filename from normalized data — default is `document.pdf`; services override for document-specific names |
| Tab widget per entity, not action button | PDF is a contextual view of the record, not a one-shot action |
| Preview via iframe + blob URL, not PDFViewer | Server renders the PDF once (`renderToBuffer`), iframe displays the result — no client-side re-render on every change |
| Fonts as base64 `*.generated.ts` per font | Works on the server (no filesystem path issues); tree-shakeable per font |
| `renderToBuffer` on the server | Deterministic output, no dependency on client environment |
| Files not stored in object storage | MVP — PDF returned directly as stream |
| `examples/` folder at package root (outside `src/`) | Working reference implementation for external template authors — not published, not built, imports from `@open-mercato/pdf-generators` via monorepo workspace |

---

## User Stories / Use Cases

- **A salesperson** wants to open a Quote and generate a PDF offer with one click.
- **An operations user** wants to generate a PDF from an Order, Invoice, or any other entity.
- **A user** wants to preview the PDF before downloading to verify the data.
- **A developer** wants to add a new PDF template by writing a React component and one registry entry — no other file changes required.
- **A developer** wants to add PDF generation to any module by creating a widget folder with `toDocumentData()`, `types.ts`, and `templateIds` — fully independent of other widgets.

---

## Architecture

```
<any module>/:id (detail view)
  └── [Widget Injection: <module>_pdf_tab]
        ↓ tab renders
  <ModulePdfTabWidget>
    └── TemplatesList(record, filter)
          ├── GET /api/pdf-generators/templates → TemplateMeta[] (filtered by TemplateFilter)
          ├── TemplatesListView → TemplateListItem (click to select)
          └── PreviewPanel(template, record)
                ├── POST /api/pdf-generators/generate { template_id, record }
                │     ├── loadTemplate(template_id, record)
                │     │     ├── entry.fromRecord(record) → data  [normalization server-side]
                │     │     └── entry.load() → Component
                │     ├── renderToBuffer(<Component data={data} />)
                │     └── returns application/pdf stream
                ├── Preview (iframe with blob URL)
                └── DownloadButton → downloadBlob(blobUrl, filename)
```

### Module Structure

```
packages/pdf-generators/
├── examples/                        # Working reference for external template authors (not built/published)
│   ├── README.md
│   ├── pdf-generators.ts            # Convention file example
│   ├── invoice/
│   │   ├── example-invoice-document-service.ts
│   │   └── templates/example-invoice/
│   │       ├── types.ts
│   │       └── index.tsx
│   └── widgets/
│       ├── injection-table.ts
│       └── injection/order-pdf-tab/
│           ├── widget.ts
│           └── widget.client.tsx
└── src/modules/pdf_generators/
    ├── config/
    │   └── registry.ts              # Single registerInternal([...all services]) call
    ├── lib/
    │   ├── interfaces.ts            # TemplateMeta, TemplateRegistryEntry, PdfTemplateDefinition
    │   ├── types.ts                 # TemplateId (derived from REGISTRY)
    │   └── template-registry.ts    # Class-based registry: registerInternal / registerExternal / getAll
    ├── services/
    │   ├── index.ts                 # Re-exports all services and their types
    │   ├── base-document-service.ts # Abstract base: registerTemplate(), getEntries(), formatDate()
    │   ├── quotes-document-service.ts  # QuotesDocumentService — moduleId: 'quotes'
    │   └── orders-document-service.ts  # OrdersDocumentService — moduleId: 'sales'
    ├── components/
    │   ├── TemplatesList.tsx        # Fetches templates, filters, shows list + opens PreviewPanel
    │   ├── TemplatesListView.tsx    # Grid of TemplateListItem cards
    │   ├── TemplatesListLoader.tsx  # Loading skeleton
    │   ├── TemplateListItem.tsx     # Single template card
    │   ├── PreviewPanel.tsx         # Fullscreen dialog: fetch blob → Preview + download
    │   ├── Preview.tsx              # iframe rendering blob URL
    │   └── Loader.tsx               # Spinner used in PreviewPanel while fetching
    ├── templates/
    │   ├── shared/
    │   │   ├── components/
    │   │   │   └── Logo.tsx         # OpenMercatoLogo — exported publicly for external templates
    │   │   ├── theme.ts             # colors, borders, spacing + Inter font registration (side-effect import)
    │   │   └── fonts/
    │   │       ├── Inter-Regular.ttf
    │   │       ├── Inter-Regular.generated.ts   # base64 data URI (build-generated)
    │   │       └── ...
    │   └── sales/
    │       ├── quotes/templates/sales-offer/
    │       │   ├── types.ts         # PdfDocumentData for sales-offer
    │       │   ├── index.tsx        # SalesOfferDocument
    │       │   ├── CoverPage.tsx
    │       │   └── QuotePage.tsx
    │       └── orders/templates/order-invoice/
    │           ├── types.ts         # OrderInvoiceData
    │           └── index.tsx        # OrderInvoiceDocument
    ├── widgets/
    │   ├── injection-table.ts       # spot → widget mapping (quotes + orders)
    │   └── injection/
    │       ├── quote_pdf_tab/
    │       │   ├── widget.ts        # id: pdf_generators.injection.quote_pdf_tab
    │       │   └── widget.client.tsx# filter: { category: 'quote', moduleId: 'quotes' }
    │       └── order_pdf_tab/
    │           ├── widget.ts        # id: pdf_generators.injection.order_pdf_tab
    │           └── widget.client.tsx# filter: { category: 'invoice', moduleId: 'sales' }
    ├── utils/
    │   ├── downloadBlob.ts
    │   └── formatDate.ts
    ├── generators.ts                # GeneratorPlugin for pdf-generators.templates (code-gen)
    ├── api/
    │   └── pdf-generators/
    │       ├── generate/route.ts    # POST /api/pdf-generators/generate
    │       └── templates/route.ts  # GET /api/pdf-generators/templates
    ├── backend/pdf-generators/
    │   └── page.tsx                 # /backend/pdf-generators
    └── acl.ts
```

---

## Data Contracts

### Template Registry

Two separate registries managed by `TemplateRegistry` class (singleton `templateRegistry`):

```ts
// lib/interfaces.ts — TemplateRegistry interface
interface TemplateRegistry {
  registerInternal(entries: TemplateEntry[]): void   // called ONCE by config/registry.ts — replaces array
  registerExternal(entries: TemplateEntry[]): void   // called by bootstrap (generated code) — replaces array
  listTemplates(): { internal: TemplateMeta[]; external: TemplateMeta[] }
  load({ id, data }, { container }): Promise<LoadedTemplate>  // fetchData → toTemplateData → lazy-load component
}
```

> **Critical**: `registerInternal` replaces the entire internal array. All built-in services must be combined into one call in `config/registry.ts`:
> ```ts
> templateRegistry.registerInternal([
>   ...quotesService.getEntries(),
>   ...ordersService.getEntries(),
> ])
> ```

```ts
// lib/interfaces.ts
interface TemplateMeta {
  id: string
  label: string
  description: string
  module: string       // top-level Medusa module — e.g. 'sales'
  entity: string       // entity within the module — e.g. 'quotes' | 'orders'
  documentType: string // document kind — e.g. 'offer' | 'invoice' | 'contract'
  tags: string[]
}

interface TemplateRegistryEntry {
  fromRecord: (data: unknown) => Record<string, unknown>  // maps enriched server data to the flat shape expected by the template
  filename: (input: { data: Record<string, unknown> }) => string  // derives the PDF filename from normalized data
  load: () => Promise<React.ComponentType<{ data: Record<string, unknown> }>>
  fetchData?: (input: { data: unknown }, ctx: { container: AppContainer }) => Promise<unknown>  // optional; called before normalization to fetch related data
}

// TemplateEntry = TemplateMeta & TemplateRegistryEntry (full descriptor used in the registry)
type TemplateEntry = TemplateMeta & TemplateRegistryEntry

interface LoadedTemplate {
  component: React.ComponentType<{ data: Record<string, unknown> }>
  data: Record<string, unknown>
  filename: string
}

interface TemplateFilter {
  module?: string
  entity?: string
  documentType?: string
  tags?: string[]       // OR logic — matches if template has ANY of the given tags
}
```

Adding a built-in template = one object in `config/registry.ts`. Adding an external template (from another module) = define a `pdf-generators.ts` convention file and run `mercato generate registry`.

### Template-specific Data Shape

Each template defines its own `PdfDocumentData` in `templates/<name>/types.ts`. Example for `sales-offer`:

```ts
// templates/sales-offer/types.ts
interface PdfDocumentData {
  document: { number: string; date: string; validUntil?: string }
  client: { name: string; email?: string; company?: string; address?: string }
  seller: { name: string; company: string; email: string; phone?: string }
  lines: Array<{ title: string; description?: string; quantity: number; unitPrice: number; total: number; currency: string }>
  totals: { subtotal: number; tax: number; total: number; currency: string }
  notes?: string
}
```

### Document Services

Each entity has a `DocumentService` class extending `BaseDocumentService`. The service owns template registration, optional server-side data fetching, and normalization for that entity:

```ts
// services/quotes-document-service.ts
export class QuotesDocumentService extends BaseDocumentService {
  readonly id = 'quotes'          // globally unique service ID
  readonly label = 'Quotes'
  readonly moduleId = 'quotes'    // used by TemplatesList filter

  constructor() {
    super()
    this.registerTemplate({ id: 'sales-offer', category: 'quote', load: () => import('...'), ... })
  }

  // Override to fetch full quote (with line items) from DB via DI container
  override async fetchData({ data }: { data: unknown }, { container }: { container: AppContainer }): Promise<unknown> {
    // uses raw SQL — SalesQuote is not in DI; customer resolved via CustomerEntity
    ...
  }

  toTemplateData({ data }: { data: unknown }): Record<string, unknown> { ... }
}
```

`BaseDocumentService` provides:
- `registerTemplate(entry)` — registers a lazy-loaded template
- `getEntries()` — returns `TemplateEntry[]` with `moduleId`, `fromRecord`, `filename`, and `fetchData` bound to this service
- `fetchData({ data }, { container })` — default no-op; override to enrich data before normalization
- `toTemplateData({ data })` — **abstract**; override to map enriched data to the flat shape expected by templates
- `filename({ data })` — returns `'document.pdf'` by default; override for document-specific names

`QuoteRecord` and `QuoteLineItem` are the typed shapes returned by `QuotesDocumentService.fetchData`. `OrderWidgetRecord` and `QuoteWidgetRecord` are exported publicly from `@open-mercato/pdf-generators` for use by external template authors.

---

## API Contracts

### GET /api/pdf-generators/templates

Returns all available templates split by source.

**Response:**
```json
{
  "internal": [{ "id": "sales-offer", "label": "Sales Offer", "description": "..." }],
  "external": [{ "id": "custom-invoice", "label": "Custom Invoice", "description": "..." }]
}
```

**Errors:**
- `401` — unauthorized

---

### POST /api/pdf-generators/preview

Renders a PDF for preview — **no side effects** (no logging, no events, no persistence). Used by `PreviewPanel` to populate the iframe.

**Request:**
```json
{
  "template_id": "sales-offer",
  "data": { /* raw context.record */ }
}
```

**Response:** `Content-Type: application/pdf` — binary PDF stream.

**Errors:**
- `400` — invalid JSON, missing `template_id` / `data`, or unknown template ID
- `401` — unauthorized

---

### POST /api/pdf-generators/generate

Generates a PDF with full side effects — logging, event emission, future persistence (Phase 5). Used by the download button in `PreviewPanel` and by external modules calling the API directly.

**Request:**
```json
{
  "template_id": "sales-offer",
  "data": { /* raw context.record — at minimum { id } when fetchData is defined */ },
  "resource_kind": "quote",
  "resource_id": "quote_01ABC",
  "resource_label": "Quote #123"
}
```

> `resource_kind`, `resource_id`, `resource_label` are optional now — required by Phase 5 for persistence.

**Response:** `Content-Type: application/pdf` — binary PDF stream with `Content-Disposition: attachment; filename="<derived>"`.

**Errors:**
- `400` — invalid JSON, missing `template_id` / `data`, or unknown template ID
- `401` — unauthorized
- `500` — render error

---

## UMES Extension Points

| Extension Point | Usage |
|----------------|-------|
| **Widget Injection** | Any module's detail view — each widget registers its own injection spot in `injection-table.ts` |
| **Backend Page** | `/backend/pdf-generators` — template overview |
| **ACL Features** | `pdf_generators.view`, `pdf_generators.generate` |

---

## Fonts

Fonts live in `templates/shared/fonts/`. Each `.ttf` file has a corresponding `*.generated.ts` file (excluded from git, generated by `build.mjs`) containing a base64 `data:font/truetype` URI.

Templates import individual font files for tree-shaking:

```ts
import InterRegular from '../shared/fonts/Inter-Regular.generated'
```

`build.mjs` generates `*.generated.ts` files before esbuild compilation. No Next.js configuration required — `.ttf` files are never imported directly by the app.

---

## Internationalization (i18n)

| Key | Default |
|-----|---------|
| `pdf_generators.generate.button` | `Generuj PDF` |
| `pdf_generators.template.select` | `Wybierz szablon` |
| `pdf_generators.preview.title` | `Podgląd dokumentu` |
| `pdf_generators.generate.generating` | `Generowanie...` |

---

## UI/UX

### Widget pattern (any module)

A **PDF tab** injected into any detail view via `injection-table.ts`. The tab renders `TemplatesList`:

1. **Template list** — card grid fetched from `GET /api/pdf-generators/templates`, filtered by `TemplateFilter` (`category`, `tags`, `moduleId`) passed as `filter` prop.
2. **Preview dialog** (`PreviewPanel`) — on card click: calls `POST /api/pdf-generators/generate`, displays the result in an `<iframe>` via blob URL. "Pobierz PDF" button triggers `downloadBlob()`.

### Page /backend/pdf-generators

Template overview — list of registered templates with labels and descriptions.

---

## Extending to Other Modules

### Adding a new built-in template for an existing entity

1. Add template component in `templates/<module>/<entity>/templates/<new-template>/` with `types.ts` and `index.tsx`
2. Call `this.registerTemplate(...)` in the existing entity's `DocumentService` constructor
3. Spread the service's entries in the single `registerInternal([...])` call in `config/registry.ts` — it is already there

No other file changes required.

### Adding PDF generation for a new entity (e.g. Shipments)

1. Create `services/shipments-document-service.ts` extending `BaseDocumentService`
2. Add template component in `templates/sales/shipments/templates/<template-name>/`
3. Add the new service to the spread in `config/registry.ts`:
   ```ts
   templateRegistry.registerInternal([
     ...quotesService.getEntries(),
     ...ordersService.getEntries(),
     ...shipmentsService.getEntries(),  // ← add here
   ])
   ```
4. Create `widgets/injection/<entity>_pdf_tab/` with `widget.ts` and `widget.client.tsx`
5. Add slot entry to `widgets/injection-table.ts`

No changes to existing services or templates required.

### Registering an external template from another module

1. Create `pdf-generators.ts` convention file in the other module exporting a `templates: TemplateRegistryEntry[]` array
2. Run `mercato generate registry` — generates `pdf-generators.generated.ts` with bootstrap registration
3. The bootstrap calls `registerExternalTemplates(...)` — templates appear in `GET /api/pdf-generators/templates` under `external`

---

## Risks & Impact Review

### Data Integrity

- **Slow render**: `renderToBuffer` is synchronous and may be slow for large documents. Acceptable for MVP; Phase 2 can move to `@open-mercato/queue`.
- **Line items fetched via raw SQL**: `QuotesDocumentService.fetchData` uses a raw SQL query because `SalesQuote` is not registered in the Awilix DI container. Customer data is resolved via `CustomerEntity` (which is in DI). Mitigation: encapsulated in one method; no impact on other services.

### Tenant & Data Isolation

- **Risk exists and is mitigated.** Both built-in document services (`QuotesDocumentService`, `OrdersDocumentService`) query tenant-scoped records: `sales_quotes`, `sales_quote_lines`, `sales_orders`, `CustomerEntity`, `CustomerAddress`. A user with `pdf_generators.view` could otherwise retrieve data from a different tenant by submitting an arbitrary UUID.
- **Mitigation:** `getAuthFromRequest` is called in both route handlers (`/generate`, `/preview`). The resulting `AuthContext` is propagated through `renderPdf → templateRegistry.load → fetchData` via `ctx.auth`. Every query filters by `tenant_id` and `organization_id` derived from that context. Both services throw explicitly if either value is missing — no silent fallback to unscoped data.
- **Custom `DocumentService` contract:** any external module implementing `BaseDocumentService` **must** apply the same tenant scoping in `fetchData`. The `ctx.auth` argument is available for exactly this purpose. Implementations that ignore it are considered a security defect.

### Font Loading

- `*.generated.ts` files are gitignored and must be regenerated after `build.mjs`. Dev mode requires either running the build or having the files pre-generated. Mitigation: `build.mjs` always regenerates them before esbuild.

### Operational

- `@react-pdf/renderer` adds ~500 KB to the server bundle. Dynamic import of template components (`loadTemplate`) limits client-side impact.

---

## Implementation Plan

### Phase 1 — Foundation ✅

1. Package scaffold (`package.json`, `build.mjs`, `tsconfig.json`)
2. `acl.ts` with `pdf_generators.view`, `pdf_generators.generate`
3. `setup.ts` with `defaultRoleFeatures`
4. Module `index.ts`

### Phase 2 — Templates & Registry ✅

1. `lib/interfaces.ts`, `lib/types.ts`, `lib/template-registry.ts` — class-based registry with `registerInternal` / `registerExternal` / `load`
2. `services/base-document-service.ts` — abstract base class
3. `services/quotes-document-service.ts` — `QuotesDocumentService` with `sales-offer` template
4. `config/registry.ts` — single `registerInternal([...])` call
5. `templates/shared/fonts/` + font build pipeline in `build.mjs`
6. `templates/shared/theme.ts` + `templates/shared/components/Logo.tsx` — shared design tokens and brand components exported publicly
7. `templates/sales/quotes/templates/sales-offer/` — `types.ts`, `CoverPage.tsx`, `QuotePage.tsx`, `index.tsx`

### Phase 3 — API ✅

1. `POST /api/pdf-generators/generate` — accepts `{ template_id, record }`, calls `loadTemplate(id, record)` which normalizes + renders, returns PDF stream
2. `GET /api/pdf-generators/templates` — returns `{ internal: TemplateMeta[], external: TemplateMeta[] }`

### Phase 4 — UI Components ✅

1. `components/TemplatesList.tsx` — fetches templates via `GET /api/pdf-generators/templates`, applies `TemplateFilter` client-side, renders card list
2. `components/TemplatesListView.tsx`, `TemplatesListLoader.tsx`, `TemplateListItem.tsx` — list sub-components
3. `components/PreviewPanel.tsx` — fullscreen dialog: sends `{ template_id, record }` to `POST /generate`, shows `Preview` (iframe) + download button
4. `components/Preview.tsx` — iframe rendering a blob URL
5. `components/Loader.tsx` — spinner
6. `utils/downloadBlob.ts` — triggers browser file download
7. `widgets/injection/quote_pdf_tab/` — `widget.ts`, `widget.client.tsx` — filter: `{ category: 'quote', moduleId: 'quotes' }`
8. `widgets/injection-table.ts` — injection spot mapping

### Phase 4.5 — External Template Code-Gen ✅

1. `generators.ts` — `pdf-generators.templates` GeneratorPlugin
2. Convention file pattern: `pdf-generators.ts` in consuming module exports `templates: TemplateRegistryEntry[]`
3. `mercato generate registry` produces `pdf-generators.generated.ts` that calls `registerExternal(...)`

### Phase 4.6 — Orders Built-in Template ✅

1. `services/orders-document-service.ts` — `OrdersDocumentService` (moduleId: `'sales'`) with `order-invoice` template
2. `templates/sales/orders/templates/order-invoice/` — `types.ts`, `index.tsx` (`OrderInvoiceDocument`)
3. `services/index.ts` updated — exports `OrdersDocumentService`, `ORDERS_TEMPLATE_IDS`, `OrderWidgetRecord`
4. `config/registry.ts` updated — single `registerInternal([...quotesService, ...ordersService])` call
5. `widgets/injection/order_pdf_tab/` — `widget.ts`, `widget.client.tsx` — filter: `{ category: 'invoice', moduleId: 'sales' }`
6. `widgets/injection-table.ts` updated — added `sales.document.detail.order:tabs` slot
7. `examples/` folder added at package root — complete working invoice example for external template authors (`pdf-generators.ts`, service, template, widget, injection-table)
8. `scaffold-pdf-templates` Claude Code skill added — guides generation of the full integration layer for external modules

### Phase 5 — History & Backend Page (Planned)

#### Files to create

| File | Description |
|------|-------------|
| `data/entities.ts` | `PdfGeneratedDocument` entity — `id`, `organization_id`, `tenant_id`, `resource_kind`, `resource_id`, `resource_label`, `template_id`, `template_label`, `generated_by`, `generated_at`, `attachment_id` (nullable — populated in Phase 6) |
| `data/validators.ts` | Zod schemas: extended `generateSchema` (adds `resource_kind`, `resource_id`, `resource_label`) + `listDocumentsSchema` (query params) |
| `api/GET/pdf-generators/documents.ts` | Paginated history endpoint, filterable by `resource_kind` and `resource_id`; exports `openApi` + `metadata` |

#### Files to modify

| File | Change |
|------|--------|
| `api/pdf-generators/generate/route.ts` | Accept `resource_kind`, `resource_id`, `resource_label` alongside `template_id` + `record`; persist `PdfGeneratedDocument` via `createRequestContainer()` + `em` after successful render; get `generated_by` from `getAuthFromRequest()` |
| `acl.ts` | Add `pdf_generators.generate` feature |
| `setup.ts` | Add `pdf_generators.generate` to `superadmin` + `admin` role features |
| `backend/pdf-generators/page.tsx` | Add history section below templates: `DataTable` with columns Resource, Template, Generated By, Date — fetched from `GET /api/pdf-generators/documents` |
| `i18n/*.json` | New keys: `pdf_generators.history.title`, `pdf_generators.history.resource`, `pdf_generators.history.template`, `pdf_generators.history.generatedBy`, `pdf_generators.history.generatedAt`, `pdf_generators.history.empty` |

#### Data flow

```
Widget → POST /generate { template_id, record, resource_kind, resource_id, resource_label }
         ├── renderToBuffer() → success
         │   └── em.persist(PdfGeneratedDocument { ..., generated_by: auth.userId })
         └── returns PDF stream

GET /api/pdf-generators/documents?resource_kind=X&resource_id=Y&page=1&pageSize=20
    └── em.find(PdfGeneratedDocument, { organization_id, [resource_kind, resource_id] }, { orderBy: generated_at DESC })
```

#### Key implementation notes

- Use `createRequestContainer()` from `@open-mercato/shared/lib/di/container` to get `em` in the generate route
- Use `getAuthFromRequest(request)` from `@open-mercato/shared/lib/auth/server` to get `auth.userId` for `generated_by`
- `resource_kind`, `resource_id`, `resource_label` are optional in `POST /generate` — PDF still renders without them; history record is only saved when all three are present
- `GET /documents` must always filter by `organization_id` — use `getAuthFromRequest` for tenant scoping
- DB migration: run `yarn mercato db:generate` after adding entity — never hand-write migration SQL

### Phase 6 — Attachment Storage (Planned)

Uses the existing core `attachments` module — no custom storage infrastructure needed.

1. Create `pdfDocuments` attachment partition (private, non-public) via `POST /api/attachments/partitions` or seeded in `setup.ts`
2. After successful render in `POST /generate`, upload the PDF buffer to `POST /api/attachments` (multipart, partition: `pdfDocuments`, `entity_id: 'pdf_generators:document'`, `record_id: resource_id`)
3. Store returned `attachment_id` in `PdfGeneratedDocument.attachment_id` (new nullable column, added via `yarn mercato db:generate`)
4. `GET /api/pdf-generators/documents` history response includes `attachment_id` — client builds download URL as `/api/attachments/file/{attachment_id}`
5. Download button in the widget uses the stored attachment URL when `attachment_id` is present, falls back to on-demand `POST /generate` render otherwise

### Phase 7 — Email & Sharing (Planned)

1. Send PDF directly to a recipient email from the widget — attach generated PDF or include storage URL
2. Shareable link — time-limited public URL for previewing a document without login
3. Bulk generation — generate PDFs for multiple records in a single action via queue worker

### Phase 8 — Advanced Templates (Planned)

1. Template versioning — record which template version was used at generation time; archived versions remain renderable
2. Draft watermark — render a "DRAFT" overlay when the source resource is not in a final status
3. Auto-generation trigger — emit `pdf_generators.document.generated` event on resource status change (e.g. quote accepted)

---

---

## Final Compliance Report — 2026-05-08

### Compliance Matrix

| Rule | Status | Notes |
|------|--------|-------|
| No direct ORM relationships between modules | ✅ | No DB entities yet; FK IDs planned |
| Filter by organization_id | ✅ | Planned for Phase 5 entity |
| Validate inputs with Zod | ✅ | generate route validates template_id + data presence |
| API routes export openApi | ✅ | Both routes export openApi |
| Module code in `packages/<name>/` | ✅ | `packages/pdf-generators/` |
| defaultRoleFeatures in setup.ts | ✅ | |
| Never hardcode user-facing strings | ✅ | All via useT() |
| No direct imports from other module internals | ✅ | Data via context.record only |

### Non-Compliant / Pending

- **Raw SQL in QuotesDocumentService.fetchData**: `SalesQuote` is not in the DI container, so line items are fetched via `em.getConnection().execute(sql)`. Not a compliance violation per se (it uses the same `em` from the container), but it bypasses the ORM layer. Accepted for MVP; revisit if `SalesQuote` is added to DI.

### Verdict

**Compliant for Phases 1–4 and 4.5.** Phase 5 requires DB entity + migration review before implementation.

---

## Changelog

| Date | Author | Summary |
|------|--------|---------|
| 2026-05-06 | Krzysztof Polak | Spec created — Phases 1–4 designed |
| 2026-05-07 | Krzysztof Polak | Initial compliance report added |
| 2026-05-08 | Krzysztof Polak | Spec updated to match implementation: widget renamed to `quote_pdf_tab` (tab, not action); `PdfGeneratorDrawer` replaced by `TemplatesList` + `PreviewPanel` + `Preview` + `Loader` + `downloadBlob`; data mapper moved to `data/quote-detail/`; `GET /api/pdf-generators/templates` endpoint added; globalThis-based dual registry (`template-registry.ts`) documented; `generators.ts` plugin (Phase 4.5) added |
| 2026-05-08 | Krzysztof Polak | `templateIds` filtering replaced by `TemplateFilter { category, tags, moduleId }` — templates declare `category`, `tags[]`, `moduleId` at registration; `TemplatesList` accepts `filter` prop instead of `templateIds`; OR logic for tags |
| 2026-05-08 | Krzysztof Polak | `fromRecord` mapper moved from `data/quote-detail/document-data.ts` into each `TemplateRegistryEntry` — template owns its own data mapping; widget passes raw `record` to `TemplatesList`; `document-data.ts` removed; `TemplatesList` resolves mapper from globalThis registry on template selection |
| 2026-05-09 | Krzysztof Polak | Normalization moved server-side: `POST /generate` now accepts `{ template_id, record }` instead of `{ template_id, data }`; `loadTemplate(id, record)` calls `entry.fromRecord(record)` server-side; client no longer needs registry import side effect; template folder convention changed to `templates/<module>/<entity>/templates/<name>/` + `templates/<module>/<entity>/data/`; `QuoteWidgetRecord` exported publicly from package root |
| 2026-05-09 | Krzysztof Polak | Phase 5 implementation plan detailed — files to create/modify, data flow, key implementation notes added to spec; `attachment_id` nullable column added to `PdfGeneratedDocument` (populated in Phase 6) |
| 2026-05-09 | Krzysztof Polak | Phase 6 rewritten — replaces custom S3/GCS storage with existing core `attachments` module; uses `POST /api/attachments` + `pdfDocuments` partition; download via `/api/attachments/file/{attachment_id}`; no custom storage infrastructure needed |
| 2026-05-09 | Krzysztof Polak | Introduced `BaseDocumentService` base class — `registerTemplate()`, `getEntries()`, `formatDate()` centralised; `QuotesDocumentService` and `OrdersDocumentService` as subclasses; `normalizeRecord` per service replaces standalone `normalize-record.ts` files; `config/registry.ts` uses single `registerInternal([...spread])` call to avoid array clobber; built-in `order-invoice` template added (`OrderInvoiceDocument`); `order_pdf_tab` widget added; `examples/` reference folder added; `scaffold-pdf-templates` skill added; sandbox example PDF implementation removed (superseded by built-in) |
| 2026-05-17 | Krzysztof Polak | **Template metadata hierarchy**: `moduleId` → `module` + `entity`; `category` → `documentType`. `BaseDocumentService` now requires `module` and `entity` abstract fields. Widget filters simplified to `{ entity: 'quotes' }` / `{ entity: 'orders' }`. `TemplateFilter` updated accordingly. `note?: string` field added to `DocumentTemplateEntry` and `TemplateMeta` — free-text description of where the template is used; surfaced as a column on the backend page. |
| 2026-05-17 | Krzysztof Polak | **Split `/generate` into `/preview` and `/generate`** — `POST /api/pdf-generators/preview` renders PDF with zero side effects (used by `PreviewPanel`); `POST /api/pdf-generators/generate` is the production endpoint with full side effects (logging, events, future persistence) and accepts optional `resource_kind`, `resource_id`, `resource_label` forward-compatible with Phase 5. Common render logic extracted to `lib/render-pdf.ts`. Download button in `PreviewPanel` calls `/generate`; iframe preview calls `/preview`. Backend page restructured: templates grouped by `module` first, then Internal/External sub-sections; External always visible with empty state when none registered; page title changed to "Available templates". |
| 2026-05-17 | Krzysztof Polak | **Server-side data fetching via `fetchData` hook** — `BaseDocumentService` gains optional `fetchData({ data }, { container })` method called before normalization; `QuotesDocumentService` overrides it to load full quote with line items via raw SQL + DI container (resolves the missing-line-items limitation); `OrdersDocumentService` gains billing address enrichment. **API body field renamed**: `POST /generate` now accepts `data` (was `record`). **`normalizeRecord` renamed to `toTemplateData`** with `{ data }` input shape for consistency. **`filename` method added** to `BaseDocumentService` — derives the PDF download filename from normalized data; `Content-Disposition` header set from the returned value. **`enrichRecord` prop removed** from `PreviewPanel` and `TemplatesList` — no client-side enrichment; widgets pass raw `record` only. **`TemplateEntry` type introduced** (`TemplateMeta & TemplateRegistryEntry`). **`TemplateRegistry` interface** extracted to `interfaces.ts`. **`getMetas()` renamed to `listTemplates()`**. Error handling hardened in `PreviewPanel` (catches promise rejection) and generate route (catches JSON parse errors). QuotePage color scheme updated. |
