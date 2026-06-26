import type { DataMapping, DataSyncAdapter, ValidationResult } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { magentoHealthCheck } from '../health'

const PRODUCT_PRICE_ENTITY_TYPE = 'catalog.product_price'

// Phase 3 sketch only (see SPEC-005). getMapping/validateConnection are wired so the
// Sync Schedule tab is functional; streamExport (base/special/tier price push) is a
// follow-up phase that needs its own addendum spec.
export async function getMapping(): Promise<DataMapping> {
  return {
    entityType: PRODUCT_PRICE_ENTITY_TYPE,
    matchStrategy: 'sku',
    matchField: 'sku',
    fields: [
      { externalField: 'sku', localField: 'sku', mappingKind: 'core', required: true, dedupeRole: 'primary' },
      { externalField: 'price', localField: 'price', mappingKind: 'core', required: true },
      { externalField: 'special_price', localField: 'specialPrice', mappingKind: 'relation' },
      { externalField: 'special_from_date', localField: 'specialFrom', mappingKind: 'relation' },
      { externalField: 'special_to_date', localField: 'specialTo', mappingKind: 'relation' },
      { externalField: 'tier_prices', localField: 'tierPrices', mappingKind: 'relation' },
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

export const magentoPricesAdapter: DataSyncAdapter = {
  providerKey: 'magento_prices',
  direction: 'export',
  supportedEntities: [PRODUCT_PRICE_ENTITY_TYPE],
  runMode: 'generic',
  operationalTelemetry: true,
  getMapping,
  validateConnection,
}
