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

/**
 * Public KSeF QR verification hosts (KOD I — invoice verification), per the
 * official kody-qr spec. Distinct from the API base URLs above.
 */
const KSEF_QR_HOSTS: Record<KsefEnvironment, string> = {
  test: 'https://qr-test.ksef.mf.gov.pl',
  demo: 'https://qr-demo.ksef.mf.gov.pl',
  prod: 'https://qr.ksef.mf.gov.pl',
}

/** Resolve the KOD I QR host for an environment (overridable via OM_KSEF_QR_HOST). */
export function resolveKsefQrHost(environment: KsefEnvironment, env: NodeJS.ProcessEnv = process.env): string {
  return env.OM_KSEF_QR_HOST ?? KSEF_QR_HOSTS[environment]
}

/**
 * MF JPK_VAT submission gateway (e-dokumenty) — a system SEPARATE from KSeF (SPEC-015 F2).
 * JPK_V7M/V7K(3) is transmitted here (InitUploadSigned → Azure-SAS PUT → FinishUpload → Status/UPO),
 * NOT via the KSeF API. Only `test`/`prod` gateways exist (no KSeF-style `demo`); a non-prod KSeF
 * environment maps to the JPK TEST gateway, which accepts self-signed XAdES + fictitious data.
 */
const JPK_GATEWAY_URLS: Record<'test' | 'prod', string> = {
  test: 'https://test-e-dokumenty.mf.gov.pl',
  prod: 'https://e-dokumenty.mf.gov.pl',
}

/** Resolve the MF JPK gateway base URL (overridable via OM_JPK_GATEWAY_URL). PROD only when the KSeF env is `prod`. */
export function resolveJpkGatewayUrl(environment: KsefEnvironment, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OM_JPK_GATEWAY_URL) return env.OM_JPK_GATEWAY_URL
  return environment === 'prod' ? JPK_GATEWAY_URLS.prod : JPK_GATEWAY_URLS.test
}

/**
 * Resolve the MF-published JPK gateway public certificate used to wrap the JPK upload AES key.
 * Operators must configure the correct per-environment certificate via `OM_JPK_MF_CERT_PEM`;
 * this module intentionally does not bundle a fabricated or stale certificate.
 */
export function resolveJpkMfPublicCert(environment: KsefEnvironment, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.OM_JPK_MF_CERT_PEM
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  // The environment is part of the resolver signature so future managed cert stores can vary by
  // MF gateway without changing callers. Today the operator-provided config is required.
  void environment
  return null
}

/**
 * NBP public exchange-rate API base (table A mid-rates), used by the FX auto-source (SPEC-015 F5).
 * The statutory invoice rate is the table-A mid-rate of the last business day BEFORE the tax point.
 */
export function resolveNbpApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.OM_NBP_API_BASE ?? 'https://api.nbp.pl/api'
}

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

/**
 * Date the EU standard VAT-rate table below was last verified. Re-verify each
 * fiscal year (and on any announced mid-year change) — a mid-year change can be
 * patched without a release via the `OM_KSEF_EU_VAT_RATES` JSON override.
 */
export const EU_VAT_RATES_AS_OF = '2026-01'

/**
 * EU-27 member-state STANDARD VAT rates (ISO alpha-2 → percentage), used by the
 * OSS/WSTO_EE path to validate or fall back the destination-country rate for
 * `P_12_XII`. Reduced rates are out of scope — the per-line sales rate is trusted
 * first; this table only validates/falls back.
 *
 * Greece is keyed under the EU VAT code `EL` (ISO alpha-2 `GR`); `getEuStandardVatRate`
 * reconciles the two so either lookup resolves.
 *
 * Verified as of `EU_VAT_RATES_AS_OF`. Maintenance: re-verify each fiscal year.
 */
export const EU_STANDARD_VAT_RATES: Readonly<Record<string, number>> = {
  AT: 20, // Austria
  BE: 21, // Belgium
  BG: 20, // Bulgaria
  CY: 19, // Cyprus
  CZ: 21, // Czechia
  DE: 19, // Germany
  DK: 25, // Denmark
  EE: 24, // Estonia (raised to 24% on 2025-07-01)
  EL: 24, // Greece (EU VAT code EL / ISO GR)
  ES: 21, // Spain
  FI: 25.5, // Finland (raised to 25.5% on 2024-09-01)
  FR: 20, // France
  HR: 25, // Croatia
  HU: 27, // Hungary
  IE: 23, // Ireland
  IT: 22, // Italy
  LT: 21, // Lithuania
  LU: 17, // Luxembourg
  LV: 21, // Latvia
  MT: 18, // Malta
  NL: 21, // Netherlands
  PL: 23, // Poland
  PT: 23, // Portugal
  RO: 21, // Romania (raised to 21% on 2025-08-01)
  SE: 25, // Sweden
  SI: 22, // Slovenia
  SK: 23, // Slovakia (raised to 23% on 2025-01-01)
} as const

/** Map an incoming country code to the table key (Greece ISO `GR` → EU code `EL`). */
function normalizeEuVatCountryKey(countryCode: string): string {
  const upper = countryCode.trim().toUpperCase()
  return upper === 'GR' ? 'EL' : upper
}

/**
 * Whether an ISO alpha-2 country code is an EU-27 member state (Greece resolves under both `GR` and
 * the EU VAT code `EL`). Used to distinguish a 0% intra-community supply (WDT → `K_21`) from a 0%
 * export to a third country (→ `K_22`) in the JPK sales register.
 */
export function isEuMemberState(countryCode: string | null | undefined): boolean {
  if (!countryCode) return false
  return normalizeEuVatCountryKey(countryCode) in EU_STANDARD_VAT_RATES
}

/**
 * Parse the optional `OM_KSEF_EU_VAT_RATES` JSON override (a partial
 * `{ "<ISO>": <rate> }` map) and merge it over the shipped table so a mid-year
 * rate change can be patched without a release. Malformed JSON or non-numeric
 * entries are ignored (the shipped table stands).
 */
function resolveEuStandardVatRates(env: NodeJS.ProcessEnv = process.env): Record<string, number> {
  const merged: Record<string, number> = { ...EU_STANDARD_VAT_RATES }
  const raw = env.OM_KSEF_EU_VAT_RATES
  if (!raw) return merged
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return merged
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return merged
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      merged[normalizeEuVatCountryKey(key)] = value
    }
  }
  return merged
}

/**
 * Resolve the standard VAT rate (percentage) for an EU member-state country code,
 * applying any `OM_KSEF_EU_VAT_RATES` override. Greece resolves under both `GR`
 * and `EL`. Returns `undefined` for an unknown/non-EU code (the caller falls back
 * to the trusted per-line sales rate).
 */
export function getEuStandardVatRate(
  countryCode: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!countryCode) return undefined
  const rates = resolveEuStandardVatRates(env)
  return rates[normalizeEuVatCountryKey(countryCode)]
}
