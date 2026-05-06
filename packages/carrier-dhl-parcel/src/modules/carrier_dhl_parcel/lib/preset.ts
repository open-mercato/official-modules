import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { dhlErrors } from './errors'

const DHL_PARCEL_INTEGRATION_ID = 'carrier_dhl_parcel'

type DhlParcelCredentialShape = {
  userId: string
  apiKey: string
  accountNumber: string
  apiBaseUrl?: string
  senderCompanyName?: string
  senderFirstName?: string
  senderLastName?: string
  senderEmail?: string
  senderPhone?: string
}

type DhlParcelEnvPreset = {
  credentials: DhlParcelCredentialShape
  force: boolean
  enabled: boolean
}

export type ApplyDhlParcelPresetResult =
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

export function readDhlParcelEnvPreset(env: NodeJS.ProcessEnv = process.env): DhlParcelEnvPreset | null {
  const requiredKeys = {
    userId: ['OM_INTEGRATION_DHL_PARCEL_USER_ID'],
    apiKey: ['OM_INTEGRATION_DHL_PARCEL_API_KEY'],
    accountNumber: ['OM_INTEGRATION_DHL_PARCEL_ACCOUNT_NUMBER'],
  } as const

  const anyRequired = [requiredKeys.userId, requiredKeys.apiKey, requiredKeys.accountNumber].some(
    (keys) => Boolean(readEnvValue(env, [...keys])),
  )

  if (!anyRequired) {
    return null
  }

  const userId = readEnvValue(env, [...requiredKeys.userId])
  const apiKey = readEnvValue(env, [...requiredKeys.apiKey])
  const accountNumber = readEnvValue(env, [...requiredKeys.accountNumber])

  if (!userId || !apiKey || !accountNumber) {
    throw dhlErrors.incompleteEnvPreset()
  }

  const apiBaseUrl = readEnvValue(env, ['OM_INTEGRATION_DHL_PARCEL_API_BASE_URL'])
  const senderCompanyName = readEnvValue(env, ['OM_INTEGRATION_DHL_PARCEL_SENDER_COMPANY_NAME'])
  const senderFirstName = readEnvValue(env, ['OM_INTEGRATION_DHL_PARCEL_SENDER_FIRST_NAME'])
  const senderLastName = readEnvValue(env, ['OM_INTEGRATION_DHL_PARCEL_SENDER_LAST_NAME'])
  const senderEmail = readEnvValue(env, ['OM_INTEGRATION_DHL_PARCEL_SENDER_EMAIL'])
  const senderPhone = readEnvValue(env, ['OM_INTEGRATION_DHL_PARCEL_SENDER_PHONE'])

  return {
    credentials: {
      userId,
      apiKey,
      accountNumber,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(senderCompanyName ? { senderCompanyName } : {}),
      ...(senderFirstName ? { senderFirstName } : {}),
      ...(senderLastName ? { senderLastName } : {}),
      ...(senderEmail ? { senderEmail } : {}),
      ...(senderPhone ? { senderPhone } : {}),
    },
    force: readBooleanEnv(env, ['OM_INTEGRATION_DHL_PARCEL_FORCE_PRECONFIGURE']) ?? false,
    enabled: readBooleanEnv(env, ['OM_INTEGRATION_DHL_PARCEL_ENABLED']) ?? true,
  }
}

async function hasExistingDhlParcelConfiguration(
  credentialsService: CredentialsService,
  integrationStateService: IntegrationStateService,
  scope: IntegrationScope,
): Promise<boolean> {
  const [credentials, state] = await Promise.all([
    credentialsService.getRaw(DHL_PARCEL_INTEGRATION_ID, scope),
    integrationStateService.get(DHL_PARCEL_INTEGRATION_ID, scope),
  ])
  return Boolean(credentials) || Boolean(state)
}

export async function applyDhlParcelEnvPreset(params: {
  credentialsService: CredentialsService
  integrationStateService: IntegrationStateService
  integrationLogService?: IntegrationLogService
  scope: IntegrationScope
  force?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<ApplyDhlParcelPresetResult> {
  const preset = readDhlParcelEnvPreset(params.env)
  if (!preset) {
    return { status: 'skipped', reason: 'No DHL Parcel preset env variables were provided.' }
  }

  const force = params.force ?? preset.force
  if (
    !force &&
    (await hasExistingDhlParcelConfiguration(
      params.credentialsService,
      params.integrationStateService,
      params.scope,
    ))
  ) {
    return {
      status: 'skipped',
      reason: 'DHL Parcel credentials or state already exist. Use force to overwrite them.',
    }
  }

  await params.credentialsService.save(DHL_PARCEL_INTEGRATION_ID, preset.credentials, params.scope)
  await params.integrationStateService.upsert(
    DHL_PARCEL_INTEGRATION_ID,
    { isEnabled: preset.enabled },
    params.scope,
  )

  if (params.integrationLogService) {
    await params.integrationLogService
      .scoped(DHL_PARCEL_INTEGRATION_ID, params.scope)
      .info('DHL Parcel integration was preconfigured from environment variables.', {
        enabled: preset.enabled,
      })
  }

  return { status: 'configured', enabled: preset.enabled }
}
