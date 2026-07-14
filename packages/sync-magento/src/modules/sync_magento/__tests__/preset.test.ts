import Chance from 'chance'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'

const chance = new Chance()

const findOneWithDecryption = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryption(...args),
}))

class MagentoSyncSettingsStub {}

jest.mock('../data/entities', () => ({
  MagentoSyncSettings: MagentoSyncSettingsStub,
}))

import { readMagentoEnvPreset, applyMagentoEnvPreset } from '../lib/preset'
import type { ApplyMagentoPresetResult } from '../lib/preset'

const makeServices = (hasExisting = false) => {
  const credentialsService = {
    getRaw: jest.fn().mockResolvedValue(hasExisting ? { baseUrl: chance.url(), accessToken: chance.guid() } : null),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as CredentialsService
  const integrationStateService = {
    get: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationStateService
  const integrationLogService = {
    scoped: jest.fn().mockReturnValue({
      info: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as IntegrationLogService
  return { credentialsService, integrationStateService, integrationLogService }
}

const makeEm = () => ({
  create: jest.fn(),
  flush: jest.fn().mockResolvedValue(undefined),
})

function makeScope() {
  return { tenantId: chance.guid(), organizationId: chance.guid() }
}

describe('readMagentoEnvPreset', () => {
  it('returns null when no env vars are set', () => {
    expect(readMagentoEnvPreset({})).toBeNull()
  })

  it('throws when only the base URL is set (missing access token)', () => {
    expect(() =>
      readMagentoEnvPreset({ OM_INTEGRATION_MAGENTO_BASE_URL: chance.url() }),
    ).toThrow('OM_INTEGRATION_MAGENTO_BASE_URL and OM_INTEGRATION_MAGENTO_ACCESS_TOKEN must both be set')
  })

  it('throws when only the access token is set (missing base URL)', () => {
    expect(() =>
      readMagentoEnvPreset({ OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid() }),
    ).toThrow('OM_INTEGRATION_MAGENTO_BASE_URL and OM_INTEGRATION_MAGENTO_ACCESS_TOKEN must both be set')
  })

  it('returns a preset with required fields and defaults', () => {
    const baseUrl = chance.url()
    const accessToken = chance.guid()

    const preset = readMagentoEnvPreset({
      OM_INTEGRATION_MAGENTO_BASE_URL: baseUrl,
      OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: accessToken,
    })

    expect(preset).not.toBeNull()
    expect(preset?.credentials).toEqual({ baseUrl, accessToken })
    expect(preset?.defaultOrderChannelId).toBeUndefined()
    expect(preset?.stockSource).toBeUndefined()
    expect(preset?.force).toBe(false)
    expect(preset?.enabled).toBe(true)
  })

  it('includes optional fields and parses boolean overrides when present', () => {
    const baseUrl = chance.url()
    const accessToken = chance.guid()
    const channelId = chance.guid()
    const stockSource = chance.word()

    const preset = readMagentoEnvPreset({
      OM_INTEGRATION_MAGENTO_BASE_URL: baseUrl,
      OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: accessToken,
      OM_INTEGRATION_MAGENTO_DEFAULT_CHANNEL_ID: channelId,
      OM_INTEGRATION_MAGENTO_STOCK_SOURCE: stockSource,
      OM_INTEGRATION_MAGENTO_FORCE_PRECONFIGURE: 'true',
      OM_INTEGRATION_MAGENTO_ENABLED: 'false',
    })

    expect(preset?.defaultOrderChannelId).toBe(channelId)
    expect(preset?.stockSource).toBe(stockSource)
    expect(preset?.force).toBe(true)
    expect(preset?.enabled).toBe(false)
  })
})

describe('applyMagentoEnvPreset', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    findOneWithDecryption.mockResolvedValue(null)
  })

  it('returns skipped when no env vars are provided', async () => {
    const services = makeServices()
    const result = await applyMagentoEnvPreset({ ...services, em: makeEm() as any, scope: makeScope(), env: {} })

    expect(result.status).toBe('skipped')
    expect(jest.mocked(services.credentialsService.save)).not.toHaveBeenCalled()
  })

  it('returns skipped when Magento credentials or integration state already exist', async () => {
    const services = makeServices(true)
    const result = await applyMagentoEnvPreset({
      ...services,
      em: makeEm() as any,
      scope: makeScope(),
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: chance.url(),
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid(),
      },
    })

    expect(result.status).toBe('skipped')
    expect(jest.mocked(services.credentialsService.save)).not.toHaveBeenCalled()
  })

  it('configures credentials and integration states when no existing config is found', async () => {
    const services = makeServices(false)
    const baseUrl = chance.url()
    const accessToken = chance.guid()
    const scope = makeScope()

    const result: ApplyMagentoPresetResult = await applyMagentoEnvPreset({
      ...services,
      em: makeEm() as any,
      scope,
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: baseUrl,
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: accessToken,
      },
    })

    expect(result).toEqual({ status: 'configured', enabled: true })
    expect(jest.mocked(services.credentialsService.save)).toHaveBeenCalledWith(
      'sync_magento',
      { baseUrl, accessToken },
      scope,
    )
    expect(jest.mocked(services.integrationStateService.upsert)).toHaveBeenCalledTimes(4)
    expect(jest.mocked(services.integrationStateService.upsert)).toHaveBeenCalledWith(
      'sync_magento_products',
      { isEnabled: true },
      scope,
    )
    expect(jest.mocked(services.integrationStateService.upsert)).toHaveBeenCalledWith(
      'sync_magento_orders',
      { isEnabled: true },
      scope,
    )
  })

  it('overwrites existing configuration when force is set', async () => {
    const services = makeServices(true)

    const result = await applyMagentoEnvPreset({
      ...services,
      em: makeEm() as any,
      scope: makeScope(),
      force: true,
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: chance.url(),
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid(),
      },
    })

    expect(result.status).toBe('configured')
    expect(jest.mocked(services.credentialsService.save)).toHaveBeenCalled()
  })

  it('logs the preconfiguration when an integration log service is provided', async () => {
    const services = makeServices(false)
    const scope = makeScope()

    await applyMagentoEnvPreset({
      ...services,
      em: makeEm() as any,
      scope,
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: chance.url(),
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid(),
        OM_INTEGRATION_MAGENTO_ENABLED: 'false',
      },
    })

    const scoped = jest.mocked(services.integrationLogService!.scoped)
    expect(scoped).toHaveBeenCalledWith('sync_magento_products', scope)
    expect(scoped.mock.results[0].value.info).toHaveBeenCalledWith(
      'Magento integration was preconfigured from environment variables.',
      { enabled: false },
    )
  })

  it('creates settings with a derived channel→stock mapping when no row exists yet', async () => {
    const services = makeServices(false)
    const em = makeEm()
    const channelId = chance.guid()
    const stockSource = chance.word()
    const scope = makeScope()

    findOneWithDecryption.mockResolvedValue(null)

    await applyMagentoEnvPreset({
      ...services,
      em: em as any,
      scope,
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: chance.url(),
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid(),
        OM_INTEGRATION_MAGENTO_DEFAULT_CHANNEL_ID: channelId,
        OM_INTEGRATION_MAGENTO_STOCK_SOURCE: stockSource,
      },
    })

    expect(em.create).toHaveBeenCalledWith(
      MagentoSyncSettingsStub,
      expect.objectContaining({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        defaultOrderChannelId: channelId,
        channelStockMappings: [{ channelId, stockSource }],
      }),
    )
    expect(em.flush).toHaveBeenCalled()
  })

  it('updates an existing settings row instead of creating a new one', async () => {
    const services = makeServices(false)
    const em = makeEm()
    const channelId = chance.guid()
    const stockSource = chance.word()
    const existing = {
      defaultOrderChannelId: null as string | null,
      channelStockMappings: null as unknown[] | null,
      updatedAt: new Date(0),
    }

    findOneWithDecryption.mockResolvedValue(existing)

    await applyMagentoEnvPreset({
      ...services,
      em: em as any,
      scope: makeScope(),
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: chance.url(),
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid(),
        OM_INTEGRATION_MAGENTO_DEFAULT_CHANNEL_ID: channelId,
        OM_INTEGRATION_MAGENTO_STOCK_SOURCE: stockSource,
      },
    })

    expect(em.create).not.toHaveBeenCalled()
    expect(existing.defaultOrderChannelId).toBe(channelId)
    expect(existing.channelStockMappings).toEqual([{ channelId, stockSource }])
    expect(existing.updatedAt.getTime()).toBeGreaterThan(0)
    expect(em.flush).toHaveBeenCalled()
  })

  it('does not overwrite existing channel→stock mappings on an existing row', async () => {
    const services = makeServices(false)
    const em = makeEm()
    const existingMappings = [{ channelId: chance.guid(), stockSource: chance.word() }]
    const existing = {
      defaultOrderChannelId: chance.guid(),
      channelStockMappings: existingMappings,
      updatedAt: new Date(0),
    }

    findOneWithDecryption.mockResolvedValue(existing)

    await applyMagentoEnvPreset({
      ...services,
      em: em as any,
      scope: makeScope(),
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: chance.url(),
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid(),
        OM_INTEGRATION_MAGENTO_DEFAULT_CHANNEL_ID: chance.guid(),
        OM_INTEGRATION_MAGENTO_STOCK_SOURCE: chance.word(),
      },
    })

    expect(existing.channelStockMappings).toBe(existingMappings)
  })

  it('skips applying the settings preset entirely when neither channel nor stock source is provided', async () => {
    const services = makeServices(false)
    const em = makeEm()

    await applyMagentoEnvPreset({
      ...services,
      em: em as any,
      scope: makeScope(),
      env: {
        OM_INTEGRATION_MAGENTO_BASE_URL: chance.url(),
        OM_INTEGRATION_MAGENTO_ACCESS_TOKEN: chance.guid(),
      },
    })

    expect(findOneWithDecryption).not.toHaveBeenCalled()
    expect(em.create).not.toHaveBeenCalled()
    expect(em.flush).not.toHaveBeenCalled()
  })
})
