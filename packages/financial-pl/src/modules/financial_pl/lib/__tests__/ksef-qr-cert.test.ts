import { webcrypto } from 'node:crypto'
import { buildKodIICanonicalString, buildKodIIUrl } from '../ksef-qr-cert'
import { ksefInvoiceHashBase64Url } from '../ksef-qr'

const XML = '<Faktura><Nr>OM-OFFLINE-1</Nr></Faktura>'
const SELLER_NIP = '2481632647'
const CERT_SERIAL = '0a1b2c3d4e5f'
const CONTEXT_VALUE = '2481632647'

function derToPem(der: Buffer, label: string): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

async function generateRsaPssKeyPem(): Promise<{ privateKeyPem: string; publicKey: webcrypto.CryptoKey }> {
  const kp = (await webcrypto.subtle.generateKey(
    { name: 'RSA-PSS', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as webcrypto.CryptoKeyPair
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey))
  return { privateKeyPem: derToPem(pkcs8, 'PRIVATE KEY'), publicKey: kp.publicKey }
}

async function generateEcKeyPem(): Promise<{ privateKeyPem: string; publicKey: webcrypto.CryptoKey }> {
  const kp = (await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as webcrypto.CryptoKeyPair
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey))
  return { privateKeyPem: derToPem(pkcs8, 'PRIVATE KEY'), publicKey: kp.publicKey }
}

describe('KOD II QR (certificate-signed)', () => {
  it('builds the canonical signed string per the official template (segments/order, no scheme, no trailing slash)', () => {
    const canonical = buildKodIICanonicalString({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
    })
    expect(canonical).toBe(
      `qr-test.ksef.mf.gov.pl/certificate/Nip/${CONTEXT_VALUE}/${SELLER_NIP}/${CERT_SERIAL}/${ksefInvoiceHashBase64Url(XML)}`,
    )
    expect(canonical).not.toMatch(/^https?:\/\//)
    expect(canonical.endsWith('/')).toBe(false)
    // Exactly 7 segments: host + certificate + ContextType + ContextValue + sellerNip + certSerial + invoiceHash.
    expect(canonical.split('/')).toHaveLength(7)
  })

  it('defaults the ContextType to Nip and honors an explicit context type', () => {
    const explicit = buildKodIICanonicalString({
      environment: 'test',
      contextType: 'InternalId',
      contextValue: 'internal-abc',
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
    })
    expect(explicit).toContain('/certificate/InternalId/internal-abc/')
  })

  it('uses the prod QR host for prod (still scheme-less)', () => {
    const canonical = buildKodIICanonicalString({
      environment: 'prod',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
    })
    expect(canonical.startsWith('qr.ksef.mf.gov.pl/certificate/')).toBe(true)
  })

  it('appends a base64url signature segment (no +/= padding) for RSA-PSS', async () => {
    const { privateKeyPem } = await generateRsaPssKeyPem()
    const url = await buildKodIIUrl({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
      offlineCertificatePrivateKeyPem: privateKeyPem,
      algorithm: 'RSA',
    })
    const canonical = buildKodIICanonicalString({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
    })
    expect(url.startsWith(`${canonical}/`)).toBe(true)
    const signatureSegment = url.slice(canonical.length + 1)
    expect(signatureSegment).not.toMatch(/[+/=]/)
    expect(signatureSegment).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(signatureSegment).not.toContain('/')
  })

  it('produces an RSA-PSS (SHA-256, saltLength 32) signature that verifies against the public key', async () => {
    const { privateKeyPem, publicKey } = await generateRsaPssKeyPem()
    const url = await buildKodIIUrl({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
      offlineCertificatePrivateKeyPem: privateKeyPem,
      algorithm: 'RSA',
    })
    const canonical = buildKodIICanonicalString({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
    })
    const signatureSegment = url.slice(canonical.length + 1)
    const sigBytes = Buffer.from(signatureSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const ok = await webcrypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 32 },
      publicKey,
      sigBytes,
      Buffer.from(canonical, 'utf8'),
    )
    expect(ok).toBe(true)
  })

  it('produces an ECDSA (SHA-256, P1363 raw) signature that verifies against the public key', async () => {
    const { privateKeyPem, publicKey } = await generateEcKeyPem()
    const url = await buildKodIIUrl({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
      offlineCertificatePrivateKeyPem: privateKeyPem,
      algorithm: 'EC',
    })
    const canonical = buildKodIICanonicalString({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
    })
    const signatureSegment = url.slice(canonical.length + 1)
    const sigBytes = Buffer.from(signatureSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    // IEEE P1363 raw for P-256 is exactly 64 bytes (r||s).
    expect(sigBytes.length).toBe(64)
    const ok = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      Buffer.from(canonical, 'utf8'),
    )
    expect(ok).toBe(true)
  })

  it('reuses the KOD I invoice hash (identical base64url SHA-256 of the XML)', () => {
    const canonical = buildKodIICanonicalString({
      environment: 'test',
      contextValue: CONTEXT_VALUE,
      sellerNip: SELLER_NIP,
      certSerial: CERT_SERIAL,
      invoiceXml: XML,
    })
    expect(canonical.endsWith(`/${ksefInvoiceHashBase64Url(XML)}`)).toBe(true)
  })
})
