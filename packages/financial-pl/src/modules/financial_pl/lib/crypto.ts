/**
 * KSeF 2.0 cryptography primitives.
 *
 * The KSeF 2.0 protocol mandates a specific scheme (the official MF
 * CIRFMF/ksef-client-csharp & ksef-client-java `CryptographyService` is the
 * reference implementation we mirror):
 *  - Invoice/document body: AES-256-CBC with PKCS#7 padding, random 256-bit key
 *    and random 128-bit IV. The IV is supplied once when opening the session
 *    (`encryptionInfo.initializationVector`); each document is the raw ciphertext.
 *  - The AES key is wrapped with RSA-OAEP (MGF1-SHA256) using the MF
 *    `SymmetricKeyEncryption` public key.
 *  - The KSeF authorization token is wrapped as RSA-OAEP-SHA256 of
 *    `"{ksefToken}|{challengeTimestampMs}"` using the MF `KsefTokenEncryption` key.
 *  - SHA-256 hashes of both the plaintext and the ciphertext accompany each send.
 *
 * This module is pure (Node `crypto` only) so it is fully unit-testable offline.
 * It is the ONLY place hand-written AES/RSA is allowed (protocol-mandated, §16).
 */
import {
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  constants as cryptoConstants,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'

export const AES_KEY_BYTES = 32
export const AES_IV_BYTES = 16

export type SymmetricKeyMaterial = {
  key: Buffer
  iv: Buffer
}

export type DocumentHashes = {
  /** SHA-256 of the plaintext invoice XML, Base64. */
  invoiceHash: string
  /** Byte length of the plaintext invoice XML. */
  invoiceSize: number
  /** SHA-256 of the encrypted document bytes, Base64. */
  encryptedDocumentHash: string
  /** Byte length of the encrypted document bytes. */
  encryptedDocumentSize: number
}

export function generateSymmetricKey(): SymmetricKeyMaterial {
  return { key: randomBytes(AES_KEY_BYTES), iv: randomBytes(AES_IV_BYTES) }
}

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}

export function sha256Base64(data: Buffer): string {
  return sha256(data).toString('base64')
}

/** AES-256-CBC + PKCS#7 padding. Returns raw ciphertext (no IV prefix). */
export function aes256CbcEncrypt(plaintext: Buffer, material: SymmetricKeyMaterial): Buffer {
  if (material.key.length !== AES_KEY_BYTES) {
    throw new Error('[internal] KSeF AES key must be 32 bytes (AES-256)')
  }
  if (material.iv.length !== AES_IV_BYTES) {
    throw new Error('[internal] KSeF AES IV must be 16 bytes')
  }
  const cipher = createCipheriv('aes-256-cbc', material.key, material.iv)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * Parse an MF public key (Base64) into a public KeyObject. Accepts an X.509 DER
 * certificate (the usual KSeF response) or a raw SubjectPublicKeyInfo (SPKI) DER.
 */
export function publicKeyFromCertificate(certBase64Der: string): KeyObject {
  const der = Buffer.from(certBase64Der, 'base64')
  try {
    return new X509Certificate(der).publicKey
  } catch {
    return createPublicKey({ key: der, format: 'der', type: 'spki' })
  }
}

/** RSA-OAEP with MGF1-SHA256. Accepts a KeyObject or a Base64 X.509 DER certificate. */
export function rsaOaepEncrypt(plaintext: Buffer, publicKey: KeyObject | string): Buffer {
  const key = typeof publicKey === 'string' ? publicKeyFromCertificate(publicKey) : publicKey
  return publicEncrypt(
    { key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    plaintext,
  )
}

/**
 * RSA PKCS#1 v1.5 key transport for the MF JPK gateway (SPEC-015 F2). Encrypts the raw AES session
 * key bytes with the MF JPK public certificate using PKCS#1 v1.5 padding (the JPK InitUpload metadata
 * labels this algorithm=RSA mode=ECB padding=PKCS#1). Distinct from the KSeF OAEP path above.
 */
export function rsaPkcs1v15WrapKey(aesKey: Buffer, publicCertPem: string): Buffer {
  const key = new X509Certificate(publicCertPem).publicKey
  return publicEncrypt({ key, padding: cryptoConstants.RSA_PKCS1_PADDING }, aesKey)
}

/** Wrap the session AES key for the MF SymmetricKeyEncryption public key (Base64). */
export function wrapSymmetricKey(material: SymmetricKeyMaterial, publicKey: KeyObject | string): string {
  return rsaOaepEncrypt(material.key, publicKey).toString('base64')
}

/**
 * Encrypt the KSeF authorization token for the challenge response.
 * Payload is `"{ksefToken}|{challengeTimestampMs}"`, RSA-OAEP-SHA256 wrapped.
 */
export function encryptAuthToken(
  ksefToken: string,
  challengeTimestampMs: number,
  publicKey: KeyObject | string,
): string {
  const payload = Buffer.from(`${ksefToken}|${challengeTimestampMs}`, 'utf8')
  return rsaOaepEncrypt(payload, publicKey).toString('base64')
}

/** Encrypt an invoice XML document and compute the four hashes/sizes KSeF requires. */
export function encryptInvoiceDocument(
  invoiceXml: string,
  material: SymmetricKeyMaterial,
): { encryptedDocument: Buffer } & DocumentHashes {
  const plaintext = Buffer.from(invoiceXml, 'utf8')
  const encryptedDocument = aes256CbcEncrypt(plaintext, material)
  return {
    encryptedDocument,
    invoiceHash: sha256Base64(plaintext),
    invoiceSize: plaintext.length,
    encryptedDocumentHash: sha256Base64(encryptedDocument),
    encryptedDocumentSize: encryptedDocument.length,
  }
}
