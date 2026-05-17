---
name: code-commenting
description: Conventions for commenting TypeScript code in @open-mercato/* community modules. Use when writing or reviewing comments, JSDoc, or inline annotations. Triggers on "add comments", "document method", "jsdoc", "how to comment", "commenting conventions".
---

# Code Commenting Conventions

**Comment the WHY, never the WHAT.** If removing a comment wouldn't confuse a future reader, don't write it.

## When to comment

✅ Hidden constraint, non-obvious invariant, initialization order dependency, deliberately rejected decision, side-effect import.  
❌ Obvious code, task/issue references, restating the type signature.

## Inline comments

One line, sentence fragment, no trailing period. Never `/* ... */` for inline use.

```ts
// globalThis used — Next.js server and client share no module state
```

## JSDoc

Use on all exported symbols and public methods of exported classes.

**Classes** — multi-line, `@param` for constructor args:
```ts
/**
 * Registry for PDF templates
 *
 * @param id - Registry ID (default: "base")
 */
class TemplateRegistry { ... }
```

**Methods** — multi-line, include `@param`, `@returns`, `@throws` when they add clarity:
```ts
/**
 * Loads a template by ID.
 *
 * @param id - Template ID
 * @returns Loaded template with normalized data
 * @throws Error if template is not found
 */
async load(id: string, record: unknown): Promise<LoadedTemplate>
```

**Exported constants** — single line:
```ts
/** Singleton registry for PDF templates — use this to register, query, and load templates. */
export const templateRegistry = new TemplateRegistry()
```

**Exported interfaces** — JSDoc on the interface itself; inline comment on fields whose purpose is not obvious from the name or type:

```ts
/**
 * Entry in the template registry — defines how a template is loaded and how raw data is normalized.
 */
export interface TemplateRegistryEntry extends TemplateMeta {
  fromRecord: (record: unknown) => Record<string, unknown> // maps raw server record to template data shape
  load: () => Promise<React.ComponentType<{ data: Record<string, unknown> }>> // lazy-loaded React component
}
```

**API route handlers** (`GET`, `POST`, etc.) — multi-line JSDoc with `@param` for the request body shape and `@returns` for the response:

```ts
/**
 * Generates a PDF document for the given template and record.
 *
 * @param request - Request body: `{ template_id: TemplateId, record: unknown }`
 * @returns PDF binary stream or JSON error response
 */
export async function POST(request: Request) { ... }
```

**Internal classes** (not exported from `src/index.ts`) — no JSDoc needed.  
**File-level comments** — never.

## Side-effect imports

```ts
import '../config/registry' // registers built-in templates into templateRegistry
```

## TODOs

```ts
// TODO: move to async queue — renderToBuffer is synchronous and blocks for large docs
```

Format: `// TODO: <what> — <why>`. Only `TODO`, never `FIXME`/`HACK`/`NOTE`.
