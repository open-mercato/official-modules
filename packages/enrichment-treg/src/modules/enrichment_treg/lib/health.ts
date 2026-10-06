import { fetchTregBalance, parseTregSettings, type FetchLike } from './client'

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy'
  message: string
  details: Record<string, unknown>
  checkedAt: Date
}

export function createTregHealthCheck(fetchImpl?: FetchLike) {
  return {
    async check(credentials: Record<string, unknown>): Promise<HealthCheckResult> {
      try {
        const settings = parseTregSettings(credentials)
        const balance = await fetchTregBalance(settings, fetchImpl)
        return {
          status: 'healthy',
          message: 'Connected to treg.to',
          details: {
            balanceUsd: balance.balanceMicro === null ? null : balance.balanceMicro / 1_000_000,
            maxCostPerCallUsd: settings.maxCostUsd,
          },
          checkedAt: new Date(),
        }
      } catch (error) {
        return {
          status: 'unhealthy',
          message: error instanceof Error ? error.message.replace(/^\[internal\]\s*/, '') : 'Unknown error',
          details: {},
          checkedAt: new Date(),
        }
      }
    },
  }
}

export const tregHealthCheck = createTregHealthCheck()
