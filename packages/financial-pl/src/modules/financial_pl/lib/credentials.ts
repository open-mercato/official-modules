/**
 * Per-organization KSeF credential resolution. Credentials live (encrypted) in
 * the platform IntegrationCredentialsService under the `ksef_pl` integration id,
 * scoped by (organizationId, tenantId) — there is NO shared/agency credential
 * (confirmed per-org-only model). Supported auth methods:
 *  - token: `ksefToken` (transitional, sunset 2026-12-31).
 *  - certificate: `certificatePem` + `certificatePrivateKeyPem` (durable; the only
 *    credential from 2027-01-01). Selected when `authMethod==='certificate'`.
 *  - auto: explicit opt-in to prefer currently-valid certificate material, falling back to token.
 */
import { X509Certificate } from 'node:crypto'
import { normalizePem } from './pem'

import type { KsefAuthConfig } from './ksef-auth'
import type { KsefEnvironmentColumn } from '../data/entities'

export type KsefAuthMethod = 'token' | 'certificate' | 'auto'

export type KsefCredentials = {
  authMethod?: KsefAuthMethod
  ksefToken?: string
  certificatePem?: string
  certificatePrivateKeyPem?: string
  certificateSerialNumber?: string
  /** Offline certificate triple (signs the KOD II offline QR; SPEC-010). Separate lifetime. */
  offlineCertificatePem?: string
  offlineCertificatePrivateKeyPem?: string
  offlineCertificateSerialNumber?: string
  /** Dedicated JPK signer credential. Do not reuse the KSeF Authentication certificate. */
  jpkSignerCertPem?: string
  jpkSignerPrivateKeyPem?: string
  environment?: KsefEnvironmentColumn
}

export type ResolverContext = { resolve: <T = unknown>(name: string) => T }

type CredentialsService = {
  getRaw: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<Record<string, unknown> | null>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** PEM fields are operator-pasted and commonly arrive newline-stripped — repair on read so every
 *  consumer (XAdES auth, offline KOD II signer, JPK signer, validity checks) sees parseable PEM. */
function asPem(value: unknown): string | undefined {
  const text = asString(value)
  return text ? normalizePem(text) : undefined
}

function isCertificateValidNow(certificatePem: string, now: Date): boolean {
  try {
    const cert = new X509Certificate(certificatePem)
    const validFrom = Date.parse(cert.validFrom)
    const validTo = Date.parse(cert.validTo)
    const current = now.getTime()
    return (
      Number.isFinite(validFrom) &&
      Number.isFinite(validTo) &&
      current >= validFrom &&
      current <= validTo
    )
  } catch {
    return false
  }
}

/** Read + normalize the `ksef_pl` credentials for an org scope. Returns `{}` on any failure. */
export async function readKsefCredentials(
  ctx: ResolverContext,
  scope: { organizationId: string; tenantId: string },
): Promise<KsefCredentials> {
  try {
    const service = ctx.resolve<CredentialsService>('integrationCredentialsService')
    const creds = await service.getRaw('ksef_pl', scope)
    if (!creds) return {}
    const environment =
      creds.environment === 'test' || creds.environment === 'demo' || creds.environment === 'prod'
        ? (creds.environment as KsefEnvironmentColumn)
        : undefined
    const authMethod =
      creds.authMethod === 'certificate'
        ? 'certificate'
        : creds.authMethod === 'token'
          ? 'token'
          : creds.authMethod === 'auto'
            ? 'auto'
            : undefined
    return {
      authMethod,
      ksefToken: asString(creds.ksefToken),
      certificatePem: asPem(creds.certificatePem),
      certificatePrivateKeyPem: asPem(creds.certificatePrivateKeyPem),
      certificateSerialNumber: asString(creds.certificateSerialNumber),
      offlineCertificatePem: asPem(creds.offlineCertificatePem),
      offlineCertificatePrivateKeyPem: asPem(creds.offlineCertificatePrivateKeyPem),
      offlineCertificateSerialNumber: asString(creds.offlineCertificateSerialNumber),
      jpkSignerCertPem: asPem(creds.jpkSignerCertPem),
      jpkSignerPrivateKeyPem: asPem(creds.jpkSignerPrivateKeyPem),
      environment,
    }
  } catch {
    return {}
  }
}

/**
 * Build the auth config for a submission, given the resolved credentials + the
 * submission's context NIP. The method is explicit (`authMethod`) and only falls
 * back to token when unset, for backward compatibility with existing token orgs.
 * Returns null when the required material for the selected method is missing.
 */
export function buildKsefAuthConfig(
  creds: KsefCredentials,
  contextNip: string,
  now: Date = new Date(),
): KsefAuthConfig | null {
  if (creds.authMethod === 'auto') {
    if (
      creds.certificatePem &&
      creds.certificatePrivateKeyPem &&
      isCertificateValidNow(creds.certificatePem, now)
    ) {
      return {
        method: 'certificate',
        contextNip,
        certificatePem: creds.certificatePem,
        privateKeyPem: creds.certificatePrivateKeyPem,
      }
    }
    if (!creds.ksefToken) return null
    return { method: 'token', ksefToken: creds.ksefToken, contextNip }
  }

  // Auth method is EXPLICIT: certificate auth is used ONLY when the operator has
  // activated it (authMethod === 'certificate'). It is NEVER inferred from the mere
  // presence of certificate material — enrollment stores the cert+key but does not
  // activate it (SPEC-007), so inferring here would silently switch a token org to
  // certificate auth on its next invoice (a regression risk if the cert is invalid or
  // not yet intended). Unset/legacy/'token' → token (backward-compatible).
  const method: KsefAuthMethod = creds.authMethod === 'certificate' ? 'certificate' : 'token'
  if (method === 'certificate') {
    if (!creds.certificatePem || !creds.certificatePrivateKeyPem) return null
    return {
      method: 'certificate',
      contextNip,
      certificatePem: creds.certificatePem,
      privateKeyPem: creds.certificatePrivateKeyPem,
    }
  }
  if (!creds.ksefToken) return null
  return { method: 'token', ksefToken: creds.ksefToken, contextNip }
}
