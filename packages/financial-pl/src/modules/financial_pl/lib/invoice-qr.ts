/**
 * KSeF verification QR PNG generation (isolated so the pdf renderer stays a sync
 * byte-layout). Used for BOTH KOD I (online/offline verification URL) and the
 * offline KOD II (cert-signed) URL — the rendering is identical; only the encoded
 * URL differs, so a single generic encoder serves both.
 */
import QRCode from 'qrcode'

/** Render a URL to a PNG QR code (error-correction M) as raw bytes. Used for KOD I and KOD II. */
export async function generateQrPng(url: string): Promise<Uint8Array> {
  const buf = await QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 240 })
  return new Uint8Array(buf)
}
