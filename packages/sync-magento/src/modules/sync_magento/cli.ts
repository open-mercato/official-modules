import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import { applyMagentoEnvPreset, readMagentoEnvPreset } from './lib/preset'

function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    if (key.includes('=')) {
      const [name, value] = key.split('=')
      result[name] = value
      continue
    }

    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      result[key] = next
      i += 1
      continue
    }

    result[key] = true
  }

  return result
}

function printHelp(): void {
  console.log('Usage: yarn mercato sync_magento configure-from-env --tenant <tenantId> --org <organizationId> [--force]')
  console.log('')
  console.log('Required env vars:')
  console.log('  OM_INTEGRATION_MAGENTO_BASE_URL')
  console.log('  OM_INTEGRATION_MAGENTO_ACCESS_TOKEN')
  console.log('')
  console.log('Optional env vars:')
  console.log('  OM_INTEGRATION_MAGENTO_DEFAULT_CHANNEL_ID')
  console.log('  OM_INTEGRATION_MAGENTO_STOCK_SOURCE')
  console.log('  OM_INTEGRATION_MAGENTO_ENABLED')
  console.log('  OM_INTEGRATION_MAGENTO_FORCE_PRECONFIGURE')
}

const configureFromEnvCommand: ModuleCli = {
  command: 'configure-from-env',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantId = String(args.tenantId ?? args.tenant ?? '')
    const organizationId = String(args.organizationId ?? args.orgId ?? args.org ?? '')
    const force = args.force === true

    if (!tenantId || !organizationId) {
      printHelp()
      return
    }

    const preset = readMagentoEnvPreset()
    if (!preset) {
      console.error('[sync_magento] No Magento env preset was found.')
      printHelp()
      process.exitCode = 1
      return
    }

    const container = await createRequestContainer()
    try {
      const em = container.resolve('em') as EntityManager
      const credentialsService = container.resolve('integrationCredentialsService') as CredentialsService
      const integrationStateService = container.resolve('integrationStateService') as IntegrationStateService
      const integrationLogService = container.resolve('integrationLogService') as IntegrationLogService

      const result = await applyMagentoEnvPreset({
        em,
        credentialsService,
        integrationStateService,
        integrationLogService,
        scope: { tenantId, organizationId },
        force,
      })

      if (result.status === 'skipped') {
        console.log(`[sync_magento] Skipped: ${result.reason}`)
        return
      }

      console.log('[sync_magento] Magento credentials and settings were configured from env.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Magento preset error'
      console.error(`[sync_magento] ${message}`)
      process.exitCode = 1
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') {
        await disposable.dispose()
      }
    }
  },
}

const helpCommand: ModuleCli = {
  command: 'help',
  async run() {
    printHelp()
  },
}

export default [configureFromEnvCommand, helpCommand]
