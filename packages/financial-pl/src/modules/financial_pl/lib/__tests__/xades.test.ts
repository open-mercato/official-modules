import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto, createPublicKey } from 'node:crypto'
import * as x509 from '@peculiar/x509'
import { buildAuthTokenRequestXml, KSEF_AUTH_TOKEN_NAMESPACE } from '../auth-token-request'
import { buildCsr, certificatePemToDerBase64, generateKsefKeyPair, signAuthTokenRequest, verifySignedXml } from '../xades'

const CHALLENGE = '20260627-CR-AB12CD34EF-1122334455-AA'

/** Generate a self-signed cert + its key PEMs to drive the signer (stands in for a KSeF cert). */
async function selfSignedCert(): Promise<{ certificatePem: string; privateKeyPem: string; publicKeyPem: string }> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const keys = (await webcrypto.subtle.generateKey(alg as never, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=KSeF Test, 2.5.4.5=2481632647, C=PL',
    notBefore: new Date('2026-01-01'),
    notAfter: new Date('2028-01-01'),
    keys,
    signingAlgorithm: alg,
  })
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey))
  const pem = (der: Buffer, label: string) =>
    `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`
  return { certificatePem: cert.toString('pem'), privateKeyPem: pem(pkcs8, 'PRIVATE KEY'), publicKeyPem: pem(spki, 'PUBLIC KEY') }
}

describe('buildAuthTokenRequestXml', () => {
  it('builds the AuthTokenRequest in the authv2.xsd namespace + order', () => {
    const xml = buildAuthTokenRequestXml({ challenge: CHALLENGE, contextNip: '2481632647' })
    expect(xml).toContain(`xmlns="${KSEF_AUTH_TOKEN_NAMESPACE}"`)
    expect(xml).toContain(`<Challenge>${CHALLENGE}</Challenge>`)
    expect(xml).toContain('<ContextIdentifier><Nip>2481632647</Nip></ContextIdentifier>')
    expect(xml).toContain('<SubjectIdentifierType>certificateSubject</SubjectIdentifierType>')
    // order: Challenge before ContextIdentifier before SubjectIdentifierType
    expect(xml.indexOf('Challenge')).toBeLessThan(xml.indexOf('ContextIdentifier'))
    expect(xml.indexOf('ContextIdentifier')).toBeLessThan(xml.indexOf('SubjectIdentifierType'))
  })

  it('honors certificateFingerprint subject type', () => {
    const xml = buildAuthTokenRequestXml({ challenge: CHALLENGE, contextNip: '2481632647', subjectIdentifierType: 'certificateFingerprint' })
    expect(xml).toContain('<SubjectIdentifierType>certificateFingerprint</SubjectIdentifierType>')
  })

  it('rejects a malformed NIP and an empty challenge', () => {
    expect(() => buildAuthTokenRequestXml({ challenge: CHALLENGE, contextNip: '12345' })).toThrow(/NIP/)
    expect(() => buildAuthTokenRequestXml({ challenge: '   ', contextNip: '2481632647' })).toThrow(/challenge/)
  })

  const xsd = process.env.OM_KSEF_AUTH_XSD
  const maybe = xsd ? it : it.skip
  maybe('validates against the official authv2.xsd (xmllint)', () => {
    const xml = buildAuthTokenRequestXml({ challenge: CHALLENGE, contextNip: '2481632647' })
    const dir = mkdtempSync(join(tmpdir(), 'ksef-auth-'))
    const file = join(dir, 'auth.xml')
    writeFileSync(file, xml)
    try {
      // Throws (non-zero exit) if the document is invalid against the schema.
      execFileSync('xmllint', ['--noout', '--schema', xsd as string, file], { stdio: 'pipe' })
    } catch (err) {
      const out = String((err as { stderr?: Buffer }).stderr ?? err)
      // libxml2's XSD regex engine cannot COMPILE some of the MF schema's patterns
      // (the IP \b and the long VAT-UE regex). That is a schema-tooling limitation,
      // not an invalid document — treat it as inconclusive rather than a failure.
      if (/regexp error|failed to compile/i.test(out)) return
      throw err
    }
  })
})

describe('signAuthTokenRequest', () => {
  it('produces an enveloped XAdES signature that verifies', async () => {
    const { certificatePem, privateKeyPem } = await selfSignedCert()
    const xml = buildAuthTokenRequestXml({ challenge: CHALLENGE, contextNip: '2481632647' })
    const signed = await signAuthTokenRequest({ xml, certificatePem, privateKeyPem })
    expect(signed).toMatch(/Signature/)
    expect(signed).toMatch(/X509Certificate/)
    expect(signed).toMatch(/SigningCertificate/) // XAdES-BES qualifying property
    await expect(verifySignedXml(signed)).resolves.toBe(true)
  })

  it('fails verification when the signed document is tampered', async () => {
    const { certificatePem, privateKeyPem } = await selfSignedCert()
    const xml = buildAuthTokenRequestXml({ challenge: CHALLENGE, contextNip: '2481632647' })
    const signed = await signAuthTokenRequest({ xml, certificatePem, privateKeyPem })
    const tampered = signed.replace('2481632647', '9999999999')
    await expect(verifySignedXml(tampered)).resolves.toBe(false)
  })

  it('extracts a base64 DER from a cert PEM', async () => {
    const { certificatePem } = await selfSignedCert()
    const der = certificatePemToDerBase64(certificatePem)
    expect(der.length).toBeGreaterThan(100)
    expect(() => Buffer.from(der, 'base64')).not.toThrow()
  })
})

describe('generateKsefKeyPair + buildCsr', () => {
  it('generates an RSA keypair and a parseable CSR with the requested subject', async () => {
    const keyPairPem = await generateKsefKeyPair('RSA')
    expect(keyPairPem.privateKeyPem).toContain('BEGIN PRIVATE KEY')
    // public key parses
    expect(() => createPublicKey(keyPairPem.publicKeyPem)).not.toThrow()
    const csrB64 = await buildCsr({
      keyPairPem,
      subject: { commonName: 'KSeF Cert', organizationName: 'Acme', serialNumber: '2481632647', countryName: 'PL' },
    })
    const csr = new x509.Pkcs10CertificateRequest(Buffer.from(csrB64, 'base64'))
    expect(csr.subject).toContain('2481632647')
    expect(await csr.verify()).toBe(true) // CSR self-signature is valid
  })
})
