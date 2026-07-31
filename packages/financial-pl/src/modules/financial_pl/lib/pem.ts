/**
 * Tolerant PEM normalization for operator-pasted credential material.
 *
 * The `ksef_pl` credential PEMs (auth/offline/JPK-signer certs and keys) are pasted into form
 * fields, and two real-world corruptions arrive with the paste: single-line inputs strip every
 * newline (`-----BEGIN CERTIFICATE-----MIID…` — OpenSSL then fails with "no start line"), and
 * copies that went through JSON or logs carry literal `\n` text instead of newlines. Both are
 * deterministically recoverable — the `-----BEGIN/END <LABEL>-----` markers plus the base64 body
 * carry all the information — so every consumer of stored PEMs runs input through here instead of
 * rejecting a credential the operator cannot tell is broken.
 *
 * Text without PEM markers is returned unchanged: this function repairs shape, it does not judge
 * content — downstream parsers still decide validity and report their own errors.
 */

const PEM_HEADER_RE = /-----BEGIN [A-Z0-9 ]+-----/
const PEM_BLOCK_RE = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g

export function normalizePem(raw: string): string {
  if (!raw) return raw
  // Literal backslash-n text (a paste that went through JSON) becomes real newlines first.
  const candidate = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
  if (!PEM_HEADER_RE.test(candidate)) return raw
  const blocks: string[] = []
  for (const match of candidate.matchAll(PEM_BLOCK_RE)) {
    const label = match[1]
    const body = match[2].replace(/\s+/g, '')
    const lines = body.match(/.{1,64}/g) ?? []
    blocks.push(`-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`)
  }
  // A header without its matching footer is not repairable — hand it through untouched.
  if (blocks.length === 0) return raw
  return blocks.join('\n')
}
