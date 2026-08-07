/**
 * KSeF certificate management commands (SPEC-007).
 *
 * Three org+tenant-scoped commands wrapping the certificate-enrollment core and the
 * KSeF client's certificate endpoints:
 *  - enroll: drive the asynchronous KSeF certificate issuance and persist the issued
 *    cert (PEM) + private key (PEM, encrypted) + serial into the `ksef_pl` credentials.
 *    It does NOT flip `authMethod` — activating certificate auth is a separate explicit
 *    operator step. The private key is NEVER returned in the result and NEVER logged.
 *  - list: query the org's KSeF certificates.
 *  - revoke: revoke a certificate by serial number.
 *
 * All three require an XAdES-capable (certificate) credential + a context NIP, because
 * the enrollment-data / certificate endpoints are certificate-auth only — an org with
 * token-only auth is rejected up front with 409 `certificate_auth_required_for_enrollment`.
 */
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureTenantScope, ensureOrganizationScope } from '@open-mercato/shared/lib/commands/scope'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { z } from 'zod'
import {
  KsefClient,
  type KsefCertificateInfo,
  type KsefCertificateRevocationReason,
} from '../lib/ksef-client'
import { authenticate, type KsefAuthConfig } from '../lib/ksef-auth'
import { normalizePem } from '../lib/pem'
import { runCertificateEnrollment } from '../lib/cert-enrollment'
import { resolveKsefEnvironment } from '../config'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const AUTH_POLL = { authMaxAttempts: 20, authDelayMs: 1500, wait } as const

const enrollInputSchema = z.object({
  certificateName: z.string().min(1),
  algorithm: z.enum(['RSA', 'EC']).optional(),
  certificateType: z.enum(['Authentication', 'Offline']).optional(),
})
export type KsefCertificateEnrollInput = z.infer<typeof enrollInputSchema>

const listInputSchema = z.object({
  filter: z.record(z.string(), z.unknown()).optional(),
})
export type KsefCertificateListInput = z.infer<typeof listInputSchema>

const revokeInputSchema = z.object({
  serialNumber: z.string().min(1),
  reason: z.enum(['Unspecified', 'Superseded', 'KeyCompromise']).optional(),
})
export type KsefCertificateRevokeInput = z.infer<typeof revokeInputSchema> & {
  reason?: KsefCertificateRevocationReason
}

type CredentialsService = {
  getRaw: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<Record<string, unknown> | null>
  save: (
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<unknown>
}

function resolveCommandScope(ctx: CommandRuntimeContext): { organizationId: string; tenantId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId =
    ctx.selectedOrganizationId ?? ctx.organizationIds?.[0] ?? ctx.auth?.orgId ?? null
  if (!organizationId || !tenantId) {
    throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })
  }
  return { organizationId, tenantId }
}

function credString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Stored PEMs are operator-pasted and commonly newline-stripped — repair on read. */
function credPem(value: unknown): string | undefined {
  const text = credString(value)
  return text ? normalizePem(text) : undefined
}

type CertCredentials = {
  raw: Record<string, unknown>
  contextNip: string
  certificatePem: string
  certificatePrivateKeyPem: string
  environment?: string
}

/**
 * Read the org's `ksef_pl` credentials and assert an XAdES-capable certificate
 * credential (cert PEM + private key PEM) AND a context NIP. Without all three,
 * the certificate endpoints would 401/403, so we fail fast with a clear 409.
 */
async function requireCertCredentials(
  ctx: CommandRuntimeContext,
  scope: { organizationId: string; tenantId: string },
): Promise<{ svc: CredentialsService; creds: CertCredentials }> {
  const svc = ctx.container.resolve('integrationCredentialsService') as CredentialsService
  const raw = (await svc.getRaw('ksef_pl', scope)) ?? {}
  const nipDigits = typeof raw.contextNip === 'string' ? raw.contextNip.replace(/[^0-9]/g, '') : ''
  const contextNip = /^[0-9]{10}$/.test(nipDigits) ? nipDigits : undefined
  const certificatePem = credPem(raw.certificatePem)
  const certificatePrivateKeyPem = credPem(raw.certificatePrivateKeyPem)
  if (!certificatePem || !certificatePrivateKeyPem || !contextNip) {
    throw new CrudHttpError(409, {
      error:
        'A KSeF certificate credential is required to enroll a new certificate. Obtain the first certificate via the Ministry of Finance taxpayer app (qualified signature).',
      code: 'certificate_auth_required_for_enrollment',
    })
  }
  return {
    svc,
    creds: { raw, contextNip, certificatePem, certificatePrivateKeyPem, environment: credString(raw.environment) },
  }
}

/** Authenticate the org's certificate credential against KSeF and return the client + access token. */
async function authenticateCert(
  creds: CertCredentials,
): Promise<{ client: KsefClient; accessToken: string }> {
  const auth: KsefAuthConfig = {
    method: 'certificate',
    contextNip: creds.contextNip,
    certificatePem: creds.certificatePem,
    privateKeyPem: creds.certificatePrivateKeyPem,
  }
  const client = new KsefClient(resolveKsefEnvironment(creds.environment))
  let a: Awaited<ReturnType<typeof authenticate>>
  try {
    a = await authenticate(client, undefined, auth, AUTH_POLL)
  } catch (err) {
    // authenticate() reports KSeF rejections as {ok:false}, but stored-credential material that
    // cannot be parsed (corrupt PEM/key) THROWS from the signing path — surface that as an
    // actionable client error, not an anonymous 500.
    if (err instanceof CrudHttpError) throw err
    throw new CrudHttpError(422, {
      error:
        'The stored KSeF certificate credential could not be used for signing — re-save the certificate and private key PEM fields on the ksef_pl credential page.',
      code: 'certificate_credential_invalid',
    })
  }
  if (!a.ok) {
    throw new CrudHttpError(502, { error: a.errorMessage, code: 'certificate_auth_failed' })
  }
  return { client, accessToken: a.accessToken }
}

export const enrollCommand: CommandHandler<KsefCertificateEnrollInput, { serial: string; status: 'issued' }> = {
  id: 'financial_pl.ksef_certificate.enroll',
  async execute(input, ctx) {
    const parsed = enrollInputSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const { svc, creds } = await requireCertCredentials(ctx, scope)
    const { client, accessToken } = await authenticateCert(creds)

    const certificateType = parsed.certificateType ?? 'Authentication'
    const result = await runCertificateEnrollment(client, accessToken, {
      certificateName: parsed.certificateName,
      algorithm: parsed.algorithm,
      certificateType,
      pollMaxAttempts: 30,
      pollDelayMs: 2000,
    })
    if (result.status === 'failed') {
      throw new CrudHttpError(422, { error: result.reason, code: 'certificate_enrollment_failed' })
    }

    // Persist the issued cert + key (encrypted by the credentials service) + serial,
    // preserving every other stored field. Deliberately does NOT set authMethod —
    // switching the active method to certificate is a separate explicit operator step.
    // The Offline cert (signs the KOD II offline QR) lives in SEPARATE credential
    // fields with a distinct lifetime, so it NEVER clobbers the Authentication
    // credential (and vice-versa) — branch on the issued certificate type (SPEC-010).
    const issuedFields =
      certificateType === 'Offline'
        ? {
            offlineCertificatePem: result.certificatePem,
            offlineCertificatePrivateKeyPem: result.privateKeyPem,
            offlineCertificateSerialNumber: result.serial,
          }
        : {
            certificatePem: result.certificatePem,
            certificatePrivateKeyPem: result.privateKeyPem,
            certificateSerialNumber: result.serial,
          }
    await svc.save(
      'ksef_pl',
      {
        ...creds.raw,
        ...issuedFields,
      },
      scope,
    )

    // NEVER return the private key.
    return { serial: result.serial, status: result.status }
  },
}

export const listCommand: CommandHandler<KsefCertificateListInput, { items: KsefCertificateInfo[] }> = {
  id: 'financial_pl.ksef_certificate.list',
  async execute(input, ctx) {
    const parsed = listInputSchema.parse(input ?? {})
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const { creds } = await requireCertCredentials(ctx, scope)
    const { client, accessToken } = await authenticateCert(creds)

    const items = await client.queryCertificates({ accessToken, filter: parsed.filter })
    return { items }
  },
}

export const revokeCommand: CommandHandler<KsefCertificateRevokeInput, { ok: true }> = {
  id: 'financial_pl.ksef_certificate.revoke',
  async execute(input, ctx) {
    const parsed = revokeInputSchema.parse(input)
    const scope = resolveCommandScope(ctx)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const { creds } = await requireCertCredentials(ctx, scope)
    const { client, accessToken } = await authenticateCert(creds)

    await client.revokeCertificate({ accessToken, serialNumber: parsed.serialNumber, reason: parsed.reason })
    return { ok: true }
  },
}

registerCommand(enrollCommand)
registerCommand(listCommand)
registerCommand(revokeCommand)
