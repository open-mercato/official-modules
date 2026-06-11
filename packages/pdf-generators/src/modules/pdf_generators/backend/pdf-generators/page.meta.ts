export const metadata = {
  requireAuth: true,
  requireFeatures: ['pdf_generators.view'],
  pageTitle: 'Available templates',
  pageTitleKey: 'pdf_generators.page.title',
  pageGroup: 'PDF Generators',
  pageGroupKey: 'pdf_generators.page.group',
  pageOrder: 900,
  breadcrumb: [
    { label: 'Available templates', labelKey: 'pdf_generators.page.title' },
  ],
} as const
export default metadata
