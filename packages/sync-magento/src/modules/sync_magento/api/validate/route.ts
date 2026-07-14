import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createMagentoClient } from '../../lib/client'
import { normalizeStockSources, normalizeStoreViews } from '../../lib/health'

export const metadata = {
  path: '/sync-magento/validate',
  POST: { requireAuth: true, requireFeatures: ['sync_magento.configure'] },
}

// Any integration sharing the `sync_magento` bundle resolves the same bundle-level credentials.
const REPRESENTATIVE_INTEGRATION_ID = 'sync_magento_products'

type CredentialsServiceLike = {
  resolve: (integrationId: string, scope: { tenantId: string; organizationId: string }) => Promise<Record<string, unknown> | null>
}

export async function POST(req: Request) {
  const { translate } = await resolveTranslations()
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) {
      throw new CrudHttpError(401, { error: translate('sync_magento.errors.unauthorized', 'Unauthorized') })
    }

    const orgScope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = orgScope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) {
      throw new CrudHttpError(400, {
        error: translate('sync_magento.errors.organization_required', 'Organization context is required'),
      })
    }

    const scope = { tenantId: auth.tenantId, organizationId }
    const credentialsService = container.resolve('integrationCredentialsService') as CredentialsServiceLike
    const credentials = await credentialsService.resolve(REPRESENTATIVE_INTEGRATION_ID, scope)
    if (!credentials || Object.keys(credentials).length === 0) {
      return NextResponse.json(
        { valid: false, storeViews: [], stockSources: [], message: translate('sync_magento.errors.no_credentials', 'No Magento credentials configured') },
        { status: 200 },
      )
    }

    let client
    try {
      client = createMagentoClient(credentials)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Magento credentials'
      return NextResponse.json({ valid: false, storeViews: [], stockSources: [], message }, { status: 200 })
    }

    let storeViews: ReturnType<typeof normalizeStoreViews> = []
    try {
      const rawStoreViews = await client.get<unknown>('/store/storeViews')
      storeViews = normalizeStoreViews(rawStoreViews)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Magento error'
      return NextResponse.json(
        { valid: false, storeViews: [], stockSources: [], message: `Magento connection failed: ${message}` },
        { status: 200 },
      )
    }

    // MSI is optional — Magento returns 404/501 when source management is unavailable (legacy stock mode).
    let stockSources: ReturnType<typeof normalizeStockSources> = []
    try {
      const rawStockSources = await client.get<unknown>('/inventory/sources', { query: { 'searchCriteria[pageSize]': 100 } })
      stockSources = normalizeStockSources(rawStockSources)
    } catch {
      stockSources = []
    }

    return NextResponse.json({ valid: true, storeViews, stockSources })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('sync_magento.validate failed', err)
    return NextResponse.json(
      { error: translate('sync_magento.errors.validate_failed', 'Failed to validate Magento connection') },
      { status: 400 },
    )
  }
}

const storeViewSchema = z.object({ code: z.string(), name: z.string() })
const stockSourceSchema = z.object({ source_code: z.string(), name: z.string() })

const validateResponseSchema = z.object({
  valid: z.boolean(),
  storeViews: z.array(storeViewSchema),
  stockSources: z.array(stockSourceSchema),
  message: z.string().optional(),
})

const validateErrorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Magento Sync',
  summary: 'Validate Magento connection',
  methods: {
    POST: {
      summary: 'Test the configured Magento connection',
      description: 'Calls `GET /rest/V1/store/storeViews` (and, if available, `/inventory/sources`) using the stored Integration Access Token credentials.',
      responses: [
        { status: 200, description: 'Validation result', schema: validateResponseSchema },
        { status: 401, description: 'Unauthorized', schema: validateErrorSchema },
        { status: 400, description: 'Organization context missing or validation failed', schema: validateErrorSchema },
      ],
    },
  },
}
