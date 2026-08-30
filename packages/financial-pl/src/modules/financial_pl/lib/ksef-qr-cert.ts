/**
 * KSeF KOD II (certificate-signed) QR URL builder.
 *
 * KOD II is the second QR rendered on an offline-issued invoice (alongside the
 * KOD I verification QR). Per the official `kody-qr` spec it encodes:
 *   {qrHost}/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}/{signature}
 * The signature is made by the seller's **Offline** KSeF certificate over the
 * canonical URL fragment up to and including the invoice hash (NOT over the raw
 * XML) — a *different* signature from the XAdES Authentication path (which uses
 * RSA-PKCS1-v1_5). KOD II mandates:
 *   - RSA → RSASSA-PSS, SHA-256, MGF1-SHA-256, 32-byte salt.
 *   - EC P-256 → ECDSA, SHA-256 (WebCrypto already yields the IEEE P1363 raw form).
 *
 * Pure: reuses the protocol `sha256` (crypto.ts) and `ksefInvoiceHashBase64Url`
 * + `toBase64Url` (ksef-qr.ts, the same hash as KOD I). No hand-rolled crypto
 * beyond the WebCrypto signing call (§16).
 */
import { createPrivateKey, webcrypto } from 'node:crypto'
import { resolveKsefQrHost, type KsefEnvironment } from '../config'
import { ksefInvoiceHashBase64Url, toBase64Url } from './ksef-qr'

/** KSeF QR context types for the KOD II `/certificate/{ContextType}/…` segment. */
export type KsefContextType = 'Nip' | 'InternalId' | 'NipVatUe' | 'PeppolId'

/** Key algorithm of the Offline certificate signing KOD II. */
export type KsefKodIIAlgorithm = 'RSA' | 'EC'

export type BuildKodIIUrlParams = {
  environment: KsefEnvironment
  /** Context type segment; defaults to 'Nip'. */
  contextType?: KsefContextType
  /** Context value (the org/seller NIP for a standard 'Nip' context). */
  contextValue: string
  /** The 10-digit seller NIP. */
  sellerNip: string
  /** The Offline cert serial (hex), as the 5th segment. */
  certSerial: string
  /** The exact registered FA(3) XML; hashed identically to KOD I. */
  invoiceXml: string
  /** The Offline certificate's private key (PEM, PKCS#8 or PKCS#1/SEC1). */
  offlineCertificatePrivateKeyPem: string
  /** The Offline key algorithm: RSA → RSA-PSS, EC → ECDSA P-256. */
  algorithm: KsefKodIIAlgorithm
}

/**
 * Sign the canonical KOD II string with the Offline private key and return the
 * raw signature bytes. RSA uses RSASSA-PSS (SHA-256, 32-byte salt); EC uses
 * ECDSA (SHA-256), which WebCrypto emits in the IEEE P1363 raw form KSeF expects.
 */
async function signKodII(
  canonical: string,
  privateKeyPem: string,
  algorithm: KsefKodIIAlgorithm,
): Promise<Buffer> {
  const keyObject = createPrivateKey(privateKeyPem)
  const pkcs8 = keyObject.export({ format: 'der', type: 'pkcs8' }) as Buffer
  const data = Buffer.from(canonical, 'utf8')
  if (algorithm === 'RSA') {
    const key = await webcrypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await webcrypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, data)
    return Buffer.from(sig)
  }
  const key = await webcrypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data)
  return Buffer.from(sig)
}

/** Strip the URL scheme from the QR host so the canonical KOD II string carries none. */
function hostWithoutScheme(environment: KsefEnvironment): string {
  return resolveKsefQrHost(environment).replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/**
 * Build the canonical (scheme-less, no trailing slash) KOD II string that is the
 * subject of the certificate signature:
 *   {host}/certificate/{ContextType}/{ContextValue}/{sellerNip}/{certSerial}/{invoiceHash}
 * The invoice hash reuses `ksefInvoiceHashBase64Url` (identical to KOD I).
 */
export function buildKodIICanonicalString(params: {
  environment: KsefEnvironment
  contextType?: KsefContextType
  contextValue: string
  sellerNip: string
  certSerial: string
  invoiceXml: string
}): string {
  const host = hostWithoutScheme(params.environment)
  const contextType = params.contextType ?? 'Nip'
  const invoiceHash = ksefInvoiceHashBase64Url(params.invoiceXml)
  return `${host}/certificate/${contextType}/${params.contextValue}/${params.sellerNip}/${params.certSerial}/${invoiceHash}`
}

/**
 * Build the full KOD II QR URL: the canonical string with the base64url-encoded
 * Offline-cert signature appended as the final segment.
 */
export async function buildKodIIUrl(params: BuildKodIIUrlParams): Promise<string> {
  const canonical = buildKodIICanonicalString(params)
  const signature = await signKodII(canonical, params.offlineCertificatePrivateKeyPem, params.algorithm)
  return `${canonical}/${toBase64Url(signature)}`
}
