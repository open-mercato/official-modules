import { fetchNbpMidRate } from '../nbp-fx'

const ok200 = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response

describe('fetchNbpMidRate', () => {
  it('fetches the prior weekday table for a weekday tax point, never same-day', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/2026-06-30/')) {
        return ok200({ rates: [{ mid: '9.9999', effectiveDate: '2026-06-30' }] })
      }
      return ok200({ rates: [{ mid: '4.3210', effectiveDate: '2026-06-29' }] })
    }) as typeof fetch

    const result = await fetchNbpMidRate('eur', '2026-06-30', {
      fetchImpl,
      now: new Date('2026-06-30T12:00:00Z'),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/exchangerates/rates/A/EUR/2026-06-29/?format=json')
    expect(calls[0]).not.toContain('/2026-06-30/')
    expect(result).toEqual({ ok: true, currency: 'EUR', rate: '4.3210', tableDate: '2026-06-29' })
  })

  it('uses the prior Friday for a Monday tax point', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return ok200({ rates: [{ mid: '4.1000', effectiveDate: '2026-07-03' }] })
    }) as typeof fetch

    await fetchNbpMidRate('usd', '2026-07-06', { fetchImpl })

    expect(calls[0]).toContain('/USD/2026-07-03/')
  })

  it('walks back on 404 until a published table is found', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/2026-07-06/')) return fail(404)
      return ok200({ rates: [{ mid: '3.9000', effectiveDate: '2026-07-03' }] })
    }) as typeof fetch

    const result = await fetchNbpMidRate('chf', '2026-07-07', { fetchImpl })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('/CHF/2026-07-06/')
    expect(calls[1]).toContain('/CHF/2026-07-03/')
    expect(result).toEqual({ ok: true, currency: 'CHF', rate: '3.9000', tableDate: '2026-07-03' })
  })

  it('rejects invalid currency without calling fetch', async () => {
    const fetchImpl = jest.fn()

    const result = await fetchNbpMidRate('EURO', '2026-06-30', { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result).toEqual({ ok: false, reason: 'invalid_currency' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails open when fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as typeof fetch

    await expect(fetchNbpMidRate('EUR', '2026-06-30', { fetchImpl })).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('maps the parsed rate and effectiveDate from the NBP response', async () => {
    const fetchImpl = (async () =>
      ok200({ rates: [{ mid: 4.5678, effectiveDate: '2026-06-29' }] })) as typeof fetch

    await expect(fetchNbpMidRate('GBP', '2026-06-30', { fetchImpl })).resolves.toEqual({
      ok: true,
      currency: 'GBP',
      rate: '4.5678',
      tableDate: '2026-06-29',
    })
  })
})
