# Contributing

## Local setup

The package is developed inside the `offical-modules` monorepo. The sandbox app (`apps/sandbox`) is used to verify changes end-to-end.

```bash
# from the monorepo root

# build the package in watch mode
yarn workspace @open-mercato/pdf-generators watch

# in a separate terminal — start the sandbox
cd apps/sandbox && yarn dev
```

After making changes, navigate to a sales order or quote in the sandbox to verify templates render correctly.

---

## Reference implementation

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

---

## Package structure

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

---

## How to add a new built-in template

1. Create a new service in `src/modules/pdf_generators/services/` extending `BaseDocumentService`
2. Create the React-PDF component under `src/modules/pdf_generators/templates/<resource>/<name>/`
3. Register the service in `src/modules/pdf_generators/config/registry.ts`
4. Add an example to `examples/` following the existing invoice layout
5. Verify in sandbox — navigate to the relevant detail page and confirm the template appears and renders correctly
