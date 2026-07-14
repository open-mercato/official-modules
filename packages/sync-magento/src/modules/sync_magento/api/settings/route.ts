import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { MagentoSyncSettings } from '../../data/entities'
import { syncSettingsSchema } from '../../data/validators'

export const metadata = {
  path: '/sync-magento/settings',
  GET: { requireAuth: true, requireFeatures: ['sync_magento.configure'] },
  PUT: { requireAuth: true, requireFeatures: ['sync_magento.configure'] },
}

const RESOURCE_KIND = 'sync_magento.settings'

type SettingsScope = {
  container: AwilixContainer
  em: EntityManager
  tenantId: string
  organizationId: string
  userId: string
}

async function resolveScope(req: Request): Promise<SettingsScope> {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  const { translate } = await resolveTranslations()
  if (!auth || !auth.tenantId) {
    throw new CrudHttpError(401, { error: translate('sync_magento.errors.unauthorized', 'Unauthorized') })
  }

  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const organizationId = scope?.selectedId ?? auth.orgId ?? null
  if (!organizationId) {
    throw new CrudHttpError(400, {
      error: translate('sync_magento.errors.organization_required', 'Organization context is required'),
    })
  }

  return {
    container,
    em: container.resolve('em') as EntityManager,
    tenantId: auth.tenantId,
    organizationId,
    userId: auth.sub,
  }
}

async function loadSettings(em: EntityManager, scope: { tenantId: string; organizationId: string }) {
  return findOneWithDecryption(
    em,
    MagentoSyncSettings,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
}

function serializeSettings(record: MagentoSyncSettings | null) {
  return {
    channelStockMappings: record?.channelStockMappings ?? null,
    channelStoreMappings: record?.channelStoreMappings ?? null,
    orderImportStatuses: record?.orderImportStatuses ?? null,
    defaultOrderChannelId: record?.defaultOrderChannelId ?? null,
    customerStrategy: record?.customerStrategy ?? 'create_or_link',
    attributeSetPrefix: record?.attributeSetPrefix ?? 'om',
    attributeCodeOverrides: record?.attributeCodeOverrides ?? null,
    imageSyncEnabled: record?.imageSyncEnabled ?? true,
    productExportConcurrency: record?.productExportConcurrency ?? 3,
    imageUploadConcurrency: record?.imageUploadConcurrency ?? 5,
    imageMaxDimension: record?.imageMaxDimension ?? 2000,
    updatedAt: record?.updatedAt ? record.updatedAt.toISOString() : null,
  }
}

export async function GET(req: Request) {
  try {
    const { em, tenantId, organizationId } = await resolveScope(req)
    const record = await loadSettings(em, { tenantId, organizationId })
    return NextResponse.json(serializeSettings(record))
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    const { translate } = await resolveTranslations()
    console.error('sync_magento.settings.get failed', err)
    return NextResponse.json(
      { error: translate('sync_magento.errors.lookup_failed', 'Failed to load Magento sync settings') },
      { status: 400 },
    )
  }
}

export async function PUT(req: Request) {
  try {
    const { container, em, tenantId, organizationId, userId } = await resolveScope(req)
    const { translate } = await resolveTranslations()

    const payload = await readJsonSafe(req, {})
    const parsed = syncSettingsSchema.safeParse(payload)
    if (!parsed.success) {
      return NextResponse.json(
        { error: translate('sync_magento.errors.invalid_payload', 'Invalid payload'), details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const input = parsed.data

    let record = await loadSettings(em, { tenantId, organizationId })
    const operation = record ? 'update' as const : 'create' as const

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId,
      organizationId,
      userId,
      resourceKind: RESOURCE_KIND,
      resourceId: organizationId,
      operation,
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: input,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    if (record) {
      try {
        enforceCommandOptimisticLock({
          resourceKind: RESOURCE_KIND,
          resourceId: record.id,
          current: record.updatedAt ?? null,
          request: req,
        })
      } catch (err) {
        if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
        throw err
      }

      record.channelStockMappings = input.channelStockMappings ?? record.channelStockMappings ?? null
      record.channelStoreMappings = input.channelStoreMappings ?? record.channelStoreMappings ?? null
      record.orderImportStatuses = input.orderImportStatuses ?? record.orderImportStatuses ?? null
      record.defaultOrderChannelId = input.defaultOrderChannelId ?? record.defaultOrderChannelId ?? null
      record.customerStrategy = input.customerStrategy ?? record.customerStrategy
      record.attributeSetPrefix = input.attributeSetPrefix ?? record.attributeSetPrefix
      record.attributeCodeOverrides = input.attributeCodeOverrides ?? record.attributeCodeOverrides ?? null
      record.imageSyncEnabled = input.imageSyncEnabled ?? record.imageSyncEnabled
      record.productExportConcurrency = input.productExportConcurrency ?? record.productExportConcurrency
      record.imageUploadConcurrency = input.imageUploadConcurrency ?? record.imageUploadConcurrency
      record.imageMaxDimension = input.imageMaxDimension ?? record.imageMaxDimension
      record.updatedAt = new Date()
    } else {
      record = em.create(MagentoSyncSettings, {
        tenantId,
        organizationId,
        channelStockMappings: input.channelStockMappings ?? null,
        channelStoreMappings: input.channelStoreMappings ?? null,
        orderImportStatuses: input.orderImportStatuses ?? null,
        defaultOrderChannelId: input.defaultOrderChannelId ?? null,
        customerStrategy: input.customerStrategy ?? 'create_or_link',
        attributeSetPrefix: input.attributeSetPrefix ?? 'om',
        attributeCodeOverrides: input.attributeCodeOverrides ?? null,
        imageSyncEnabled: input.imageSyncEnabled ?? true,
        productExportConcurrency: input.productExportConcurrency ?? 3,
        imageUploadConcurrency: input.imageUploadConcurrency ?? 5,
        imageMaxDimension: input.imageMaxDimension ?? 2000,
      })
      em.persist(record)
    }

    await em.flush()

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId,
        organizationId,
        userId,
        resourceKind: RESOURCE_KIND,
        resourceId: record.id,
        operation,
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json(serializeSettings(record))
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    const { translate } = await resolveTranslations()
    console.error('sync_magento.settings.put failed', err)
    return NextResponse.json(
      { error: translate('sync_magento.errors.save_failed', 'Failed to save Magento sync settings') },
      { status: 400 },
    )
  }
}

const channelStockMappingResponseSchema = z.object({ channelId: z.string(), stockSource: z.string() })
const channelStoreMappingResponseSchema = z.object({ channelId: z.string(), storeViewCode: z.string(), currencyCode: z.string() })
const attributeCodeOverrideResponseSchema = z.object({ omFieldName: z.string(), magentoAttributeCode: z.string() })

const settingsResponseSchema = z.object({
  channelStockMappings: z.array(channelStockMappingResponseSchema).nullable(),
  channelStoreMappings: z.array(channelStoreMappingResponseSchema).nullable(),
  orderImportStatuses: z.array(z.string()).nullable(),
  defaultOrderChannelId: z.string().nullable(),
  customerStrategy: z.enum(['create_or_link', 'create_only', 'skip']),
  attributeSetPrefix: z.string(),
  attributeCodeOverrides: z.array(attributeCodeOverrideResponseSchema).nullable(),
  imageSyncEnabled: z.boolean(),
  productExportConcurrency: z.number(),
  imageUploadConcurrency: z.number(),
  imageMaxDimension: z.number(),
  updatedAt: z.string().nullable(),
})

const settingsErrorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Magento Sync',
  summary: 'Magento sync settings',
  methods: {
    GET: {
      summary: 'Get Magento sync settings',
      description: 'Returns the current Magento sync configuration for the active organization.',
      responses: [
        { status: 200, description: 'Current settings', schema: settingsResponseSchema },
        { status: 401, description: 'Unauthorized', schema: settingsErrorSchema },
        { status: 400, description: 'Organization context missing', schema: settingsErrorSchema },
      ],
    },
    PUT: {
      summary: 'Update Magento sync settings',
      description: 'Creates or updates the Magento sync configuration for the active organization.',
      requestBody: { contentType: 'application/json', schema: syncSettingsSchema },
      responses: [
        { status: 200, description: 'Updated settings', schema: settingsResponseSchema },
        { status: 400, description: 'Invalid payload', schema: settingsErrorSchema },
        { status: 401, description: 'Unauthorized', schema: settingsErrorSchema },
        { status: 409, description: 'Optimistic lock conflict', schema: settingsErrorSchema },
      ],
    },
  },
}
