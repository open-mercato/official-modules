import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { EnrichmentRecord, EnrichmentSignal } from '../../data/entities'
import { enrichmentRecordSchema, enrichmentSignalSchema, signalsQuerySchema } from '../../data/validators'
import { SIGNAL_ENDPOINT_BY_KIND, SIGNAL_KINDS } from '../../lib/constants'
import { serializeRecord, type SerializedEnrichmentRecord } from '../../lib/enrichment-service'
import { serializeSignal } from '../../lib/signals'
import { ensureSubjectAccess, errorSchema, jsonError, resolveRequestScope } from '../helpers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['enrichment_treg.view'] },
}

export async function GET(req: Request) {
  const scope = await resolveRequestScope(req)
  if (scope instanceof NextResponse) return scope

  const url = new URL(req.url)
  const parsed = signalsQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) return jsonError(400, 'validation_failed')
  const { subjectId, signalType, page, pageSize } = parsed.data
  const accessDenied = await ensureSubjectAccess(scope, 'company')
  if (accessDenied) return accessDenied

  const em = scope.container.resolve<EntityManager>('em').fork()
  const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const where = {
    ...tenantScope,
    subjectType: 'company' as const,
    subjectId,
    deletedAt: null,
    ...(signalType ? { signalType } : {}),
  }
  const [signals, total, latestByKind] = await Promise.all([
    findWithDecryption(
      em,
      EnrichmentSignal,
      where,
      {
        orderBy: { occurredAt: 'desc nulls last', firstSeenAt: 'desc' },
        limit: pageSize,
        offset: (page - 1) * pageSize,
      },
      tenantScope,
    ),
    em.count(EnrichmentSignal, where),
    Promise.all(
      SIGNAL_KINDS.map(async (kind) => {
        const record = await findOneWithDecryption(
          em,
          EnrichmentRecord,
          { ...tenantScope, subjectType: 'company', subjectId, endpointId: SIGNAL_ENDPOINT_BY_KIND[kind], deletedAt: null },
          { orderBy: { createdAt: 'desc' } },
          tenantScope,
        )
        return [kind, record ? serializeRecord(record) : null] as const
      }),
    ),
  ])

  const refreshes: Record<string, SerializedEnrichmentRecord | null> = Object.fromEntries(latestByKind)
  return NextResponse.json({
    items: signals.map(serializeSignal),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    refreshes,
  })
}

const getDoc: OpenApiMethodDoc = {
  summary: 'List company signals',
  description: 'Hiring and news signals stored for a company, newest event first, plus the latest refresh record per signal kind.',
  tags: ['treg Enrichment'],
  query: signalsQuerySchema,
  responses: [
    {
      status: 200,
      description: 'Company signals',
      schema: z.object({
        items: z.array(enrichmentSignalSchema),
        total: z.number(),
        page: z.number(),
        pageSize: z.number(),
        totalPages: z.number(),
        refreshes: z.record(z.string(), enrichmentRecordSchema.nullable()),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Invalid query', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers.companies.view', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'List treg company signals',
  methods: { GET: getDoc },
}
