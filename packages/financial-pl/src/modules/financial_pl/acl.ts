export const features = [
  { id: 'financial_pl.view', title: 'View KSeF submissions', module: 'financial_pl' },
  { id: 'financial_pl.submit', title: 'Submit invoices to KSeF', module: 'financial_pl', dependsOn: ['financial_pl.view'] },
  { id: 'financial_pl.manage', title: 'Manage KSeF configuration', module: 'financial_pl', dependsOn: ['financial_pl.view'] },
  // Gates creating/editing invoices when the organization opts into invoice-write restriction
  // (QA #35). Admins hold it via the `financial_pl.*` wildcard; it is NOT granted to employees by
  // default, so enabling the restriction locks invoice writes down to explicitly-granted roles.
  { id: 'financial_pl.invoices.manage', title: 'Create and edit invoices', module: 'financial_pl', dependsOn: ['financial_pl.view'] },
] as const

export default features
