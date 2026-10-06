import { buildSignalRequestBody, computeSignalDedupeHash, normalizeSignals } from '../lib/signals'

const newsOutput = {
  articles: [
    {
      id: 'evt-1',
      type: 'news_event',
      attributes: {
        summary: 'Example Pay integrates with Acme',
        headline: 'Example Pay integrates with Acme',
        category: 'integrates_with',
        found_at: '2026-03-31T00:00:00Z',
        first_seen_at: '2026-04-07T04:19:16Z',
        article_sentence: 'Through this integration, Example Pay verifies bank transfers with Acme proofs.',
        location: null,
      },
      relationships: {
        most_relevant_source: { data: { id: 'art-1', type: 'news_article' } },
      },
    },
    {
      id: 'evt-2',
      type: 'news_event',
      attributes: { summary: null, headline: null, found_at: null },
      relationships: {
        most_relevant_source: { data: { id: 'art-2', type: 'news_article' } },
      },
    },
    { id: 'evt-3', type: 'news_event', attributes: { category: 'unknown' } },
  ],
}

const newsRaw = {
  data: [],
  included: [
    { id: 'art-1', type: 'news_article', attributes: { url: 'https://acme.example/blog/example-pay', published_at: '2026-03-30T00:00:00Z', title: 'Example Pay x Acme' } },
    { id: 'art-2', type: 'news_article', attributes: { url: 'https://news.example/acme-raises', published_at: '2026-02-01T00:00:00Z', title: 'Acme raises a seed round' } },
    { id: 'cmp-1', type: 'company', attributes: { domain: 'acme.example' } },
  ],
}

const jobsOutput = {
  jobs: [
    {
      id: 'job-1',
      type: 'job_opening',
      attributes: {
        title: 'Android Engineer',
        description: 'Android Engineer',
        url: 'https://acme.example/careers/android',
        first_seen_at: '2026-07-24T07:01:32Z',
        posted_at: null,
        location: null,
        location_data: [{ city: 'Wrocław', country: 'Poland' }],
      },
    },
    {
      id: 'job-1-duplicate',
      type: 'job_opening',
      attributes: { title: 'Android Engineer', url: 'https://acme.example/careers/android/' },
    },
    { id: 'job-2', type: 'job_opening', attributes: { normalized_title: 'iOS Engineer', location: 'Remote' } },
  ],
}

describe('normalizeSignals', () => {
  it('maps predictleads news events and resolves the source article from included', () => {
    const result = normalizeSignals({ kind: 'news', output: newsOutput, raw: newsRaw })

    expect(result.skippedRows).toBe(1)
    expect(result.signals).toHaveLength(2)
    expect(result.signals[0]).toMatchObject({
      signalType: 'news',
      title: 'Example Pay integrates with Acme',
      summary: 'Through this integration, Example Pay verifies bank transfers with Acme proofs.',
      url: 'https://acme.example/blog/example-pay',
      occurredAt: new Date('2026-03-31T00:00:00Z'),
    })
    expect(result.signals[1]).toMatchObject({
      title: 'Acme raises a seed round',
      url: 'https://news.example/acme-raises',
      occurredAt: new Date('2026-02-01T00:00:00Z'),
    })
    expect(result.signals[0].payload).toEqual(newsOutput.articles[0])
  })

  it('maps job openings, builds a location and drops duplicates of the same url', () => {
    const result = normalizeSignals({ kind: 'hiring', output: jobsOutput, raw: null })

    expect(result.skippedRows).toBe(0)
    expect(result.signals.map((signal) => signal.title)).toEqual(['Android Engineer', 'iOS Engineer'])
    expect(result.signals[0]).toMatchObject({
      url: 'https://acme.example/careers/android',
      location: 'Wrocław, Poland',
      occurredAt: new Date('2026-07-24T07:01:32Z'),
    })
    expect(result.signals[1]).toMatchObject({ url: null, location: 'Remote', occurredAt: null })
  })

  it('handles flat rows from an unknown provider', () => {
    const result = normalizeSignals({
      kind: 'news',
      output: { articles: [{ headline: 'Acme opens Berlin office', link: 'news.example/berlin', published_at: '2026-05-01' }] },
      raw: null,
    })

    expect(result.signals[0]).toMatchObject({
      title: 'Acme opens Berlin office',
      url: 'https://news.example/berlin',
      occurredAt: new Date('2026-05-01'),
    })
  })

  it('returns nothing for a missing or malformed list', () => {
    expect(normalizeSignals({ kind: 'hiring', output: {}, raw: null })).toEqual({ signals: [], skippedRows: 0 })
    expect(normalizeSignals({ kind: 'hiring', output: { jobs: ['oops'] }, raw: null })).toEqual({ signals: [], skippedRows: 1 })
  })
})

describe('computeSignalDedupeHash', () => {
  it('is stable for the same url regardless of case and trailing slash', () => {
    const base = { signalType: 'hiring' as const, title: 'A', occurredAt: null }
    expect(computeSignalDedupeHash({ ...base, url: 'https://Acme.example/jobs/1/' })).toBe(
      computeSignalDedupeHash({ ...base, url: 'https://acme.example/jobs/1', title: 'B' }),
    )
  })

  it('falls back to title and day when there is no url, and separates kinds', () => {
    const at = new Date('2026-05-01T10:00:00Z')
    const later = new Date('2026-05-01T18:00:00Z')
    expect(computeSignalDedupeHash({ signalType: 'news', url: null, title: 'Acme', occurredAt: at })).toBe(
      computeSignalDedupeHash({ signalType: 'news', url: null, title: 'ACME', occurredAt: later }),
    )
    expect(computeSignalDedupeHash({ signalType: 'news', url: null, title: 'Acme', occurredAt: at })).not.toBe(
      computeSignalDedupeHash({ signalType: 'hiring', url: null, title: 'Acme', occurredAt: at }),
    )
  })
})

describe('buildSignalRequestBody', () => {
  it('requires a domain for news', () => {
    expect(buildSignalRequestBody('news', { name: 'Acme' })).toBeNull()
    expect(buildSignalRequestBody('news', { domain: 'acme.example', name: 'Acme' })).toEqual({ domain: 'acme.example', limit: 10 })
  })

  it('accepts a domain or a name for hiring', () => {
    expect(buildSignalRequestBody('hiring', {})).toBeNull()
    expect(buildSignalRequestBody('hiring', { name: 'Acme' })).toEqual({ domain: undefined, name: 'Acme', limit: 10 })
  })
})
