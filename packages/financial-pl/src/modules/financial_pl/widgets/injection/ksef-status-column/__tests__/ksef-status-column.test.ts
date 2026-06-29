import { isOfflineSendOverdue, formatDeadline } from '../widget.client'

const NOW = Date.parse('2026-06-29T12:00:00Z')

describe('isOfflineSendOverdue', () => {
  it('flags an offline_issued row whose deadline is past', () => {
    expect(isOfflineSendOverdue('offline_issued', '2026-06-28T23:59:59Z', NOW)).toBe(true)
  })

  it('does not flag an offline_issued row whose deadline is still in the future', () => {
    expect(isOfflineSendOverdue('offline_issued', '2026-06-30T00:00:00Z', NOW)).toBe(false)
  })

  it('never flags an accepted row (retroactive number landed) even past the deadline', () => {
    expect(isOfflineSendOverdue('accepted', '2026-06-01T00:00:00Z', NOW)).toBe(false)
  })

  it('never flags non-offline statuses', () => {
    expect(isOfflineSendOverdue('processing', '2026-06-01T00:00:00Z', NOW)).toBe(false)
    expect(isOfflineSendOverdue('queued', '2026-06-01T00:00:00Z', NOW)).toBe(false)
  })

  it('is false when no deadline is present', () => {
    expect(isOfflineSendOverdue('offline_issued', null, NOW)).toBe(false)
    expect(isOfflineSendOverdue('offline_issued', undefined, NOW)).toBe(false)
  })

  it('is false for an unparseable deadline (degrades safely, no false overdue)', () => {
    expect(isOfflineSendOverdue('offline_issued', 'not-a-date', NOW)).toBe(false)
  })
})

describe('formatDeadline', () => {
  it('formats a valid ISO deadline to a date string', () => {
    expect(formatDeadline('2026-06-30T00:00:00Z')).toMatch(/2026/)
  })

  it('returns the raw value for an unparseable input', () => {
    expect(formatDeadline('garbage')).toBe('garbage')
  })
})
