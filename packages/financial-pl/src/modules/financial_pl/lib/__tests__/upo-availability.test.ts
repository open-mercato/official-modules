import type { EntityManager } from '@mikro-orm/postgresql'
import { selectSubmissionIdsWithUpo } from '../upo-availability'
import { KsefSubmission } from '../../data/entities'

function emStub(rows: Array<{ id: string }>) {
  const find = jest.fn().mockResolvedValue(rows)
  return { em: { find } as unknown as EntityManager, find }
}

describe('selectSubmissionIdsWithUpo', () => {
  it('returns only the submissions that actually stored a receipt', async () => {
    const { em } = emStub([{ id: 'has-upo' }])

    const result = await selectSubmissionIdsWithUpo(em, ['has-upo', 'accepted-without-upo'], 'tenant-1')

    expect(result.has('has-upo')).toBe(true)
    // The QA #40 regression: an accepted row with no receipt must not advertise a download.
    expect(result.has('accepted-without-upo')).toBe(false)
  })

  it('filters on the receipt column and tenant without ever projecting the encrypted XML', async () => {
    const { em, find } = emStub([])

    await selectSubmissionIdsWithUpo(em, ['a'], 'tenant-1')

    const [entity, where, options] = find.mock.calls[0]
    expect(entity).toBe(KsefSubmission)
    expect(where).toEqual({ id: { $in: ['a'] }, tenantId: 'tenant-1', upoXml: { $ne: null } })
    // Projecting `upoXml` would drag the (potentially large) receipt through the on-load
    // decryption subscriber on every list render — the id-only projection is the contract.
    expect(options).toEqual({ fields: ['id'] })
  })

  it('skips the query entirely when there are no submissions to check', async () => {
    const { em, find } = emStub([])

    const result = await selectSubmissionIdsWithUpo(em, [], 'tenant-1')

    expect(result.size).toBe(0)
    expect(find).not.toHaveBeenCalled()
  })
})
