import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { ProgressService, ProgressServiceContext } from '@open-mercato/core/modules/progress/lib/progressService'
import type { BatchSendInput } from '../data/validators'
import { FINANCIAL_PL_QUEUES, type KsefBatchSendJobPayload } from '../lib/queue'

export const metadata: WorkerMeta = {
  queue: FINANCIAL_PL_QUEUES.ksefBatchSend,
  id: 'financial_pl:ksef-batch-send',
  concurrency: 1,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(
  job: QueuedJob<KsefBatchSendJobPayload>,
  ctx: HandlerContext,
): Promise<void> {
  const { progressJobId, invoiceIds, scope } = job.payload
  const progressService = ctx.resolve<ProgressService>('progressService')
  const progressContext: ProgressServiceContext = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    userId: scope.userId ?? null,
  }

  try {
    await progressService.startJob(progressJobId, progressContext)
    await progressService.updateProgress(
      progressJobId,
      { totalCount: invoiceIds.length, processedCount: 0 },
      progressContext,
    )

    const commandBus = ctx.resolve<CommandBus>('commandBus')
    const containerProxy = { resolve: ctx.resolve.bind(ctx) }
    const commandCtx: CommandRuntimeContext = {
      container: containerProxy as never,
      auth: {
        tenantId: scope.tenantId,
        orgId: scope.organizationId,
        sub: scope.userId ?? 'system',
        isSuperAdmin: false,
      },
      organizationScope: null,
      selectedOrganizationId: scope.organizationId,
      organizationIds: [scope.organizationId],
    }

    const { result } = await commandBus.execute<BatchSendInput, { batchReference: string; count: number }>(
      'financial_pl.ksef_submission.send_batch',
      { input: { invoiceIds }, ctx: commandCtx },
    )
    const processedCount = result?.count ?? invoiceIds.length

    await progressService.updateProgress(
      progressJobId,
      { totalCount: invoiceIds.length, processedCount },
      progressContext,
    )
    await progressService.completeJob(
      progressJobId,
      {
        resultSummary: {
          batchReference: result?.batchReference ?? null,
          count: processedCount,
        },
      },
      progressContext,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'KSeF batch send failed'
    const stack = err instanceof Error ? err.stack : undefined
    try {
      await progressService.failJob(
        progressJobId,
        { errorMessage: message.slice(0, 2000), errorStack: stack?.slice(0, 10000) },
        progressContext,
      )
    } catch (failErr) {
      console.error(
        `[internal] financial_pl:ksef-batch-send failed to mark progress job ${progressJobId} failed: ${
          failErr instanceof Error ? failErr.message : String(failErr)
        }`,
      )
    }
    throw err
  }
}
