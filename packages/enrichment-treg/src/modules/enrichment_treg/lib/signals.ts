import { createHash } from 'node:crypto'
import type { EnrichmentSignal } from '../data/entities'
import { SIGNAL_LIST_KEY_BY_KIND, SIGNALS_DEFAULT_LIMIT, type SignalKind } from './constants'
import { normalizeUrl, type CompanyIdentity } from './normalize'

export type NormalizedSignal = {
  signalType: SignalKind
  title: string
  summary: string | null
  url: string | null
  location: string | null
  occurredAt: Date | null
  dedupeHash: string
  payload: Record<string, unknown>
}

export type SignalNormalization = {
  signals: NormalizedSignal[]
  skippedRows: number
}

const TITLE_MAX_LENGTH = 500
const SUMMARY_MAX_LENGTH = 2000
const LOCATION_MAX_LENGTH = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null
}

function firstText(source: Record<string, unknown>, keys: string[], maxLength: number): string | null {
  for (const key of keys) {
    const value = text(source[key], maxLength)
    if (value) return value
  }
  return null
}

function firstDate(source: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  return null
}

function firstUrl(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = normalizeUrl(source[key])
    if (value && /^https?:\/\//i.test(value)) return value
  }
  return null
}

function readLocation(attributes: Record<string, unknown>): string | null {
  const direct = text(attributes.location, LOCATION_MAX_LENGTH)
  if (direct) return direct
  const data = Array.isArray(attributes.location_data) ? attributes.location_data : []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const parts = [entry.city, entry.state, entry.country].filter((part) => typeof part === 'string' && part.trim().length > 0)
    if (parts.length > 0) return text(parts.join(', '), LOCATION_MAX_LENGTH)
  }
  return null
}

function indexIncluded(raw: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>()
  const included = isRecord(raw) && Array.isArray(raw.included) ? raw.included : []
  for (const item of included) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.type !== 'string') continue
    index.set(`${item.type}:${item.id}`, isRecord(item.attributes) ? item.attributes : {})
  }
  return index
}

function relatedAttributes(
  row: Record<string, unknown>,
  relation: string,
  included: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const relationships = isRecord(row.relationships) ? row.relationships : null
  const link = relationships && isRecord(relationships[relation]) ? relationships[relation] : null
  const data = link && isRecord(link.data) ? link.data : null
  if (!data || typeof data.id !== 'string' || typeof data.type !== 'string') return null
  return included.get(`${data.type}:${data.id}`) ?? null
}

export function computeSignalDedupeHash(input: {
  signalType: SignalKind
  url: string | null
  title: string
  occurredAt: Date | null
}): string {
  const identity = input.url
    ? `${input.signalType}|url|${input.url.toLowerCase().replace(/\/+$/, '')}`
    : `${input.signalType}|title|${input.title.toLowerCase()}|${input.occurredAt ? input.occurredAt.toISOString().slice(0, 10) : ''}`
  return createHash('sha256').update(identity).digest('hex')
}

type RowFields = Omit<NormalizedSignal, 'signalType' | 'dedupeHash' | 'payload'>

function readHiringRow(attributes: Record<string, unknown>): RowFields | null {
  const title = firstText(attributes, ['title', 'normalized_title', 'job_title', 'name'], TITLE_MAX_LENGTH)
  if (!title) return null
  return {
    title,
    summary: firstText(attributes, ['description', 'summary'], SUMMARY_MAX_LENGTH),
    url: firstUrl(attributes, ['url', 'link', 'job_url', 'source_url']),
    location: readLocation(attributes),
    occurredAt: firstDate(attributes, ['posted_at', 'first_seen_at', 'published_at', 'date', 'found_at']),
  }
}

function readNewsRow(
  row: Record<string, unknown>,
  attributes: Record<string, unknown>,
  included: Map<string, Record<string, unknown>>,
): RowFields | null {
  const source = relatedAttributes(row, 'most_relevant_source', included)
  const title = firstText(attributes, ['summary', 'headline', 'title', 'name'], TITLE_MAX_LENGTH)
    ?? (source ? firstText(source, ['title'], TITLE_MAX_LENGTH) : null)
  if (!title) return null
  return {
    title,
    summary: firstText(attributes, ['article_sentence', 'description', 'snippet'], SUMMARY_MAX_LENGTH),
    url: firstUrl(attributes, ['url', 'link', 'source_url']) ?? (source ? firstUrl(source, ['url']) : null),
    location: null,
    occurredAt: firstDate(attributes, ['found_at', 'published_at', 'date', 'first_seen_at'])
      ?? (source ? firstDate(source, ['published_at']) : null),
  }
}

export function normalizeSignals(params: {
  kind: SignalKind
  output: Record<string, unknown>
  raw: unknown
}): SignalNormalization {
  const rows = params.output[SIGNAL_LIST_KEY_BY_KIND[params.kind]]
  const list = Array.isArray(rows) ? rows : []
  const included = indexIncluded(params.raw)
  const seen = new Set<string>()
  const signals: NormalizedSignal[] = []
  let skippedRows = 0

  for (const row of list) {
    if (!isRecord(row)) {
      skippedRows += 1
      continue
    }
    const attributes = isRecord(row.attributes) ? row.attributes : row
    const fields = params.kind === 'hiring' ? readHiringRow(attributes) : readNewsRow(row, attributes, included)
    if (!fields) {
      skippedRows += 1
      continue
    }
    const dedupeHash = computeSignalDedupeHash({ signalType: params.kind, ...fields })
    if (seen.has(dedupeHash)) continue
    seen.add(dedupeHash)
    signals.push({ signalType: params.kind, ...fields, dedupeHash, payload: row })
  }

  return { signals, skippedRows }
}

export function buildSignalRequestBody(kind: SignalKind, identity: CompanyIdentity): Record<string, unknown> | null {
  if (kind === 'news') {
    return identity.domain ? { domain: identity.domain, limit: SIGNALS_DEFAULT_LIMIT } : null
  }
  if (!identity.domain && !identity.name) return null
  return { domain: identity.domain, name: identity.name, limit: SIGNALS_DEFAULT_LIMIT }
}

export type SerializedSignal = {
  id: string
  subjectId: string
  signalType: SignalKind
  title: string
  summary: string | null
  url: string | null
  location: string | null
  occurredAt: string | null
  source: string | null
  firstSeenAt: string
  lastSeenAt: string
}

export function serializeSignal(signal: EnrichmentSignal): SerializedSignal {
  return {
    id: signal.id,
    subjectId: signal.subjectId,
    signalType: signal.signalType,
    title: signal.title,
    summary: signal.summary ?? null,
    url: signal.url ?? null,
    location: signal.location ?? null,
    occurredAt: signal.occurredAt ? signal.occurredAt.toISOString() : null,
    source: signal.source ?? null,
    firstSeenAt: signal.firstSeenAt.toISOString(),
    lastSeenAt: signal.lastSeenAt.toISOString(),
  }
}
