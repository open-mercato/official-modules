import { resolveNbpApiBase } from '../config'

export type NbpRateResult =
  | { ok: true; currency: string; rate: string; tableDate: string }
  | { ok: false; reason: 'invalid_currency' | 'unavailable' | 'not_found' }

export type NbpFetchOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; now?: Date }

type NbpApiResponse = {
  rates?: Array<{
    mid?: unknown
    effectiveDate?: unknown
  }>
}

const DEFAULT_TIMEOUT_MS = 6000
const MAX_404_WALKBACKS = 7
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Fetch the NBP table-A mid-rate effective for an invoice with the given tax-point date. */
export async function fetchNbpMidRate(
  currency: string,
  taxPointDate: string,
  opts: NbpFetchOptions = {},
): Promise<NbpRateResult> {
  const normalizedCurrency = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) return { ok: false, reason: 'invalid_currency' }

  const taxPoint = parseDateOnly(taxPointDate)
  if (!taxPoint) return { ok: false, reason: 'unavailable' }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'unavailable' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    let tableDate = previousBusinessDay(taxPoint)
    for (let attempt = 0; attempt <= MAX_404_WALKBACKS; attempt += 1) {
      const tableDateText = formatDateOnly(tableDate)
      const response = await fetchImpl(buildNbpRateUrl(normalizedCurrency, tableDateText), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })

      if (response.status === 404) {
        tableDate = previousBusinessDay(tableDate)
        continue
      }
      if (!response.ok) return { ok: false, reason: 'unavailable' }

      const parsed = parseNbpRateResponse((await response.json()) as NbpApiResponse)
      if (!parsed) return { ok: false, reason: 'unavailable' }

      return {
        ok: true,
        currency: normalizedCurrency,
        rate: parsed.rate,
        tableDate: parsed.tableDate,
      }
    }

    return { ok: false, reason: 'not_found' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

function buildNbpRateUrl(currency: string, tableDate: string): string {
  const base = resolveNbpApiBase().replace(/\/+$/, '')
  return `${base}/exchangerates/rates/A/${encodeURIComponent(currency)}/${tableDate}/?format=json`
}

function parseNbpRateResponse(body: NbpApiResponse): { rate: string; tableDate: string } | null {
  const rateRow = body.rates?.[0]
  if (!rateRow || typeof rateRow.effectiveDate !== 'string' || !DATE_ONLY_RE.test(rateRow.effectiveDate)) {
    return null
  }

  if (typeof rateRow.mid === 'number') {
    if (!Number.isFinite(rateRow.mid)) return null
    return { rate: rateRow.mid.toFixed(4), tableDate: rateRow.effectiveDate }
  }

  if (typeof rateRow.mid === 'string') {
    const rate = rateRow.mid.trim()
    if (!rate) return null
    return { rate, tableDate: rateRow.effectiveDate }
  }

  return null
}

function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY_RE.test(value)) return null
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(year, month - 1, day))

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }

  return date
}

function previousBusinessDay(date: Date): Date {
  const candidate = new Date(date.getTime())
  do {
    candidate.setUTCDate(candidate.getUTCDate() - 1)
  } while (isWeekend(candidate))
  return candidate
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay()
  return day === 0 || day === 6
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}
