export { metadata } from './modules/pdf_generators/index'

// Public API for external template authors
export { templateRegistry } from './modules/pdf_generators/lib/template-registry'
export type { TemplateEntry, TemplateRegistryEntry, TemplateMeta, TemplateFilter } from './modules/pdf_generators/lib/interfaces'
export { BaseDocumentService } from './modules/pdf_generators/services'
export type { DocumentTemplateEntry } from './modules/pdf_generators/services'
export { TemplatesList } from './modules/pdf_generators/components/TemplatesList'
export { formatDate } from './modules/pdf_generators/utils/formatDate'
// Shared PDF UI — import in external templates to get Inter font + brand components
export { colors as sharedColors, borders, spacing } from './modules/pdf_generators/templates/shared/theme'
export { OpenMercatoLogo } from './modules/pdf_generators/templates/shared/components/Logo'
