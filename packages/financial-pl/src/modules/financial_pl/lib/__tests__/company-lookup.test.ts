import { lookupCompanyByNip, normalizeNipDigits, parseWykazAddress } from '../company-lookup'
import { companyLookupQuerySchema } from '../../data/validators'

// Real, valid-checksum NIP (Google Poland — used in the live MF Wykaz probe this session).
const VALID_NIP = '5252344078'
const BAD_NIP = '1234567890' // valid shape, invalid checksum

const ok200 = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response

describe('normalizeNipDigits', () => {
  it('strips spaces, dashes and letters', () => {
    expect(normalizeNipDigits(' 525-234-40-78 ')).toBe('5252344078')
    expect(normalizeNipDigits('PL5252344078')).toBe('5252344078')
  })
})

describe('parseWykazAddress', () => {
  it('splits a single registry string into street / postal / city', () => {
    expect(parseWykazAddress('RONDO IGNACEGO DASZYŃSKIEGO 2C, 00-843 WARSZAWA')).toEqual({
      addressLine1: 'RONDO IGNACEGO DASZYŃSKIEGO 2C',
      postalCode: '00-843',
      city: 'WARSZAWA',
    })
  })
  it('falls back to addressLine1 when there is no postal code', () => {
    expect(parseWykazAddress('UL. TESTOWA 1')).toEqual({ addressLine1: 'UL. TESTOWA 1', postalCode: '', city: '' })
  })
  it('handles empty / nullish input', () => {
    expect(parseWykazAddress(null)).toEqual({ addressLine1: '', postalCode: '', city: '' })
    expect(parseWykazAddress('  ')).toEqual({ addressLine1: '', postalCode: '', city: '' })
  })
})

describe('lookupCompanyByNip', () => {
  it('rejects an invalid-checksum NIP without calling fetch', async () => {
    const fetchImpl = jest.fn()
    const res = await lookupCompanyByNip(BAD_NIP, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res).toEqual({ ok: false, reason: 'invalid_nip' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a successful MF subject (address = workingAddress; accountNumbers NOT exposed)', async () => {
    const fetchImpl = (async () =>
      ok200({
        result: {
          subject: {
            nip: VALID_NIP,
            name: 'GOOGLE POLAND SP. Z O.O.',
            statusVat: 'Czynny',
            regon: '140182840',
            workingAddress: 'RONDO IGNACEGO DASZYŃSKIEGO 2C, 00-843 WARSZAWA',
            residenceAddress: null,
            accountNumbers: ['93103015080000000504162006'],
          },
        },
      })) as unknown as typeof fetch
    const res = await lookupCompanyByNip(VALID_NIP, { fetchImpl })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.company).toEqual({
        nip: VALID_NIP,
        name: 'GOOGLE POLAND SP. Z O.O.',
        statusVat: 'Czynny',
        regon: '140182840',
        address: 'RONDO IGNACEGO DASZYŃSKIEGO 2C, 00-843 WARSZAWA',
      })
      expect((res.company as Record<string, unknown>).accountNumbers).toBeUndefined()
    }
  })

  it('falls back to residenceAddress when workingAddress is absent', async () => {
    const fetchImpl = (async () =>
      ok200({ result: { subject: { name: 'X', residenceAddress: 'RES 1, 00-001 KRAKÓW' } } })) as unknown as typeof fetch
    const res = await lookupCompanyByNip(VALID_NIP, { fetchImpl })
    expect(res.ok && res.company.address).toBe('RES 1, 00-001 KRAKÓW')
  })

  it('returns not_found on HTTP 404', async () => {
    const fetchImpl = (async () => fail(404)) as unknown as typeof fetch
    expect(await lookupCompanyByNip(VALID_NIP, { fetchImpl })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns not_found when the subject is missing', async () => {
    const fetchImpl = (async () => ok200({ result: { subject: null } })) as unknown as typeof fetch
    expect(await lookupCompanyByNip(VALID_NIP, { fetchImpl })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('fails open (unavailable) on a 5xx', async () => {
    const fetchImpl = (async () => fail(500)) as unknown as typeof fetch
    expect(await lookupCompanyByNip(VALID_NIP, { fetchImpl })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('fails open (unavailable) when fetch throws / aborts', async () => {
    const fetchImpl = (async () => {
      throw new Error('aborted')
    }) as unknown as typeof fetch
    expect(await lookupCompanyByNip(VALID_NIP, { fetchImpl })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('queries the MF register with the digit NIP and the injected date', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      return ok200({ result: { subject: { name: 'X', workingAddress: 'A 1, 00-000 B' } } })
    }) as unknown as typeof fetch
    await lookupCompanyByNip(' 525-234-40-78 ', { fetchImpl, now: new Date('2026-06-30T10:00:00Z') })
    expect(calls[0]).toContain('/api/search/nip/5252344078?date=2026-06-30')
  })
})

describe('companyLookupQuerySchema', () => {
  it('accepts a raw NIP including formatting', () => {
    expect(companyLookupQuerySchema.parse({ nip: ' 525-234-40-78 ' }).nip).toBe('525-234-40-78')
  })
  it('rejects an empty NIP', () => {
    expect(companyLookupQuerySchema.safeParse({ nip: '' }).success).toBe(false)
  })
})
