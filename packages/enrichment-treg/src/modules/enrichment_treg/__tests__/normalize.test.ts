import {
  buildCompanyIdentity,
  buildPersonIdentity,
  hasUsableIdentity,
  normalizeCompanyOutput,
  normalizeDomain,
  normalizePersonOutput,
  normalizeUrl,
} from '../lib/normalize'

describe('identity builders', () => {
  it('builds a person identity and derives the domain from the email', () => {
    expect(
      buildPersonIdentity({
        email: ' Jane@Acme.com ',
        linkedInUrl: 'linkedin.com/in/jane',
        firstName: 'Jane',
        lastName: 'Doe',
        displayName: 'J. Doe',
      }),
    ).toEqual({
      email: 'jane@acme.com',
      linkedin_url: 'https://linkedin.com/in/jane',
      first_name: 'Jane',
      last_name: 'Doe',
      full_name: 'Jane Doe',
      domain: 'acme.com',
    })
  })

  it('prefers the linked company domain and ignores non-LinkedIn urls', () => {
    const identity = buildPersonIdentity({ linkedInUrl: 'https://example.com/jane', displayName: 'Jane Doe', companyDomain: 'https://www.Acme.io/about' })
    expect(identity).toEqual({ full_name: 'Jane Doe', domain: 'acme.io' })
    expect(hasUsableIdentity('person', identity)).toBe(true)
  })

  it('rejects a person with only a name', () => {
    expect(hasUsableIdentity('person', buildPersonIdentity({ displayName: 'Jane Doe' }))).toBe(false)
  })

  it('builds a company identity from website when domain is empty', () => {
    const identity = buildCompanyIdentity({ websiteUrl: 'stripe.com', name: 'Stripe' })
    expect(identity).toEqual({ domain: 'stripe.com', website: 'https://stripe.com', name: 'Stripe' })
    expect(hasUsableIdentity('company', identity)).toBe(true)
    expect(hasUsableIdentity('company', {})).toBe(false)
  })
})

describe('normalizers', () => {
  it('maps a person output to CRM proposal fields', () => {
    expect(
      normalizePersonOutput({
        full_name: 'Jane Doe',
        title: '  Chief  Technology Officer ',
        company: 'Acme',
        company_domain: 'acme.com',
        linkedin_url: 'https://www.linkedin.com/in/jane',
        location: 'Berlin, DE',
      }),
    ).toEqual({
      proposal: { jobTitle: 'Chief Technology Officer', linkedInUrl: 'https://www.linkedin.com/in/jane' },
      summary: { name: 'Jane Doe', company: 'Acme', companyDomain: 'acme.com', location: 'Berlin, DE', employees: null, founded: null },
    })
  })

  it('maps a company output and stringifies headcount', () => {
    const result = normalizeCompanyOutput({
      name: 'Stripe',
      domain: 'stripe.com',
      website: 'https://stripe.com/',
      industry: 'Financial Services',
      employees: 8000,
      founded: 2010,
      description: 'Payments infrastructure',
      location: 'South San Francisco',
    })
    expect(result.proposal).toEqual({
      brandName: 'Stripe',
      domain: 'stripe.com',
      websiteUrl: 'https://stripe.com',
      industry: 'Financial Services',
      sizeBucket: '8000',
      description: 'Payments infrastructure',
    })
    expect(result.summary).toMatchObject({ employees: '8000', founded: 2010 })
  })

  it('omits fields that are missing or invalid', () => {
    expect(normalizeCompanyOutput({ name: 'X', website: 'not a url', industry: '' }).proposal).toEqual({ brandName: 'X' })
    expect(normalizePersonOutput({ full_name: 'Y', linkedin_url: 'https://twitter.com/y' }).proposal).toEqual({})
  })

  it('truncates values to CRM column limits', () => {
    const long = 'a'.repeat(400)
    expect(normalizePersonOutput({ full_name: 'Z', title: long }).proposal.jobTitle).toHaveLength(150)
  })
})

describe('url helpers', () => {
  it('normalizes domains', () => {
    expect(normalizeDomain('HTTPS://www.Example.co.uk/path?q=1')).toBe('example.co.uk')
    expect(normalizeDomain('localhost')).toBeNull()
  })

  it('normalizes urls', () => {
    expect(normalizeUrl('example.com/')).toBe('https://example.com')
    expect(normalizeUrl('nothing')).toBeNull()
  })
})
