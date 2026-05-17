# @open-mercato/pdf-generators

A community module for generating and previewing PDF documents (invoices, sales offers, shipment labels) inside Open Mercato. It ships two built-in templates (order invoice, sales offer) and exposes a public extension API so any other module can register its own templates with zero changes to this package.

---

## Contents

- [Screenshots](#screenshots)
- [Using the module](#using-the-module)
  - [Installation](#installation)
  - [Registering templates from another module](#registering-templates-from-another-module)
  - [Dependencies](#dependencies)
  - [Public API](#public-api)
- [Contributing to this package](#contributing-to-this-package)
  - [Running locally](#running-locally)
  - [Reference implementation](#reference-implementation)
  - [Package structure](#package-structure)

---

## Screenshots

**Template registry — admin page**

Lists all registered templates grouped by origin (internal built-ins vs. external templates registered by other modules).

![Available templates admin page](screenshots/screen-1.png)

**PDF tab on an Order detail page**

The tab appears automatically — no widget registration needed in your module.

![PDF tab on order detail](screenshots/screen-2.png)

**PDF tab on a Quote detail page**

![PDF tab on quote detail](screenshots/screen-4.png)

**Document preview dialog**

Clicking a template card opens a full-screen preview with a Download PDF button.

![Document preview dialog](screenshots/screen-3.png)

---

## Using the module

### Installation

1. **Add the package** to your Open Mercato application:

   ```bash
   yarn mercato module add @open-mercato/pdf-generators
   ```

2. **Register the module** in `src/modules.ts`:

   ```ts
   { id: 'pdf_generators', from: '@open-mercato/pdf-generators' }
   ```

3. **Regenerate** the module registry so the built-in templates are picked up:

   ```bash
   yarn generate
   ```

4. **Grant permissions** — new features are automatically added to default roles on the next `yarn generate` run. To sync existing tenants manually:

   ```bash
   yarn mercato auth sync-role-acls
   ```

5. **Verify** — navigate to a sales order or quote detail page. A **PDF** tab appears automatically. Clicking any template card opens a preview; clicking **Download PDF** streams the file.

---

### Registering templates from another module

Templates are registered via a **convention file** named `pdf-generators.ts` at the root of any module (sibling of `index.ts`, `acl.ts`, etc.). The `mercato generate registry` step scans all loaded modules for this file and adds its templates to the global registry automatically.

No widget, no injection-table entry needed — the PDF tab is already rendered by the core sales module for orders and quotes.

> **Shortcut**: use the `scaffold-pdf-templates` Claude Code skill to generate all files below automatically. In Claude Code, type:
> ```
> /scaffold-pdf-templates
> ```
> The skill will ask for your module ID, resource kind, and template name, then create the DocumentService, template component, and convention file in one step.

A fully working example of the complete file layout is available in `packages/pdf-generators/examples/` inside the `offical-modules` repository.

#### Step 1 — Create a `DocumentService`

Place it in `src/modules/<your_module>/pdf-templates/services/`.

```ts
// src/modules/my_module/pdf-templates/services/my-module-invoice-document-service.ts
import { BaseDocumentService, formatDate } from '@open-mercato/pdf-generators'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'

export class MyModuleInvoiceDocumentService extends BaseDocumentService {
  readonly id = 'my-module-invoices'    // globally unique — convention: <module>-<category>s
  readonly label = 'My Module Invoices'
  readonly module = 'my_module'         // top-level module name — used for grouping in the UI
  readonly resourceKind = 'sales.order' // must match ctx.resourceKind on the target detail page

  constructor() {
    super()

    this.registerTemplate({
      id: 'my-module-invoice',
      label: 'My Module Invoice',
      description: 'Standard invoice for my module orders.',
      documentType: 'invoice',
      tags: ['invoice', 'my_module'],
      load: () =>
        import('../templates/invoice/my-module-invoice').then(
          (m) => m.MyModuleInvoiceDocument as unknown as React.ComponentType<{ data: Record<string, unknown> }>
        ),
    })
  }

  // The detail page passes only { id }. Override fetchData to load the full record.
  override async fetchData({ data }: { data: unknown }, { container }: { container: AppContainer }) {
    const record = data as { id: string }
    // const service = container.resolve('myOrderService')
    // return service.retrieve(record.id)
    throw new Error(`fetchData not implemented (id: ${record.id})`)
  }

  toTemplateData({ data }: { data: unknown }): Record<string, unknown> {
    const r = data as { id: string; number: string }
    return {
      document: { number: r.number, date: formatDate(new Date().toISOString()) },
      seller:   { name: '', company: '', email: '' },
      client:   { name: '' },
      lines:    [],
      totals:   { subtotal: 0, tax: 0, total: 0, currency: 'PLN' },
    }
  }

  override filename({ data }: { data: Record<string, unknown> }): string {
    const doc = data.document as { number?: string } | undefined
    return doc?.number ? `invoice-${doc.number}.pdf` : 'invoice.pdf'
  }
}
```

#### Step 2 — Create the template component

Place it in `src/modules/<your_module>/pdf-templates/templates/<category>/<template-id>/index.tsx`.

```tsx
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { OpenMercatoLogo } from '@open-mercato/pdf-generators'
import '@open-mercato/pdf-generators/modules/pdf_generators/templates/shared/theme' // registers Inter font
import { colors } from '@open-mercato/pdf-generators/modules/pdf_generators/templates/shared/theme'

const s = StyleSheet.create({
  page:  { paddingHorizontal: 52, paddingVertical: 48, fontSize: 10, fontFamily: 'Inter', color: colors.text },
  title: { fontSize: 28, fontWeight: 600 },
})

export function MyModuleInvoiceDocument({ data }: { data: Record<string, unknown> }) {
  const doc = data.document as { number: string; date: string }

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 }}>
          <Text style={s.title}>Invoice {doc.number}</Text>
          <OpenMercatoLogo />
        </View>
        {/* seller, client, line items, totals … */}
      </Page>
    </Document>
  )
}
```

> The bare `import '…/theme'` is a **required side-effect** — it registers the Inter font with `@react-pdf/renderer`. Without it, `fontFamily: 'Inter'` silently falls back to the default font.

#### Step 3 — Create the convention file

```ts
// src/modules/my_module/pdf-generators.ts
import { MyModuleInvoiceDocumentService } from './pdf-templates/services/my-module-invoice-document-service'

const service = new MyModuleInvoiceDocumentService()

export const templates = service.getEntries()
export default templates
```

#### Step 4 — Regenerate

```bash
yarn generate
```

The template now appears in the **PDF** tab on all sales order detail pages.

---

### Dependencies

| Package | Role |
|---------|------|
| `@react-pdf/renderer` `4.x` | Renders React component trees to PDF binary |
| `@open-mercato/shared` | DI container types, shared utilities |
| `@open-mercato/ui` | Design system components used in `TemplatesList` and `PreviewPanel` |
| `react` `^19` | Peer dependency — provided by the host application |

Font files (Inter Regular, Medium, SemiBold) are bundled inside the package and registered automatically via the `theme` side-effect import.

---

### Public API

#### REST endpoints

All endpoints require authentication (`pdf_generators.view` feature). Both rendering endpoints follow the same two-step flow internally: `fetchData` is called server-side first (to load the full record via DI), then `toTemplateData` normalizes it, and finally the React-PDF component renders the binary stream.

##### `GET /api/pdf-generators/templates`

Returns all registered templates grouped by origin — internal (built-in) and external (registered by other modules via `pdf-generators.ts`).

```jsonc
// Response
{
  "internal": [
    {
      "id": "order-invoice",
      "label": "Order Invoice",
      "description": "Standard invoice for sales orders.",
      "module": "sales",
      "resourceKind": "sales.order",
      "documentType": "invoice",
      "tags": ["invoice", "order"]
    }
  ],
  "external": [
    // templates registered via pdf-generators.ts in other modules
  ]
}
```

Use this endpoint to build custom template pickers or to verify that your registered templates are visible to the registry.

---

##### `POST /api/pdf-generators/preview`

**Purpose**: render a PDF for display inside a dialog iframe. Called automatically by `PreviewPanel` when the user clicks a template card in the PDF tab.

**No side effects** — no logging, no events, no persistence. Safe to call repeatedly as the user switches between templates.

```jsonc
// Request body
{
  "template_id": "order-invoice",  // id from registerTemplate()
  "data": { "id": "order_01JXYZ..." }  // minimal record — fetchData loads the rest server-side
}
```

```
// Response
Content-Type: application/pdf
<binary stream>
```

---

##### `POST /api/pdf-generators/generate`

**Purpose**: render a PDF and stream it to the browser as a file download. Called automatically by `PreviewPanel` when the user clicks **Download PDF**.

**Has side effects** — intended for production use. Future phases will add logging, event emission (`pdf_generators.document.generated`), and PDF history persistence. Pass `resource_kind`, `resource_id`, and `resource_label` so these side effects have full context.

```jsonc
// Request body
{
  "template_id": "order-invoice",
  "data": { "id": "order_01JXYZ..." },
  "resource_kind": "sales.order",      // optional — for logging and future history
  "resource_id": "order_01JXYZ...",    // optional — for logging and future history
  "resource_label": "Order #1042"      // optional — human-readable label for history UI
}
```

```
// Response
Content-Type: application/pdf
Content-Disposition: attachment; filename="invoice-1042.pdf"
<binary stream>
```

**Typical client-side usage** (what `PreviewPanel` does internally):

```ts
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { downloadBlob } from '@open-mercato/pdf-generators/modules/pdf_generators/utils/downloadBlob'

const { result, error } = await apiCall(
  '/api/pdf-generators/generate',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_id: template.id,
      data: record,
      resource_kind: resource?.kind,
      resource_id: resource?.id,
      resource_label: resource?.label,
    }),
  },
  { parse: (res) => res.blob() },
)

if (!error && result) {
  const url = URL.createObjectURL(result)
  downloadBlob(url, template.id)
  URL.revokeObjectURL(url)
}
```

---

**Preview vs generate — decision guide**

| | `/preview` | `/generate` |
|---|---|---|
| Purpose | Display in iframe | File download |
| Side effects | None | Logging, events, future history |
| When to call | On template card click | On "Download PDF" button click |
| `resource_*` fields | Not needed | Recommended |
| Safe to call repeatedly | Yes | Avoid — each call is a billable action in future phases |

#### TypeScript exports

Everything below is exported from `@open-mercato/pdf-generators`.

##### `BaseDocumentService`

Abstract base class. Extend once per category of documents in your module.

| Member | Description |
|--------|-------------|
| `id` (abstract) | Globally unique service identifier. Convention: `<module>-<category>s` |
| `label` (abstract) | Human-readable name shown in the admin page |
| `module` (abstract) | Top-level module name — used for grouping (`'sales'`, `'my_module'`) |
| `resourceKind` (abstract) | Framework resource kind matching the detail page (`'sales.order'`, `'sales.quote'`) |
| `registerTemplate(entry)` | Registers a template with this service |
| `getEntries()` | Returns all registered templates ready for the global registry |
| `toTemplateData(input)` (abstract) | Maps the enriched server record to the flat data shape expected by template components |
| `fetchData(input, ctx)` | Server-side hook called before `toTemplateData`. Override to load related data via DI. Default: passes data through unchanged |
| `filename(input)` | Derives the download filename from normalized data. Default: `'document.pdf'` |

##### `formatDate(isoString)`

Formats an ISO 8601 string to a locale-friendly display string. Use inside `toTemplateData`.

##### `TemplatesList`

React component that renders the template list for a given resource. Normally rendered automatically by the core sales module — you do not need to use it directly.

| Prop | Type | Description |
|------|------|-------------|
| `record` | `{ id: string }` | Minimal record — full data is fetched server-side |
| `filter` | `TemplateFilter` | Scopes the list by `resourceKind`, `documentType`, or `tags` |
| `resource` | `{ kind: string; id: string }` | Passed to `/generate` for logging and future history |

##### `OpenMercatoLogo`

Pre-built React-PDF component rendering the Open Mercato brand mark. Use directly inside template components.

##### `sharedColors`, `borders`, `spacing`

Design tokens from the shared theme. Import the theme file as a side-effect first, then destructure what you need.

##### Types

| Type | Description |
|------|-------------|
| `TemplateMeta` | UI-facing descriptor: id, label, module, resourceKind, documentType, tags |
| `TemplateEntry` | Full descriptor — `TemplateMeta` plus runtime handlers |
| `TemplateRegistryEntry` | Runtime handlers only: `fromRecord`, `load`, `fetchData`, `filename` |
| `TemplateFilter` | Filter shape: `{ resourceKind?, documentType?, tags? }` |
| `DocumentTemplateEntry` | Shape passed to `registerTemplate()` |
| `templateRegistry` | Global singleton registry — use only for custom rendering pipelines outside the standard endpoints |

---

## Contributing to this package

### Running locally

The package is developed inside the `offical-modules` monorepo. The sandbox app (`apps/sandbox`) is used to verify changes end-to-end.

```bash
# from the monorepo root

# build the package in watch mode
yarn workspace @open-mercato/pdf-generators watch

# in a separate terminal — start the sandbox
cd apps/sandbox && yarn dev
```

After making changes, navigate to a sales order or quote in the sandbox to verify templates render correctly.

### Reference implementation

`packages/pdf-generators/examples/` contains a fully working invoice example that mirrors the structure a consuming module should produce:

```
examples/
  pdf-generators.ts                        ← convention file (auto-discovery entry point)
  invoice/
    services/
      example-invoice-document-service.ts  ← concrete DocumentService
    templates/
      example-invoice/
        index.tsx                          ← React-PDF template component
        types.ts                           ← typed data shape
  widgets/                                 ← reference only — illustrates the widget pattern
                                             do NOT copy; the core sales module owns the PDF tab
```

When adding a new built-in template to this package, follow the same layout under `src/modules/pdf_generators/templates/`.

### Package structure

```
src/
  index.ts                              ← public exports
  modules/pdf_generators/
    api/pdf-generators/
      templates/route.ts                ← GET /api/pdf-generators/templates
      preview/route.ts                  ← POST /api/pdf-generators/preview
      generate/route.ts                 ← POST /api/pdf-generators/generate
    components/
      TemplatesList.tsx                 ← list rendered inside the PDF tab
      PreviewPanel.tsx                  ← dialog with iframe preview + download button
    lib/
      interfaces.ts                     ← TemplateMeta, TemplateEntry, TemplateRegistry …
      template-registry.ts              ← global singleton registry
      render-pdf.ts                     ← shared rendering logic for both endpoints
    services/
      base-document-service.ts          ← BaseDocumentService abstract class
      orders-document-service.ts        ← built-in order invoice service
      quotes-document-service.ts        ← built-in sales offer service
    templates/
      sales/orders/…                    ← Order Invoice React-PDF component
      sales/quotes/…                    ← Sales Offer React-PDF component
      shared/
        theme.ts                        ← colors, borders, spacing + Inter font registration
        components/Logo.tsx             ← OpenMercatoLogo component
    config/registry.ts                  ← bootstraps built-in templates into the global registry
    generators.ts                       ← mercato generate hook — picks up external pdf-generators.ts files
```
