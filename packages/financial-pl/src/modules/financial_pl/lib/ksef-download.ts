'use client'

import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

export type KsefDownloadOutcome =
  | { ok: true }
  | { ok: false; error?: string; code?: string; status: number }

/**
 * Fetch a KSeF binary (invoice PDF, UPO, JPK XML) through the sanctioned `apiCall` client and open
 * it as a blob on success, distinguishing a real document from a JSON error body. Previously these
 * downloads `window.open`ed the API URL directly, so a non-2xx JSON response (e.g. a 422
 * `seller_required`) rendered as raw JSON in a new browser tab (QA #39). No raw `fetch`.
 *
 * On failure the parsed `{ error, code }` is returned so the caller can flash a translated,
 * actionable message (and link to seller/KSeF configuration) instead of leaking the raw body.
 */
function downloadNameFor(mime: string): string {
  if (mime.includes('pdf')) return 'invoice.pdf'
  if (mime.includes('xml')) return 'document.xml'
  return 'download'
}

export async function openKsefDownload(href: string): Promise<KsefDownloadOutcome> {
  const res = await apiCall<Blob | { error?: string; code?: string }>(
    href,
    { method: 'GET' },
    { parse: async (r) => (r.ok ? await r.blob() : ((await r.json().catch(() => null)) as { error?: string; code?: string } | null)) },
  )
  if (res.ok && res.result instanceof Blob) {
    if (typeof document !== 'undefined') {
      const url = URL.createObjectURL(res.result)
      // Trigger the download via a programmatic <a download> click rather than window.open: opening a
      // new window AFTER the awaited fetch is treated as a non-user-gesture popup and is commonly
      // blocked (council F-29/F-34). A download link is never popup-blocked, and these are all
      // "Download PDF / UPO / XML" actions.
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = downloadNameFor(res.result.type)
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
    return { ok: true }
  }
  const body = res.result && !(res.result instanceof Blob) ? res.result : null
  return {
    ok: false,
    error: typeof body?.error === 'string' ? body.error : undefined,
    code: typeof body?.code === 'string' ? body.code : undefined,
    status: res.status,
  }
}
