jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))
jest.mock('../../lib/submission-flow', () => ({
  submitInvoiceToKsef: jest.fn(),
}))

import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { submitInvoiceToKsef } from '../../lib/submission-flow'
import handler from '../ksef-submit'

describe('ksef-submit subscriber', () => {
  beforeEach(() => {
    ;(findOneWithDecryption as jest.Mock).mockReset()
    ;(submitInvoiceToKsef as jest.Mock).mockReset()
  })

  it('bails without loading the submission when the queued->processing claim is lost (no double-send)', async () => {
    const nativeUpdate = jest.fn(async () => 0)
    const em: Record<string, unknown> = { nativeUpdate }
    em.fork = () => em
    const ctx = { resolve: (name: string) => (name === 'em' ? em : undefined) }

    await handler({ submissionId: 'S', organizationId: 'O', tenantId: 'T' }, ctx as never)

    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'S', organizationId: 'O', tenantId: 'T', status: 'queued', deletedAt: null }),
      expect.objectContaining({ status: 'processing' }),
    )
    expect(findOneWithDecryption).not.toHaveBeenCalled()
    expect(submitInvoiceToKsef).not.toHaveBeenCalled()
  })

  it('resets a claimed submission back to queued and rethrows when the KSeF send throws, so the queue retries', async () => {
    const submission: Record<string, unknown> = {
      status: 'processing',
      attemptCount: 0,
      invoiceXml: '<Faktura/>',
      contextNip: '1234567890',
      environment: 'test',
    }
    const flush = jest.fn(async () => {})
    const nativeUpdate = jest.fn(async () => 1)
    const em: Record<string, unknown> = { nativeUpdate, flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    ;(submitInvoiceToKsef as jest.Mock).mockRejectedValue(new Error('429 Too Many Requests'))
    const credsService = { getRaw: jest.fn(async () => ({ ksefToken: 'T', environment: 'test' })) }
    const ctx = {
      resolve: (name: string) =>
        name === 'em' ? em : name === 'integrationCredentialsService' ? credsService : undefined,
    }

    await expect(handler({ submissionId: 'S', organizationId: 'O', tenantId: 'T' }, ctx as never)).rejects.toThrow('429')

    expect(submission.status).toBe('queued')
    expect(submission.lastErrorMessage).toContain('KSeF send failed')
    expect(flush).toHaveBeenCalled()
  })
})
