import type { CommandRuntimeContext, CommandUndoLogEntry } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createRecordCommand, markAppliedCommand } from '../commands/records'
import type { EnrichmentRecord } from '../data/entities'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))
jest.mock('../data/entities', () => ({ EnrichmentRecord: class EnrichmentRecord {} }))
jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand: jest.fn() }))

const scope = { tenantId: 't1', organizationId: 'o1' }

function makeContext() {
  const created: Array<Record<string, unknown>> = []
  const em = {
    flush: jest.fn(async () => undefined),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      const row = { id: 'new-record', ...data }
      created.push(row)
      return row
    }),
  }
  const forkable = { fork: () => em }
  const ctx = {
    container: { resolve: jest.fn(() => forkable) },
    auth: null,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as unknown as CommandRuntimeContext
  return { ctx, em, created }
}

function completedRecord(overrides: Partial<EnrichmentRecord> = {}): EnrichmentRecord {
  return {
    id: 'rec-1',
    ...scope,
    subjectType: 'person',
    subjectId: 'person-1',
    status: 'completed',
    proposal: { jobTitle: 'CTO', linkedInUrl: 'https://linkedin.com/in/jane' },
    appliedFields: null,
    appliedAt: null,
    appliedByUserId: null,
    ...overrides,
  } as EnrichmentRecord
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('enrichment_treg.records.create', () => {
  it('creates a pending record and soft-deletes it on undo', async () => {
    const { ctx, em, created } = makeContext()
    const result = await createRecordCommand.execute(
      { ...scope, subjectType: 'company', subjectId: 'company-1', identity: { domain: 'acme.com' }, requestedByUserId: 'user-1' },
      ctx,
    )

    expect(result).toEqual({ recordId: 'new-record' })
    expect(created[0]).toMatchObject({ subjectType: 'company', endpointId: 'treg.companies.enrich', identity: { domain: 'acme.com' } })
    expect(em.flush).toHaveBeenCalled()

    const row = completedRecord({ id: 'new-record' })
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(row)
    await createRecordCommand.undo?.({
      input: { ...scope, subjectType: 'company', subjectId: 'company-1', identity: {}, requestedByUserId: null },
      ctx,
      logEntry: { resourceId: 'new-record' } as CommandUndoLogEntry,
    })
    expect(row.deletedAt).toBeInstanceOf(Date)
  })
})

describe('enrichment_treg.records.mark_applied', () => {
  it('merges applied fields and restores the previous state on undo', async () => {
    const { ctx } = makeContext()
    const row = completedRecord({ appliedFields: ['linkedInUrl'] })
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(row)
    const input = { ...scope, recordId: 'rec-1', fields: ['jobTitle'], appliedByUserId: 'user-2' }

    const prepared = await markAppliedCommand.prepare?.(input, ctx)
    const result = await markAppliedCommand.execute(input, ctx)

    expect(result.appliedFields.sort()).toEqual(['jobTitle', 'linkedInUrl'])
    expect(row.appliedByUserId).toBe('user-2')

    await markAppliedCommand.undo?.({ input, ctx, logEntry: { snapshotBefore: prepared?.before } as CommandUndoLogEntry })
    expect(row.appliedFields).toEqual(['linkedInUrl'])
    expect(row.appliedByUserId).toBeNull()
    expect(row.appliedAt).toBeNull()
  })

  it.each([
    [null, 404, 'record_not_found'],
    [completedRecord({ status: 'running', proposal: null }), 409, 'record_not_applicable'],
  ])('rejects %#', async (row, status, error) => {
    const { ctx } = makeContext()
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(row)
    await expect(
      markAppliedCommand.execute({ ...scope, recordId: 'rec-1', fields: ['jobTitle'], appliedByUserId: 'u' }, ctx),
    ).rejects.toMatchObject({ status, body: { error } })
  })

  it('rejects fields that are not in the proposal', async () => {
    const { ctx } = makeContext()
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(completedRecord())
    await expect(
      markAppliedCommand.execute({ ...scope, recordId: 'rec-1', fields: ['industry'], appliedByUserId: 'u' }, ctx),
    ).rejects.toMatchObject({ status: 400, body: { error: 'field_not_in_proposal' } })
  })
})
