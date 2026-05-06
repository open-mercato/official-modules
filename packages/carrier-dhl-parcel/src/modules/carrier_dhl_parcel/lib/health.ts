import { match } from 'ts-pattern'
import { dhlRequest, resolveUserId, resolveAccountNumber } from './client'

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy'
  message: string
  details: Record<string, unknown>
  checkedAt: Date
}

type DhlCapabilityResponse = unknown[]

export const dhlParcelHealthCheck = {
  async check(credentials: Record<string, unknown>): Promise<HealthCheckResult> {
    try {
      const userId = resolveUserId(credentials)
      const accountNumber = resolveAccountNumber(credentials)

      // Validate credentials by fetching capabilities for a known country pair.
      // A 200 response confirms authentication and API access are working.
      const caps = await dhlRequest<DhlCapabilityResponse>(
        credentials,
        '/capabilities/business',
        { query: { fromCountry: 'NL', toCountry: 'NL', carrier: 'DHL-PARCEL' } },
      )

      return {
        status: 'healthy',
        message: `Connected to DHL Parcel API for account ${accountNumber} (userId: ${userId}). ${caps.length} capabilities found for NL→NL.`,
        details: {
          userId,
          accountNumber,
          capabilitiesCount: caps.length,
        },
        checkedAt: new Date(),
      }
    } catch (err: unknown) {
      const message = match(err)
        .when((e): e is Error => e instanceof Error, (e) => e.message)
        .otherwise(() => 'Unknown error')
      return {
        status: 'unhealthy',
        message: `DHL Parcel connection failed: ${message}`,
        details: { error: message },
        checkedAt: new Date(),
      }
    }
  },
}
