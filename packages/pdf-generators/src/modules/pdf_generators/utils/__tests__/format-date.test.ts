import { formatDate } from '../formatDate'

describe('formatDate', () => {
  it('formats an ISO date as dd.mm.yyyy for the default pl-PL locale', () => {
    expect(formatDate('2026-05-09T10:30:00.000Z')).toBe('09.05.2026')
  })

  it('honours an explicit locale', () => {
    // en-GB renders day/month/year with slashes and 2-digit day/month.
    expect(formatDate('2026-05-09T10:30:00.000Z', 'en-GB')).toBe('09/05/2026')
  })

  it('pads single-digit day and month to two digits', () => {
    expect(formatDate('2026-01-03T00:00:00.000Z')).toBe('03.01.2026')
  })

  it('returns "Invalid Date" for an unparseable input', () => {
    expect(formatDate('not-a-date')).toBe('Invalid Date')
  })
})
