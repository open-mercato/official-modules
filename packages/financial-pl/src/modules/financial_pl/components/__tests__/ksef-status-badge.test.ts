import { ksefStatusMap, isOfflineSendOverdue } from '../KsefStatusBadge'

/**
 * SPEC-013 unit coverage for the pure component logic that the deleted KSeF-status
 * injection-widget test used to cover. The widget render is exercised by the
 * integration suite (TC-KSEF-UI-001 asserts the column renders); here we pin the two
 * pure, DOM-free helpers the badge depends on:
 *  - `ksefStatusMap` — the semantic status-role map (DS §22: a StatusMap, never
 *    hardcoded colors), incl. the synthetic `offline_overdue` error role (review M9).
 *  - `isOfflineSendOverdue` — the deadline predicate that escalates an offline-issued
 *    row to the error role once its statutory send-to-KSeF deadline has passed.
 */

describe('ksefStatusMap — semantic status roles (SPEC-013, DS §22)', () => {
  it('maps every KSeF status to a known StatusBadge role (no hardcoded colors)', () => {
    expect(ksefStatusMap).toEqual({
      accepted: 'success',
      offline_issued: 'success',
      ready: 'info',
      queued: 'info',
      processing: 'warning',
      rejected: 'error',
      not_applicable: 'neutral',
      offline_overdue: 'error',
    })
  })

  it('rejected and the synthetic offline_overdue both read as the error role', () => {
    expect(ksefStatusMap.rejected).toBe('error')
    // offline_overdue carries its OWN error role so an overdue offline row never reads
    // as a (success) offline_issued.
    expect(ksefStatusMap.offline_overdue).toBe('error')
    expect(ksefStatusMap.offline_overdue).not.toBe(ksefStatusMap.offline_issued)
  })

  it('accepted and a clean offline_issued read as success', () => {
    expect(ksefStatusMap.accepted).toBe('success')
    expect(ksefStatusMap.offline_issued).toBe('success')
  })
})

describe('isOfflineSendOverdue — statutory send-deadline predicate (review M9)', () => {
  const NOW = Date.parse('2026-06-29T12:00:00.000Z')
  const PAST = '2026-06-28T12:00:00.000Z'
  const FUTURE = '2026-06-30T12:00:00.000Z'

  it('is true ONLY for an offline_issued row whose deadline is in the past', () => {
    expect(isOfflineSendOverdue('offline_issued', PAST, NOW)).toBe(true)
  })

  it('is false for an offline_issued row whose deadline is still in the future', () => {
    expect(isOfflineSendOverdue('offline_issued', FUTURE, NOW)).toBe(false)
  })

  it('is false at the exact deadline boundary (overdue means strictly past)', () => {
    const exact = new Date(NOW).toISOString()
    expect(isOfflineSendOverdue('offline_issued', exact, NOW)).toBe(false)
  })

  it('never flags a non-offline status, even with a past deadline (accepted is terminal)', () => {
    // The retroactive KSeF number lands on acceptance, so an accepted row is never overdue.
    expect(isOfflineSendOverdue('accepted', PAST, NOW)).toBe(false)
    expect(isOfflineSendOverdue('queued', PAST, NOW)).toBe(false)
    expect(isOfflineSendOverdue('rejected', PAST, NOW)).toBe(false)
  })

  it('is false when there is no deadline or status', () => {
    expect(isOfflineSendOverdue('offline_issued', null, NOW)).toBe(false)
    expect(isOfflineSendOverdue('offline_issued', undefined, NOW)).toBe(false)
    expect(isOfflineSendOverdue(null, PAST, NOW)).toBe(false)
  })

  it('is false for an unparseable deadline string (no false-positive overdue)', () => {
    expect(isOfflineSendOverdue('offline_issued', 'not-a-date', NOW)).toBe(false)
  })

  it('defaults `now` to the current clock when omitted', () => {
    // A deadline far in the past is overdue against the real clock; one far in the
    // future is not — without passing an explicit `now`.
    expect(isOfflineSendOverdue('offline_issued', '2000-01-01T00:00:00.000Z')).toBe(true)
    expect(isOfflineSendOverdue('offline_issued', '2999-01-01T00:00:00.000Z')).toBe(false)
  })
})
