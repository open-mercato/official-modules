/**
 * KSeF connectivity health check, wired into the integration definition.
 * Verifies the connector can reach the configured KSeF environment by fetching
 * the MF public-key certificates (a public, unauthenticated endpoint).
 */
import { resolveKsefEnvironment } from '../config'
import { KsefClient, defaultFetchTransport, type KsefTransport } from './ksef-client'

export type HealthCheckResult = {
  status: 'healthy' | 'unhealthy'
  message: string
  details: Record<string, unknown>
  checkedAt: Date
}

export function createKsefHealthCheck(transport: KsefTransport = defaultFetchTransport) {
  return {
    async check(credentials: Record<string, unknown>): Promise<HealthCheckResult> {
      const environment = resolveKsefEnvironment(
        typeof credentials.environment === 'string' ? credentials.environment : null,
      )
      const client = new KsefClient(environment, transport)
      try {
        const certs = await client.getPublicKeyCertificates()
        const healthy = certs.length > 0
        return {
          status: healthy ? 'healthy' : 'unhealthy',
          message: healthy
            ? `Connected to KSeF ${environment.environment} (${certs.length} public keys)`
            : `KSeF ${environment.environment} returned no public keys`,
          details: { environment: environment.environment, baseUrl: environment.baseUrl, publicKeys: certs.length },
          checkedAt: new Date(),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return {
          status: 'unhealthy',
          message: `KSeF connection failed: ${message}`,
          details: { environment: environment.environment, error: message },
          checkedAt: new Date(),
        }
      }
    },
  }
}

export const ksefHealthCheck = createKsefHealthCheck()
