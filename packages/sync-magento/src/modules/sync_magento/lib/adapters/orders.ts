import type { DataMapping, DataSyncAdapter, ValidationResult } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { magentoHealthCheck } from '../health'

const SALES_ORDER_ENTITY_TYPE = 'sales.order'

// Phase 5 sketch only (see SPEC-005). getMapping/validateConnection are wired so the
// Sync Schedule tab is functional; streamImport (order/customer import via CommandBus)
// is a follow-up phase that needs its own addendum spec.
export async function getMapping(): Promise<DataMapping> {
  return {
    entityType: SALES_ORDER_ENTITY_TYPE,
    matchStrategy: 'externalId',
    matchField: 'entity_id',
    fields: [
      { externalField: 'entity_id', localField: 'externalReference', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
      { externalField: 'increment_id', localField: 'orderNumber', mappingKind: 'core', required: true },
      { externalField: 'order_currency_code', localField: 'currencyCode', mappingKind: 'core', required: true },
      { externalField: 'grand_total', localField: 'grandTotalGrossAmount', mappingKind: 'core' },
      { externalField: 'customer_email', localField: 'customer', mappingKind: 'relation' },
      { externalField: 'items', localField: 'lines', mappingKind: 'relation' },
    ],
  }
}

export async function validateConnection(input: { credentials: Record<string, unknown> }): Promise<ValidationResult> {
  const result = await magentoHealthCheck.check(input.credentials)
  if (result.status === 'healthy') {
    return { ok: true, message: result.message, details: result.details }
  }
  return { ok: false, message: result.message }
}

export const magentoOrdersAdapter: DataSyncAdapter = {
  providerKey: 'magento_orders',
  direction: 'import',
  supportedEntities: [SALES_ORDER_ENTITY_TYPE],
  runMode: 'generic',
  operationalTelemetry: true,
  getMapping,
  validateConnection,
}
