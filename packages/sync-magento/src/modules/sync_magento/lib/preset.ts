import type { EntityManager } from '@mikro-orm/postgresql'
import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MagentoSyncSettings } from '../data/entities'

const MAGENTO_BUNDLE_ID = 'sync_magento'
const MAGENTO_INTEGRATION_IDS = [
  'sync_magento_products',
  'sync_magento_prices',
  'sync_magento_inventory',
  'sync_magento_orders',
] as const

type MagentoCredentialShape = {
  baseUrl: string
  accessToken: string
}

type MagentoEnvPreset = {
  credentials: MagentoCredentialShape
  defaultOrderChannelId?: string
  stockSource?: string
  force: boolean
  enabled: boolean
}

export type ApplyMagentoPresetResult =
  | { status: 'skipped'; reason: string }
  | { status: 'configured'; enabled: boolean }

function readEnvValue(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function readBooleanEnv(env: NodeJS.ProcessEnv, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const parsed = parseBooleanToken(env[key])
    if (parsed !== null) return parsed
  }
  return undefined
}

export function readMagentoEnvPreset(env: NodeJS.ProcessEnv = process.env): MagentoEnvPreset | null {
  const baseUrl = readEnvValue(env, ['OM_INTEGRATION_MAGENTO_BASE_URL'])
  const accessToken = readEnvValue(env, ['OM_INTEGRATION_MAGENTO_ACCESS_TOKEN'])

  if (!baseUrl && !accessToken) return null
  if (!baseUrl || !accessToken) {
    throw new Error(
      '[internal] Incomplete Magento env preset: OM_INTEGRATION_MAGENTO_BASE_URL and OM_INTEGRATION_MAGENTO_ACCESS_TOKEN must both be set.',
    )
  }

  const defaultOrderChannelId = readEnvValue(env, ['OM_INTEGRATION_MAGENTO_DEFAULT_CHANNEL_ID'])
  const stockSource = readEnvValue(env, ['OM_INTEGRATION_MAGENTO_STOCK_SOURCE'])

  return {
    credentials: { baseUrl, accessToken },
    ...(defaultOrderChannelId ? { defaultOrderChannelId } : {}),
    ...(stockSource ? { stockSource } : {}),
    force: readBooleanEnv(env, ['OM_INTEGRATION_MAGENTO_FORCE_PRECONFIGURE']) ?? false,
    enabled: readBooleanEnv(env, ['OM_INTEGRATION_MAGENTO_ENABLED']) ?? true,
  }
}

async function hasExistingMagentoConfiguration(
  credentialsService: CredentialsService,
  integrationStateService: IntegrationStateService,
  scope: IntegrationScope,
): Promise<boolean> {
  const [credentials, ...states] = await Promise.all([
    credentialsService.getRaw(MAGENTO_BUNDLE_ID, scope),
    ...MAGENTO_INTEGRATION_IDS.map((integrationId) => integrationStateService.get(integrationId, scope)),
  ])

  return Boolean(credentials) || states.some(Boolean)
}

async function applySettingsPreset(em: EntityManager, preset: MagentoEnvPreset, scope: IntegrationScope): Promise<void> {
  if (!preset.defaultOrderChannelId && !preset.stockSource) return

  const existing = await findOneWithDecryption(
    em,
    MagentoSyncSettings,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )

  const channelStockMappings = preset.defaultOrderChannelId && preset.stockSource
    ? [{ channelId: preset.defaultOrderChannelId, stockSource: preset.stockSource }]
    : null

  if (existing) {
    if (preset.defaultOrderChannelId) existing.defaultOrderChannelId = preset.defaultOrderChannelId
    if (channelStockMappings && !existing.channelStockMappings?.length) existing.channelStockMappings = channelStockMappings
    existing.updatedAt = new Date()
  } else {
    em.create(MagentoSyncSettings, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      defaultOrderChannelId: preset.defaultOrderChannelId ?? null,
      channelStockMappings: channelStockMappings ?? null,
    })
  }

  await em.flush()
}

export async function applyMagentoEnvPreset(params: {
  em: EntityManager
  credentialsService: CredentialsService
  integrationStateService: IntegrationStateService
  integrationLogService?: IntegrationLogService
  scope: IntegrationScope
  force?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<ApplyMagentoPresetResult> {
  const preset = readMagentoEnvPreset(params.env)
  if (!preset) {
    return { status: 'skipped', reason: 'No Magento preset env variables were provided.' }
  }

  const force = params.force ?? preset.force
  if (!force && await hasExistingMagentoConfiguration(params.credentialsService, params.integrationStateService, params.scope)) {
    return { status: 'skipped', reason: 'Magento credentials or integration state already exist. Use force to overwrite them.' }
  }

  await params.credentialsService.save(MAGENTO_BUNDLE_ID, preset.credentials, params.scope)
  await Promise.all(
    MAGENTO_INTEGRATION_IDS.map((integrationId) =>
      params.integrationStateService.upsert(integrationId, { isEnabled: preset.enabled }, params.scope)),
  )
  await applySettingsPreset(params.em, preset, params.scope)

  if (params.integrationLogService) {
    // IntegrationLog rows are queried per integration id (each of the 4 Magento
    // integrations has its own detail-page log tab) — `MAGENTO_BUNDLE_ID` isn't a
    // registered integration id, so logging under it would never surface on any
    // page. Log under the bundle's primary/first-declared integration instead.
    await params.integrationLogService.scoped(MAGENTO_INTEGRATION_IDS[0], params.scope).info(
      'Magento integration was preconfigured from environment variables.',
      { enabled: preset.enabled },
    )
  }

  return { status: 'configured', enabled: preset.enabled }
}
