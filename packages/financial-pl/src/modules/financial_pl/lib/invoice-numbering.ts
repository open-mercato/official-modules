import type { InvoiceNumberingSeries } from '../data/entities'

/**
 * Invoice numbering series — the model decision behind it (PR #29 discussion):
 *
 * A series needs its own gap-free counter. Core already stores one counter per
 * `(organization, tenant, document_kind)` in `sales_document_sequences`, `document_kind` is an
 * unconstrained text key, and core's `salesDocumentNumberGenerator.generate()` accepts both a
 * caller-supplied kind and a caller-supplied format. So each series claims from core under the
 * namespaced kind `invoice:<CODE>` — counter per series, owned and atomically incremented by core
 * (single upsert … returning), no second source of truth in this module. financial_pl keeps only
 * the series metadata (code, name, format) in `InvoiceSettings.numberingSeries`.
 *
 * Collisions: numbers claimed here are rendered from per-series formats that this module validates
 * to be unique per organization and distinct from the system default format; core's unique index
 * `sales_invoices_number_unique (organization_id, tenant_id, invoice_number)` is the hard backstop
 * for anything that slips through (including manually typed numbers). Invoices created without a
 * series keep today's behavior byte-for-byte: no number in the payload, core's default counter
 * assigns it.
 *
 * If core later grows first-class series (a `series` column in the unique key), migrating is one
 * UPDATE: split `document_kind = 'invoice:<CODE>'` into `(kind='invoice', series='<CODE>')`.
 */

/** Counter namespace — `invoice:<CODE>` rows live beside core's plain `invoice` row. */
export const INVOICE_SERIES_KIND_PREFIX = 'invoice:'

/** Longest template we accept; rendered numbers stay well inside KSeF's P_2 limit (256). */
export const SERIES_FORMAT_MAX_LENGTH = 64

/** Tokens a series format may use. Deliberately deterministic-only: {rand}/{nanoid}/{guid} would
 *  break the monotone, explainable numbering a Polish VAT series is expected to keep, and {kind}
 *  would render the internal namespaced kind. */
const ALLOWED_DATE_TOKENS = new Set(['yyyy', 'yy', 'mm', 'dd', 'hh'])

const TOKEN_RE = /\{([a-zA-Z]+)(?::([^}]+))?\}/g

export function normalizeSeriesCode(raw: string): string {
  return raw.trim().toUpperCase()
}

/** The `sales_document_sequences.document_kind` under which this series' counter lives. */
export function seriesDocumentKind(code: string): string {
  return `${INVOICE_SERIES_KIND_PREFIX}${normalizeSeriesCode(code)}`
}

export type SeriesFormatValidation =
  | { ok: true }
  | { ok: false; issue: 'empty' | 'tooLong' | 'missingSeq' }
  | { ok: false; issue: 'invalidToken'; token: string }

export function validateSeriesFormat(format: string): SeriesFormatValidation {
  const value = format.trim()
  if (!value) return { ok: false, issue: 'empty' }
  if (value.length > SERIES_FORMAT_MAX_LENGTH) return { ok: false, issue: 'tooLong' }
  let seqCount = 0
  for (const match of value.matchAll(TOKEN_RE)) {
    const raw = match[0]
    const token = match[1].toLowerCase()
    const arg = match[2]
    if (token === 'seq') {
      // Width must be a plain 1–12 when present; anything else is a typo that would render literally.
      if (arg !== undefined) {
        const width = /^\d{1,2}$/.test(arg.trim()) ? Number(arg.trim()) : NaN
        if (!Number.isFinite(width) || width < 1 || width > 12) return { ok: false, issue: 'invalidToken', token: raw }
      }
      seqCount += 1
      continue
    }
    if (ALLOWED_DATE_TOKENS.has(token) && arg === undefined) continue
    return { ok: false, issue: 'invalidToken', token: raw }
  }
  if (seqCount < 1) return { ok: false, issue: 'missingSeq' }
  return { ok: true }
}

/**
 * Render a number template. Mirrors core's token semantics for the deterministic subset; unknown
 * tokens are left as-is rather than guessed at, so peeking a core-owned template (the system
 * default) never invents a value core would not produce.
 */
export function renderInvoiceNumberTemplate(template: string, sequence: number, date: Date): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return template.replace(TOKEN_RE, (match, rawToken: string, rawArg?: string) => {
    const token = rawToken.toLowerCase()
    const width = Number((rawArg ?? '').trim())
    switch (token) {
      case 'yyyy':
        return String(date.getFullYear())
      case 'yy':
        return String(date.getFullYear()).slice(-2)
      case 'mm':
        return pad(date.getMonth() + 1, 2)
      case 'dd':
        return pad(date.getDate(), 2)
      case 'hh':
        return pad(date.getHours(), 2)
      case 'seq':
        return pad(sequence, Number.isFinite(width) && width > 0 ? width : 1)
      default:
        return match
    }
  })
}

/** Active lookup for claiming/peeking — a deactivated or unknown series fails closed. */
export function findActiveSeries(
  list: InvoiceNumberingSeries[] | null | undefined,
  seriesId: string,
): InvoiceNumberingSeries | null {
  if (!Array.isArray(list)) return null
  const found = list.find((entry) => entry.id === seriesId)
  if (!found) return null
  return found.isActive === false ? null : found
}

export type SeriesListValidation =
  | { ok: true }
  | { ok: false; issue: 'duplicateCode' | 'duplicateFormat' | 'reservedFormat'; value: string }
  | { ok: false; issue: 'multipleDefaults' }

/**
 * Cross-entry rules that make collisions structurally impossible before the DB backstop:
 * duplicate codes would share one counter, duplicate (or default-reserved) formats would render
 * identical numbers from independent counters, and two defaults make the form preselection random.
 */
export function validateSeriesList(
  list: InvoiceNumberingSeries[],
  opts: { reservedFormats?: string[] } = {},
): SeriesListValidation {
  const seenCodes = new Set<string>()
  for (const entry of list) {
    const code = normalizeSeriesCode(entry.code)
    if (seenCodes.has(code)) return { ok: false, issue: 'duplicateCode', value: code }
    seenCodes.add(code)
  }
  const seenFormats = new Set<string>()
  const reserved = new Set((opts.reservedFormats ?? []).map((format) => format.trim()))
  for (const entry of list) {
    const format = entry.format.trim()
    if (seenFormats.has(format)) return { ok: false, issue: 'duplicateFormat', value: format }
    seenFormats.add(format)
    if (reserved.has(format)) return { ok: false, issue: 'reservedFormat', value: format }
  }
  const defaults = list.filter((entry) => entry.isDefault === true && entry.isActive !== false)
  if (defaults.length > 1) return { ok: false, issue: 'multipleDefaults' }
  return { ok: true }
}
