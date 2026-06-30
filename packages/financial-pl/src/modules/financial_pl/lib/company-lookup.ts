import { isValidPolishNip } from './nip'

/**
 * Company lookup by NIP against the Polish Ministry of Finance "Wykaz podatników VAT"
 * (Biała lista) register — https://wl-api.mf.gov.pl. Free, no API key. Used to autofill a
 * buyer (Nabywca) on an invoice from its NIP and to surface the counterparty's VAT status.
 *
 * Design: fail-open. Any upstream error/timeout/shape-mismatch resolves to a structured
 * `{ ok: false, reason }` — never throws — so invoice authoring is never blocked on this
 * convenience. The caller (the company-lookup route) is the only place that reaches the
 * external service; the browser never calls MF directly (CORS + date param + timeout).
 */

export type CompanyLookupResult =
  | {
      ok: true
      company: {
        nip: string
        name: string | null
        /** Raw MF VAT status string — typically 'Czynny' | 'Zwolniony' | 'Niezarejestrowany'. */
        statusVat: string | null
        regon: string | null
        /** Single registry address string (working address, falling back to residence). */
        address: string | null
      }
    }
  | { ok: false; reason: 'invalid_nip' | 'unavailable' | 'not_found' }

/** The (subset of the) MF Wykaz response we read. Everything is optional/defensive. */
type WykazSubject = {
  nip?: unknown
  name?: unknown
  statusVat?: unknown
  regon?: unknown
  workingAddress?: unknown
  residenceAddress?: unknown
}
type WykazResponse = { result?: { subject?: WykazSubject | null } | null }

const MF_WYKAZ_BASE = 'https://wl-api.mf.gov.pl/api/search/nip'
const DEFAULT_TIMEOUT_MS = 6000

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

/** Strip everything but digits (the MF API wants a bare 10-digit NIP). */
export function normalizeNipDigits(value: string): string {
  return value.replace(/\D/g, '')
}

function toRegisterDate(now: Date): string {
  // MF Wykaz requires a `date` param (the register is date-versioned). Use today (UTC date).
  return now.toISOString().slice(0, 10)
}

export type ParsedAddress = { addressLine1: string; postalCode: string; city: string }

/**
 * Best-effort split of the single MF registry address string into street / postal / city — e.g.
 * "RONDO IGNACEGO DASZYŃSKIEGO 2C, 00-843 WARSZAWA" → { addressLine1: "RONDO … 2C",
 * postalCode: "00-843", city: "WARSZAWA" }. Falls back to putting the whole string in
 * `addressLine1` when no `NN-NNN` postal code is present (graceful — the operator can split it).
 */
export function parseWykazAddress(address: string | null | undefined): ParsedAddress {
  const text = (address ?? '').trim()
  if (!text) return { addressLine1: '', postalCode: '', city: '' }
  const postalMatch = text.match(/(\d{2}-\d{3})\s+([^,]+)\s*$/)
  if (postalMatch && postalMatch.index !== undefined) {
    let addressLine1 = text.slice(0, postalMatch.index).trim()
    if (addressLine1.endsWith(',')) addressLine1 = addressLine1.slice(0, -1).trim()
    return { addressLine1, postalCode: postalMatch[1], city: postalMatch[2].trim() }
  }
  return { addressLine1: text, postalCode: '', city: '' }
}

export type LookupOptions = {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date
  timeoutMs?: number
}

/**
 * Resolve a company by NIP. Validates the checksum locally first (so a typo never hits MF),
 * then calls the Wykaz register with a bounded timeout. Returns a normalised result; never throws.
 */
export async function lookupCompanyByNip(rawNip: string, opts: LookupOptions = {}): Promise<CompanyLookupResult> {
  const nip = normalizeNipDigits(rawNip)
  if (!isValidPolishNip(nip)) return { ok: false, reason: 'invalid_nip' }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'unavailable' }
  const now = opts.now ?? new Date()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = `${MF_WYKAZ_BASE}/${encodeURIComponent(nip)}?date=${toRegisterDate(now)}`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    // 404 (and the documented "not found" payload) ⇒ no such active taxpayer.
    if (res.status === 404) return { ok: false, reason: 'not_found' }
    if (!res.ok) return { ok: false, reason: 'unavailable' }
    const body = (await res.json()) as WykazResponse
    const subject = body?.result?.subject
    if (!subject) return { ok: false, reason: 'not_found' }
    return {
      ok: true,
      company: {
        nip,
        name: asTrimmedString(subject.name),
        statusVat: asTrimmedString(subject.statusVat),
        regon: asTrimmedString(subject.regon),
        address: asTrimmedString(subject.workingAddress) ?? asTrimmedString(subject.residenceAddress),
      },
    }
  } catch {
    // Timeout (abort), network error, or non-JSON body — fail open.
    return { ok: false, reason: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}
