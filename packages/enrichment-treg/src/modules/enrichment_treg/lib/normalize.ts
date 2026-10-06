import type { CompanyProposalField, PersonProposalField, SubjectType } from './constants'

export type PersonIdentity = {
  email?: string
  linkedin_url?: string
  full_name?: string
  first_name?: string
  last_name?: string
  domain?: string
}

export type CompanyIdentity = {
  domain?: string
  website?: string
  name?: string
  email?: string
}

export type SubjectIdentity = PersonIdentity | CompanyIdentity

export type Proposal = Partial<Record<PersonProposalField | CompanyProposalField, string>>

export type EnrichmentSummary = {
  name: string | null
  company: string | null
  companyDomain: string | null
  location: string | null
  employees: string | null
  founded: number | null
}

export type NormalizedEnrichment = {
  proposal: Proposal
  summary: EnrichmentSummary
}

const FIELD_MAX_LENGTH: Record<PersonProposalField | CompanyProposalField, number> = {
  jobTitle: 150,
  linkedInUrl: 500,
  brandName: 200,
  domain: 255,
  websiteUrl: 500,
  industry: 150,
  sizeBucket: 100,
  description: 4000,
}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeDomain(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const host = raw
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0]
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

export function normalizeUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (!url.hostname.includes('.')) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function emailDomain(email: string | undefined): string | null {
  if (!email || !email.includes('@')) return null
  return normalizeDomain(email.split('@')[1])
}

function put<K extends keyof Proposal>(proposal: Proposal, field: K, value: string | null) {
  if (!value) return
  proposal[field] = value.slice(0, FIELD_MAX_LENGTH[field])
}

export function buildPersonIdentity(input: {
  email?: string | null
  linkedInUrl?: string | null
  firstName?: string | null
  lastName?: string | null
  displayName?: string | null
  companyDomain?: string | null
}): PersonIdentity {
  const identity: PersonIdentity = {}
  const email = text(input.email)?.toLowerCase()
  if (email && email.includes('@')) identity.email = email
  const linkedin = normalizeUrl(input.linkedInUrl)
  if (linkedin && /linkedin\.com\//i.test(linkedin)) identity.linkedin_url = linkedin
  const firstName = text(input.firstName)
  const lastName = text(input.lastName)
  if (firstName) identity.first_name = firstName
  if (lastName) identity.last_name = lastName
  const fullName = firstName && lastName ? `${firstName} ${lastName}` : text(input.displayName)
  if (fullName) identity.full_name = fullName
  const domain = normalizeDomain(input.companyDomain) ?? emailDomain(identity.email)
  if (domain) identity.domain = domain
  return identity
}

export function buildCompanyIdentity(input: {
  domain?: string | null
  websiteUrl?: string | null
  name?: string | null
  email?: string | null
}): CompanyIdentity {
  const identity: CompanyIdentity = {}
  const domain = normalizeDomain(input.domain) ?? normalizeDomain(input.websiteUrl)
  if (domain) identity.domain = domain
  const website = normalizeUrl(input.websiteUrl)
  if (website) identity.website = website
  const name = text(input.name)
  if (name) identity.name = name
  const email = text(input.email)?.toLowerCase()
  if (email && email.includes('@')) identity.email = email
  return identity
}

export function hasUsableIdentity(subjectType: SubjectType, identity: SubjectIdentity): boolean {
  if (subjectType === 'company') {
    const company = identity as CompanyIdentity
    return Boolean(company.domain || company.website || company.name || company.email)
  }
  const person = identity as PersonIdentity
  if (person.email || person.linkedin_url) return true
  return Boolean(person.domain && person.full_name)
}

export function normalizePersonOutput(output: Record<string, unknown>): NormalizedEnrichment {
  const proposal: Proposal = {}
  put(proposal, 'jobTitle', text(output.title))
  const linkedin = normalizeUrl(output.linkedin_url)
  put(proposal, 'linkedInUrl', linkedin && /linkedin\.com\//i.test(linkedin) ? linkedin : null)
  return {
    proposal,
    summary: {
      name: text(output.full_name),
      company: text(output.company),
      companyDomain: normalizeDomain(output.company_domain),
      location: text(output.location),
      employees: null,
      founded: null,
    },
  }
}

export function normalizeCompanyOutput(output: Record<string, unknown>): NormalizedEnrichment {
  const proposal: Proposal = {}
  put(proposal, 'brandName', text(output.name))
  put(proposal, 'domain', normalizeDomain(output.domain) ?? normalizeDomain(output.website))
  put(proposal, 'websiteUrl', normalizeUrl(output.website))
  put(proposal, 'industry', text(output.industry))
  put(proposal, 'sizeBucket', text(output.employees))
  put(proposal, 'description', text(output.description))
  const founded = typeof output.founded === 'number' && Number.isInteger(output.founded) ? output.founded : null
  return {
    proposal,
    summary: {
      name: text(output.name),
      company: null,
      companyDomain: null,
      location: text(output.location),
      employees: text(output.employees),
      founded,
    },
  }
}

export function normalizeOutput(subjectType: SubjectType, output: Record<string, unknown>): NormalizedEnrichment {
  return subjectType === 'company' ? normalizeCompanyOutput(output) : normalizePersonOutput(output)
}
