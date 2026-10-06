import { z } from 'zod'
import { COMPANY_PROPOSAL_FIELDS, PERSON_PROPOSAL_FIELDS, RECORD_STATUSES, SIGNAL_KINDS, SUBJECT_TYPES } from '../lib/constants'

export const enrichRequestSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().uuid(),
})
export type EnrichRequest = z.infer<typeof enrichRequestSchema>

export const recordsQuerySchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
})
export type RecordsQuery = z.infer<typeof recordsQuerySchema>

const proposalFieldSchema = z.enum([...PERSON_PROPOSAL_FIELDS, ...COMPANY_PROPOSAL_FIELDS])

export const markAppliedSchema = z.object({
  fields: z.array(proposalFieldSchema).min(1).max(20),
})
export type MarkAppliedRequest = z.infer<typeof markAppliedSchema>

export const enrichJobSchema = z.object({
  recordId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})
export type EnrichJob = z.infer<typeof enrichJobSchema>

export const enrichmentRecordSchema = z.object({
  id: z.string().uuid(),
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().uuid(),
  status: z.enum(RECORD_STATUSES),
  failureReason: z.string().nullable(),
  servedBy: z.string().nullable(),
  costMicro: z.number(),
  proposal: z.record(z.string(), z.string()).nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  appliedFields: z.array(z.string()).nullable(),
  appliedAt: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const signalsRefreshSchema = z.object({
  subjectId: z.string().uuid(),
  kinds: z.array(z.enum(SIGNAL_KINDS)).min(1).max(SIGNAL_KINDS.length),
})
export type SignalsRefreshRequest = z.infer<typeof signalsRefreshSchema>

export const signalsQuerySchema = z.object({
  subjectId: z.string().uuid(),
  signalType: z.enum(SIGNAL_KINDS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type SignalsQuery = z.infer<typeof signalsQuerySchema>

export const enrichmentSignalSchema = z.object({
  id: z.string().uuid(),
  subjectId: z.string().uuid(),
  signalType: z.enum(SIGNAL_KINDS),
  title: z.string(),
  summary: z.string().nullable(),
  url: z.string().nullable(),
  location: z.string().nullable(),
  occurredAt: z.string().nullable(),
  source: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
})
