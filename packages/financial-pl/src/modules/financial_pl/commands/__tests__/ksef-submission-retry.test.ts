// Captures the persistent events the retry/send commands emit, so we can assert the OFFLINE retry
// re-routes to the deferred-send path (H6) and the H1 status-based immutability gate.
const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
jest.mock('../../events', () => ({
  emitFinancialPlEvent: jest.fn(async (event: string, payload: Record<string, unknown>) => {
    emitted.push({ event, payload })
  }),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

import { retryCommand, sendFromInvoiceCommand } from '../ksef-submission'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const SUB = '44444444-4444-4444-8444-444444444444'
const INV = '33333333-3333-4333-8333-333333333333'

function makeCtx(em: unknown, extraResolve: Record<string, unknown> = {}) {
  return {
    container: {
      resolve: (name: string) => (name === 'em' ? em : extraResolve[name]),
    },
    auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
    organizationScope: null,
    selectedOrganizationId: ORG,
    request: null,
  } as unknown as Parameters<typeof retryCommand.execute>[1]
}

function makeEm(submission: Record<string, unknown> | null) {
  const em: Record<string, unknown> = {
    findOne: jest.fn(async () => submission),
    flush: jest.fn(async () => {}),
  }
  em.fork = () => em
  return em
}

beforeEach(() => {
  emitted.length = 0
})

describe('retryCommand — recovery routing (H6: offline submissions retry through the deferred send path)', () => {
  it('looks up the submission inside the caller organization and tenant scope', async () => {
    const submission: Record<string, unknown> = {
      id: SUB,
      organizationId: ORG,
      tenantId: TEN,
      status: 'rejected',
      mode: 'online',
      updatedAt: new Date(),
    }
    const em = makeEm(submission)

    await retryCommand.execute({ id: SUB }, makeCtx(em))

    expect((em as Record<string, jest.Mock>).findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: SUB,
        organizationId: ORG,
        tenantId: TEN,
        deletedAt: null,
      }),
      undefined,
    )
  })

  it('an offline-issued offline24 submission re-emits send_offline and stays offline_issued (NOT queued)', async () => {
    const submission: Record<string, unknown> = {
      id: SUB,
      organizationId: ORG,
      tenantId: TEN,
      status: 'offline_issued',
      mode: 'offline24',
      updatedAt: new Date('2026-06-20T00:00:00Z'),
    }
    const em = makeEm(submission)
    const result = await retryCommand.execute({ id: SUB }, makeCtx(em))

    expect(result).toEqual({ submissionId: SUB })
    expect(submission.status).toBe('offline_issued')
    expect(emitted.map((e) => e.event)).toEqual(['financial_pl.ksef_submission.offline_send_requested'])
  })

  it('a rejected awaryjny (offline) submission also re-routes to send_offline, not the online queue', async () => {
    const submission: Record<string, unknown> = {
      id: SUB, organizationId: ORG, tenantId: TEN, status: 'rejected', mode: 'awaryjny', updatedAt: new Date(),
    }
    await retryCommand.execute({ id: SUB }, makeCtx(makeEm(submission)))
    expect(submission.status).toBe('offline_issued')
    expect(emitted.map((e) => e.event)).toEqual(['financial_pl.ksef_submission.offline_send_requested'])
  })

  it('a rejected niedostepnosc (offline) submission also re-routes to send_offline, not the online queue', async () => {
    const submission: Record<string, unknown> = {
      id: SUB, organizationId: ORG, tenantId: TEN, status: 'rejected', mode: 'niedostepnosc', updatedAt: new Date(),
    }
    await retryCommand.execute({ id: SUB }, makeCtx(makeEm(submission)))
    expect(submission.status).toBe('offline_issued')
    expect(emitted.map((e) => e.event)).toEqual(['financial_pl.ksef_submission.offline_send_requested'])
  })

  it('a rejected ONLINE submission resets to queued and emits the online queued event', async () => {
    const submission: Record<string, unknown> = {
      id: SUB, organizationId: ORG, tenantId: TEN, status: 'rejected', mode: 'online', updatedAt: new Date(),
    }
    await retryCommand.execute({ id: SUB }, makeCtx(makeEm(submission)))
    expect(submission.status).toBe('queued')
    expect(emitted.map((e) => e.event)).toEqual(['financial_pl.ksef_submission.queued'])
  })

  it('an already-accepted submission is rejected with 409 (no event)', async () => {
    const submission: Record<string, unknown> = {
      id: SUB, organizationId: ORG, tenantId: TEN, status: 'accepted', mode: 'online', updatedAt: new Date(),
    }
    await expect(retryCommand.execute({ id: SUB }, makeCtx(makeEm(submission)))).rejects.toMatchObject({ status: 409 })
    expect(emitted).toHaveLength(0)
  })
})

describe('sendFromInvoiceCommand — H1 immutability gate via core status', () => {
  function ctxWithInvoice(invoice: Record<string, unknown>) {
    const em = makeEm(null)
    return makeCtx(em, {
      queryEngine: { query: async () => ({ items: [invoice] }) },
    })
  }

  it('rejects a draft invoice with 409 invoice_not_issued', async () => {
    await expect(
      sendFromInvoiceCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV },
        ctxWithInvoice({ id: INV, status: 'draft', document_type: 'vat' }),
      ),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('a missing status is treated as not-issued (409)', async () => {
    await expect(
      sendFromInvoiceCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV },
        ctxWithInvoice({ id: INV, document_type: 'vat' }),
      ),
    ).rejects.toMatchObject({ status: 409 })
  })
})
