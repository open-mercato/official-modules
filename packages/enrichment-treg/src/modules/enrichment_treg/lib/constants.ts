export const TREG_INTEGRATION_ID = 'enrichment_treg'
export const TREG_DEFAULT_BASE_URL = 'https://treg.to'
export const TREG_DEFAULT_MAX_COST_USD = 0.05
export const TREG_REQUEST_TIMEOUT_MS = 30_000
export const ENRICHMENT_QUEUE_NAME = 'enrichment-treg'

export const SUBJECT_TYPES = ['person', 'company'] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

export const RECORD_STATUSES = ['pending', 'running', 'completed', 'no_match', 'failed'] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

export const FAILURE_REASONS = [
  'not_configured',
  'missing_identity',
  'out_of_balance',
  'invalid_input',
  'unauthorized',
  'provider_unavailable',
  'unexpected',
] as const
export type FailureReason = (typeof FAILURE_REASONS)[number]

export const ENDPOINT_BY_SUBJECT: Record<SubjectType, string> = {
  person: 'treg.people.enrich',
  company: 'treg.companies.enrich',
}

export const PERSON_PROPOSAL_FIELDS = ['jobTitle', 'linkedInUrl'] as const
export const COMPANY_PROPOSAL_FIELDS = ['brandName', 'domain', 'websiteUrl', 'industry', 'sizeBucket', 'description'] as const
export type PersonProposalField = (typeof PERSON_PROPOSAL_FIELDS)[number]
export type CompanyProposalField = (typeof COMPANY_PROPOSAL_FIELDS)[number]
export type ProposalField = PersonProposalField | CompanyProposalField

export const SIGNAL_KINDS = ['hiring', 'news'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

export const SIGNAL_ENDPOINT_BY_KIND: Record<SignalKind, string> = {
  hiring: 'treg.companies.jobs.search',
  news: 'treg.companies.news',
}

export const SIGNAL_LIST_KEY_BY_KIND: Record<SignalKind, string> = {
  hiring: 'jobs',
  news: 'articles',
}

export const SIGNALS_DEFAULT_LIMIT = 10

export function signalKindForEndpoint(endpointId: string): SignalKind | null {
  const match = SIGNAL_KINDS.find((kind) => SIGNAL_ENDPOINT_BY_KIND[kind] === endpointId)
  return match ?? null
}
