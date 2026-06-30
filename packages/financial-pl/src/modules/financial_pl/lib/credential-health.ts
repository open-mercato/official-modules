import { X509Certificate } from 'node:crypto'

export type CredentialHealth = {
  token: { present: boolean; sunsetDate: string; daysToSunset: number | null }
  authCert: { present: boolean; notAfter: string | null; daysToExpiry: number | null; expiringSoon: boolean }
  offlineCert: { present: boolean; notAfter: string | null; daysToExpiry: number | null; expiringSoon: boolean }
  warnings: string[]
}

export type CredentialHealthInput = {
  ksefToken?: string | null
  authCertPem?: string | null
  offlineCertPem?: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN_SUNSET_DATE = '2026-12-31'
const TOKEN_SUNSET_AT = new Date(`${TOKEN_SUNSET_DATE}T00:00:00.000Z`)
const TOKEN_SUNSET_WARNING_DAYS = 60
const CERT_EXPIRING_WARNING_DAYS = 30

export function assessCredentialHealth(input: CredentialHealthInput, now: Date = new Date()): CredentialHealth {
  const tokenPresent = hasText(input.ksefToken)
  const daysToSunset = tokenPresent ? daysBetween(TOKEN_SUNSET_AT, now) : null
  const authCert = assessCertificate(input.authCertPem, now)
  const offlineCert = assessCertificate(input.offlineCertPem, now)

  const warnings: string[] = []
  if (tokenPresent && daysToSunset !== null && daysToSunset < TOKEN_SUNSET_WARNING_DAYS) {
    warnings.push('token_sunset_soon')
  }
  if (authCert.expiringSoon) warnings.push('auth_cert_expiring')
  if (offlineCert.expiringSoon) warnings.push('offline_cert_expiring')

  return {
    token: { present: tokenPresent, sunsetDate: TOKEN_SUNSET_DATE, daysToSunset },
    authCert,
    offlineCert,
    warnings,
  }
}

function assessCertificate(
  pem: string | null | undefined,
  now: Date,
): CredentialHealth['authCert'] {
  const trimmedPem = pem?.trim()
  if (!trimmedPem) return { present: false, notAfter: null, daysToExpiry: null, expiringSoon: false }

  try {
    const cert = new X509Certificate(trimmedPem)
    const notAfterDate = new Date(cert.validTo)
    if (Number.isNaN(notAfterDate.getTime())) {
      return { present: true, notAfter: null, daysToExpiry: null, expiringSoon: false }
    }

    const daysToExpiry = daysBetween(notAfterDate, now)
    return {
      present: true,
      notAfter: notAfterDate.toISOString().slice(0, 10),
      daysToExpiry,
      expiringSoon: daysToExpiry < CERT_EXPIRING_WARNING_DAYS,
    }
  } catch {
    return { present: true, notAfter: null, daysToExpiry: null, expiringSoon: false }
  }
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS)
}
