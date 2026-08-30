import handle from '../ksef-batch-send.worker'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const INV_1 = '33333333-3333-4333-8333-333333333333'
const INV_2 = '44444444-4444-4444-8444-444444444444'
const JOB = '77777777-7777-4777-8777-777777777777'

function makeProgressService() {
  return {
    startJob: jest.fn(async () => ({})),
    updateProgress: jest.fn(async () => ({})),
    completeJob: jest.fn(async () => ({})),
    failJob: jest.fn(async () => ({})),
  }
}

function makeCtx(progressService: unknown, commandBus: unknown) {
  return {
    resolve: (name: string) => {
      if (name === 'progressService') return progressService
      if (name === 'commandBus') return commandBus
      throw new Error(`unknown dependency: ${name}`)
    },
  }
}

function makeJob() {
  return {
    payload: {
      progressJobId: JOB,
      invoiceIds: [INV_1, INV_2],
      scope: { organizationId: ORG, tenantId: TEN, userId: 'user' },
    },
  }
}

describe('financial_pl:ksef-batch-send worker', () => {
  it('runs the direct batch command and completes the progress job', async () => {
    const progressService = makeProgressService()
    const commandBus = {
      execute: jest.fn(async () => ({ result: { batchReference: 'BATCH-REF-1', count: 2 } })),
    }

    await handle(makeJob() as never, makeCtx(progressService, commandBus) as never)

    expect(progressService.startJob).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({ tenantId: TEN, organizationId: ORG, userId: 'user' }),
    )
    expect(commandBus.execute).toHaveBeenCalledWith(
      'financial_pl.ksef_submission.send_batch',
      expect.objectContaining({
        input: { invoiceIds: [INV_1, INV_2] },
        ctx: expect.objectContaining({
          selectedOrganizationId: ORG,
          organizationIds: [ORG],
        }),
      }),
    )
    expect(progressService.updateProgress).toHaveBeenLastCalledWith(
      JOB,
      { totalCount: 2, processedCount: 2 },
      expect.objectContaining({ tenantId: TEN, organizationId: ORG }),
    )
    expect(progressService.completeJob).toHaveBeenCalledWith(
      JOB,
      { resultSummary: { batchReference: 'BATCH-REF-1', count: 2 } },
      expect.objectContaining({ tenantId: TEN, organizationId: ORG }),
    )
  })

  it('marks the progress job failed when the direct command fails', async () => {
    const progressService = makeProgressService()
    const commandBus = {
      execute: jest.fn(async () => {
        throw new Error('KSeF rejected batch')
      }),
    }

    await expect(handle(makeJob() as never, makeCtx(progressService, commandBus) as never)).rejects.toThrow(
      'KSeF rejected batch',
    )

    expect(progressService.failJob).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({ errorMessage: 'KSeF rejected batch' }),
      expect.objectContaining({ tenantId: TEN, organizationId: ORG }),
    )
  })
})
