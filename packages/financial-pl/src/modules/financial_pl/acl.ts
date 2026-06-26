export const features = [
  { id: 'financial_pl.view', title: 'View KSeF submissions', module: 'financial_pl' },
  { id: 'financial_pl.submit', title: 'Submit invoices to KSeF', module: 'financial_pl', dependsOn: ['financial_pl.view'] },
  { id: 'financial_pl.manage', title: 'Manage KSeF configuration', module: 'financial_pl', dependsOn: ['financial_pl.view'] },
] as const

export default features
