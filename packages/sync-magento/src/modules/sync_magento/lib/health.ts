import { createMagentoClient } from './client'

export type MagentoStoreView = {
  code: string
  name: string
}

type MagentoStoreViewRaw = {
  code?: string | null
  name?: string | null
}

export function normalizeStoreViews(raw: unknown): MagentoStoreView[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is MagentoStoreViewRaw =>
      Boolean(entry) && typeof (entry as MagentoStoreViewRaw).code === 'string' && (entry as MagentoStoreViewRaw).code!.trim().length > 0)
    .map((entry) => ({
      code: String(entry.code).trim(),
      name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : String(entry.code).trim(),
    }))
}

// Field names mirror Magento's raw `GET /rest/V1/inventory/sources` response
// (`source_code`/`name`) per the documented `/api/sync-magento/validate` contract —
// `stockSource` settings store this exact `source_code` value.
export type MagentoStockSource = {
  source_code: string
  name: string
}

type MagentoStockSourceRaw = {
  source_code?: string | null
  name?: string | null
}

export function normalizeStockSources(raw: unknown): MagentoStockSource[] {
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown[] } | null)?.items) ? (raw as { items: unknown[] }).items : []
  return items
    .filter((entry): entry is MagentoStockSourceRaw =>
      Boolean(entry) && typeof (entry as MagentoStockSourceRaw).source_code === 'string' && (entry as MagentoStockSourceRaw).source_code!.trim().length > 0)
    .map((entry) => ({
      source_code: String(entry.source_code).trim(),
      name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : String(entry.source_code).trim(),
    }))
}

export const magentoHealthCheck = {
  async check(credentials: Record<string, unknown>) {
    try {
      const client = createMagentoClient(credentials)
      const raw = await client.get<unknown>('/store/storeViews')
      const storeViews = normalizeStoreViews(raw)
      return {
        status: 'healthy' as const,
        message: `Connected to Magento (${storeViews.length} store view${storeViews.length === 1 ? '' : 's'})`,
        details: { storeViews },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Magento error'
      return {
        status: 'unhealthy' as const,
        message: `Magento connection failed: ${message}`,
        details: { error: message },
      }
    }
  },
}
