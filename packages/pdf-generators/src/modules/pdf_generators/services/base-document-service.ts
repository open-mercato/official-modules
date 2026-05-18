import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { TemplateEntry } from '../lib/interfaces'

/**
 * Registration shape for a single template within a document service.
 * Does not include resourceKind or fromRecord — those are supplied by the service itself.
 */
export interface DocumentTemplateEntry {
  id: string
  label: string
  description: string
  documentType: string
  tags: string[]
  note?: string
  load: () => Promise<React.ComponentType<{ data: Record<string, unknown> }>>
}

/**
 * Base class for document services.
 *
 * Each concrete service owns a set of related templates and the normalization
 * logic for converting raw widget records into the data shape those templates expect.
 * Extend this class once per module (e.g. QuotesDocumentService, OrdersDocumentService).
 */
export abstract class BaseDocumentService {
  abstract readonly id: string
  abstract readonly label: string
  /** Top-level module name — e.g. 'sales'. Used for grouping on the backend page. */
  abstract readonly module: string
  /** Framework resource kind — matches ctx.resourceKind in widgets. E.g. 'sales.quote'. */
  abstract readonly resourceKind: string

  protected templates_: Map<string, DocumentTemplateEntry> = new Map()

  /**
   * Normalizes a raw server record into the flat data shape expected by this service's templates.
   *
   * @param record - Raw record from the widget context (already enriched if fetchData is defined)
   * @returns Normalized data object passed to the template component
   */
  abstract toTemplateData(input: { data: unknown }): Record<string, unknown>

  /**
   * Returns the filename for the generated PDF.
   * Override in concrete services to include document-specific identifiers (e.g. order number).
   *
   * @param data - Normalized data returned by toTemplateData
   */
  filename(_input: { data: Record<string, unknown> }): string {
    return 'document.pdf'
  }

  /**
   * Optional hook to fetch related data before normalization.
   * Called server-side in the generate route with the request-scoped DI container.
   * Override in concrete services that need data not available in the widget context (e.g. line items).
   *
   * @param record - Raw record from the widget context
   * @param container - Request-scoped Awilix DI container
   * @returns Enriched record with related data attached
   */
  async fetchData(input: { data: unknown }, _ctx: { container: AppContainer }): Promise<unknown> {
    return input.data
  }

  /**
   * Registers a template with this service.
   *
   * @param entry - Template definition without resourceKind and fromRecord
   */
  registerTemplate(entry: DocumentTemplateEntry): void {
    this.templates_.set(entry.id, entry)
  }

  /**
   * Returns all templates registered with this service as TemplateEntry objects,
   * with resourceKind and fromRecord bound to this service instance.
   *
   * @returns Array of registry entries ready to be passed to templateRegistry
   */
  getEntries(): TemplateEntry[] {
    return Array.from(this.templates_.values()).map((template) => ({
      id: template.id,
      label: template.label,
      description: template.description,
      module: this.module,
      resourceKind: this.resourceKind,
      documentType: template.documentType,
      tags: template.tags,
      note: template.note,
      fromRecord: (data: unknown) => this.toTemplateData({ data }),
      filename: (input: { data: Record<string, unknown> }) => this.filename(input),
      fetchData: (input: { data: unknown }, ctx: { container: AppContainer }) => this.fetchData(input, ctx),
      load: template.load,
    }))
  }
}
