import { createModuleQueue, type Queue } from '@open-mercato/queue'

const queues = new Map<string, Queue<Record<string, unknown>>>()

export const FINANCIAL_PL_QUEUES = {
  ksefBatchSend: 'financial-pl-ksef-batch-send',
} as const

export type FinancialPlQueueName = (typeof FINANCIAL_PL_QUEUES)[keyof typeof FINANCIAL_PL_QUEUES]

export type KsefBatchSendJobPayload = {
  progressJobId: string
  invoiceIds: string[]
  scope: {
    organizationId: string
    tenantId: string
    userId?: string | null
  }
}

export function getFinancialPlQueue(queueName: FinancialPlQueueName): Queue<Record<string, unknown>> {
  const existing = queues.get(queueName)
  if (existing) return existing

  const concurrency = Math.min(
    20,
    Math.max(1, Number.parseInt(process.env.FINANCIAL_PL_QUEUE_CONCURRENCY ?? '1', 10) || 1),
  )
  const created = createModuleQueue<Record<string, unknown>>(queueName, { concurrency })
  queues.set(queueName, created)
  return created
}
