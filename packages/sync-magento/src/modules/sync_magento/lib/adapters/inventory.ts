import type { DataMapping, DataSyncAdapter, ValidationResult } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { magentoHealthCheck } from '../health'

const PRODUCT_STOCK_ENTITY_TYPE = 'catalog.product_stock'

// Phase 4 sketch only (see SPEC-005). getMapping/validateConnection are wired so the
// Sync Schedule tab is functional; streamExport (MSI/legacy stock push, sourced from
// the stock_qty_<channelCode> custom-field convention) is a follow-up phase that
// needs its own addendum spec.
export async function getMapping(): Promise<DataMapping> {
  return {
    entityType: PRODUCT_STOCK_ENTITY_TYPE,
    matchStrategy: 'sku',
    matchField: 'sku',
    fields: [
      { externalField: 'sku', localField: 'sku', mappingKind: 'core', required: true, dedupeRole: 'primary' },
      { externalField: 'quantity', localField: 'stockQty', mappingKind: 'custom_field', required: true },
      { externalField: 'is_in_stock', localField: 'stockQty', mappingKind: 'relation', transform: 'stockQty > 0' },
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

export const magentoInventoryAdapter: DataSyncAdapter = {
  providerKey: 'magento_inventory',
  direction: 'export',
  supportedEntities: [PRODUCT_STOCK_ENTITY_TYPE],
  runMode: 'generic',
  operationalTelemetry: true,
  getMapping,
  validateConnection,
}
