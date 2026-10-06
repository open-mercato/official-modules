import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { TREG_INTEGRATION_ID } from './constants'

type TregEnvPreset = {
  credentials: Record<string, string>
  enabled: boolean
  force: boolean
}

export type ApplyTregPresetResult =
  | { status: 'skipped'; reason: string }
  | { status: 'configured'; enabled: boolean }

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

export function readTregEnvPreset(env: NodeJS.ProcessEnv = process.env): TregEnvPreset | null {
  const apiToken = readEnv(env, 'OM_INTEGRATION_TREG_API_TOKEN')
  if (!apiToken) return null
  const credentials: Record<string, string> = { apiToken }
  const orgSlug = readEnv(env, 'OM_INTEGRATION_TREG_ORG_SLUG')
  const maxCost = readEnv(env, 'OM_INTEGRATION_TREG_MAX_COST_PER_CALL_USD')
  const baseUrl = readEnv(env, 'OM_INTEGRATION_TREG_API_BASE_URL')
  if (orgSlug) credentials.orgSlug = orgSlug
  if (maxCost) credentials.maxCostPerCallUsd = maxCost
  if (baseUrl) credentials.apiBaseUrl = baseUrl
  return {
    credentials,
    enabled: parseBooleanToken(env.OM_INTEGRATION_TREG_ENABLED) ?? true,
    force: parseBooleanToken(env.OM_INTEGRATION_TREG_FORCE_PRECONFIGURE) ?? false,
  }
}

export async function applyTregEnvPreset(params: {
  credentialsService: CredentialsService
  integrationStateService: IntegrationStateService
  scope: IntegrationScope
  force?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<ApplyTregPresetResult> {
  const preset = readTregEnvPreset(params.env)
  if (!preset) return { status: 'skipped', reason: 'OM_INTEGRATION_TREG_API_TOKEN is not set.' }

  const force = params.force ?? preset.force
  if (!force) {
    const [credentials, state] = await Promise.all([
      params.credentialsService.getRaw(TREG_INTEGRATION_ID, params.scope),
      params.integrationStateService.get(TREG_INTEGRATION_ID, params.scope),
    ])
    if (credentials || state) {
      return { status: 'skipped', reason: 'treg credentials or state already exist. Use force to overwrite them.' }
    }
  }

  await params.credentialsService.save(TREG_INTEGRATION_ID, preset.credentials, params.scope)
  await params.integrationStateService.upsert(TREG_INTEGRATION_ID, { isEnabled: preset.enabled }, params.scope)
  return { status: 'configured', enabled: preset.enabled }
}
