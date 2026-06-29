/**
 * Statutory send-to-KSeF deadline calculator for offline issuance (SPEC-010).
 *
 * Pure + deterministic — no I/O, no clock reads beyond the supplied `issuedAt`.
 *
 * Two legal modes (art. 106nda / art. 106nf):
 * - `offline24`: send by the **next business day** after issuance.
 * - `awaryjny` (MF-announced failure): send within **7 business days** from the
 *   **end** of the announced failure window. An `offline24` invoice overtaken by
 *   a later-announced failure switches to this rule (supply `failureEndsAt`).
 *
 * Business days skip Saturdays, Sundays, and Polish public holidays. The holiday
 * set is computed locally via `polishPublicHolidays` (Anonymous Gregorian /
 * Meeus Computus algorithm for the Easter-derived movable feasts) — no external
 * data, valid for any year. `OM_KSEF_PL_HOLIDAYS` (CSV of ISO YYYY-MM-DD) adds
 * extra non-working days (e.g. an ad-hoc statutory day) when env-supplied.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Format a UTC Date as an ISO `YYYY-MM-DD` calendar day. */
function toIsoDay(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0')
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = date.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Build a UTC midnight Date for the given Y/M(1-based)/D triple. */
function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

/**
 * The Polish (Europe/Warsaw) calendar day of an instant, as a UTC-midnight Date used as a
 * "floating" calendar-day token by the business-day arithmetic. The statutory deadline is a
 * Polish calendar date (art. 106nda/106nf), so an instant near midnight UTC MUST be mapped to its
 * Warsaw-local day (CET/CEST), not its UTC day — otherwise the wrong calendar day (and deadline)
 * is computed. Deterministic (no clock read); uses the ICU time-zone database.
 */
function warsawCalendarDay(instant: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  return utcDay(part('year'), part('month'), part('day'))
}

/**
 * Easter Sunday for a given year via the Anonymous Gregorian algorithm
 * (Meeus/Jones/Butcher Computus). Returns a UTC-midnight Date.
 */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return utcDay(year, month, day)
}

/** Add `days` calendar days to a UTC-midnight Date, returning a new Date. */
function addCalendarDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY)
}

/**
 * The Polish public (statutory non-working) holidays for a calendar `year`, as
 * ISO `YYYY-MM-DD` strings: the fixed national holidays plus the Easter-derived
 * movable feasts (Easter Sunday, Easter Monday, Pentecost Sunday = Easter+49,
 * Corpus Christi = Easter+60). Computed locally — valid for any year.
 */
export function polishPublicHolidays(year: number): readonly string[] {
  const fixed: ReadonlyArray<[number, number]> = [
    [1, 1], // Nowy Rok
    [1, 6], // Trzech Króli (Epiphany)
    [5, 1], // Święto Pracy (Labour Day)
    [5, 3], // Święto Konstytucji 3 Maja
    [8, 15], // Wniebowzięcie NMP (Assumption)
    [11, 1], // Wszystkich Świętych (All Saints)
    [11, 11], // Narodowe Święto Niepodległości
    [12, 25], // Boże Narodzenie (Christmas Day)
    [12, 26], // Drugi dzień Bożego Narodzenia (Second day)
  ]
  const easter = easterSunday(year)
  const movable: ReadonlyArray<Date> = [
    easter, // Wielkanoc (Easter Sunday)
    addCalendarDays(easter, 1), // Poniedziałek Wielkanocny (Easter Monday)
    addCalendarDays(easter, 49), // Zielone Świątki (Pentecost Sunday)
    addCalendarDays(easter, 60), // Boże Ciało (Corpus Christi)
  ]
  const days = [
    ...fixed.map(([m, d]) => toIsoDay(utcDay(year, m, d))),
    ...movable.map(toIsoDay),
  ]
  // Sorted + de-duplicated for stable, deterministic output.
  return Object.freeze([...new Set(days)].sort())
}

/** Parse the optional `OM_KSEF_PL_HOLIDAYS` CSV (ISO YYYY-MM-DD) override. */
function parseHolidayOverride(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env.OM_KSEF_PL_HOLIDAYS
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
}

/**
 * Default holiday set for a calculation: the computed Polish public holidays for
 * every year the calculation may touch, merged with any `OM_KSEF_PL_HOLIDAYS`
 * env override. `fromYear`/`toYear` are inclusive.
 */
function defaultHolidays(
  fromYear: number,
  toYear: number,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const set = new Set<string>()
  for (let y = fromYear; y <= toYear; y += 1) {
    for (const day of polishPublicHolidays(y)) set.add(day)
  }
  for (const day of parseHolidayOverride(env)) set.add(day)
  return set as unknown as ReadonlyArray<string>
}

/** Is the given UTC-midnight Date a weekend or a listed holiday? */
function isNonBusinessDay(date: Date, holidays: ReadonlySet<string>): boolean {
  const weekday = date.getUTCDay() // 0 = Sunday, 6 = Saturday
  if (weekday === 0 || weekday === 6) return true
  return holidays.has(toIsoDay(date))
}

/** The next business day strictly after `date` (skips weekends + holidays). */
function nextBusinessDay(date: Date, holidays: ReadonlySet<string>): Date {
  let cursor = addCalendarDays(date, 1)
  while (isNonBusinessDay(cursor, holidays)) {
    cursor = addCalendarDays(cursor, 1)
  }
  return cursor
}

/** Add `count` business days strictly after `date` (skips weekends + holidays). */
function addBusinessDays(date: Date, count: number, holidays: ReadonlySet<string>): Date {
  let cursor = date
  for (let i = 0; i < count; i += 1) {
    cursor = nextBusinessDay(cursor, holidays)
  }
  return cursor
}

export type OfflineSendMode = 'offline24' | 'awaryjny'

export type ComputeOfflineSendDeadlineParams = {
  issuedAt: Date
  mode: OfflineSendMode
  /**
   * The MF-BIP-announced failure-end timestamp. Required for `awaryjny`; also set
   * when a failure is announced over an already-issued `offline24` invoice, which
   * switches the deadline to the awaryjny rule.
   */
  failureEndsAt?: Date | null
  /**
   * ISO `YYYY-MM-DD` non-working days. When omitted, the computed Polish public
   * holidays for the relevant years are used, merged with `OM_KSEF_PL_HOLIDAYS`.
   */
  holidays?: ReadonlyArray<string>
}

/**
 * Compute the statutory send-to-KSeF deadline for an offline-issued invoice.
 *
 * - `offline24` (no failure window): the **next business day** after `issuedAt`.
 * - `awaryjny`, or `offline24` overtaken by a supplied `failureEndsAt`:
 *   `failureEndsAt` + **7 business days**.
 *
 * The returned Date is the UTC-midnight start of the deadline business day. Pure
 * and deterministic for a fixed `(issuedAt, mode, failureEndsAt, holidays)`.
 */
export function computeOfflineSendDeadline(
  params: ComputeOfflineSendDeadlineParams,
  env: NodeJS.ProcessEnv = process.env,
): Date {
  const { issuedAt, mode, failureEndsAt, holidays } = params

  // A supplied failure window always governs (awaryjny, or offline24 overtaken
  // by an announced failure). offline24 with no failure window → next-business-day.
  const useFailureWindow = mode === 'awaryjny' || !!failureEndsAt
  const anchorTime = useFailureWindow ? failureEndsAt : issuedAt
  if (!anchorTime) {
    throw new Error('computeOfflineSendDeadline: awaryjny mode requires failureEndsAt')
  }

  // Anchor on the Polish (Warsaw) calendar day of the instant — the statutory deadline is a
  // Polish calendar date, so a near-midnight-UTC issuance must not shift to the wrong day.
  const anchor = warsawCalendarDay(anchorTime)

  // The deadline can land up to ~2 weeks ahead; cover the anchor year and the next.
  const holidaySet: ReadonlySet<string> = holidays
    ? new Set(holidays)
    : new Set(defaultHolidays(anchor.getUTCFullYear(), anchor.getUTCFullYear() + 1, env))

  return useFailureWindow
    ? addBusinessDays(anchor, 7, holidaySet)
    : nextBusinessDay(anchor, holidaySet)
}
