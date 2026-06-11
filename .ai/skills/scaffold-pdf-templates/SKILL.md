---
name: scaffold-pdf-templates
description: Scaffold the files needed to add custom PDF templates to an @open-mercato module using the pdf-generators package. Creates a DocumentService, a template component, a types file, and the pdf-generators.ts convention file. The PDF tab is rendered automatically by the core sales module — no widget scaffolding needed. Triggers on "scaffold pdf templates", "add pdf template", "create pdf template", "add invoice template", "add quote template", "pdf widget", "generate pdf".
---

# scaffold-pdf-templates

Scaffolds everything needed for a community module (or sandbox module) to register and render its own PDF templates via `@open-mercato/pdf-generators`.

> **Reference implementation**: `packages/pdf-generators/examples/` — a fully working invoice example. Read it before generating files to verify current API shape. The `widgets/` subfolder in examples is a **read-only reference** showing how the widget pattern works — do NOT copy or scaffold it; the PDF tab is rendered automatically by the core sales module when templates are registered.

---

## How it works (conceptual map)

```
pdf-generators.ts          ← convention file picked up by `mercato generate registry`
└── DocumentService        ← extends BaseDocumentService, owns one category of templates
    ├── fetchData()        ← optional server-side hook: fetches related data via DI container
    ├── toTemplateData()   ← maps enriched record → flat typed data for the template
    └── registerTemplate() ← lazy-loads the React-PDF component

pdf-templates/
  services/
    {{MODULE_ID}}-{{CATEGORY}}-document-service.ts   ← the service class
  templates/
    {{CATEGORY}}/
      {{TEMPLATE_ID}}/
        index.tsx          ← React-PDF component (<Document><Page>…)
        types.ts           ← TypeScript data shape for the template
```

> **No widget needed.** The PDF tab for sales orders and quotes is rendered automatically by the core sales module. Registering a `DocumentService` with the correct `resourceKind` is sufficient for templates to appear in the tab.

---

## Inputs

| Variable | Format | Example |
|----------|--------|---------|
| `MODULE_ID` | snake_case | `example` |
| `MODULE_TITLE` | Title Case | `Example` |
| `RESOURCE_KIND` | framework resource kind | `sales.order` \| `sales.quote` |
| `MODULE_NAME` | top-level module | `sales` |
| `CATEGORY` | singular noun, kebab-case | `invoice` \| `quote` \| `shipment` |
| `TEMPLATE_ID` | kebab-case | `example-invoice` |
| `TEMPLATE_LABEL` | Title Case | `Example Invoice` |
| `RECORD_TYPE_NAME` | PascalCase | `OrderRecord` |

Ask the user for anything that is ambiguous before writing files.

> **`RESOURCE_KIND`** determines which PDF tab the templates appear in. Common values: `sales.order` (order detail), `sales.quote` (quote detail).

---

## Step 1 — Types file

**`pdf-templates/templates/{{CATEGORY}}/{{TEMPLATE_ID}}/types.ts`**

```ts
/**
 * Data shape expected by the {{TEMPLATE_LABEL}} PDF template.
 */
export interface {{PascalTemplateId}}Data {
  document: {
    number: string
    date: string
    dueDate?: string
  }
  seller: {
    name: string
    company: string
    email: string
  }
  client: {
    name: string
    company?: string
    email?: string
    address?: string
  }
  lines: Array<{
    title: string
    description?: string
    quantity: number
    unitPrice: number
    total: number
    currency: string
  }>
  totals: {
    subtotal: number
    tax: number
    total: number
    currency: string
  }
  notes?: string
}
```

**Why**: Keeping the data shape in a separate `types.ts` lets the service's `toTemplateData()` and the template component share the same type without circular imports.

---

## Step 2 — Template component

**`pdf-templates/templates/{{CATEGORY}}/{{TEMPLATE_ID}}/index.tsx`**

```tsx
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { OpenMercatoLogo } from '@open-mercato/pdf-generators'
import '@open-mercato/pdf-generators/modules/pdf_generators/templates/shared/theme'
import { colors } from '@open-mercato/pdf-generators/modules/pdf_generators/templates/shared/theme'
import type { {{PascalTemplateId}}Data } from './types'

const s = StyleSheet.create({
  page: { paddingHorizontal: 52, paddingVertical: 48, fontSize: 10, fontFamily: 'Inter', color: colors.text },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 },
  title: { fontSize: 28, fontWeight: 600 },
  // Add more styles as needed
})

export function {{PascalTemplateId}}Document({ data }: { data: {{PascalTemplateId}}Data }) {
  const cur = data.totals.currency
  const fmt = (n: number) => `${n.toFixed(2)} ${cur}`

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>{{TEMPLATE_LABEL}}</Text>
          <OpenMercatoLogo />
        </View>

        {/* Add sections: parties, line items, totals */}
      </Page>
    </Document>
  )
}
```

**Why**:
- `import '@open-mercato/pdf-generators/…/theme'` is a **side-effect import** — it registers the Inter font with `@react-pdf/renderer`. Without it, `fontFamily: 'Inter'` silently falls back to the default font.
- `colors` keeps the template visually consistent with the built-in Open Mercato templates.
- `OpenMercatoLogo` is a pre-built React-PDF component exported from the package.

---

## Step 3 — Document service

**`pdf-templates/services/{{MODULE_ID}}-{{CATEGORY}}-document-service.ts`**

```ts
import { BaseDocumentService, formatDate } from '@open-mercato/pdf-generators'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Minimal record passed from the widget context.
 * Only { id } is required — full data is fetched server-side via fetchData().
 */
interface {{RECORD_TYPE_NAME}} {
  id: string
}

/**
 * Document service for the {{MODULE_TITLE}} module.
 *
 * - `readonly id`           globally unique: `{{MODULE_ID}}-{{CATEGORY}}s`
 * - `readonly module`       top-level module name (e.g. 'sales') — used for grouping on backend page
 * - `readonly resourceKind` matches ctx.resourceKind in the widget (e.g. 'sales.order')
 *
 * Extend: call this.registerTemplate() in the constructor for each additional template.
 */
export class {{PascalModuleId}}{{PascalCategory}}DocumentService extends BaseDocumentService {
  readonly id = '{{MODULE_ID}}-{{CATEGORY}}s'
  readonly label = '{{MODULE_TITLE}} {{PascalCategory}}s'
  readonly module = '{{MODULE_NAME}}'
  readonly resourceKind = '{{RESOURCE_KIND}}'

  constructor() {
    super()

    this.registerTemplate({
      id: '{{TEMPLATE_ID}}',
      label: '{{TEMPLATE_LABEL}}',
      description: 'Short description of what this template produces.',
      documentType: '{{CATEGORY}}',
      tags: ['{{CATEGORY}}', '{{MODULE_ID}}'],
      note: 'Rendered in the PDF tab on the ... detail page.',
      load: () =>
        import('../templates/{{CATEGORY}}/{{TEMPLATE_ID}}').then(
          (m) => m.{{PascalTemplateId}}Document as unknown as React.ComponentType<{ data: Record<string, unknown> }>
        ),
    })
  }

  /**
   * Optional: fetch related data before normalization (e.g. line items not in widget context).
   * The widget only passes { id } — override this to load the full record from the database.
   *
   * Remove this method entirely if the widget context already contains all needed data.
   */
  override async fetchData({ data }: { data: unknown }, { container }: { container: AppContainer }): Promise<unknown> {
    const { id } = data as {{RECORD_TYPE_NAME}}

    // Fetch the full record from the database — the widget only passes { id }.
    // All data required by toTemplateData() must come from here.
    // const myService = container.resolve('myService')
    // return myService.retrieve(id)

    throw new Error(`fetchData not implemented — cannot render template without full data (id: ${id})`)
  }

  /**
   * Maps the enriched record (returned by fetchData) into the flat shape expected by templates.
   */
  toTemplateData({ data }: { data: unknown }): Record<string, unknown> {
    const r = data as {{RECORD_TYPE_NAME}}

    return {
      document: {
        number: String(r.id ?? ''),
        date: formatDate(new Date().toISOString()),
      },
      seller: { name: '', company: '', email: '' },
      client: { name: '' },
      lines: [],
      totals: { subtotal: 0, tax: 0, total: 0, currency: 'PLN' },
    }
  }
}
```

**Why**:
- `BaseDocumentService` provides `getEntries()` and `registerTemplate()`. Never reimplement these.
- `readonly module` + `readonly resourceKind` replace the old `moduleId` field. `module` is used for grouping on the backend page; `resourceKind` must match `ctx.resourceKind` from the framework (e.g. `'sales.order'`).
- `fetchData` is the server-side hook that loads all data needed for the template. The widget passes only `{ id }` — `fetchData` is responsible for fetching the full record. It always runs before `toTemplateData()`. Never pass template data through the widget context — always fetch server-side.
- `toTemplateData` replaces the old `normalizeRecord`. It receives the enriched data from `fetchData` and maps it to the template shape.
- `formatDate` is imported from `@open-mercato/pdf-generators` — it is **not** a method on `BaseDocumentService`.
- `load` must be a **function returning a dynamic import** — never a static import.

---

## Step 4 — Convention file

**`pdf-generators.ts`** (at module root, sibling of `index.ts`)

```ts
import { {{PascalModuleId}}{{PascalCategory}}DocumentService } from './pdf-templates/services/{{MODULE_ID}}-{{CATEGORY}}-document-service'

// Convention file — picked up by `mercato generate registry` to register external PDF templates.
const service = new {{PascalModuleId}}{{PascalCategory}}DocumentService()

export const templates = service.getEntries()
export default templates
```

**Why**: `mercato generate registry` scans every loaded module for a `pdf-generators.ts` export named `templates`. This is the **only** place auto-discovery reads from. The file must be at the module root (next to `acl.ts`, `setup.ts`, etc.).

---

## Step 5 — Verify

```bash
# Rebuild to pick up new files
yarn workspace @open-mercato/{{PACKAGE_NAME}} build   # or: yarn build (for app)

# Regenerate the module registry so pdf-generators.ts is picked up
yarn generate

# Start the sandbox
yarn dev
```

Then navigate to a record detail page (sales order, sales quote) and confirm:
1. The **PDF tab** appears in the tab bar.
2. The tab shows the template name from `registerTemplate({ label })`.
3. Clicking a template card opens the **preview dialog** with the rendered PDF.
4. Clicking **Download PDF** triggers `POST /generate` and downloads the file.

---

## File summary

| File | Purpose |
|------|---------|
| `pdf-generators.ts` | Auto-discovery entry point for `mercato generate registry` |
| `pdf-templates/services/…-document-service.ts` | Service: template registration, data fetching, normalization |
| `pdf-templates/templates/{{CATEGORY}}/{{TEMPLATE_ID}}/types.ts` | TypeScript data shape for the template |
| `pdf-templates/templates/{{CATEGORY}}/{{TEMPLATE_ID}}/index.tsx` | React-PDF template component |

---

## Critical rules

- The `theme` import (`@open-mercato/pdf-generators/…/shared/theme`) **must be a bare side-effect import** — it registers fonts. Do it once, at the top of the template `index.tsx`.
- `load` in `registerTemplate` must be a **function returning a dynamic import** — never a static import, or the whole template bundle loads eagerly.
- `id` in `BaseDocumentService` must be unique globally. Convention: `{{MODULE_ID}}-{{CATEGORY}}s`.
- `resourceKind` must match the resource kind used by the core sales module tab: `sales.order` for orders, `sales.quote` for quotes.
- `pdf-generators.ts` must export `templates` as a named export and a default export.
- Pass only `{ id: record.id }` to `TemplatesList record` prop — full data fetching belongs in `fetchData()` server-side.
- `POST /preview` (iframe) and `POST /generate` (download) are separate endpoints. Preview has zero side effects; generate triggers logging and events. Never conflate them.
- **Do NOT scaffold a widget or injection-table entry** — the PDF tab is rendered by the core module. The `packages/pdf-generators/examples/widgets/` folder is a reference-only example of what such a widget looks like; it should never be copied into a community module.
