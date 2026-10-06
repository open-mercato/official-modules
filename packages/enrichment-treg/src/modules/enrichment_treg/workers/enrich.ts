import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { enrichJobSchema, type EnrichJob } from '../data/validators'
import { ENRICHMENT_QUEUE_NAME } from '../lib/constants'
import { runEnrichment, type IntegrationErrorLogger } from '../lib/enrichment-service'

export const metadata: WorkerMeta = {
  queue: ENRICHMENT_QUEUE_NAME,
  id: 'enrichment_treg:enrich',
  concurrency: 5,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

type CredentialsResolver = {
  resolve(integrationId: string, scope: { tenantId: string; organizationId: string }): Promise<Record<string, unknown> | null>
}

export default async function handle(job: QueuedJob<EnrichJob>, ctx: HandlerContext): Promise<void> {
  const payload = enrichJobSchema.parse(job.payload)
  await runEnrichment({
    em: ctx.resolve<EntityManager>('em').fork(),
    credentialsService: ctx.resolve<CredentialsResolver>('integrationCredentialsService'),
    logService: ctx.resolve<IntegrationErrorLogger>('integrationLogService'),
    recordId: payload.recordId,
    scope: { tenantId: payload.tenantId, organizationId: payload.organizationId },
  })
}
