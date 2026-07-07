/**
 * Received-invoice sync paging guards. The command is allowed to persist rows already fetched,
 * but the KSeF cursor is the legal replay boundary: a dropped page must be retried, not skipped.
 */
const mockGetPublicKeyCertificates = jest.fn()
const mockQueryReceivedInvoices = jest.fn()

jest.mock('../../lib/ksef-client', () => ({
  KsefClient: jest.fn(() => ({
    getPublicKeyCertificates: mockGetPublicKeyCertificates,
    queryReceivedInvoices: mockQueryReceivedInvoices,
  })),
}))

jest.mock('../../lib/ksef-auth', () => ({
  authenticate: jest.fn(),
}))

jest.mock('../../lib/credentials', () => ({
  buildKsefAuthConfig: jest.fn(),
  readKsefCredentials: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { authenticate } from '../../lib/ksef-auth'
import { buildKsefAuthConfig, readKsefCredentials } from '../../lib/credentials'
import type { QueryReceivedInvoicesResult, ReceivedInvoiceMetadata } from '../../lib/ksef-client'
import { receiveInvoicesCommand } from '../ksef-receive'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const CONTEXT_NIP = '5260001246'
const ABORT_ERROR = '[internal] KSeF received-invoice sync aborted after repeated page failures; cursor not advanced'

type StoredRow = Record<string, unknown>

function invoice(ksefNumber: string, permanentStorageDate: string): ReceivedInvoiceMetadata {
  return {
    ksefNumber,
    invoiceNumber: ksefNumber,
    issueDate: '2026-02-02',
    acquisitionDate: '2026-02-03',
    permanentStorageDate,
    seller: { nip: '7342867148', name: 'Supplier' },
    buyer: { identifier: { type: 'Nip', value: CONTEXT_NIP }, name: 'Buyer' },
    netAmount: 100,
    grossAmount: 123,
    vatAmount: 23,
    currency: 'PLN',
    invoiceType: 'VAT',
    invoiceHash: `hash-${ksefNumber}`,
  }
}

function page(
  invoices: ReceivedInvoiceMetadata[],
  permanentStorageHwmDate: string,
  hasMore: boolean,
): QueryReceivedInvoicesResult {
  return { hasMore, isTruncated: false, permanentStorageHwmDate, invoices }
}

function makeCursor(permanentStorageHwmDate: string) {
  return {
    organizationId: ORG,
    tenantId: TEN,
    contextNip: CONTEXT_NIP,
    subjectType: 'Subject2',
    permanentStorageHwmDate,
    lastSyncedAt: new Date('2026-02-01T00:00:00.000Z'),
    deletedAt: null,
  }
}

function makeEm(cursor: StoredRow) {
  const persisted: StoredRow[] = []
  const em: Record<string, unknown> = {
    findOne: jest.fn(async (entity: unknown, where: unknown) => {
      const entityName = (entity as { name?: string }).name
      const query = where as Record<string, unknown>
      if (entityName === 'ReceiveCursor') return cursor
      if (entityName === 'ReceivedInvoice') {
        return (
          persisted.find(
            (row) =>
              row.ksefNumber === query.ksefNumber &&
              row.organizationId === query.organizationId &&
              row.tenantId === query.tenantId &&
              row.contextNip === query.contextNip &&
              row.deletedAt === query.deletedAt,
          ) ?? null
        )
      }
      return null
    }),
    create: jest.fn((_entity: unknown, data: StoredRow) => ({ ...data })),
    persist: jest.fn((record: StoredRow) => ({
      flush: async () => {
        persisted.push(record)
      },
    })),
    flush: jest.fn(async () => {}),
    clear: jest.fn(),
  }
  return { em, persisted }
}

function makeCtx(em: Record<string, unknown>) {
  return {
    container: {
      resolve: (name: string) => {
        if (name === 'em') return em
        if (name === 'integrationCredentialsService') {
          return { getRaw: async () => ({ contextNip: CONTEXT_NIP, environment: 'test' }) }
        }
        return undefined
      },
    },
    auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
    organizationScope: null,
    selectedOrganizationId: ORG,
    organizationIds: null,
    request: null,
  } as unknown as Parameters<typeof receiveInvoicesCommand.execute>[1]
}

let consoleErrorSpy: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  mockGetPublicKeyCertificates.mockResolvedValue([])
  ;(authenticate as jest.Mock).mockResolvedValue({ ok: true, accessToken: 'ACCESS' })
  ;(buildKsefAuthConfig as jest.Mock).mockReturnValue({ type: 'token' })
  ;(readKsefCredentials as jest.Mock).mockResolvedValue({ environment: 'test', token: 'TOKEN' })
  ;(findOneWithDecryption as jest.Mock).mockImplementation(
    (em: { findOne: (entity: unknown, where: unknown, options?: unknown) => Promise<unknown> }, entity: unknown, where: unknown, options?: unknown) =>
      em.findOne(entity, where, options),
  )
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
})

describe('financial_pl.ksef_receive.receive_invoices page retry cursor safety', () => {
  it('retries a transient failed page at the same offset and advances the cursor after the retry succeeds', async () => {
    const cursor = makeCursor('2026-02-01T00:00:00.000Z')
    const { em, persisted } = makeEm(cursor)
    const pageOffsets: number[] = []
    let failedOnce = false

    mockQueryReceivedInvoices.mockImplementation(async (params: { pageOffset?: number }) => {
      const offset = params.pageOffset ?? 0
      pageOffsets.push(offset)
      if (offset === 0) {
        return page([invoice('KSEF-RECV-1', '2026-02-02T00:00:00.000Z')], '2026-02-02T00:00:00.000Z', true)
      }
      if (offset === 100 && !failedOnce) {
        failedOnce = true
        throw new Error('temporary page failure')
      }
      if (offset === 100) {
        return page([invoice('KSEF-RECV-2', '2026-02-03T00:00:00.000Z')], '2026-02-03T00:00:00.000Z', false)
      }
      return page([], 'unexpected-offset', false)
    })

    const result = await receiveInvoicesCommand.execute(
      { dateFrom: '2026-02-01', dateTo: '2026-02-28' },
      makeCtx(em),
    )

    expect(result).toEqual({ synced: 2 })
    expect(pageOffsets).toEqual([0, 100, 100])
    expect(mockQueryReceivedInvoices).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageOffset: 100, pageSize: 100 }))
    expect(mockQueryReceivedInvoices).toHaveBeenNthCalledWith(3, expect.objectContaining({ pageOffset: 100, pageSize: 100 }))
    expect(persisted.map((row) => row.ksefNumber)).toEqual(['KSEF-RECV-1', 'KSEF-RECV-2'])
    expect(cursor.permanentStorageHwmDate).toBe('2026-02-03T00:00:00.000Z')
  })

  it('aborts loudly after repeated failures on one page and leaves the cursor HWM unchanged', async () => {
    const cursor = makeCursor('2026-02-01T00:00:00.000Z')
    const lastSyncedAt = cursor.lastSyncedAt
    const { em, persisted } = makeEm(cursor)
    const pageOffsets: number[] = []

    mockQueryReceivedInvoices.mockImplementation(async (params: { pageOffset?: number }) => {
      const offset = params.pageOffset ?? 0
      pageOffsets.push(offset)
      if (offset === 0) {
        return page([invoice('KSEF-RECV-1', '2026-02-02T00:00:00.000Z')], '2026-02-02T00:00:00.000Z', true)
      }
      if (offset === 100) throw new Error('persistent page failure')
      throw new Error(`unexpected page offset ${offset}`)
    })

    await expect(
      receiveInvoicesCommand.execute({ dateFrom: '2026-02-01', dateTo: '2026-02-28' }, makeCtx(em)),
    ).rejects.toMatchObject({
      status: 502,
      body: { error: ABORT_ERROR },
    })

    expect(pageOffsets).toEqual([0, 100, 100, 100])
    expect(persisted.map((row) => row.ksefNumber)).toEqual(['KSEF-RECV-1'])
    expect(cursor.permanentStorageHwmDate).toBe('2026-02-01T00:00:00.000Z')
    expect(cursor.lastSyncedAt).toBe(lastSyncedAt)
  })

  it('fails loudly and leaves the cursor HWM unchanged when a row upsert fails on an otherwise good page', async () => {
    const cursor = makeCursor('2026-02-01T00:00:00.000Z')
    const { em, persisted } = makeEm(cursor)
    const basePersist = em.persist as (record: StoredRow) => { flush: () => Promise<void> }
    em.persist = jest.fn((record: StoredRow) => {
      if (record.ksefNumber === 'KSEF-RECV-BAD') {
        return { flush: async () => { throw new Error('row persistence failure') } }
      }
      return basePersist(record)
    })

    mockQueryReceivedInvoices.mockResolvedValue(
      page(
        [invoice('KSEF-RECV-1', '2026-02-02T00:00:00.000Z'), invoice('KSEF-RECV-BAD', '2026-02-03T00:00:00.000Z')],
        '2026-02-03T00:00:00.000Z',
        false,
      ),
    )

    await expect(
      receiveInvoicesCommand.execute({ dateFrom: '2026-02-01', dateTo: '2026-02-28' }, makeCtx(em)),
    ).rejects.toMatchObject({
      status: 502,
      body: { error: '[internal] KSeF received-invoice sync completed with failed rows; cursor not advanced' },
    })

    // The good row stays persisted (idempotent refetch), but the legal replay boundary does not move.
    expect(persisted.map((row) => row.ksefNumber)).toEqual(['KSEF-RECV-1'])
    expect(cursor.permanentStorageHwmDate).toBe('2026-02-01T00:00:00.000Z')
  })
})
