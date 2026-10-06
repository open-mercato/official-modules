import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { EnrichmentRecord } from '../../data/entities'
import { enrichmentRecordSchema, recordsQuerySchema } from '../../data/validators'
import { ENDPOINT_BY_SUBJECT } from '../../lib/constants'
import { serializeRecord } from '../../lib/enrichment-service'
import { ensureSubjectAccess, errorSchema, jsonError, resolveRequestScope } from '../helpers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['enrichment_treg.view'] },
}

export async function GET(req: Request) {
  const scope = await resolveRequestScope(req)
  if (scope instanceof NextResponse) return scope

  const url = new URL(req.url)
  const parsed = recordsQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) return jsonError(400, 'validation_failed')
  const { subjectType, subjectId, page, pageSize } = parsed.data
  const accessDenied = await ensureSubjectAccess(scope, subjectType)
  if (accessDenied) return accessDenied

  const em = scope.container.resolve<EntityManager>('em').fork()
  const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const where = { ...tenantScope, subjectType, subjectId, endpointId: ENDPOINT_BY_SUBJECT[subjectType], deletedAt: null }
  const [records, total] = await Promise.all([
    findWithDecryption(
      em,
      EnrichmentRecord,
      where,
      { orderBy: { createdAt: 'desc' }, limit: pageSize, offset: (page - 1) * pageSize },
      tenantScope,
    ),
    em.count(EnrichmentRecord, where),
  ])

  return NextResponse.json({
    items: records.map(serializeRecord),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

const getDoc: OpenApiMethodDoc = {
  summary: 'List enrichment records for a CRM subject',
  description: 'Profile lookups only, newest first. Each record carries the proposed CRM field values returned by treg.to. Signal refreshes are listed by /api/enrichment_treg/signals.',
  tags: ['treg Enrichment'],
  query: recordsQuerySchema,
  responses: [
    {
      status: 200,
      description: 'Enrichment records',
      schema: z.object({
        items: z.array(enrichmentRecordSchema),
        total: z.number(),
        page: z.number(),
        pageSize: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Invalid query', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers view permission for the subject type', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'List treg enrichment records',
  methods: { GET: getDoc },
}
