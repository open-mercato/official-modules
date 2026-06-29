jest.mock('../../events', () => ({
  emitFinancialPlEvent: jest.fn(),
}))

import { emitFinancialPlEvent } from '../../events'
import handle from '../ksef-reconcile.worker'

type Row = {
  id: string
  status: 'queued' | 'processing' | 'offline_issued'
  attemptCount: number
  submittedAt?: Date | null
  updatedAt?: Date | null
  offlineSendDeadlineAt?: Date | null
}

type FindWhere = { status?: string | { $in: string[] } }

function makeEm(opts: {
  processing?: Row[]
  queued?: Row[]
  offlineIssued?: Row[]
  gaveUp?: { id: string }[]
  nativeUpdate?: jest.Mock
}) {
  const find = jest.fn(async (_entity: unknown, where: FindWhere) => {
    if (where.status === 'processing') return opts.processing ?? []
    if (where.status === 'queued') return opts.queued ?? []
    if (where.status === 'offline_issued') return opts.offlineIssued ?? []
    // The over-ceiling give-up query keys status as { $in: [...] }.
    return opts.gaveUp ?? []
  })
  const nativeUpdate = opts.nativeUpdate ?? jest.fn(async () => 1)
  const em: Record<string, unknown> = { find, nativeUpdate }
  em.fork = () => em
  return { em, find, nativeUpdate }
}

function makeCtx(em: unknown) {
  return { resolve: (name: string) => (name === 'em' ? em : undefined) }
}

function candidateFinds(find: jest.Mock) {
  return find.mock.calls.filter((call) => typeof (call[1] as FindWhere).status === 'string')
}

function gaveUpFind(find: jest.Mock) {
  return find.mock.calls.find((call) => {
    const status = (call[1] as FindWhere).status
    return typeof status === 'object' && Array.isArray(status?.$in)
  })?.[1] as Record<string, unknown> | undefined
}

const PAYLOAD = { scope: { organizationId: 'O', tenantId: 'T' } }
const STALE = new Date(Date.now() - 60 * 60_000)

describe('ksef-reconcile worker', () => {
  beforeEach(() => {
    ;(emitFinancialPlEvent as jest.Mock).mockReset()
    delete process.env.OM_KSEF_RECONCILE_MAX_ATTEMPTS
    delete process.env.OM_KSEF_RECONCILE_STALE_MINUTES
  })

  it('returns early without querying when the scope is incomplete', async () => {
    const { em, find } = makeEm({})
    await handle({ payload: { scope: { organizationId: 'O' } } } as never, makeCtx(em) as never)
    expect(find).not.toHaveBeenCalled()
  })

  it('re-drives a stale processing row: resets to queued, increments attemptCount, re-emits', async () => {
    const { em, nativeUpdate } = makeEm({
      processing: [{ id: 'S1', status: 'processing', attemptCount: 2, submittedAt: STALE }],
    })
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)

    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'S1',
        organizationId: 'O',
        tenantId: 'T',
        status: 'processing',
        submittedAt: { $lt: expect.any(Date) },
      }),
      expect.objectContaining({ status: 'queued', attemptCount: 3 }),
    )
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.queued',
      { submissionId: 'S1', organizationId: 'O', tenantId: 'T' },
      { persistent: true },
    )
  })

  it('re-emits a stale queued row whose dispatch event was lost', async () => {
    const { em } = makeEm({ queued: [{ id: 'S2', status: 'queued', attemptCount: 0, updatedAt: STALE }] })
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.queued',
      { submissionId: 'S2', organizationId: 'O', tenantId: 'T' },
      { persistent: true },
    )
  })

  it('keys the processing candidate query on submittedAt so a freshly-claimed live row is excluded', async () => {
    const { em, find } = makeEm({})
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    const processingWhere = find.mock.calls.find((call) => (call[1] as FindWhere).status === 'processing')?.[1]
    expect(processingWhere).toEqual(expect.objectContaining({ submittedAt: { $lt: expect.any(Date) } }))
    expect(processingWhere).not.toHaveProperty('updatedAt')
  })

  it('excludes over-ceiling rows from the candidate query and names the gave-up ids', async () => {
    const { em, find } = makeEm({ gaveUp: [{ id: 'G1' }, { id: 'G2' }] })
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    for (const call of candidateFinds(find)) {
      expect((call[1] as { attemptCount?: unknown }).attemptCount).toEqual({ $lt: 6 })
    }
    expect(gaveUpFind(find)).toEqual(
      expect.objectContaining({
        organizationId: 'O',
        tenantId: 'T',
        deletedAt: null,
        // offline_issued rows over the ceiling must also be surfaced as gave-up.
        status: { $in: ['queued', 'processing', 'offline_issued'] },
        attemptCount: { $gte: 6 },
      }),
    )
  })

  it('honors the OM_KSEF_RECONCILE_MAX_ATTEMPTS override', async () => {
    process.env.OM_KSEF_RECONCILE_MAX_ATTEMPTS = '3'
    const { em, find } = makeEm({})
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    for (const call of candidateFinds(find)) {
      expect((call[1] as { attemptCount?: unknown }).attemptCount).toEqual({ $lt: 3 })
    }
    expect(gaveUpFind(find)?.attemptCount).toEqual({ $gte: 3 })
  })

  it('does not re-emit when the CAS claim is lost to another worker', async () => {
    const { em } = makeEm({
      processing: [{ id: 'S3', status: 'processing', attemptCount: 0, submittedAt: STALE }],
      nativeUpdate: jest.fn(async () => 0),
    })
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    expect(emitFinancialPlEvent).not.toHaveBeenCalled()
  })

  it('scopes every query to the org + tenant (no cross-tenant re-drive)', async () => {
    const { em, find } = makeEm({})
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    for (const call of find.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ organizationId: 'O', tenantId: 'T', deletedAt: null }))
    }
  })

  // --- SPEC-010: offline_issued deadline routing (deferred INITIAL send) ---

  it('queries offline_issued candidates keyed on the deadline, soonest-first', async () => {
    const { em, find } = makeEm({})
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    const call = find.mock.calls.find((c) => (c[1] as FindWhere).status === 'offline_issued')
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        status: 'offline_issued',
        attemptCount: { $lt: 6 },
        offlineSendDeadlineAt: { $lte: expect.any(Date) },
      }),
    )
    // Prioritized by approaching deadline.
    const opts = (call as unknown as unknown[])?.[2] as { orderBy?: unknown }
    expect(opts.orderBy).toEqual({ offlineSendDeadlineAt: 'asc' })
  })

  it('CAS-claims an offline_issued row near its deadline and emits send_offline (initial send)', async () => {
    const { em, nativeUpdate } = makeEm({
      offlineIssued: [
        { id: 'OFF1', status: 'offline_issued', attemptCount: 0, submittedAt: null, offlineSendDeadlineAt: new Date(Date.now() + 3_600_000) },
      ],
    })
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)

    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'OFF1', organizationId: 'O', tenantId: 'T', status: 'offline_issued' }),
      expect.objectContaining({ attemptCount: 1 }),
    )
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.offline_send_requested',
      { submissionId: 'OFF1', organizationId: 'O', tenantId: 'T' },
      { persistent: true },
    )
  })

  it('does not emit send_offline when the offline CAS claim is lost to another worker', async () => {
    const { em } = makeEm({
      offlineIssued: [
        { id: 'OFF2', status: 'offline_issued', attemptCount: 0, submittedAt: null, offlineSendDeadlineAt: new Date(Date.now() + 3_600_000) },
      ],
      nativeUpdate: jest.fn(async () => 0),
    })
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    expect(emitFinancialPlEvent).not.toHaveBeenCalledWith(
      'financial_pl.ksef_submission.offline_send_requested',
      expect.anything(),
      expect.anything(),
    )
  })

  it('includes offline_issued in the over-ceiling gave-up surfacing', async () => {
    const { em, find } = makeEm({})
    await handle({ payload: PAYLOAD } as never, makeCtx(em) as never)
    expect(gaveUpFind(find)).toEqual(
      expect.objectContaining({ status: { $in: ['queued', 'processing', 'offline_issued'] }, attemptCount: { $gte: 6 } }),
    )
  })
})
