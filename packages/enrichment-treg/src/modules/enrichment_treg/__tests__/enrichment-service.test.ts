import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { EnrichmentRecord } from '../data/entities'
import { emitEnrichmentTregEvent } from '../events'
import type { FetchLike } from '../lib/client'
import { RUNNING_STALE_AFTER_MS, runEnrichment } from '../lib/enrichment-service'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(async () => []),
}))
jest.mock('../data/entities', () => ({
  EnrichmentRecord: class EnrichmentRecord {},
  EnrichmentSignal: class EnrichmentSignal {},
}))
jest.mock('../events', () => ({
  emitEnrichmentTregEvent: jest.fn(async () => undefined),
}))

const scope = { tenantId: 't1', organizationId: 'o1' }
const now = new Date('2026-10-05T12:00:00.000Z')

function makeRecord(overrides: Partial<EnrichmentRecord> = {}): EnrichmentRecord {
  return {
    id: 'rec-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    subjectType: 'person',
    subjectId: 'person-1',
    status: 'pending',
    endpointId: 'treg.people.enrich',
    identity: { email: 'jane@acme.com' },
    costMicro: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as EnrichmentRecord
}

function setup(record: EnrichmentRecord, response: () => Promise<Response>) {
  const flush = jest.fn(async () => undefined)
  const em = { flush } as unknown as EntityManager
  ;(findOneWithDecryption as jest.Mock).mockResolvedValue(record)
  const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(response)
  const errorLog = jest.fn(async () => undefined)
  const logService = { scoped: jest.fn(() => ({ error: errorLog })) }
  const credentialsService = { resolve: jest.fn(async () => ({ apiToken: 'trg_test' })) }
  return { em, flush, fetchImpl, errorLog, logService, credentialsService }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }))
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('runEnrichment', () => {
  it('completes a pending record with a normalized proposal and emits completion', async () => {
    const record = makeRecord()
    const deps = setup(record, () =>
      json(200, { output: { full_name: 'Jane Doe', title: 'CTO' }, raw: { ok: true } }, { 'x-treg-cost-micro': '2634', 'x-treg-served-by': 'pdl' }),
    )

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(record.status).toBe('completed')
    expect(record.proposal).toEqual({ jobTitle: 'CTO' })
    expect(record.costMicro).toBe(2634)
    expect(record.servedBy).toBe('pdl')
    expect(deps.fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ 'Idempotency-Key': 'om-enrichment-rec-1' })
    expect(emitEnrichmentTregEvent).toHaveBeenCalledWith('enrichment_treg.record.completed', expect.objectContaining({ id: 'rec-1', status: 'completed' }))
    expect(deps.errorLog).not.toHaveBeenCalled()
  })

  it('marks a miss as no_match without reporting an error', async () => {
    const record = makeRecord()
    const deps = setup(record, () => json(200, { output: { full_name: null } }))

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(record.status).toBe('no_match')
    expect(deps.errorLog).not.toHaveBeenCalled()
  })

  it('records the failure reason and reports it to the integration log', async () => {
    const record = makeRecord()
    const deps = setup(record, () => json(402, { error: 'balance' }))

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(record.status).toBe('failed')
    expect(record.failureReason).toBe('out_of_balance')
    expect(deps.logService.scoped).toHaveBeenCalledWith('enrichment_treg', scope)
    expect(deps.errorLog).toHaveBeenCalledWith('treg enrichment failed', expect.objectContaining({ recordId: 'rec-1', reason: 'out_of_balance', httpStatus: 402 }))
    expect(emitEnrichmentTregEvent).toHaveBeenCalledWith('enrichment_treg.record.failed', expect.anything())
  })

  it('keeps the failure when the integration log itself fails', async () => {
    const record = makeRecord()
    const deps = setup(record, () => json(503, {}))
    deps.errorLog.mockRejectedValueOnce(new Error('log down'))

    await expect(runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })).resolves.toBe(record)
    expect(record.status).toBe('failed')
  })

  it('skips records that are already finished', async () => {
    const record = makeRecord({ status: 'completed' })
    const deps = setup(record, () => json(200, {}))

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(deps.fetchImpl).not.toHaveBeenCalled()
    expect(deps.flush).not.toHaveBeenCalled()
  })

  it('leaves a recently started running record alone', async () => {
    const record = makeRecord({ status: 'running', updatedAt: new Date(now.getTime() - 1000) })
    const deps = setup(record, () => json(200, {}))

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('resumes a stale running record left behind by a crashed worker', async () => {
    const record = makeRecord({ status: 'running', updatedAt: new Date(now.getTime() - RUNNING_STALE_AFTER_MS - 1) })
    const deps = setup(record, () => json(200, { output: { full_name: 'Jane Doe' } }))

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(deps.fetchImpl).toHaveBeenCalledTimes(1)
    expect(record.status).toBe('completed')
  })

  it('returns null for a record outside the scope', async () => {
    const deps = setup(makeRecord(), () => json(200, {}))
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)

    await expect(runEnrichment({ ...deps, recordId: 'missing', scope, now: () => now })).resolves.toBeNull()
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('runEnrichment for company signals', () => {
  const jobs = [
    { id: 'job-1', type: 'job_opening', attributes: { title: 'Android Engineer', url: 'https://acme.example/jobs/android', first_seen_at: '2026-07-24T07:01:32Z' } },
    { id: 'job-2', type: 'job_opening', attributes: { title: 'iOS Engineer', url: 'https://acme.example/jobs/ios' } },
  ]

  function signalRecord(overrides: Partial<EnrichmentRecord> = {}) {
    return makeRecord({
      subjectType: 'company',
      subjectId: 'company-1',
      endpointId: 'treg.companies.jobs.search',
      identity: { domain: 'acme.example', limit: 10 },
      ...overrides,
    })
  }

  function withCreate(deps: ReturnType<typeof setup>) {
    const create = jest.fn((_entity: unknown, data: Record<string, unknown>) => data)
    ;(deps.em as unknown as { create: typeof create }).create = create
    return create
  }

  it('stores new signals, records counts on the record and emits signal.detected', async () => {
    const record = signalRecord()
    const deps = setup(record, () =>
      json(200, { output: { jobs }, raw: { data: [] } }, { 'x-treg-cost-micro': '40000', 'x-treg-served-by': 'predictleads.companies.job_openings' }),
    )
    const create = withCreate(deps)

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(deps.fetchImpl.mock.calls[0][0]).toBe('https://treg.to/call/treg.companies.jobs.search')
    expect(JSON.parse(String(deps.fetchImpl.mock.calls[0][1]?.body))).toEqual({ domain: 'acme.example', limit: 10 })
    expect(record.status).toBe('completed')
    expect(record.proposal).toBeUndefined()
    expect(record.summary).toEqual({ newCount: 2, totalCount: 2, skippedRows: 0 })
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][1]).toMatchObject({
      tenantId: 't1',
      organizationId: 'o1',
      subjectId: 'company-1',
      recordId: 'rec-1',
      signalType: 'hiring',
      title: 'Android Engineer',
      source: 'predictleads.companies.job_openings',
    })
    expect(emitEnrichmentTregEvent).toHaveBeenCalledWith(
      'enrichment_treg.signal.detected',
      expect.objectContaining({ subjectId: 'company-1', signalType: 'hiring', newCount: 2 }),
    )
  })

  it('only bumps last_seen_at for signals that are already stored', async () => {
    const record = signalRecord()
    const deps = setup(record, () => json(200, { output: { jobs }, raw: null }))
    const create = withCreate(deps)
    const { computeSignalDedupeHash } = jest.requireActual('../lib/signals') as typeof import('../lib/signals')
    const known = {
      dedupeHash: computeSignalDedupeHash({ signalType: 'hiring', url: 'https://acme.example/jobs/android', title: 'Android Engineer', occurredAt: null }),
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    }
    ;(findWithDecryption as jest.Mock).mockResolvedValueOnce([known])

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][1]).toMatchObject({ title: 'iOS Engineer' })
    expect(known.lastSeenAt.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime())
    expect(record.summary).toEqual({ newCount: 1, totalCount: 2, skippedRows: 0 })
  })

  it('does not emit signal.detected when nothing new was found', async () => {
    const record = signalRecord({ endpointId: 'treg.companies.news', identity: { domain: 'acme.example', limit: 10 } })
    const deps = setup(record, () => json(404, { detail: { error: 'route_caller_fault' } }, { 'x-treg-cost-micro': '0' }))
    withCreate(deps)

    await runEnrichment({ ...deps, recordId: record.id, scope, now: () => now })

    expect(record.status).toBe('no_match')
    expect(record.costMicro).toBe(0)
    expect(deps.errorLog).not.toHaveBeenCalled()
    expect(emitEnrichmentTregEvent).not.toHaveBeenCalledWith('enrichment_treg.signal.detected', expect.anything())
  })
})
