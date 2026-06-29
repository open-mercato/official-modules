/**
 * KSeF KOD I (invoice-verification) QR URL builder.
 *
 * Per the official `kody-qr` spec, KOD I encodes:
 *   {qrHost}/invoice/{sellerNip}/{DD-MM-YYYY}/{base64url(SHA-256 of the FA(3) XML)}
 * It applies to BOTH online and offline invoices; the QR is labelled with the
 * KSeF number when assigned, otherwise "OFFLINE". The hash MUST be of the exact
 * invoice XML bytes registered in KSeF, so callers pass the stored `invoice_xml`
 * of the accepted submission (byte-stable per SPEC-005/007).
 *
 * Pure: reuses the protocol SHA-256 from crypto.ts and only adds base64url
 * formatting + the URL template (no new hand-rolled crypto, §16).
 */
import { sha256 } from './crypto'
import { resolveKsefQrHost, type KsefEnvironment } from '../config'

/** Base64URL (RFC 4648 §5): base64 with -/_ and no padding. */
export function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url(SHA-256(utf8 invoice XML)) — the KOD I file hash. */
export function ksefInvoiceHashBase64Url(invoiceXml: string): string {
  return toBase64Url(sha256(Buffer.from(invoiceXml, 'utf8')))
}

/** Convert an ISO `YYYY-MM-DD` (the FA(3) issue date) to the KOD I `DD-MM-YYYY`. */
export function toKodIDate(issueDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(issueDate.trim())
  if (!m) throw new Error('[internal] KOD I requires an ISO issue date (YYYY-MM-DD)')
  return `${m[3]}-${m[2]}-${m[1]}`
}

/**
 * Build the KOD I verification URL for an invoice. `sellerNip` is the 10-digit
 * seller NIP; `issueDate` is the FA(3) ISO issue date; `invoiceXml` is the exact
 * registered FA(3) document.
 */
export function buildKodIUrl(params: {
  environment: KsefEnvironment
  sellerNip: string
  issueDate: string
  invoiceXml: string
}): string {
  const host = resolveKsefQrHost(params.environment)
  return `${host}/invoice/${params.sellerNip}/${toKodIDate(params.issueDate)}/${ksefInvoiceHashBase64Url(params.invoiceXml)}`
}
