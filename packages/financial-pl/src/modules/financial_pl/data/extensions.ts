import type { EntityExtension } from '@open-mercato/shared/modules/entities'

/**
 * Cross-module links. financial_pl extends `sales.SalesInvoice` additively with
 * Polish statutory metadata and KSeF submission tracking — by FK-id only, never
 * a direct ORM relation (§4/§21). The `sales` module knows nothing about these.
 */
const entityExtensions: EntityExtension[] = [
  {
    base: 'sales:sales_invoice',
    extension: 'financial_pl:sales_invoice_pl_meta',
    join: { baseKey: 'id', extensionKey: 'sales_invoice_id' },
    cardinality: 'one-to-one',
    description: 'Polish statutory metadata (KSeF status/number, MPP, VAT exemption basis) for a sales invoice',
  },
  {
    base: 'sales:sales_invoice',
    extension: 'financial_pl:ksef_submission',
    join: { baseKey: 'id', extensionKey: 'sales_invoice_id' },
    cardinality: 'one-to-many',
    description: 'KSeF submission attempts for a sales invoice',
  },
]

export const extensions = entityExtensions
export default entityExtensions
