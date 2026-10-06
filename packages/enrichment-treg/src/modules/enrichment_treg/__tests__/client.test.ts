import { callTregEndpoint, fetchTregBalance, parseTregSettings, TregError, type FetchLike } from '../lib/client'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const settings = parseTregSettings({ apiToken: 'trg_live_test', orgSlug: 'acme', maxCostPerCallUsd: '0.02' })

describe('parseTregSettings', () => {
  it('throws not_configured without a token', () => {
    expect(() => parseTregSettings({})).toThrow(TregError)
    try {
      parseTregSettings(null)
    } catch (error) {
      expect((error as TregError).reason).toBe('not_configured')
    }
  })

  it('applies defaults and trims the base url', () => {
    expect(parseTregSettings({ apiToken: 'x' })).toEqual({
      apiToken: 'x',
      orgSlug: null,
      baseUrl: 'https://treg.to',
      maxCostUsd: 0.05,
    })
    expect(parseTregSettings({ apiToken: 'x', apiBaseUrl: 'http://localhost:4599/', maxCostPerCallUsd: 'abc' })).toMatchObject({
      baseUrl: 'http://localhost:4599',
      maxCostUsd: 0.05,
    })
  })
})

describe('parseTregSettings base URL policy', () => {
  it.each([
    ['https://treg.example', true],
    ['http://localhost:4599', true],
    ['http://127.0.0.1:4599', true],
    ['http://internal.corp', false],
    ['https://user:pass@treg.example', false],
    ['ftp://treg.example', false],
    ['not a url', false],
  ])('%s allowed=%s', (apiBaseUrl, allowed) => {
    const parse = () => parseTregSettings({ apiToken: 'x', apiBaseUrl })
    if (allowed) expect(parse).not.toThrow()
    else expect(parse).toThrow(TregError)
  })
})

describe('callTregEndpoint', () => {
  it('sends auth, cost ceiling, idempotency and meta headers with a compact body', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse(
        200,
        { output: { full_name: 'Jane Doe', title: 'CTO' }, raw: { id: 1 }, _treg: { served_by: 'pdl' } },
        { 'x-treg-cost-micro': '2634', 'x-treg-call-id': 'call_1' },
      ),
    )
    const result = await callTregEndpoint({
      settings,
      endpointId: 'treg.people.enrich',
      body: { email: 'jane@acme.com', full_name: '', domain: undefined },
      missWhenEmpty: 'full_name',
      idempotencyKey: 'om-enrichment-1',
      meta: { tenant: 't1' },
      fetchImpl,
    })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://treg.to/call/treg.people.enrich')
    const headers = init?.headers as Record<string, string>
    expect(headers['X-Treg-Token']).toBe('trg_live_test')
    expect(headers['X-Treg-Org']).toBe('acme')
    expect(headers['X-Treg-Route-Max-Cost']).toBe('0.02')
    expect(headers['Idempotency-Key']).toBe('om-enrichment-1')
    expect(headers['X-Treg-Meta']).toBe('tenant=t1')
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'jane@acme.com' })
    expect(result).toMatchObject({
      status: 'hit',
      output: { full_name: 'Jane Doe', title: 'CTO' },
      servedBy: 'pdl',
      callId: 'call_1',
      costMicro: 2634,
    })
  })

  it('reports a miss when the required output key is empty', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { output: { full_name: null }, raw: null })
    const result = await callTregEndpoint({
      settings,
      endpointId: 'treg.people.enrich',
      body: { email: 'nobody@acme.com' },
      missWhenEmpty: 'full_name',
      idempotencyKey: 'k',
      fetchImpl,
    })
    expect(result.status).toBe('miss')
  })

  it('treats a non-empty list as a hit and an empty list as a miss', async () => {
    const call = (jobs: unknown[]) =>
      callTregEndpoint({
        settings,
        endpointId: 'treg.companies.jobs.search',
        body: { domain: 'acme.com', limit: 10 },
        missWhenEmpty: 'jobs',
        idempotencyKey: 'k',
        fetchImpl: async () => jsonResponse(200, { output: { jobs }, raw: null }),
      })
    expect((await call([{ id: 'job-1' }])).status).toBe('hit')
    expect((await call([])).status).toBe('miss')
  })

  it('reports a 404 as an uncharged miss only when asked to', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(404, { detail: { error: 'route_caller_fault', charged_micro: 0 } }, { 'x-treg-cost-micro': '0' })
    const params = { settings, endpointId: 'treg.companies.news', body: { domain: 'acme.com' }, missWhenEmpty: 'articles', idempotencyKey: 'k', fetchImpl }

    await expect(callTregEndpoint({ ...params, missOnNotFound: true })).resolves.toMatchObject({ status: 'miss', costMicro: 0 })
    await expect(callTregEndpoint(params)).rejects.toMatchObject({ reason: 'invalid_input', httpStatus: 404 })
  })

  it.each([
    [401, 'unauthorized'],
    [402, 'out_of_balance'],
    [409, 'provider_unavailable'],
    [429, 'provider_unavailable'],
    [503, 'provider_unavailable'],
    [422, 'invalid_input'],
  ])('maps HTTP %i to %s', async (status, reason) => {
    const fetchImpl: FetchLike = async () => jsonResponse(status, { error: 'nope' })
    await expect(
      callTregEndpoint({ settings, endpointId: 'treg.companies.enrich', body: {}, missWhenEmpty: 'name', idempotencyKey: 'k', fetchImpl }),
    ).rejects.toMatchObject({ reason, httpStatus: status })
  })

  it('maps network failures to provider_unavailable', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNRESET')
    }
    await expect(
      callTregEndpoint({ settings, endpointId: 'treg.companies.enrich', body: {}, missWhenEmpty: 'name', idempotencyKey: 'k', fetchImpl }),
    ).rejects.toMatchObject({ reason: 'provider_unavailable' })
  })
})

describe('fetchTregBalance', () => {
  it('reads the balance in micro-USD', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { balance_micro: 1_250_000 })
    await expect(fetchTregBalance(settings, fetchImpl)).resolves.toEqual({ balanceMicro: 1_250_000 })
  })

  it('throws on an unauthorized token', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, { error: 'bad token' })
    await expect(fetchTregBalance(settings, fetchImpl)).rejects.toMatchObject({ reason: 'unauthorized' })
  })
})
