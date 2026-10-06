import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { applyTregEnvPreset, readTregEnvPreset } from '../lib/preset'

const scope = { tenantId: 't1', organizationId: 'o1' }

function createServices(existing: { credentials?: Record<string, unknown> | null; state?: unknown } = {}) {
  const credentialsService = {
    getRaw: jest.fn(async () => existing.credentials ?? null),
    save: jest.fn(async () => undefined),
  }
  const integrationStateService = {
    get: jest.fn(async () => existing.state ?? null),
    upsert: jest.fn(async () => ({})),
  }
  return {
    credentialsService: credentialsService as unknown as CredentialsService,
    integrationStateService: integrationStateService as unknown as IntegrationStateService,
    mocks: { credentialsService, integrationStateService },
  }
}

describe('readTregEnvPreset', () => {
  it('returns null without a token', () => {
    expect(readTregEnvPreset({})).toBeNull()
  })

  it('collects optional settings and defaults to enabled', () => {
    expect(
      readTregEnvPreset({
        OM_INTEGRATION_TREG_API_TOKEN: ' trg_live_x ',
        OM_INTEGRATION_TREG_ORG_SLUG: 'acme',
        OM_INTEGRATION_TREG_MAX_COST_PER_CALL_USD: '0.1',
      }),
    ).toEqual({
      credentials: { apiToken: 'trg_live_x', orgSlug: 'acme', maxCostPerCallUsd: '0.1' },
      enabled: true,
      force: false,
    })
  })
})

describe('applyTregEnvPreset', () => {
  const env = { OM_INTEGRATION_TREG_API_TOKEN: 'trg_live_x', OM_INTEGRATION_TREG_ENABLED: 'false' }

  it('saves credentials and state for a fresh tenant', async () => {
    const services = createServices()
    await expect(applyTregEnvPreset({ ...services, scope, env })).resolves.toEqual({ status: 'configured', enabled: false })
    expect(services.mocks.credentialsService.save).toHaveBeenCalledWith('enrichment_treg', { apiToken: 'trg_live_x' }, scope)
    expect(services.mocks.integrationStateService.upsert).toHaveBeenCalledWith('enrichment_treg', { isEnabled: false }, scope)
  })

  it('does not overwrite existing configuration unless forced', async () => {
    const services = createServices({ credentials: { apiToken: 'old' } })
    await expect(applyTregEnvPreset({ ...services, scope, env })).resolves.toMatchObject({ status: 'skipped' })
    expect(services.mocks.credentialsService.save).not.toHaveBeenCalled()
    await expect(applyTregEnvPreset({ ...services, scope, env, force: true })).resolves.toMatchObject({ status: 'configured' })
  })
})
