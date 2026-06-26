/**
 * KSeF 2.0 environment + FA(3) schema configuration.
 *
 * Statutory volatility note: the KSeF programme has slipped twice, so base URLs,
 * the FA schema version, and obligation dates are CONFIGURATION, never compiled-in
 * constants. The values below are the published KSeF 2.0 defaults (verified against
 * the CIRFMF/ksef-docs repository and the live TEST OpenAPI at
 * https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json on 2026-06). They can be
 * overridden per-tenant via the KSeF integration credentials/settings, or per
 * process via the OM_KSEF_* env fallbacks consumed by `resolveKsefEnvironment`.
 */

export type KsefEnvironment = 'test' | 'demo' | 'prod'

export type KsefEnvironmentConfig = {
  environment: KsefEnvironment
  baseUrl: string
  apiPrefix: string
}

const KSEF_BASE_URLS: Record<KsefEnvironment, string> = {
  test: 'https://api-test.ksef.mf.gov.pl',
  demo: 'https://api-demo.ksef.mf.gov.pl',
  prod: 'https://api.ksef.mf.gov.pl',
}

export const KSEF_API_PREFIX = '/v2'

/** FA(3) structured-invoice schema identifiers (KSeF 2.0, effective 2026). */
export const FA3_SCHEMA = {
  formCode: 'FA',
  systemCode: 'FA (3)',
  schemaVersion: '1-0E',
  variant: 3,
  targetNamespace: 'http://crd.gov.pl/wzor/2025/06/25/13775/',
  elementReference: 'FA',
} as const

export const KSEF_DEFAULT_ENVIRONMENT: KsefEnvironment = 'test'

export function isKsefEnvironment(value: unknown): value is KsefEnvironment {
  return value === 'test' || value === 'demo' || value === 'prod'
}

export function resolveKsefBaseUrl(environment: KsefEnvironment): string {
  return KSEF_BASE_URLS[environment]
}

/**
 * Resolve the effective KSeF environment for a connector. Priority:
 * 1. explicit per-tenant credential/setting value, 2. OM_KSEF_ENVIRONMENT env,
 * 3. the safe default (`test`). PROD is never selected implicitly.
 */
export function resolveKsefEnvironment(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): KsefEnvironmentConfig {
  const candidate = explicit ?? env.OM_KSEF_ENVIRONMENT ?? KSEF_DEFAULT_ENVIRONMENT
  const environment = isKsefEnvironment(candidate) ? candidate : KSEF_DEFAULT_ENVIRONMENT
  return {
    environment,
    baseUrl: resolveKsefBaseUrl(environment),
    apiPrefix: KSEF_API_PREFIX,
  }
}
