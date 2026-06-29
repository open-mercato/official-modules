/**
 * Subscriber tests for financial_pl:ksef-send-offline (SPEC-010 §Deferred send). Mirrors
 * ksef-submit.test.ts: the external boundary (the CAS claim via em.nativeUpdate,
 * findOneWithDecryption, submitInvoiceToKsef, credentials, KsefClient, the event emit) is mocked
 * so the test exercises the offline state-machine transitions that carry double-send risk.
 *
 * Safety properties under test:
 *  - the `offline_issued → processing` CAS claim is single-execution — a lost claim returns early
 *    with NO load and NO send (no duplicate offline send),
 *  - a transient send throw resets the row back to `offline_issued` (so the reconcile worker can
 *    re-claim) and rethrows,
 *  - a non-terminal send outcome resets the row back to `offline_issued` (never strands `processing`).
 */
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))
jest.mock('../../lib/submission-flow', () => ({
  submitInvoiceToKsef: jest.fn(),
}))
jest.mock('../../lib/credentials', () => ({
  readKsefCredentials: jest.fn(async () => ({ environment: 'test' })),
  buildKsefAuthConfig: jest.fn(() => ({ token: 'T' })),
}))
jest.mock('../../lib/ksef-client', () => ({
  KsefClient: jest.fn().mockImplementation(() => ({})),
}))
jest.mock('../../events', () => ({
  emitFinancialPlEvent: jest.fn(async () => {}),
}))

import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { submitInvoiceToKsef } from '../../lib/submission-flow'
import { buildKsefAuthConfig } from '../../lib/credentials'
import { emitFinancialPlEvent } from '../../events'
import handler from '../ksef-send-offline'

const PAYLOAD = { submissionId: 'S', organizationId: 'O', tenantId: 'T' }

function ctxWithEm(em: Record<string, unknown>) {
  return { resolve: (name: string) => (name === 'em' ? em : undefined) } as never
}

beforeEach(() => {
  ;(findOneWithDecryption as jest.Mock).mockReset()
  ;(submitInvoiceToKsef as jest.Mock).mockReset()
  ;(emitFinancialPlEvent as jest.Mock).mockClear()
  ;(buildKsefAuthConfig as jest.Mock).mockReset().mockReturnValue({ token: 'T' })
})

describe('ksef-send-offline subscriber', () => {
  it('bails when the offline_issued->processing CAS claim is lost (no load, no duplicate send)', async () => {
    const nativeUpdate = jest.fn(async () => 0) // claim lost ⇒ 0 rows transitioned
    const em: Record<string, unknown> = { nativeUpdate }
    em.fork = () => em

    await handler(PAYLOAD, ctxWithEm(em))

    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'S', organizationId: 'O', tenantId: 'T', status: 'offline_issued', deletedAt: null }),
      expect.objectContaining({ status: 'processing' }),
    )
    expect(findOneWithDecryption).not.toHaveBeenCalled()
    expect(submitInvoiceToKsef).not.toHaveBeenCalled()
    expect(emitFinancialPlEvent).not.toHaveBeenCalled()
  })

  it('resets to `offline_issued` and rethrows when the send throws (so the worker can re-claim)', async () => {
    const nativeUpdate = jest.fn(async () => 1) // claim won
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      attemptCount: 0,
      invoiceXml: '<Faktura/>',
      contextNip: '1234567890',
      environment: 'test',
    }
    const em: Record<string, unknown> = { nativeUpdate, flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    ;(submitInvoiceToKsef as jest.Mock).mockRejectedValue(new Error('429 Too Many Requests'))

    await expect(handler(PAYLOAD, ctxWithEm(em))).rejects.toThrow('429')

    expect(submission.status).toBe('offline_issued')
    expect(submission.lastErrorMessage).toContain('KSeF offline send failed')
    expect(flush).toHaveBeenCalled()
    // A throw is not a terminal outcome ⇒ no accepted/rejected event is emitted.
    expect(emitFinancialPlEvent).not.toHaveBeenCalled()
  })

  it('resets to `offline_issued` on a non-terminal send outcome (never strands `processing`)', async () => {
    const nativeUpdate = jest.fn(async () => 1)
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      attemptCount: 0,
      invoiceXml: '<Faktura/>',
      contextNip: '1234567890',
      environment: 'test',
    }
    const em: Record<string, unknown> = { nativeUpdate, flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    // Still processing KSeF-side (neither accepted nor rejected) ⇒ non-terminal.
    ;(submitInvoiceToKsef as jest.Mock).mockResolvedValue({
      status: 'processing',
      sessionReference: 'sess',
      invoiceReference: 'inv',
    })

    await handler(PAYLOAD, ctxWithEm(em))

    expect(submission.status).toBe('offline_issued')
    expect(submission.sessionReference).toBe('sess')
    expect(submission.invoiceReference).toBe('inv')
    expect(flush).toHaveBeenCalled()
    expect(emitFinancialPlEvent).not.toHaveBeenCalled()
  })

  it('on acceptance: stamps the terminal row + emits exactly one `...accepted`', async () => {
    const nativeUpdate = jest.fn(async () => 1)
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      attemptCount: 0,
      invoiceXml: '<Faktura/>',
      contextNip: '1234567890',
      environment: 'test',
    }
    const em: Record<string, unknown> = { nativeUpdate, flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    ;(submitInvoiceToKsef as jest.Mock).mockResolvedValue({ status: 'accepted', ksefNumber: 'KSEF-OFF-1' })

    await handler(PAYLOAD, ctxWithEm(em))

    expect(submission.status).toBe('accepted')
    expect(submission.ksefNumber).toBe('KSEF-OFF-1')
    expect(submission.acceptedAt).toBeInstanceOf(Date)
    expect(emitFinancialPlEvent).toHaveBeenCalledTimes(1)
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.accepted',
      expect.objectContaining({ submissionId: 'S', ksefNumber: 'KSEF-OFF-1' }),
      expect.objectContaining({ persistent: true }),
    )
  })
})
