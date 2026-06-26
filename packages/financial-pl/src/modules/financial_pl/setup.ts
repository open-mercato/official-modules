import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import crypto from 'node:crypto'

function stableUuidFromString(input: string): string {
  const bytes = crypto.createHash('sha256').update(input).digest().subarray(0, 16)
  // RFC4122: set version (5) and variant (10xx)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

type SchedulerServiceLike = {
  register: (registration: {
    id: string
    name: string
    description?: string
    scopeType: 'organization'
    organizationId: string
    tenantId: string
    scheduleType: 'cron' | 'interval'
    scheduleValue: string
    timezone?: string
    targetType: 'queue'
    targetQueue: string
    targetPayload: Record<string, unknown>
    requireFeature?: string
    sourceType: 'module'
    sourceModule: string
    isEnabled?: boolean
  }) => Promise<void>
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['financial_pl.*'],
    employee: ['financial_pl.view'],
  },

  async seedDefaults({ container, organizationId, tenantId }) {
    // The scheduler is an optional peer — degrade silently when it is absent so a
    // lean install without it still works.
    const cradle = container as { hasRegistration?: (name: string) => boolean }
    if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration('schedulerService')) {
      return
    }

    const schedulerService = container.resolve('schedulerService') as SchedulerServiceLike
    // The id includes BOTH tenantId AND organizationId: seedDefaults runs
    // per-organization and the schedule is organization-scoped, so a tenantId-only
    // id would let a second org's registration overwrite the first org's job and
    // leave it without reconciliation.
    await schedulerService.register({
      id: stableUuidFromString(`financial_pl:ksef-reconcile:${tenantId}:${organizationId}`),
      name: 'KSeF submission reconciliation',
      description: 'Re-drives KSeF submissions stuck in queued/processing so no invoice silently fails to reach KSeF.',
      scopeType: 'organization',
      organizationId,
      tenantId,
      scheduleType: 'interval',
      scheduleValue: '15m',
      timezone: 'UTC',
      targetType: 'queue',
      targetQueue: 'financial-pl-ksef-reconcile',
      targetPayload: {
        scope: { organizationId, tenantId },
      },
      sourceType: 'module',
      sourceModule: 'financial_pl',
      isEnabled: true,
    })
  },
}

export default setup
