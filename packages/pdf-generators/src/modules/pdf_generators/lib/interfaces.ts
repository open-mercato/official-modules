import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'

/** UI-facing metadata for a PDF template — used in listings and filtering. */
export interface TemplateMeta {
  id: string
  label: string
  description: string
  module: string          // top-level module — e.g. 'sales'
  resourceKind: string    // framework resource kind — e.g. 'sales.quote' | 'sales.order'
  documentType: string    // document kind — e.g. 'offer' | 'invoice' | 'contract'
  tags: string[]
  note?: string           // free-text note — e.g. where the template is used or registered
}

/** Runtime handlers for a PDF template — normalization, lazy loading, and optional server-side data fetching. */
export interface TemplateRegistryEntry {
  fromRecord: (data: unknown) => Record<string, unknown> // maps enriched server data to the flat shape expected by the template component
  filename: (input: { data: Record<string, unknown> }) => string // derives the PDF filename from normalized data
  load: () => Promise<React.ComponentType<{ data: Record<string, unknown> }>> // lazy-loaded React-PDF component
  fetchData?: (input: { data: unknown }, ctx: { container: AppContainer; auth: AuthContext | null }) => Promise<unknown> // server-side hook; called before normalization to fetch related data
}

/** Full template descriptor — UI metadata combined with runtime handlers. */
export type TemplateEntry = TemplateMeta & TemplateRegistryEntry

/** Filter criteria for querying templates from the registry. */
export interface TemplateFilter {
  resourceKind?: string
  documentType?: string
  tags?: string[]
}

/** Resolved template ready for rendering — component is loaded, data is normalized. */
export interface LoadedTemplate {
  component: React.ComponentType<{ data: Record<string, unknown> }>
  data: Record<string, unknown>
  filename: string
}

/** Contract for the template registry — extracted for testability. */
export interface TemplateRegistry {
  registerInternal(entries: TemplateEntry[]): void
  registerExternal(entries: TemplateEntry[]): void
  listTemplates(): { internal: TemplateMeta[]; external: TemplateMeta[] }
  load(input: { id: string; data: unknown }, ctx: { container: AppContainer; auth: AuthContext | null }): Promise<LoadedTemplate>
}
