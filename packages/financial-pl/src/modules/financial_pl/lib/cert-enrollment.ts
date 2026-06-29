/**
 * KSeF certificate enrollment orchestration (pure core).
 *
 * Drives the asynchronous KSeF certificate-issuance runbook end-to-end:
 *   GET /certificates/enrollments/data (the exact DN the CSR must carry, XAdES-auth
 *   only) -> generate a local keypair -> build a PKCS#10 CSR matching that DN ->
 *   POST /certificates/enrollments -> poll GET /certificates/enrollments/{ref} until
 *   terminal -> POST /certificates/retrieve to download the issued cert.
 *
 * Pure with respect to the platform: the KSeF transport (`client`) and the poll
 * `wait` are injected, and the crypto primitives default to `xades.ts` but are
 * overridable for deterministic unit testing with a mock client. NEVER returns the
 * private key to anything that would log/serialize it carelessly — the caller
 * (the enroll command) persists it as an encrypted integration secret and returns
 * only `{ serial, status }`.
 */
import type { KsefCertificateType, KsefClient } from './ksef-client'
import {
  buildCsr as defaultBuildCsr,
  generateKsefKeyPair as defaultGenerateKeyPair,
  type KsefCsrSubject,
  type KsefKeyAlgorithm,
  type KsefKeyPairPem,
} from './xades'

export type CertificateEnrollmentParams = {
  /** The certificate name registered with KSeF (free-form label). */
  certificateName: string
  /**
   * Which KSeF certificate to issue. `Authentication` (default) is the XAdES auth
   * cert; `Offline` is the cert that signs the KOD II offline QR. The two are kept
   * in separate credential fields and have distinct lifetimes (SPEC-010).
   */
  certificateType?: KsefCertificateType
  /** Signing keypair algorithm; defaults to RSA. */
  algorithm?: KsefKeyAlgorithm
  /** Bounded poll budget for the asynchronous enrollment status. */
  pollMaxAttempts: number
  pollDelayMs: number
}

export type CertificateEnrollmentResult =
  | {
      status: 'issued'
      serial: string
      /** The issued KSeF certificate, normalized to PEM. */
      certificatePem: string
      /** The matching private key (PEM). Caller MUST store encrypted; never return it. */
      privateKeyPem: string
    }
  | { status: 'failed'; reason: string }

export type CertificateEnrollmentDeps = {
  wait?: (ms: number) => Promise<void>
  generateKeyPair?: (algorithm?: KsefKeyAlgorithm) => Promise<KsefKeyPairPem>
  buildCsr?: (params: { keyPairPem: KsefKeyPairPem; subject: KsefCsrSubject }) => Promise<string>
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** KSeF enrollment status codes: 200 = issued, >= 400 = terminal failure, else pending. */
function isTerminalSuccess(code: number): boolean {
  return code === 200
}
function isTerminalFailure(code: number): boolean {
  return code >= 400
}

function isPemCertificate(value: string): boolean {
  return /-----BEGIN CERTIFICATE-----/.test(value)
}

function derBase64ToPem(derBase64: string): string {
  const body = derBase64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

/**
 * Pull the issued certificate (PEM) out of the `/certificates/retrieve` response,
 * matching the requested serial when possible. KSeF returns the cert as Base64 DER
 * (or, in some shapes, already PEM); both are normalized to PEM here. Returns
 * undefined when no certificate material can be located.
 */
function extractCertificatePem(retrieved: unknown, serial: string): string | undefined {
  const fromField = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.trim().length === 0) return undefined
    const trimmed = value.trim()
    return isPemCertificate(trimmed) ? trimmed : derBase64ToPem(trimmed)
  }

  if (typeof retrieved === 'string') return fromField(retrieved)
  if (!retrieved || typeof retrieved !== 'object') return undefined

  const record = retrieved as Record<string, unknown>
  const list = (Array.isArray(record.certificates) && record.certificates)
    || (Array.isArray(record.items) && record.items)
    || (Array.isArray(retrieved) ? (retrieved as unknown[]) : null)

  if (list) {
    const entries: Record<string, unknown>[] = list.map((raw) =>
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : { value: raw },
    )
    const match = entries.find((entry) => {
      const entrySerial = entry.certificateSerialNumber ?? entry.serialNumber
      return typeof entrySerial === 'string' && entrySerial === serial
    })
    const chosen = match ?? entries[0]
    if (chosen) {
      return fromField(chosen.certificate) ?? fromField(chosen.certificatePem) ?? fromField(chosen.value)
    }
    return undefined
  }

  return fromField(record.certificate) ?? fromField(record.certificatePem) ?? fromField(record.value)
}

/**
 * Run the full certificate enrollment for an already-authenticated KSeF session.
 * The caller supplies a valid `accessToken` obtained via XAdES (certificate) auth —
 * `GET /certificates/enrollments/data` is XAdES-only, so a token session would 401.
 */
export async function runCertificateEnrollment(
  client: KsefClient,
  accessToken: string,
  params: CertificateEnrollmentParams,
  deps: CertificateEnrollmentDeps = {},
): Promise<CertificateEnrollmentResult> {
  const wait = deps.wait ?? defaultWait
  const generateKeyPair = deps.generateKeyPair ?? defaultGenerateKeyPair
  const buildCsr = deps.buildCsr ?? defaultBuildCsr

  const enrollmentData = await client.getCertificateEnrollmentData(accessToken)
  const subject: KsefCsrSubject = {
    commonName: enrollmentData.commonName,
    countryName: enrollmentData.countryName,
    organizationName: enrollmentData.organizationName,
    serialNumber: enrollmentData.serialNumber,
    uniqueIdentifier: enrollmentData.uniqueIdentifier,
    organizationIdentifier: enrollmentData.organizationIdentifier,
  }

  const keyPairPem = await generateKeyPair(params.algorithm)
  const csr = await buildCsr({ keyPairPem, subject })

  const { referenceNumber } = await client.enrollCertificate({
    accessToken,
    csr,
    certificateType: params.certificateType ?? 'Authentication',
    certificateName: params.certificateName,
  })

  // Poll the asynchronous issuance until a terminal status (issued or rejected).
  for (let attempt = 0; attempt < params.pollMaxAttempts; attempt += 1) {
    const status = await client.getCertificateEnrollmentStatus({ accessToken, referenceNumber })
    if (isTerminalSuccess(status.code)) {
      const serial = status.certificateSerialNumber
      if (!serial) {
        return { status: 'failed', reason: '[internal] KSeF issued the certificate but returned no serial number' }
      }
      const retrieved = await client.retrieveCertificates({ accessToken, serialNumbers: [serial] })
      const certificatePem = extractCertificatePem(retrieved, serial)
      if (!certificatePem) {
        return { status: 'failed', reason: '[internal] KSeF certificate retrieve returned no certificate material' }
      }
      return { status: 'issued', serial, certificatePem, privateKeyPem: keyPairPem.privateKeyPem }
    }
    if (isTerminalFailure(status.code)) {
      const reason = status.description
        ? `KSeF rejected the certificate enrollment (status ${status.code}): ${status.description}`
        : `KSeF rejected the certificate enrollment (status ${status.code})`
      return { status: 'failed', reason }
    }
    await wait(params.pollDelayMs)
  }

  return {
    status: 'failed',
    reason: `[internal] KSeF certificate enrollment did not complete after ${params.pollMaxAttempts} status checks`,
  }
}

/** Raised when an offline certificate is outside its validity window at signing time. */
export class CertificateValidityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CertificateValidityError'
  }
}

/**
 * Assert a certificate (PEM) is valid AT `now` — i.e. `notBefore <= now <= notAfter`.
 * Parses the X.509 validity window via `@peculiar/x509` (already a dep). Used before
 * signing the KOD II offline QR so an expired / not-yet-valid Offline cert is rejected
 * up front rather than producing an unverifiable QR (jury delta #3). Throws
 * `CertificateValidityError` when out of window or when the PEM cannot be parsed.
 */
export async function assertCertificateValidNow(pem: string, now: Date = new Date()): Promise<void> {
  // `@peculiar/x509` needs reflect-metadata (tsyringe); load both lazily so only the
  // offline path pays for it. reflect-metadata MUST evaluate before x509.
  await import('reflect-metadata')
  const x509 = await import('@peculiar/x509')
  let cert: import('@peculiar/x509').X509Certificate
  try {
    cert = new x509.X509Certificate(pem)
  } catch {
    throw new CertificateValidityError('[internal] Offline certificate PEM could not be parsed')
  }
  const notBefore = cert.notBefore
  const notAfter = cert.notAfter
  if (now.getTime() < notBefore.getTime()) {
    throw new CertificateValidityError(
      `Offline certificate is not yet valid (valid from ${notBefore.toISOString()})`,
    )
  }
  if (now.getTime() > notAfter.getTime()) {
    throw new CertificateValidityError(
      `Offline certificate has expired (valid until ${notAfter.toISOString()})`,
    )
  }
}
