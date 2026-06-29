/**
 * Subscriber tests for financial_pl:ksef-repoll. Mirrors ksef-submit.test.ts: the external
 * boundary (findOneWithDecryption, repollSubmission, credentials, KsefClient, the event emit) is
 * mocked so the test exercises the state-machine resets that carry double-send / lost-update risk.
 *
 * Re-polling is READ-ONLY KSeF-side, so its safety property is: it only finalizes a `processing`
 * row that already carries BOTH references; on a missing-creds / non-terminal / notFound outcome it
 * resets the row to `queued` and re-emits exactly one `...queued` so the duplicate-safe re-send
 * (440-heal) recovers it; a transient throw rethrows WITHOUT a terminal write.
 */
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))
jest.mock('../../lib/submission-flow', () => ({
  repollSubmission: jest.fn(),
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
import { repollSubmission } from '../../lib/submission-flow'
import { buildKsefAuthConfig } from '../../lib/credentials'
import { emitFinancialPlEvent } from '../../events'
import handler from '../ksef-repoll'

const PAYLOAD = { submissionId: 'S', organizationId: 'O', tenantId: 'T' }

function ctxWithEm(em: Record<string, unknown>) {
  return { resolve: (name: string) => (name === 'em' ? em : undefined) } as never
}

beforeEach(() => {
  ;(findOneWithDecryption as jest.Mock).mockReset()
  ;(repollSubmission as jest.Mock).mockReset()
  ;(emitFinancialPlEvent as jest.Mock).mockClear()
  ;(buildKsefAuthConfig as jest.Mock).mockReset().mockReturnValue({ token: 'T' })
})

describe('ksef-repoll subscriber', () => {
  it('returns WITHOUT a terminal write when the row is not `processing` (not ours to recover)', async () => {
    const flush = jest.fn(async () => {})
    // `queued` row with references — still not eligible (only `processing` is re-pollable).
    const submission: Record<string, unknown> = {
      status: 'queued',
      sessionReference: 'sess',
      invoiceReference: 'inv',
    }
    const em: Record<string, unknown> = { flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)

    await handler(PAYLOAD, ctxWithEm(em))

    expect(repollSubmission).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(emitFinancialPlEvent).not.toHaveBeenCalled()
    expect(submission.status).toBe('queued')
  })

  it('returns WITHOUT a write when a reference is missing (a `processing` orphan)', async () => {
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      sessionReference: 'sess',
      invoiceReference: null, // missing the second reference ⇒ not re-pollable
    }
    const em: Record<string, unknown> = { flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)

    await handler(PAYLOAD, ctxWithEm(em))

    expect(repollSubmission).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(emitFinancialPlEvent).not.toHaveBeenCalled()
  })

  it('missing credentials: resets to `queued` and emits exactly one `...queued` (hand-off, no terminal mark)', async () => {
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      sessionReference: 'sess',
      invoiceReference: 'inv',
      contextNip: '1234567890',
      environment: 'test',
    }
    const em: Record<string, unknown> = { flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    ;(buildKsefAuthConfig as jest.Mock).mockReturnValue(null) // no usable auth ⇒ missing-creds path

    await handler(PAYLOAD, ctxWithEm(em))

    expect(repollSubmission).not.toHaveBeenCalled()
    expect(submission.status).toBe('queued')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(emitFinancialPlEvent).toHaveBeenCalledTimes(1)
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.queued',
      expect.objectContaining({ submissionId: 'S', organizationId: 'O', tenantId: 'T' }),
      expect.objectContaining({ persistent: true }),
    )
  })

  it('non-terminal / notFound poll result: resets to `queued` and emits exactly one `...queued`', async () => {
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      sessionReference: 'sess',
      invoiceReference: 'inv',
      contextNip: '1234567890',
      environment: 'test',
    }
    const em: Record<string, unknown> = { flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    // KSeF has no record of the reference (notFound) / still processing ⇒ non-terminal.
    ;(repollSubmission as jest.Mock).mockResolvedValue({ status: 'processing', notFound: true })

    await handler(PAYLOAD, ctxWithEm(em))

    expect(submission.status).toBe('queued')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(emitFinancialPlEvent).toHaveBeenCalledTimes(1)
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.queued',
      expect.objectContaining({ submissionId: 'S' }),
      expect.objectContaining({ persistent: true }),
    )
  })

  it('a transient repoll throw rethrows WITHOUT a terminal write (row stays `processing`, re-pollable)', async () => {
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      sessionReference: 'sess',
      invoiceReference: 'inv',
      contextNip: '1234567890',
      environment: 'test',
    }
    const em: Record<string, unknown> = { flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    ;(repollSubmission as jest.Mock).mockRejectedValue(new Error('503 Service Unavailable'))

    await expect(handler(PAYLOAD, ctxWithEm(em))).rejects.toThrow('503')

    // The error is recorded (one flush) but the row is NOT marked terminal and NO event is emitted.
    expect(submission.status).toBe('processing')
    expect(submission.lastErrorMessage).toContain('KSeF repoll failed')
    expect(emitFinancialPlEvent).not.toHaveBeenCalled()
  })

  it('an accepted poll result finalizes the row terminal and emits exactly one `...accepted`', async () => {
    const flush = jest.fn(async () => {})
    const submission: Record<string, unknown> = {
      status: 'processing',
      sessionReference: 'sess',
      invoiceReference: 'inv',
      contextNip: '1234567890',
      environment: 'test',
    }
    const em: Record<string, unknown> = { flush }
    em.fork = () => em
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(submission)
    ;(repollSubmission as jest.Mock).mockResolvedValue({ status: 'accepted', ksefNumber: 'KSEF-1' })

    await handler(PAYLOAD, ctxWithEm(em))

    expect(submission.status).toBe('accepted')
    expect(submission.ksefNumber).toBe('KSEF-1')
    expect(emitFinancialPlEvent).toHaveBeenCalledTimes(1)
    expect(emitFinancialPlEvent).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.accepted',
      expect.objectContaining({ submissionId: 'S', ksefNumber: 'KSEF-1' }),
      expect.objectContaining({ persistent: true }),
    )
  })
})
