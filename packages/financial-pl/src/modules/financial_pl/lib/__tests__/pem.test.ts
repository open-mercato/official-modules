import { X509Certificate } from 'node:crypto'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { normalizePem } from '../pem'
import { certificatePemToDerBase64 } from '../xades'
import { assessCredentialHealth } from '../credential-health'

/** Self-signed throwaway cert generated for this suite (public material only). */
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIC/DCCAeQCCQDKHjvD/ikOmjANBgkqhkiG9w0BAQsFADBAMSIwIAYDVQQDDBlm
aW5hbmNpYWwtcGwtdGVzdC1maXh0dXJlMQ0wCwYDVQQKDARUZXN0MQswCQYDVQQG
EwJQTDAeFw0yNjA3MzExMDM5MjRaFw0yNzA3MzExMDM5MjRaMEAxIjAgBgNVBAMM
GWZpbmFuY2lhbC1wbC10ZXN0LWZpeHR1cmUxDTALBgNVBAoMBFRlc3QxCzAJBgNV
BAYTAlBMMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxJrWdpde6PsJ
9nnKnzlF6njS5siBuNvTQl02+rTX7usPhmatcXjur1rxTcRxvB9Vzuxy6tI6Oh2B
XQDtRboaTqmBEHEfskHL6kIYPBaVqAuPLVQJaZ7dvDxilomwCtt1042/JO50U3/5
Mf+14U8MQ6xE84zrY1BiLs1XLtP2aCdzvOv74rN9LBSkvc56gjKf65vYp4LE8TOK
4uwmMktBHRoTctvqA4QSG8fKq7escqyujmKWfgkBUamdYQ/Qv5y7aVGy0Xv0fX+p
Jf6LjK863kLqiqGiV8VIB9p2Db8x6jvmMJdwc1weKoP2SJ5nYURcrnkvkOkum9vb
mCGA7z+3uwIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQAA7boKjW4tL0V6fxnpcAY+
IvWQ3TcY0dHtmieR2yn4JWkrqP9MCCvCVIQ4zZPAxyKEt/UNol25WfHHKgLExdJg
jMvl4KryzbC/3UixZ5odTNUFzbePR0AO3YzljOAKEYyT8FN1IlABmcYke0aoX5gL
1b9JF2vWSHDVOrIDID7tSVu2RGdm8L8jjExkeR1YR3QCVeEqCHMVg+/VwgyLEy4B
clSsFkhVpdRSszEzM+xBOrLL5C+FjMZSuEwzg5xHWiTUOA05gbRRi+c9QlBIghLE
PDrw4lNppg9zy+NOl4XndGnLAOQRHWh1kQDqIWXWuTQrtLKzlBFgW9HBsT9eySoQ
-----END CERTIFICATE-----`

/** The real-world corruption: a PEM pasted into a single-line input loses every newline. */
const flatten = (pem: string) => pem.replace(/\r?\n/g, '')

describe('normalizePem', () => {
  it('reflows a newline-stripped certificate into parseable PEM', () => {
    const flat = flatten(FIXTURE_CERT_PEM)
    expect(flat.includes('\n')).toBe(false)
    expect(() => new X509Certificate(flat)).toThrow()
    const restored = normalizePem(flat)
    const cert = new X509Certificate(restored)
    expect(cert.subject).toContain('financial-pl-test-fixture')
  })

  it('leaves a well-formed PEM semantically intact (idempotent)', () => {
    const once = normalizePem(FIXTURE_CERT_PEM)
    expect(new X509Certificate(once).fingerprint256).toBe(new X509Certificate(FIXTURE_CERT_PEM).fingerprint256)
    expect(normalizePem(once)).toBe(once)
  })

  it('recovers a PEM whose newlines were pasted as literal backslash-n text', () => {
    const literal = FIXTURE_CERT_PEM.replace(/\n/g, '\\n')
    const restored = normalizePem(literal)
    expect(() => new X509Certificate(restored)).not.toThrow()
  })

  it('reflows a newline-stripped private key so createPrivateKey accepts it', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const keyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    const flat = flatten(keyPem)
    expect(() => createPrivateKey(flat)).toThrow()
    expect(() => createPrivateKey(normalizePem(flat))).not.toThrow()
  })

  it('passes through text without PEM markers unchanged', () => {
    expect(normalizePem('not a pem at all')).toBe('not a pem at all')
    expect(normalizePem('')).toBe('')
  })
})

describe('flattened-PEM tolerance at the consumption sites', () => {
  it('certificatePemToDerBase64 accepts a newline-stripped certificate', () => {
    const der = certificatePemToDerBase64(flatten(FIXTURE_CERT_PEM))
    expect(der).toBe(new X509Certificate(FIXTURE_CERT_PEM).raw.toString('base64'))
  })

  it('credential health reads the expiry of a newline-stripped certificate', () => {
    const health = assessCredentialHealth(
      { authCertPem: flatten(FIXTURE_CERT_PEM) },
      new Date('2026-07-31T12:00:00Z'),
    )
    expect(health.authCert.present).toBe(true)
    expect(health.authCert.notAfter).toBe('2027-07-31')
    expect(health.warnings).not.toContain('auth_cert_unreadable')
  })

  it('credential health flags a stored certificate that cannot be parsed at all', () => {
    const health = assessCredentialHealth({ authCertPem: 'garbage-not-a-cert' }, new Date('2026-07-31T12:00:00Z'))
    expect(health.authCert.present).toBe(true)
    expect(health.authCert.notAfter).toBeNull()
    expect(health.warnings).toContain('auth_cert_unreadable')
  })

  it('credential health flags an unreadable offline certificate independently', () => {
    const health = assessCredentialHealth({ offlineCertPem: 'garbage' }, new Date('2026-07-31T12:00:00Z'))
    expect(health.warnings).toContain('offline_cert_unreadable')
    expect(health.warnings).not.toContain('auth_cert_unreadable')
  })
})
