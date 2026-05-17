import { templateRegistry } from '../lib/template-registry'
import { QuotesDocumentService, QUOTES_TEMPLATE_IDS } from '../services'
import { OrdersDocumentService, ORDERS_TEMPLATE_IDS } from '../services'

const quotesService = new QuotesDocumentService()
const ordersService = new OrdersDocumentService()

templateRegistry.registerInternal([
  ...quotesService.getEntries(),
  ...ordersService.getEntries(),
])

/** All built-in template IDs — exported for TemplateId type derivation only, not intended for runtime use. */
export const REGISTRY = [...QUOTES_TEMPLATE_IDS, ...ORDERS_TEMPLATE_IDS] as const
