import { computeOfflineSendDeadline, polishPublicHolidays } from '../offline-deadline'

const iso = (date: Date): string => date.toISOString().slice(0, 10)
/** UTC-midnight Date for an ISO `YYYY-MM-DD` day. */
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

describe('polishPublicHolidays', () => {
  it('pins the full 2026 set (fixed + Easter-derived movable feasts)', () => {
    expect(polishPublicHolidays(2026)).toEqual([
      '2026-01-01', // Nowy Rok
      '2026-01-06', // Trzech Króli
      '2026-04-05', // Wielkanoc (Easter Sunday)
      '2026-04-06', // Poniedziałek Wielkanocny (Easter Monday)
      '2026-05-01', // Święto Pracy
      '2026-05-03', // Konstytucji 3 Maja
      '2026-05-24', // Zielone Świątki (Pentecost)
      '2026-06-04', // Boże Ciało (Corpus Christi)
      '2026-08-15', // Wniebowzięcie NMP
      '2026-11-01', // Wszystkich Świętych
      '2026-11-11', // Niepodległości
      '2026-12-25', // Boże Narodzenie
      '2026-12-26', // Drugi dzień
    ])
  })

  it('pins the full 2027 set', () => {
    expect(polishPublicHolidays(2027)).toEqual([
      '2027-01-01',
      '2027-01-06',
      '2027-03-28', // Easter Sunday
      '2027-03-29', // Easter Monday
      '2027-05-01',
      '2027-05-03',
      '2027-05-16', // Pentecost
      '2027-05-27', // Corpus Christi
      '2027-08-15',
      '2027-11-01',
      '2027-11-11',
      '2027-12-25',
      '2027-12-26',
    ])
  })

  it('is deterministic and frozen', () => {
    const a = polishPublicHolidays(2026)
    expect(Object.isFrozen(a)).toBe(true)
    expect(polishPublicHolidays(2026)).toEqual(a)
  })
})

describe('computeOfflineSendDeadline — offline24 (next business day)', () => {
  it('rolls a Friday issuance over the weekend to Monday', () => {
    // 2026-02-06 is a Friday → next business day is Monday 2026-02-09.
    const deadline = computeOfflineSendDeadline({ issuedAt: day('2026-02-06'), mode: 'offline24' }, {})
    expect(iso(deadline)).toBe('2026-02-09')
  })

  it('skips both weekends AND a public holiday', () => {
    // Issue Thursday 2026-12-24. Fri 25 + Sat 26 are Christmas holidays, Sun 27
    // is a weekend → first business day is Monday 2026-12-28.
    const deadline = computeOfflineSendDeadline({ issuedAt: day('2026-12-24'), mode: 'offline24' }, {})
    expect(iso(deadline)).toBe('2026-12-28')
  })

  it('honours the OM_KSEF_PL_HOLIDAYS override as an extra non-working day', () => {
    // Friday 2026-02-06 would roll to Monday 2026-02-09, but the override marks
    // 2026-02-09 non-working → Tuesday 2026-02-10.
    const deadline = computeOfflineSendDeadline(
      { issuedAt: day('2026-02-06'), mode: 'offline24' },
      { OM_KSEF_PL_HOLIDAYS: '2026-02-09' },
    )
    expect(iso(deadline)).toBe('2026-02-10')
  })
})

describe('computeOfflineSendDeadline — awaryjny (failure end + 7 business days)', () => {
  it('adds 7 business days skipping the Corpus Christi holiday', () => {
    // failureEndsAt Monday 2026-06-01. 7 business days after, skipping the
    // 2026-06-04 (Corpus Christi) holiday: 02,03,05,08,09,10,11 → 2026-06-11.
    const deadline = computeOfflineSendDeadline(
      { issuedAt: day('2026-05-15'), mode: 'awaryjny', failureEndsAt: day('2026-06-01') },
      {},
    )
    expect(iso(deadline)).toBe('2026-06-11')
  })

  it('requires failureEndsAt for awaryjny', () => {
    expect(() => computeOfflineSendDeadline({ issuedAt: day('2026-06-01'), mode: 'awaryjny' }, {})).toThrow()
  })
})

describe('computeOfflineSendDeadline — offline24 overtaken by an announced failure', () => {
  it('recomputes to the awaryjny rule (failure end + 7bd) when a window is supplied', () => {
    // Same invoice issued offline24, but a failure window is later announced.
    // The deadline switches to failureEndsAt + 7 business days (≠ next-bd-of-issue).
    const overtaken = computeOfflineSendDeadline(
      { issuedAt: day('2026-05-15'), mode: 'offline24', failureEndsAt: day('2026-06-01') },
      {},
    )
    expect(iso(overtaken)).toBe('2026-06-11')

    const original = computeOfflineSendDeadline({ issuedAt: day('2026-05-15'), mode: 'offline24' }, {})
    expect(iso(original)).toBe('2026-05-18') // next business day after Fri 2026-05-15
    expect(iso(overtaken)).not.toBe(iso(original))
  })
})

describe('computeOfflineSendDeadline — purity', () => {
  it('returns the same result for the same inputs', () => {
    const params = { issuedAt: day('2026-02-06'), mode: 'offline24' as const }
    const a = computeOfflineSendDeadline(params, {})
    const b = computeOfflineSendDeadline(params, {})
    expect(iso(a)).toBe(iso(b))
  })

  it('honours an explicitly supplied holidays list', () => {
    // With no holidays at all, Fri 2026-12-25 (Christmas) is treated as business:
    // issuance Thu 2026-12-24 → Fri 2026-12-25.
    const deadline = computeOfflineSendDeadline(
      { issuedAt: day('2026-12-24'), mode: 'offline24', holidays: [] },
      {},
    )
    expect(iso(deadline)).toBe('2026-12-25')
  })
})
