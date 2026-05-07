# SPEC-004: PDF Generators

## TLDR
**Key Points:**
- The `@open-mercato/pdf-generators` module is a **universal PDF generation engine** — any module in OpenMercato can inject a widget that generates PDFs from its own data.
- A user clicks "Generate PDF" in any supported view, picks a template, previews the PDF live, then downloads the final file.
- Quote/Sales is the first supported module; Orders, Invoices, or any other entity can be added independently.

**Scope:**
- Universal template registry (code-defined, not database-driven) — shared across all modules
- Data passed directly from widget `context.record` — no separate fetch endpoint
- Per-widget `toDocumentData()` mapper normalizing module-specific data to template shape
- Live PDF preview (`PDFViewer` client-side)
- Final PDF generation via API (server-side `renderToBuffer`)
- Widget injection pattern reusable for any module and any entity type

**Concerns:**
- `@react-pdf/renderer` operates client-side (`PDFViewer`) and server-side (`renderToBuffer`) — fonts must be accessible in both environments; solved via base64-encoded `*.generated.ts` font files
- Large documents may render slowly on the server — async queue may be needed in a later phase

---

## Overview

The `pdf_generators` module extends OpenMercato with the ability to generate professional, branded PDF documents from any entity in the system. A "Generate PDF" button can be injected into any detail view — it opens a dialog: template selection → live preview → download.

Templates are defined as React components (JSX) inside the package. Each template defines its own data shape (`PdfDocumentData` in `types.ts`). The list of available templates comes from a code registry in `config/registry.ts`. Each widget decides which templates it exposes via the `templateIds` prop.

Data flows directly from the widget's `context.record` — no intermediate API fetch. Each widget folder contains a `document-data.ts` file exporting a single `toDocumentData()` function that maps the context record to the template's data shape.

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

1. **Action widgets** — injected into any module's detail view via `injection-table.ts`. Each widget is self-contained and provides its own `toDocumentData()` mapper.
2. **Backend page** `/backend/pdf-generators` — template overview.
3. **Single API route**:
   - `POST /api/pdf-generators/generate` — accepts `{ template_id, data }`, returns PDF stream
4. **Live preview** — `PDFViewer` dynamically loaded with selected template and context data.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Templates as code (JSX), not database config | Git-versioned, full typographic control, no visual editor required |
| Data from `context.record`, not a fetch | Widget already receives full record from the framework — no redundant API call |
| `toDocumentData()` per widget, not a global mapper | Each module knows its own data shape; global mapper would become a god-object |
| `PdfDocumentData` lives in `templates/sales-offer/types.ts` | Type is a contract between the widget mapper and the template, not a global concern |
| `Record<string, unknown>` in route and drawer | Route and drawer are template-agnostic; type safety lives at the widget→template boundary |
| Template registry in `config/registry.ts` | Configuration separated from logic; adding a template = one registry entry |
| Fonts as base64 `*.generated.ts` per font | Works in both browser (no HTTP) and server (no filesystem path); tree-shakeable per font |
| `renderToBuffer` on the server | Deterministic output, no dependency on client environment |
| Files not stored in object storage | MVP — PDF returned directly as stream |

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
  └── [Widget Injection: <module>_generate_pdf]
        ↓ click "Generate PDF"
  <ModuleGeneratePdfWidget>
    ├── context.record → toDocumentData() → data: Record<string, unknown>
    └── PdfGeneratorDrawer(templateIds, data)
          ├── Step 1: template selection (filtered by templateIds)
          ├── Step 2: PdfPreview(templateId, data)
          │     └── loadTemplate(templateId) → PDFViewer (client-side)
          └── Step 3: DownloadButton
                └── POST /api/pdf-generators/generate
                      ├── loadTemplate(template_id)
                      ├── renderToBuffer(<Template data={data} />)
                      └── returns application/pdf stream
```

### Module Structure

```
src/modules/pdf_generators/
├── config/
│   └── registry.ts              # REGISTRY array — add templates here
├── lib/
│   ├── interfaces.ts            # TemplateMeta, TemplateRegistryEntry, PdfTemplateDefinition
│   ├── types.ts                 # TemplateId (derived from REGISTRY)
│   └── templates.ts             # getTemplateMetas(), loadTemplate()
├── components/
│   ├── PdfGeneratorDrawer.tsx   # Dialog: select → preview → download
│   └── PdfPreview.tsx           # PDFViewer wrapper, loads template dynamically
├── templates/
│   ├── shared/
│   │   └── fonts/
│   │       ├── Inter-Regular.ttf
│   │       ├── Inter-Regular.generated.ts   # base64 data URI (build-generated)
│   │       └── ...
│   └── sales-offer/
│       ├── types.ts             # PdfDocumentData (template-specific contract)
│       ├── theme.ts             # Font.register() + color tokens
│       ├── index.tsx            # SalesOfferDocument component
│       ├── CoverPage.tsx
│       └── QuotePage.tsx
├── widgets/
│   ├── injection-table.ts       # spot → widget mapping
│   └── injection/
│       └── quote_generate_pdf/
│           ├── widget.ts        # widget metadata
│           ├── widget.client.tsx# QuoteGeneratePdfWidget
│           ├── types.ts         # QuoteWidgetRecord, QuoteWidgetContext
│           └── document-data.ts # toDocumentData(record) → Record<string, unknown>
├── api/
│   └── pdf-generators/
│       └── generate/
│           └── route.ts         # POST /api/pdf-generators/generate
├── backend/
│   └── pdf-generators/
│       └── page.tsx             # /backend/pdf-generators
└── acl.ts
```

---

## Data Contracts

### Template Registry Entry

```ts
// config/registry.ts
interface TemplateRegistryEntry {
  id: string
  label: string
  description: string
  load: () => Promise<React.ComponentType<{ data: Record<string, unknown> }>>
}
```

Adding a new template = one object in `REGISTRY`. No other file needs to change.

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

### Widget Data Mapper

```ts
// widgets/injection/quote_generate_pdf/document-data.ts
export function toDocumentData(record: QuoteWidgetRecord): Record<string, unknown>
```

Maps `context.record` from the injection framework to the template's expected shape. Lives next to the widget — not a global utility.

### Widget Context Types

```ts
// widgets/injection/quote_generate_pdf/types.ts
interface QuoteWidgetRecord { /* fields from context.record */ }
interface QuoteWidgetContext {
  kind: string
  resourceId: string
  resourceKind: string
  record: QuoteWidgetRecord
}
```

---

## API Contracts

### POST /api/pdf-generators/generate

Generates a PDF using the specified template and data.

**Request:**
```json
{
  "template_id": "sales-offer",
  "data": { /* Record<string, unknown> — template-specific shape */ }
}
```

**Response:** `Content-Type: application/pdf` — binary PDF stream

**Errors:**
- `400` — missing or invalid `template_id` / `data`
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

A "Generate PDF" button injected into any detail view via `injection-table.ts`. Opens a fullscreen dialog:

1. **Step 1 — Select template**: card list filtered by `templateIds` prop passed from the widget.
2. **Step 2 — Preview + Download**: `PDFViewer` renders live with data from `context.record`. "Pobierz PDF" button triggers `POST /generate`.

### Page /backend/pdf-generators

Template overview — list of registered templates with labels and descriptions.

---

## Extending to Other Modules

To add PDF generation for a new module (e.g. Orders):

1. Add template component in `templates/order-invoice/`
2. Register in `config/registry.ts`
3. Create `widgets/injection/order_generate_pdf/` with `types.ts`, `document-data.ts`, `widget.client.tsx`
4. Add entry to `widgets/injection-table.ts`

No changes to existing code required.

---

## Risks & Impact Review

### Data Integrity

- **Slow render**: `renderToBuffer` is synchronous and may be slow for large documents. Acceptable for MVP; Phase 2 can move to `@open-mercato/queue`.
- **Missing line items**: `context.record` does not include line items (only `lineItemCount`). `toDocumentData()` returns empty `lines: []` until core exposes line items in the injection context.

### Tenant & Data Isolation

- No database entities — no tenant isolation risk in this phase.
- Templates are code-defined — no cross-tenant data leakage.

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

1. `config/registry.ts` — REGISTRY array
2. `lib/interfaces.ts`, `lib/types.ts`, `lib/templates.ts`
3. `templates/shared/fonts/` + font build pipeline in `build.mjs`
4. `templates/sales-offer/` — `types.ts`, `theme.ts`, `CoverPage.tsx`, `QuotePage.tsx`, `index.tsx`

### Phase 3 — API ✅

1. `POST /api/pdf-generators/generate` — accepts `{ template_id, data }`, `renderToBuffer`, returns PDF stream

### Phase 4 — UI Components ✅

1. `components/PdfPreview.tsx` — `PDFViewer` wrapper with dynamic `loadTemplate`
2. `components/PdfGeneratorDrawer.tsx` — fullscreen dialog, select → preview → download
3. `widgets/injection/quote_generate_pdf/` — first reference widget: `types.ts`, `document-data.ts`, `widget.client.tsx`, `widget.ts`
4. `widgets/injection-table.ts` — injection spot mapping (one entry per supported module view)

### Phase 5 — History & Backend Page (Planned)

1. `PdfGeneratedDocument` entity — `id`, `organization_id`, `tenant_id`, `resource_kind`, `resource_id`, `resource_label`, `template_id`, `template_label`, `generated_by`, `generated_at`
2. DB migration
3. Save metadata in `POST /generate` after successful render (resource kind + ID passed alongside `template_id` and `data`)
4. `GET /api/pdf-generators/documents` — paginated history, filterable by `resource_kind` and `resource_id`
5. Backend page — history table: Resource, Template, Generated By, Date

### Phase 6 — External Storage (Planned)

1. After successful render, upload the PDF buffer to a configured external storage provider (e.g. S3, GCS, or any compatible object store)
2. Store the resulting public/signed URL in `PdfGeneratedDocument.storage_url`
3. `GET /api/pdf-generators/documents/:id/url` — return a fresh signed URL (re-signed if expired)
4. Download button in the widget uses the stored URL when available, falls back to on-demand render otherwise

### Phase 7 — Email & Sharing (Planned)

1. Send PDF directly to a recipient email from the widget — attach generated PDF or include storage URL
2. Shareable link — time-limited public URL for previewing a document without login
3. Bulk generation — generate PDFs for multiple records in a single action via queue worker

### Phase 8 — Advanced Templates (Planned)

1. Template versioning — record which template version was used at generation time; archived versions remain renderable
2. Draft watermark — render a "DRAFT" overlay when the source resource is not in a final status
3. Auto-generation trigger — emit `pdf_generators.document.generated` event on resource status change (e.g. quote accepted)
