import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { createQueue, resolveQueueStrategy } from '@open-mercato/queue'
import type { CreateRecordInput } from '../../../commands/records'
import { EnrichmentRecord } from '../../../data/entities'
import { enrichmentRecordSchema, signalsRefreshSchema, type EnrichJob } from '../../../data/validators'
import { ENRICHMENT_QUEUE_NAME, SIGNAL_ENDPOINT_BY_KIND, TREG_INTEGRATION_ID, type SignalKind } from '../../../lib/constants'
import { runEnrichment, serializeRecord, type IntegrationErrorLogger } from '../../../lib/enrichment-service'
import type { CompanyIdentity } from '../../../lib/normalize'
import { buildSignalRequestBody } from '../../../lib/signals'
import { loadSubjectIdentity } from '../../../lib/subject'
import {
  commandErrorResponse,
  ensureSubjectAccess,
  errorSchema,
  jsonError,
  rejectInvalidWriteScope,
  resolveCommandBus,
  resolveRequestScope,
  runGuardAfterSuccess,
  runWriteGuards,
} from '../../helpers'

const logger = createLogger('enrichment_treg').child({ component: 'api/signals/refresh' })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['enrichment_treg.run'] },
}

type CredentialsService = {
  resolve(integrationId: string, scope: { tenantId: string; organizationId: string }): Promise<Record<string, unknown> | null>
}
type StateService = {
  isEnabled(integrationId: string, scope: { tenantId: string; organizationId: string }): Promise<boolean>
}

export async function POST(req: Request) {
  const scope = await resolveRequestScope(req)
  if (scope instanceof NextResponse) return scope
  const scopeRejection = rejectInvalidWriteScope(scope)
  if (scopeRejection) return scopeRejection

  const parsed = signalsRefreshSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return jsonError(400, 'validation_failed')
  const accessDenied = await ensureSubjectAccess(scope, 'company')
  if (accessDenied) return accessDenied

  const guard = await runWriteGuards({ scope, req, resourceId: null, operation: 'create', payload: parsed.data })
  if (!guard.ok) return guard.response

  const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const stateService = scope.container.resolve<StateService>('integrationStateService')
  const credentialsService = scope.container.resolve<CredentialsService>('integrationCredentialsService')
  if (!(await stateService.isEnabled(TREG_INTEGRATION_ID, tenantScope))) {
    return jsonError(422, 'integration_disabled')
  }
  const credentials = await credentialsService.resolve(TREG_INTEGRATION_ID, tenantScope)
  if (!credentials || typeof credentials.apiToken !== 'string' || credentials.apiToken.trim().length === 0) {
    return jsonError(422, 'integration_not_configured')
  }

  const em = scope.container.resolve<EntityManager>('em').fork()
  const identity = await loadSubjectIdentity(em, 'company', parsed.data.subjectId, tenantScope)
  if (!identity) return jsonError(404, 'subject_not_found')

  const kinds = [...new Set(parsed.data.kinds)]
  const planned = kinds
    .map((kind) => ({ kind, body: buildSignalRequestBody(kind, identity as CompanyIdentity) }))
    .filter((entry): entry is { kind: SignalKind; body: Record<string, unknown> } => entry.body !== null)
  const skipped = kinds
    .filter((kind) => !planned.some((entry) => entry.kind === kind))
    .map((kind) => ({ kind, reason: 'missing_identity' as const }))
  if (planned.length === 0) return jsonError(422, 'missing_identity')

  const recordIds: string[] = []
  try {
    for (const entry of planned) {
      const { result } = await resolveCommandBus(scope).execute<CreateRecordInput, { recordId: string }>(
        'enrichment_treg.records.create',
        {
          input: {
            ...tenantScope,
            subjectType: 'company',
            subjectId: parsed.data.subjectId,
            identity: entry.body,
            requestedByUserId: scope.userId,
            endpointId: SIGNAL_ENDPOINT_BY_KIND[entry.kind],
          },
          ctx: scope.commandContext,
          metadata: { ...tenantScope, resourceKind: 'enrichment_treg.record' },
        },
      )
      recordIds.push(result.recordId)
    }
  } catch (error) {
    const response = commandErrorResponse(error)
    if (response) return response
    throw error
  }

  for (const recordId of recordIds) {
    try {
      const queue = createQueue<EnrichJob>(ENRICHMENT_QUEUE_NAME, resolveQueueStrategy())
      await queue.enqueue({ recordId, ...tenantScope })
    } catch (err) {
      logger.warn('Signal refresh enqueue failed, running inline', { err, recordId })
      await runEnrichment({
        em,
        credentialsService,
        logService: scope.container.resolve<IntegrationErrorLogger>('integrationLogService'),
        recordId,
        scope: tenantScope,
      })
    }
  }

  const records = await findWithDecryption(
    em.fork(),
    EnrichmentRecord,
    { id: { $in: recordIds }, ...tenantScope },
    undefined,
    tenantScope,
  )
  for (const recordId of recordIds) {
    await runGuardAfterSuccess(guard.callbacks, { scope, req, resourceId: recordId, operation: 'create' })
  }
  return NextResponse.json({ records: records.map(serializeRecord), skipped }, { status: 202 })
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Refresh company signals',
  description: 'Creates one enrichment record per requested signal kind (hiring, news) and queues a treg.to lookup for each. New signals are stored without duplicates; poll GET /api/enrichment_treg/signals or listen for enrichment_treg.signal.detected.',
  tags: ['treg Enrichment'],
  requestBody: { contentType: 'application/json', schema: signalsRefreshSchema },
  responses: [
    {
      status: 202,
      description: 'Signal lookups queued',
      schema: z.object({
        records: z.array(enrichmentRecordSchema),
        skipped: z.array(z.object({ kind: z.string(), reason: z.literal('missing_identity') })),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Invalid payload or no organization selected', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers.companies.view, or the selected organization is not allowed', schema: errorSchema },
    { status: 404, description: 'Company not found in scope', schema: errorSchema },
    { status: 422, description: 'Integration disabled or not configured, or the company has no domain or name for any requested kind', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Refresh treg company signals',
  methods: { POST: postDoc },
}
