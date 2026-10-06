import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { createQueue, resolveQueueStrategy } from '@open-mercato/queue'
import type { CreateRecordInput } from '../../commands/records'
import { EnrichmentRecord } from '../../data/entities'
import { enrichmentRecordSchema, enrichRequestSchema, type EnrichJob } from '../../data/validators'
import { ENRICHMENT_QUEUE_NAME, TREG_INTEGRATION_ID } from '../../lib/constants'
import { runEnrichment, serializeRecord, type IntegrationErrorLogger } from '../../lib/enrichment-service'
import { hasUsableIdentity } from '../../lib/normalize'
import { loadSubjectIdentity } from '../../lib/subject'
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
} from '../helpers'

const logger = createLogger('enrichment_treg').child({ component: 'api/enrich' })

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

  const parsed = enrichRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return jsonError(400, 'validation_failed')
  const accessDenied = await ensureSubjectAccess(scope, parsed.data.subjectType)
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
  const identity = await loadSubjectIdentity(em, parsed.data.subjectType, parsed.data.subjectId, tenantScope)
  if (!identity) return jsonError(404, 'subject_not_found')
  if (!hasUsableIdentity(parsed.data.subjectType, identity)) {
    return jsonError(422, 'missing_identity')
  }

  let recordId: string
  try {
    const { result } = await resolveCommandBus(scope).execute<CreateRecordInput, { recordId: string }>(
      'enrichment_treg.records.create',
      {
        input: {
          ...tenantScope,
          subjectType: parsed.data.subjectType,
          subjectId: parsed.data.subjectId,
          identity,
          requestedByUserId: scope.userId,
        },
        ctx: scope.commandContext,
        metadata: { ...tenantScope, resourceKind: 'enrichment_treg.record' },
      },
    )
    recordId = result.recordId
  } catch (error) {
    const response = commandErrorResponse(error)
    if (response) return response
    throw error
  }

  try {
    const queue = createQueue<EnrichJob>(ENRICHMENT_QUEUE_NAME, resolveQueueStrategy())
    await queue.enqueue({ recordId, ...tenantScope })
  } catch (err) {
    logger.warn('Enrichment enqueue failed, running inline', { err, recordId })
    await runEnrichment({
      em,
      credentialsService,
      logService: scope.container.resolve<IntegrationErrorLogger>('integrationLogService'),
      recordId,
      scope: tenantScope,
    })
  }

  const record = await findOneWithDecryption(em.fork(), EnrichmentRecord, { id: recordId, ...tenantScope }, undefined, tenantScope)
  if (!record) return jsonError(404, 'record_not_found')
  await runGuardAfterSuccess(guard.callbacks, { scope, req, resourceId: recordId, operation: 'create' })
  return NextResponse.json({ record: serializeRecord(record) }, { status: 202 })
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Start enrichment for a CRM person or company',
  description: 'Creates an enrichment record from the CRM subject and queues a treg.to lookup. Poll the records endpoint (or listen for enrichment_treg.record.completed) for the result.',
  tags: ['treg Enrichment'],
  requestBody: { contentType: 'application/json', schema: enrichRequestSchema },
  responses: [{ status: 202, description: 'Enrichment queued', schema: z.object({ record: enrichmentRecordSchema }) }],
  errors: [
    { status: 400, description: 'Invalid payload or no organization selected', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers view permission, or the selected organization is not allowed', schema: errorSchema },
    { status: 404, description: 'Subject not found in scope', schema: errorSchema },
    { status: 422, description: 'Integration disabled or not configured, or subject has no usable identity', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Enrich a CRM subject via treg.to',
  methods: { POST: postDoc },
}
