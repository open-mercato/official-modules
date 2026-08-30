export type PutResult = { ok: boolean; status: number; bodyText?: string }

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * PUT raw bytes to an absolute URL with caller-supplied headers (e.g. Content-MD5, x-ms-blob-type).
 * Time-bounded via AbortController. Never throws on a non-2xx; returns { ok:false, status }.
 */
export async function putToAbsoluteUrl(
  url: string,
  body: Uint8Array | Buffer | string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<PutResult> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, status: 0 }
  } catch {
    return { ok: false, status: 0 }
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0 }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers,
      body: body as BodyInit,
      signal: controller.signal,
    })
    const bodyText = await res.text().catch(() => undefined)
    return bodyText ? { ok: res.ok, status: res.status, bodyText } : { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}
