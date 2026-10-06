import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { getAllMutationGuardInstances } from '@open-mercato/shared/lib/crud/mutation-guard-store'
import {
  bridgeLegacyGuard,
  runMutationGuards,
  type MutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import type { SubjectType } from '../lib/constants'

const logger = createLogger('enrichment_treg').child({ component: 'api' })

export const errorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
})

const SUBJECT_VIEW_FEATURE: Record<SubjectType, string> = {
  person: 'customers.people.view',
  company: 'customers.companies.view',
}

export type RequestScope = {
  container: AppContainer
  tenantId: string
  organizationId: string
  userId: string
  features: string[]
  selectionRejected: boolean
  commandContext: CommandRuntimeContext
}

type RbacService = {
  userHasAllFeatures(userId: string, required: string[], scope: { tenantId: string | null; organizationId: string | null }): Promise<boolean>
}

export function jsonError(status: number, error: string, message?: string): NextResponse {
  return NextResponse.json(message ? { error, message } : { error }, { status })
}

export async function resolveRequestScope(req: Request): Promise<RequestScope | NextResponse> {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.sub) {
    return jsonError(401, 'unauthorized')
  }
  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const tenantId = scope.tenantId ?? auth.tenantId ?? null
  const organizationId = scope.selectedId ?? auth.orgId ?? null
  if (!tenantId) return jsonError(401, 'unauthorized')
  if (!organizationId) return jsonError(400, 'organization_required')
  const rawFeatures = (auth as { features?: unknown }).features
  const features = Array.isArray(rawFeatures)
    ? rawFeatures.filter((value): value is string => typeof value === 'string')
    : []
  return {
    container,
    tenantId,
    organizationId,
    userId: auth.sub,
    features,
    selectionRejected: scope.selectionRejected === true,
    commandContext: {
      container,
      auth,
      organizationScope: scope,
      selectedOrganizationId: organizationId,
      organizationIds: scope.filterIds ?? [organizationId],
      request: req,
    },
  }
}

export function rejectInvalidWriteScope(scope: RequestScope): NextResponse | null {
  return scope.selectionRejected ? jsonError(403, 'organization_selection_rejected') : null
}

export async function ensureSubjectAccess(scope: RequestScope, subjectType: SubjectType): Promise<NextResponse | null> {
  const rbacService = scope.container.resolve<RbacService>('rbacService')
  const allowed = await rbacService.userHasAllFeatures(scope.userId, [SUBJECT_VIEW_FEATURE[subjectType]], {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  return allowed ? null : jsonError(403, 'forbidden')
}

export function resolveCommandBus(scope: RequestScope): CommandBus {
  return scope.container.resolve<CommandBus>('commandBus')
}

export function commandErrorResponse(error: unknown): NextResponse | null {
  if (!isCrudHttpError(error)) return null
  return NextResponse.json(error.body, { status: error.status })
}

type GuardCallbacks = Array<{ guard: MutationGuard; metadata: Record<string, unknown> | null }>

type GuardRequest = {
  scope: RequestScope
  req: Request
  resourceId: string | null
  operation: 'create' | 'update'
  payload: Record<string, unknown>
}

export async function runWriteGuards(input: GuardRequest): Promise<
  { ok: true; payload: Record<string, unknown>; callbacks: GuardCallbacks } | { ok: false; response: NextResponse }
> {
  const legacyGuard = bridgeLegacyGuard(input.scope.container)
  const guards = [...getAllMutationGuardInstances(), ...(legacyGuard ? [legacyGuard] : [])]
  const result = await runMutationGuards(
    guards,
    {
      tenantId: input.scope.tenantId,
      organizationId: input.scope.organizationId,
      userId: input.scope.userId,
      resourceKind: 'enrichment_treg.record',
      resourceId: input.resourceId,
      operation: input.operation,
      requestMethod: input.req.method,
      requestHeaders: input.req.headers,
      mutationPayload: input.payload,
    },
    { userFeatures: input.scope.features },
  )
  if (!result.ok) {
    return {
      ok: false,
      response: NextResponse.json(result.errorBody ?? { error: 'mutation_blocked' }, { status: result.errorStatus ?? 422 }),
    }
  }
  return {
    ok: true,
    payload: result.modifiedPayload ? { ...input.payload, ...result.modifiedPayload } : input.payload,
    callbacks: result.afterSuccessCallbacks,
  }
}

export async function runGuardAfterSuccess(
  callbacks: GuardCallbacks,
  input: Omit<GuardRequest, 'payload'> & { resourceId: string },
): Promise<void> {
  for (const callback of callbacks) {
    if (!callback.guard.afterSuccess) continue
    try {
      await callback.guard.afterSuccess({
        tenantId: input.scope.tenantId,
        organizationId: input.scope.organizationId,
        userId: input.scope.userId,
        resourceKind: 'enrichment_treg.record',
        resourceId: input.resourceId,
        operation: input.operation,
        requestMethod: input.req.method,
        requestHeaders: input.req.headers,
        metadata: callback.metadata ?? null,
      })
    } catch (err) {
      logger.warn('Mutation guard afterSuccess callback failed', { err })
    }
  }
}
