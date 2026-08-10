---
"@open-mercato/pdf-generators": minor
---

Introduce `PdfRenderingService` as the focused React-PDF rendering boundary and return format-neutral `RenderedDocument` results carrying output metadata and canonical template/resource identity.

Template sources are now discriminated: external template entries must return `{ type: 'react-pdf', component }` from `load()` instead of returning the React component directly. Generation rejects client resource metadata that does not match the server-resolved document resource.
