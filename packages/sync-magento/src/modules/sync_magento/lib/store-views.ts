import type { MagentoClient } from './client'

// Shape of GET /rest/V1/store/storeViews entries (Magento 2.4 REST API).
export type MagentoStoreView = {
  id: number
  code: string
  website_id: number
  store_group_id: number
}

// Resolves every configured Magento store view once per run and indexes it by
// `code`, since `MagentoSyncSettings.channelStoreMappings` only stores the store
// view's human-readable code (not Magento's internal numeric store_id/website_id
// that the bulk price endpoints require).
export async function fetchStoreViewsByCode(client: MagentoClient): Promise<Map<string, MagentoStoreView>> {
  const views = await client.get<MagentoStoreView[]>('/store/storeViews')
  return new Map(views.map((view) => [view.code, view]))
}

// The `price` product attribute's `scope` field mirrors Magento's system-wide
// "Catalog Price Scope" config (Stores > Configuration > Catalog > Catalog >
// Price), which also governs `special_price` and tier prices (none of these are
// independently configurable). When it's 'global', the bulk price endpoints
// reject any non-zero store_id/website_id with "Could not change non global
// Price when price scope is global" — callers must submit 0 instead of a
// channel's resolved store/website id in that case.
export async function isGlobalPriceScope(client: MagentoClient): Promise<boolean> {
  const attribute = await client.get<{ scope?: string }>('/products/attributes/price')
  return attribute.scope === 'global'
}
