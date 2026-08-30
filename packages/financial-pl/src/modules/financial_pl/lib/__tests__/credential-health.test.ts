import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import * as x509 from '@peculiar/x509'
import { assessCredentialHealth } from '../credential-health'

const NOW = new Date('2026-11-15T00:00:00.000Z')

describe('assessCredentialHealth', () => {
  it('reports token sunset math for token-only credentials', () => {
    const health = assessCredentialHealth({ ksefToken: 'token-secret' }, NOW)

    expect(health.token).toEqual({ present: true, sunsetDate: '2026-12-31', daysToSunset: 46 })
    expect(health.authCert.present).toBe(false)
    expect(health.offlineCert.present).toBe(false)
    expect(health.warnings).toEqual(['token_sunset_soon'])
  })

  it('flags an auth certificate expiring in 10 days', async () => {
    const certPem = await selfSignedCertPem(new Date('2026-01-01T00:00:00.000Z'), new Date('2026-11-25T00:00:00.000Z'))

    const health = assessCredentialHealth({ authCertPem: certPem }, NOW)

    expect(health.authCert).toEqual({
      present: true,
      notAfter: '2026-11-25',
      daysToExpiry: 10,
      expiringSoon: true,
    })
    expect(health.warnings).toEqual(['auth_cert_expiring'])
  })

  it('treats a certificate valid for one year as healthy', async () => {
    const certPem = await selfSignedCertPem(new Date('2026-01-01T00:00:00.000Z'), new Date('2027-11-15T00:00:00.000Z'))

    const health = assessCredentialHealth({ offlineCertPem: certPem }, NOW)

    expect(health.offlineCert).toEqual({
      present: true,
      notAfter: '2027-11-15',
      daysToExpiry: 365,
      expiringSoon: false,
    })
    expect(health.warnings).toEqual([])
  })

  it('does not throw for an unparseable PEM and flags it instead of staying silent', () => {
    expect(() => assessCredentialHealth({ authCertPem: 'not a pem' }, NOW)).not.toThrow()

    const health = assessCredentialHealth({ authCertPem: 'not a pem' }, NOW)
    expect(health.authCert).toEqual({ present: true, notAfter: null, daysToExpiry: null, expiringSoon: false })
    // Present-but-unreadable is a broken credential; silence here meant the operator's first
    // symptom was a failed filing.
    expect(health.warnings).toEqual(['auth_cert_unreadable'])
  })

  it('reports no credentials as absent with no warnings', () => {
    expect(assessCredentialHealth({}, NOW)).toEqual({
      token: { present: false, sunsetDate: '2026-12-31', daysToSunset: null },
      authCert: { present: false, notAfter: null, daysToExpiry: null, expiringSoon: false },
      offlineCert: { present: false, notAfter: null, daysToExpiry: null, expiringSoon: false },
      warnings: [],
    })
  })
})

async function selfSignedCertPem(notBefore: Date, notAfter: Date): Promise<string> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const keys = (await webcrypto.subtle.generateKey(alg as never, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '0A',
    name: 'CN=Credential Health Test, C=PL',
    notBefore,
    notAfter,
    keys: keys as never,
    signingAlgorithm: alg,
  })
  return cert.toString('pem')
}
