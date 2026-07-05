const mockAuthenticate = jest.fn()

jest.mock('../../events', () => ({
  emitFinancialPlEvent: jest.fn(),
}))

jest.mock('../../lib/ksef-auth', () => ({
  authenticate: (...args: unknown[]) => mockAuthenticate(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (em: { findOne: (...args: unknown[]) => Promise<unknown> }, entity: unknown, where: unknown) =>
    em.findOne(entity, where),
  findWithDecryption: (em: { find: (...args: unknown[]) => Promise<unknown> }, entity: unknown, where: unknown, options?: unknown) =>
    em.find(entity, where, options),
}))

import { emitFinancialPlEvent } from '../../events'
import type { KsefTransport, KsefTransportRequest } from '../../lib/ksef-client'
import handle from '../ksef-reconcile.worker'

type Row = {
  id: string
  status: 'queued' | 'processing' | 'offline_issued' | 'accepted' | 'rejected'
  attemptCount: number
  mode?: 'online' | 'batch'
  batchReference?: string | null
  sessionReference?: string | null
  invoiceReference?: string | null
  contextNip?: string
  environment?: 'test' | 'demo' | 'prod'
  salesInvoiceId?: string
  ksefNumber?: string | null
  upoXml?: string | null
  lastStatusCode?: number | null
  lastErrorCode?: string | null
  lastErrorMessage?: string | null
  acceptedAt?: Date | null
  submittedAt?: Date | null
  updatedAt?: Date | null
  offlineSendDeadlineAt?: Date | null
}

type FindWhere = { id?: string; status?: string | { $in: string[] } }

function makeEm(opts: {
  processing?: Row[]
  queued?: Row[]
  offlineIssued?: Row[]
  gaveUp?: { id: string }[]
  nativeUpdate?: jest.Mock
}) {
  const rows = [...(opts.processing ?? []), ...(opts.queued ?? []), ...(opts.offlineIssued ?? [])]
  const find = jest.fn(async (_entity: unknown, where: FindWhere) => {
    if (where.status === 'processing') return opts.processing ?? []
    if (where.status === 'queued') return opts.queued ?? []
    if (where.status === 'offline_issued') return opts.offlineIssued ?? []
    // The over-ceiling give-up query keys status as { $in: [...] }.
    return opts.gaveUp ?? []
  })
  const nativeUpdate =
    opts.nativeUpdate ??
    jest.fn(async (_entity: unknown, where: FindWhere, update: Partial<Row>) => {
      const matches = rows.filter((row) => !where.id || row.id === where.id)
      for (const row of matches) Object.assign(row, update)
      return matches.length || 1
    })
  const findOne = jest.fn(async (_entity: unknown, where: FindWhere) => rows.find((row) => row.id === where.id) ?? null)
  const flush = jest.fn(async () => {})
  const em: Record<string, unknown> = { find, findOne, flush, nativeUpdate }
  em.fork = () => em
  return { em, find, findOne, flush, nativeUpdate }
}

function makeCtx(em: unknown, transport?: KsefTransport) {
  return {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'ksefTransport') return transport
      if (name === 'integrationCredentialsService') {
        return {
          getRaw: async () => ({
            authMethod: 'token',
            ksefToken: 'TOKEN',
            environment: 'test',
          }),
        }
      }
      return undefined
    },
  }
}

function json(body: unknown) {
  return { status: 200, headers: {}, text: JSON.stringify(body) }
}

function makeBatchTransport(): { transport: KsefTransport; calls: KsefTransportRequest[] } {
  const calls: KsefTransportRequest[] = []
  const transport: KsefTransport = async (req) => {
    calls.push(req)
    const path = new URL(req.url).pathname
    if (path.endsWith('/security/public-key-certificates')) {
      return json([{ publicKeyId: 'TOKEN', certificate: 'TOKEN-CERT', usage: ['token'], validFrom: '2026-01-01' }])
    }
    if (path.endsWith('/sessions/BATCH-REF-1')) {
      return json({ status: { code: 200, description: 'accepted' } })
    }
    if (path.endsWith('/sessions/BATCH-REF-1/invoices')) {
      return json({ invoices: [{ fileName: 'INV-1.xml', status: { code: 200 }, ksefNumber: 'KSEF-NO-1' }] })
    }
    if (path.endsWith('/sessions/BATCH-REF-1/invoices/ksef/KSEF-NO-1/upo')) {
      return { status: 200, headers: {}, text: '<UPO/>' }
    }
    throw new Error(`unexpected KSeF request: ${req.method} ${path}`)
  }
  return { transport, calls }
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
    mockAuthenticate.mockReset()
    mockAuthenticate.mockResolvedValue({ ok: true, accessToken: 'ACCESS' })
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

  it('resolves a processing batch row to accepted with KSeF number and UPO', async () => {
    const row: Row = {
      id: 'BATCH-S1',
      status: 'processing',
      mode: 'batch',
      batchReference: 'BATCH-REF-1',
      sessionReference: 'BATCH-REF-1',
      contextNip: '5260001246',
      environment: 'test',
      salesInvoiceId: 'INV-1',
      attemptCount: 1,
      submittedAt: STALE,
    }
    const { em, nativeUpdate } = makeEm({ processing: [row] })
    const { transport, calls } = makeBatchTransport()

    await handle({ payload: PAYLOAD } as never, makeCtx(em, transport) as never)

    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'BATCH-S1',
        organizationId: 'O',
        tenantId: 'T',
        status: 'processing',
        mode: 'batch',
        batchReference: 'BATCH-REF-1',
      }),
      expect.objectContaining({ attemptCount: 2 }),
    )
    expect(calls.some((req) => new URL(req.url).pathname.endsWith('/sessions/BATCH-REF-1/invoices'))).toBe(true)
    expect(row.status).toBe('accepted')
    expect(row.ksefNumber).toBe('KSEF-NO-1')
    expect(row.upoXml).toBe('<UPO/>')
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.accepted',
      { submissionId: 'BATCH-S1', organizationId: 'O', tenantId: 'T', ksefNumber: 'KSEF-NO-1' },
      { persistent: true },
    )
    expect(emitFinancialPlEvent).not.toHaveBeenCalledWith(
      'financial_pl.ksef_submission.queued',
      expect.anything(),
      expect.anything(),
    )
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
