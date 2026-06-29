/**
 * KSeF 2.0 certificate-path cryptography: XAdES signing of the `AuthTokenRequest`
 * and the keypair + PKCS#10 CSR used to enroll a KSeF certificate.
 *
 * KSeF authenticates a system either with a token (see `crypto.ts`) or with a
 * certificate / qualified signature. The certificate path signs the
 * `AuthTokenRequest` (auth-token-request.ts) as an **enveloped XAdES-BES**
 * signature and posts it to `/auth/xades-signature`. From 2027-01-01 the KSeF
 * certificate is the only remaining credential (tokens sunset 2026-12-31), so
 * this path is the durable one.
 *
 * Implemented with `xadesjs` (vetted XML-DSig/XAdES, used across EU e-gov) over
 * Node's built-in WebCrypto, and `@peculiar/x509` for the CSR. Hand-rolling XML
 * canonicalization for a legally-binding signature is unacceptable risk, so a
 * library is used here (the protocol-mandated AES/RSA stay in crypto.ts, §16).
 *
 * Pure with respect to the platform (no DB / DI / network) so the signer is
 * unit-testable offline: the produced signature verifies, and the signed
 * `AuthTokenRequest` validates against the official authv2.xsd with xmllint.
 */
import { createPrivateKey, webcrypto, X509Certificate } from 'node:crypto'
import * as xadesjs from 'xadesjs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

// xadesjs/xmldsigjs need a WebCrypto engine and the DOM globals (Node has no
// global DOMParser/XMLSerializer). Wire them once, idempotently, at first use.
// `@peculiar/x509` (CSR path only) is loaded lazily in buildCsr so the hot auth
// signing path does not drag in tsyringe/reflect-metadata.
let engineReady = false
function ensureEngine(): void {
  if (engineReady) return
  xadesjs.Application.setEngine('NodeJS', webcrypto as unknown as Crypto)
  const g = globalThis as unknown as { DOMParser?: unknown; XMLSerializer?: unknown }
  if (!g.DOMParser) g.DOMParser = DOMParser
  if (!g.XMLSerializer) g.XMLSerializer = XMLSerializer
  engineReady = true
}

export type KsefKeyAlgorithm = 'RSA' | 'EC'

export type KsefKeyPairPem = {
  privateKeyPem: string
  publicKeyPem: string
  algorithm: KsefKeyAlgorithm
}

export type KsefCsrSubject = {
  /** X.500 attributes, in the order returned by GET /certificates/enrollments/data. */
  commonName?: string
  countryName?: string
  organizationName?: string
  /** OID 2.5.4.5 — the taxpayer NIP/PESEL serial KSeF embeds in the cert subject. */
  serialNumber?: string
  /** OID 2.5.4.45 — the KSeF uniqueIdentifier. */
  uniqueIdentifier?: string
  /** OID 2.5.4.97 — organizationIdentifier (VATPL-NIP). */
  organizationIdentifier?: string
}

function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

function pemBodyToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

/** The base64 DER of an X.509 cert PEM, for KeyInfo/X509Data and the XAdES SigningCertificate. */
export function certificatePemToDerBase64(certificatePem: string): string {
  // Validates it parses as a real X.509 cert (throws on garbage) and normalizes
  // any extra PEM whitespace.
  const cert = new X509Certificate(certificatePem)
  return cert.raw.toString('base64')
}

/**
 * Import a PEM private key into a WebCrypto signing key, deriving the matching
 * signature algorithm from the key type (RSA → RSASSA-PKCS1-v1_5 / SHA-256;
 * EC P-256 → ECDSA / SHA-256). Both are accepted by KSeF per the enrollment spec.
 */
async function importSigningKey(
  privateKeyPem: string,
): Promise<{ key: webcrypto.CryptoKey; algorithm: { name: string; hash: string } }> {
  const keyObject = createPrivateKey(privateKeyPem)
  const pkcs8 = keyObject.export({ format: 'der', type: 'pkcs8' }) as Buffer
  if (keyObject.asymmetricKeyType === 'rsa' || keyObject.asymmetricKeyType === 'rsa-pss') {
    const key = await webcrypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    return { key, algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } }
  }
  if (keyObject.asymmetricKeyType === 'ec') {
    const key = await webcrypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    return { key, algorithm: { name: 'ECDSA', hash: 'SHA-256' } }
  }
  throw new Error(`[internal] unsupported KSeF signing key type: ${keyObject.asymmetricKeyType}`)
}

export type SignAuthTokenRequestInput = {
  /** The unsigned AuthTokenRequest XML (from buildAuthTokenRequestXml). */
  xml: string
  /** The KSeF authentication certificate (PEM) that pairs with the private key. */
  certificatePem: string
  /** The certificate's private key (PEM). */
  privateKeyPem: string
}

/**
 * Produce the enveloped XAdES-BES signature over the AuthTokenRequest and return
 * the full signed XML string for `POST /auth/xades-signature`. The signer cert is
 * embedded both in KeyInfo/X509Data and the XAdES SigningCertificate qualifying
 * property so KSeF can verify the signature and bind it to the subject.
 */
export async function signAuthTokenRequest(input: SignAuthTokenRequestInput): Promise<string> {
  ensureEngine()
  const certDerBase64 = certificatePemToDerBase64(input.certificatePem)
  const { key, algorithm } = await importSigningKey(input.privateKeyPem)

  const doc = xadesjs.Parse(input.xml)
  const signed = new xadesjs.SignedXml()
  // Node's webcrypto CryptoKey and the DOM lib's CryptoKey are structurally the
  // same but nominally distinct under the package tsconfig — bridge at the boundary.
  await signed.Sign(algorithm, key as unknown as CryptoKey, doc, {
    references: [{ uri: '', hash: 'SHA-256', transforms: ['enveloped', 'c14n'] }],
    x509: [certDerBase64],
    signingCertificate: certDerBase64,
  })
  // Enveloped: append the <Signature> into the AuthTokenRequest root.
  const root = doc.documentElement
  if (!root) throw new Error('[internal] AuthTokenRequest XML has no root element')
  root.appendChild(signed.XmlSignature.GetXml() as unknown as Node)
  return new XMLSerializer().serializeToString(doc)
}

/**
 * Verify a signed AuthTokenRequest using the certificate embedded in KeyInfo
 * (used by unit tests; KSeF performs the authoritative check server-side).
 */
export async function verifySignedXml(signedXml: string): Promise<boolean> {
  ensureEngine()
  const doc = xadesjs.Parse(signedXml)
  const sig = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0]
  if (!sig) return false
  const verifier = new xadesjs.SignedXml(doc)
  verifier.LoadXml(sig)
  try {
    return await verifier.Verify()
  } catch {
    // xmldsigjs throws (e.g. "Invalid digest") on a tampered/mismatched signature;
    // for a boolean utility that is simply "not verified".
    return false
  }
}

/** Generate a fresh signing keypair for certificate enrollment, returned as PEM. */
export async function generateKsefKeyPair(algorithm: KsefKeyAlgorithm = 'RSA'): Promise<KsefKeyPairPem> {
  const params =
    algorithm === 'EC'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const kp = (await webcrypto.subtle.generateKey(params as never, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey))
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey))
  return {
    privateKeyPem: derToPem(pkcs8, 'PRIVATE KEY'),
    publicKeyPem: derToPem(spki, 'PUBLIC KEY'),
    algorithm,
  }
}

/**
 * Build a PKCS#10 CSR (DER, Base64) for a KSeF certificate enrollment. The subject
 * DN attributes MUST mirror, in order, what GET /certificates/enrollments/data
 * returned for the authenticated subject.
 */
export async function buildCsr(params: { keyPairPem: KsefKeyPairPem; subject: KsefCsrSubject }): Promise<string> {
  // `@peculiar/x509` needs reflect-metadata (tsyringe); load both lazily so only
  // the enrollment path pays for it. reflect-metadata MUST evaluate before x509.
  await import('reflect-metadata')
  const x509 = await import('@peculiar/x509')
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const { keyPairPem, subject } = params
  const signingAlgorithm =
    keyPairPem.algorithm === 'EC'
      ? { name: 'ECDSA', hash: 'SHA-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  const keyAlg =
    keyPairPem.algorithm === 'EC'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const privateKey = await webcrypto.subtle.importKey('pkcs8', pemBodyToDer(keyPairPem.privateKeyPem), keyAlg as never, false, ['sign'])
  const publicKey = await webcrypto.subtle.importKey('spki', pemBodyToDer(keyPairPem.publicKeyPem), keyAlg as never, true, ['verify'])

  // DN attribute VALUES are taken verbatim from GET /certificates/enrollments/data
  // (never invented). The RDN order below follows the KSeF cert subject convention
  // (CN, O, organizationIdentifier 2.5.4.97, serialNumber 2.5.4.5, uniqueIdentifier
  // 2.5.4.45, C); the exact accepted order is confirmed in the live enrollment
  // round-trip (handoff) — KSeF validates the CSR before issuing. Only present fields
  // are emitted, so a field KSeF did not return is never fabricated.
  const attrs: Array<Record<string, string[]>> = []
  if (subject.commonName) attrs.push({ CN: [subject.commonName] })
  if (subject.organizationName) attrs.push({ O: [subject.organizationName] })
  if (subject.organizationIdentifier) attrs.push({ '2.5.4.97': [subject.organizationIdentifier] })
  if (subject.serialNumber) attrs.push({ '2.5.4.5': [subject.serialNumber] })
  if (subject.uniqueIdentifier) attrs.push({ '2.5.4.45': [subject.uniqueIdentifier] })
  if (subject.countryName) attrs.push({ C: [subject.countryName] })

  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: new x509.Name(attrs as never).toString(),
    keys: { privateKey: privateKey as unknown as CryptoKey, publicKey: publicKey as unknown as CryptoKey },
    signingAlgorithm,
  })
  return Buffer.from(csr.rawData).toString('base64')
}
