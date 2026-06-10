# pdf-generators — examples

Working reference implementation showing how to add custom PDF templates to your `@open-mercato/*` module.

Copy the structure below into your own module and adjust names, data shapes, and template layout.

## File layout

```
your-module/
  pdf-generators.ts                          ← convention file, picked up by `mercato generate registry`
  pdf-templates/
    services/
      my-module-invoices-document-service.ts ← extends BaseDocumentService
    templates/
      invoice/
        my-invoice/
          types.ts                           ← data shape for the template
          index.tsx                          ← React-PDF component
  widgets/                                   ← optional — only needed for custom slots (see step 6)
    injection/
      order-pdf-tab/
        widget.ts                            ← InjectionWidgetModule descriptor
        widget.client.tsx                    ← renders <TemplatesList>
    injection-table.ts                       ← declares which slot gets the widget
```

## Quick-start checklist

1. Copy `invoice/` → rename to your category (`quote/`, `shipment/`, etc.)
2. Rename `ExampleInvoice*` → your own prefix
3. Edit `types.ts` to match the data available in your widget context (`context.record`)
4. Implement `normalizeRecord()` in the service to map `context.record` → your types
5. Design the template layout in `index.tsx`
6. *(Optional)* If you want to embed the PDF tab in a **custom slot** (any resource other than sales orders or quotes — those are already covered by the built-in `pdf-generators` widgets), copy `widgets/` and update the slot key in `injection-table.ts`. Adding a widget for `sales.document.detail.order:tabs` or `sales.document.detail.quote:tabs` would produce duplicate tabs.
7. Run `yarn generate` to pick up the new `pdf-generators.ts` entry

See [scaffold-pdf-templates skill](../../.claude/skills/scaffold-pdf-templates/SKILL.md) to generate this structure automatically.
