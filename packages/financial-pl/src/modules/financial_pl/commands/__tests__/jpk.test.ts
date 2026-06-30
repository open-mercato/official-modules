/**
 * Command tests for the JPK_V7 commands (SPEC-012): upsert/delete purchase records,
 * upsert filing, and generate. Mirrors the `makeCtx`/em-mock style of ksef-submission.test.ts.
 *
 * Focus is the cross-cutting safety guards, not the XML build (proven by the jpk/lib suites):
 *  - tenant/org isolation (a row owned by another org reads as null ⇒ 404 — never silently
 *    upserts/deletes across the scope boundary),
 *  - the create path persists under the resolved scope's (organizationId, tenantId),
 *  - the partial unique index race on a duplicate filing surfaces a clean 409 (not a 500),
 *  - generate refuses to clobber a `submitted` filing (terminal) and refuses without a contextNip.
 */
// generateCommand resolves i18n translations via the shared server helper, which needs the module
// registry bootstrapped at runtime. These tests are not about translations, so mock the helper to
// return the fallback translator (translate(key, fallback) => fallback) — mirrors ksef-issue-offline.
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  })),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

const mockPollJpkStatus = jest.fn()
const mockSubmitJpk = jest.fn()

jest.mock('../../lib/jpk/jpk-submission-client', () => ({
  JPK_STATUS_POLL_TIMEOUT_ERROR: 'status poll timed out',
  pollJpkStatus: (...args: unknown[]) => mockPollJpkStatus(...args),
  submitJpk: (...args: unknown[]) => mockSubmitJpk(...args),
}))

import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  upsertPurchaseRecordCommand,
  deletePurchaseRecordCommand,
  upsertFilingCommand,
  generateCommand,
  submitFilingCommand,
} from '../jpk'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const REC = '33333333-3333-4333-8333-333333333333'
const FIL = '44444444-4444-4444-8444-444444444444'
const ORIGINAL_OM_JPK_MF_CERT_PEM = process.env.OM_JPK_MF_CERT_PEM

type Resolvable = { creds?: Record<string, unknown> | null; em: Record<string, unknown> }

/** Build a CommandRuntimeContext whose container resolves `em` to an object whose `.fork()`
 * returns the mock em (the commands call `(resolve('em') as EntityManager).fork()`), plus an
 * optional integration-credentials service (generate reads it). */
function makeCtx(opts: Resolvable) {
  const forkHost = { fork: () => opts.em }
  return {
    container: {
      resolve: (name: string) => {
        if (name === 'em') return forkHost
        if (name === 'integrationCredentialsService') return { getRaw: async () => opts.creds ?? null }
        if (name === 'queryEngine') return { query: async () => ({ items: [] }) }
        return undefined
      },
    },
    auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
    organizationScope: null,
    selectedOrganizationId: ORG,
    organizationIds: null,
    request: null,
  } as unknown as Parameters<typeof generateCommand.execute>[1]
}

function makeSubmitEm(filing: Record<string, unknown>) {
  const flush = jest.fn(async () => {})
  const nativeUpdate = jest.fn(async (_entity: unknown, _where: unknown, update: Record<string, unknown>) => {
    Object.assign(filing, update)
    return 1
  })
  const em: Record<string, unknown> = {
    nativeUpdate,
    flush,
    transactional: jest.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn(em)),
  }
  em.fork = () => em
  return { em, flush, nativeUpdate }
}

/** A minimal valid purchase-record upsert input (schema-complete: year/month/documentNumber/date). */
function purchaseInput(overrides: Record<string, unknown> = {}) {
  return {
    year: 2026,
    month: 6,
    documentNumber: 'FZ/1',
    purchaseDate: '2026-06-10',
    transactionClass: 'domestic' as const,
    netOther: '1000.00',
    vatOther: '230.00',
    ...overrides,
  }
}

/** A minimal valid filing upsert input (primary V7M filing — correctionScope must be 'both'). */
function filingInput(overrides: Record<string, unknown> = {}) {
  return {
    variant: 'V7M' as const,
    year: 2026,
    month: 6,
    celZlozenia: 1 as const,
    correctionScope: 'both' as const,
    kodUrzedu: '0202',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(findOneWithDecryption as jest.Mock).mockReset()
  mockPollJpkStatus.mockReset()
  mockSubmitJpk.mockReset()
  delete process.env.OM_JPK_MF_CERT_PEM
})

afterAll(() => {
  if (ORIGINAL_OM_JPK_MF_CERT_PEM === undefined) {
    delete process.env.OM_JPK_MF_CERT_PEM
  } else {
    process.env.OM_JPK_MF_CERT_PEM = ORIGINAL_OM_JPK_MF_CERT_PEM
  }
})

describe('JPK commands — tenant/org isolation guard (a foreign id reads null ⇒ 404)', () => {
  it('upsertPurchaseRecordCommand with a parsed.id whose row belongs to another org → 404', async () => {
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => null), // id belongs to another (organization, tenant) ⇒ scoped lookup misses
      create: jest.fn(),
      persist: jest.fn(),
      flush: jest.fn(),
    }
    await expect(
      upsertPurchaseRecordCommand.execute(purchaseInput({ id: REC }), makeCtx({ em })),
    ).rejects.toMatchObject({ status: 404 })
    expect(em.create).not.toHaveBeenCalled()
  })

  it('deletePurchaseRecordCommand with a foreign id (scoped findOne → null) → 404, no soft-delete flushed', async () => {
    const em: Record<string, unknown> = { findOne: jest.fn(async () => null), flush: jest.fn() }
    await expect(deletePurchaseRecordCommand.execute({ id: REC }, makeCtx({ em }))).rejects.toMatchObject({ status: 404 })
    expect(em.findOne).toHaveBeenCalled()
    expect(em.flush).not.toHaveBeenCalled()
  })

  it('upsertFilingCommand with a parsed.id whose row belongs to another org → 404', async () => {
    const em: Record<string, unknown> = { findOne: jest.fn(async () => null), create: jest.fn(), flush: jest.fn() }
    await expect(
      upsertFilingCommand.execute(filingInput({ id: FIL }), makeCtx({ em })),
    ).rejects.toMatchObject({ status: 404 })
    expect(em.create).not.toHaveBeenCalled()
  })
})

describe('JPK commands — create path persists under the resolved scope', () => {
  it('upsertPurchaseRecordCommand with NO id creates + persists under (ORG, TEN) and returns { id }', async () => {
    const create = jest.fn((_e: unknown, data: Record<string, unknown>) => ({ id: 'NEW', ...data }))
    const flush = jest.fn(async () => {})
    const persist = jest.fn(() => ({ flush }))
    const em: Record<string, unknown> = { findOne: jest.fn(async () => null), create, persist }

    const result = await upsertPurchaseRecordCommand.execute(purchaseInput(), makeCtx({ em }))

    expect(result).toMatchObject({ id: 'NEW' })
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, tenantId: TEN }),
    )
    expect(persist).toHaveBeenCalled()
    expect(flush).toHaveBeenCalled()
  })
})

describe('JPK commands — undoable (M8)', () => {
  it('delete is undoable: execute soft-deletes + returns a snapshot, undo restores deleted_at', async () => {
    const record: Record<string, unknown> = { id: REC, organizationId: ORG, tenantId: TEN, deletedAt: null, updatedAt: null }
    const em: Record<string, unknown> = { findOne: jest.fn(async () => record), flush: jest.fn(async () => {}) }

    const result = await deletePurchaseRecordCommand.execute({ id: REC }, makeCtx({ em }))
    expect(record.deletedAt).toBeInstanceOf(Date)
    expect(result.undo).toMatchObject({ kind: 'purchase_record', op: 'delete', id: REC, tenantId: TEN, organizationId: ORG })

    const logEntry = { commandPayload: { undo: result.undo } }
    await deletePurchaseRecordCommand.undo!({ ctx: makeCtx({ em }), logEntry } as never)
    expect(record.deletedAt).toBeNull()
  })

  it('upsert create is undoable: undo soft-deletes the created row', async () => {
    const created: Record<string, unknown> = { id: 'NEW', organizationId: ORG, tenantId: TEN, deletedAt: null, updatedAt: null }
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => created),
      create: jest.fn(() => created),
      persist: () => ({ flush: async () => {} }),
      flush: jest.fn(async () => {}),
    }
    const result = await upsertPurchaseRecordCommand.execute(purchaseInput(), makeCtx({ em }))
    expect(result.undo).toMatchObject({ op: 'create', id: 'NEW' })
    await upsertPurchaseRecordCommand.undo!({ ctx: makeCtx({ em }), logEntry: { commandPayload: { undo: result.undo } } } as never)
    expect(created.deletedAt).toBeInstanceOf(Date)
  })
})

describe('JPK commands — duplicate filing race (M6: partial unique index ⇒ 409, not 500)', () => {
  it('upsertFilingCommand create path maps a 23505 unique violation to 409 with the winner id', async () => {
    let findOneCalls = 0
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => {
        findOneCalls += 1
        // No id on the input ⇒ no pre-check lookup; the only findOne is the post-conflict winner lookup.
        return { id: 'WINNER' }
      }),
      create: jest.fn((_e: unknown, data: Record<string, unknown>) => ({ id: 'LOSER', ...data })),
      persist: () => ({
        flush: async () => {
          throw Object.assign(new Error('dup'), {
            code: '23505',
            constraint: 'financial_pl_jpk_filing_active_unique',
          })
        },
      }),
    }

    let caught: { status?: number; body?: Record<string, unknown> } | null = null
    try {
      await upsertFilingCommand.execute(filingInput(), makeCtx({ em }))
    } catch (e) {
      caught = e as { status?: number; body?: Record<string, unknown> }
    }
    expect(caught?.status).toBe(409)
    expect(caught?.body?.filingId).toBe('WINNER')
    expect(findOneCalls).toBe(1)
  })
})

describe('JPK generate — terminal/credentials guards', () => {
  it('L4: refuses to regenerate a submitted filing → 409 (before building any XML)', async () => {
    const flush = jest.fn(async () => {})
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => ({ id: FIL, status: 'submitted', contextNip: '5260001246' })),
      flush,
    }
    await expect(
      generateCommand.execute({ filingId: FIL }, makeCtx({ em, creds: { contextNip: '5260001246' } })),
    ).rejects.toMatchObject({ status: 409 })
    // No write — the filed XML/status is never clobbered.
    expect(flush).not.toHaveBeenCalled()
  })

  it('cross-org filingId reads null → 404', async () => {
    const em: Record<string, unknown> = { findOne: jest.fn(async () => null), flush: jest.fn() }
    await expect(
      generateCommand.execute({ filingId: FIL }, makeCtx({ em, creds: { contextNip: '5260001246' } })),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('no contextNip (filing has none AND no credential NIP) → 409 credentials_missing', async () => {
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => ({ id: FIL, status: 'draft', contextNip: null })),
      flush: jest.fn(),
    }
    // creds: null ⇒ readKsefCredentials yields {} ⇒ no contextNip resolved ⇒ 409.
    await expect(
      generateCommand.execute({ filingId: FIL }, makeCtx({ em, creds: null })),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe('JPK submit — ambiguous MF reference remains resumable', () => {
  it('keeps a failed submission with a reference in submitting state, then re-polls on the next submit', async () => {
    process.env.OM_JPK_MF_CERT_PEM = 'MF CERT'
    const filing: Record<string, unknown> = {
      id: FIL,
      organizationId: ORG,
      tenantId: TEN,
      status: 'generated',
      generatedXml: '<JPK>payload</JPK>',
      submissionReference: null,
      submissionError: null,
      deletedAt: null,
      createdAt: new Date('2026-06-30T10:00:00Z'),
      updatedAt: new Date('2026-06-30T10:00:00Z'),
    }
    const { em } = makeSubmitEm(filing)
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(filing)
    mockSubmitJpk.mockResolvedValueOnce({
      ok: false,
      referenceNumber: 'JPK-REF-AMBIGUOUS',
      error: 'JPK blob upload failed with HTTP 502',
    })

    await expect(
      submitFilingCommand.execute(
        { filingId: FIL },
        makeCtx({
          em,
          creds: {
            environment: 'test',
            jpkSignerCertPem: 'SIGNER CERT',
            jpkSignerPrivateKeyPem: 'SIGNER KEY',
          },
        }),
      ),
    ).rejects.toMatchObject({
      status: 502,
      body: { code: 'jpk_submit_failed', referenceNumber: 'JPK-REF-AMBIGUOUS' },
    })

    expect(filing.status).toBe('submitting')
    expect(filing.submissionReference).toBe('JPK-REF-AMBIGUOUS')
    expect(filing.submissionError).toBe('JPK blob upload failed with HTTP 502')

    mockPollJpkStatus.mockResolvedValueOnce({
      ok: true,
      referenceNumber: 'JPK-REF-AMBIGUOUS',
      status: '200',
      upoXml: '<UPO>ok</UPO>',
    })

    const result = await submitFilingCommand.execute(
      { filingId: FIL },
      makeCtx({
        em,
        creds: {
          environment: 'test',
          jpkSignerCertPem: 'SIGNER CERT',
          jpkSignerPrivateKeyPem: 'SIGNER KEY',
        },
      }),
    )

    expect(result).toEqual({ filingId: FIL, status: 'submitted', referenceNumber: 'JPK-REF-AMBIGUOUS' })
    expect(mockPollJpkStatus).toHaveBeenCalledWith('JPK-REF-AMBIGUOUS', { environment: 'test' })
    expect(mockSubmitJpk).toHaveBeenCalledTimes(1)
    expect(filing.status).toBe('submitted')
    expect(filing.upoXml).toBe('<UPO>ok</UPO>')
  })

  it('names OM_JPK_MF_CERT_PEM when the MF public certificate is missing', async () => {
    const filing: Record<string, unknown> = {
      id: FIL,
      organizationId: ORG,
      tenantId: TEN,
      status: 'generated',
      generatedXml: '<JPK>payload</JPK>',
      submissionReference: null,
      submissionError: null,
      deletedAt: null,
      createdAt: new Date('2026-06-30T10:00:00Z'),
      updatedAt: new Date('2026-06-30T10:00:00Z'),
    }
    const { em } = makeSubmitEm(filing)
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(filing)

    await expect(
      submitFilingCommand.execute(
        { filingId: FIL },
        makeCtx({
          em,
          creds: {
            environment: 'test',
            jpkSignerCertPem: 'SIGNER CERT',
            jpkSignerPrivateKeyPem: 'SIGNER KEY',
          },
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      body: {
        code: 'jpk_mf_cert_missing',
        error: expect.stringContaining('OM_JPK_MF_CERT_PEM'),
      },
    })
    expect(filing.status).toBe('generated')
    expect(mockSubmitJpk).not.toHaveBeenCalled()
  })
})
