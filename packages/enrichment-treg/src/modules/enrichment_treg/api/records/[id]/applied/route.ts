import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { MarkAppliedInput } from '../../../../commands/records'
import { EnrichmentRecord } from '../../../../data/entities'
import { enrichmentRecordSchema, markAppliedSchema } from '../../../../data/validators'
import { emitEnrichmentTregEvent } from '../../../../events'
import { serializeRecord } from '../../../../lib/enrichment-service'
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
} from '../../../helpers'

const logger = createLogger('enrichment_treg').child({ component: 'api/records/applied' })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['enrichment_treg.run'] },
}

export async function POST(
  req: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
) {
  const scope = await resolveRequestScope(req)
  if (scope instanceof NextResponse) return scope
  const scopeRejection = rejectInvalidWriteScope(scope)
  if (scopeRejection) return scopeRejection

  const { id } = await Promise.resolve(context.params)
  if (!z.string().uuid().safeParse(id).success) return jsonError(400, 'validation_failed')
  const parsed = markAppliedSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return jsonError(400, 'validation_failed')

  const em = scope.container.resolve<EntityManager>('em').fork()
  const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const existing = await findOneWithDecryption(em, EnrichmentRecord, { id, ...tenantScope, deletedAt: null }, undefined, tenantScope)
  if (!existing) return jsonError(404, 'record_not_found')
  const accessDenied = await ensureSubjectAccess(scope, existing.subjectType)
  if (accessDenied) return accessDenied

  const guard = await runWriteGuards({ scope, req, resourceId: id, operation: 'update', payload: parsed.data })
  if (!guard.ok) return guard.response

  try {
    await resolveCommandBus(scope).execute<MarkAppliedInput, { recordId: string; appliedFields: string[] }>(
      'enrichment_treg.records.mark_applied',
      {
        input: { ...tenantScope, recordId: id, fields: parsed.data.fields, appliedByUserId: scope.userId },
        ctx: scope.commandContext,
        metadata: { ...tenantScope, resourceKind: 'enrichment_treg.record', resourceId: id },
      },
    )
  } catch (error) {
    const response = commandErrorResponse(error)
    if (response) return response
    throw error
  }

  const record = await findOneWithDecryption(em.fork(), EnrichmentRecord, { id, ...tenantScope }, undefined, tenantScope)
  if (!record) return jsonError(404, 'record_not_found')

  try {
    await emitEnrichmentTregEvent('enrichment_treg.record.applied', {
      id: record.id,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      fields: parsed.data.fields,
      tenantId: record.tenantId,
      organizationId: record.organizationId,
    })
  } catch (err) {
    logger.warn('Failed to emit applied event', { err, recordId: record.id })
  }

  await runGuardAfterSuccess(guard.callbacks, { scope, req, resourceId: record.id, operation: 'update' })
  return NextResponse.json({ record: serializeRecord(record) })
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Mark proposal fields as applied',
  description: 'Records which proposed fields the user accepted after writing them to the CRM through the customers API. Undoable.',
  tags: ['treg Enrichment'],
  requestBody: { contentType: 'application/json', schema: markAppliedSchema },
  responses: [{ status: 200, description: 'Record updated', schema: z.object({ record: enrichmentRecordSchema }) }],
  errors: [
    { status: 400, description: 'Invalid payload or field not in proposal', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers view permission, or the selected organization is not allowed', schema: errorSchema },
    { status: 404, description: 'Record not found in scope', schema: errorSchema },
    { status: 409, description: 'Record has no completed proposal', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Mark treg enrichment proposal as applied',
  methods: { POST: postDoc },
}
