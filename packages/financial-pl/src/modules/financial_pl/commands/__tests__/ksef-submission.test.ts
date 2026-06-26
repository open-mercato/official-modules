import { sendCommand } from '../ksef-submission'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const INV = '33333333-3333-4333-8333-333333333333'

const validInvoice = {
  invoiceNumber: 'INV-1',
  issueDate: '2026-06-23',
  currencyCode: 'PLN',
  seller: { nip: '5260001246', name: 'Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1' },
  buyer: { nip: '7342867148', name: 'Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2' },
  vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
  totalGross: '123.00',
  lines: [{ lineNumber: 1, name: 'Item', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
}

function makeCtx(em: unknown) {
  return {
    container: { resolve: (name: string) => (name === 'em' ? em : undefined) },
    auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
    organizationScope: null,
    selectedOrganizationId: ORG,
    request: null,
  } as unknown as Parameters<typeof sendCommand.execute>[1]
}

describe('financial_pl.ksef_submission.send idempotency', () => {
  it('returns the existing in-flight submission instead of queuing a second live send', async () => {
    const create = jest.fn()
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => ({ id: 'EXISTING' })),
      create,
      persist: () => ({ flush: async () => {} }),
    }
    em.fork = () => em

    const result = await sendCommand.execute(
      { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, contextNip: '5260001246', invoice: validInvoice },
      makeCtx(em),
    )

    expect(result).toEqual({ submissionId: 'EXISTING' })
    expect(create).not.toHaveBeenCalled()
    expect(em.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        salesInvoiceId: INV,
        organizationId: ORG,
        tenantId: TEN,
        status: { $in: ['queued', 'processing', 'accepted'] },
        deletedAt: null,
      }),
    )
  })

  it('rejects (422) a direct payload whose seller NIP does not match the submission context NIP', async () => {
    const em: Record<string, unknown> = { findOne: jest.fn(), create: jest.fn() }
    em.fork = () => em
    await expect(
      sendCommand.execute(
        {
          organizationId: ORG,
          tenantId: TEN,
          salesInvoiceId: INV,
          contextNip: '5260001246',
          invoice: { ...validInvoice, seller: { ...validInvoice.seller, nip: '7342867148' } },
        },
        makeCtx(em),
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'seller_nip_mismatch' } })
    expect(em.findOne).not.toHaveBeenCalled()
  })

  it('rejects (422) a direct payload whose context NIP differs from the stored credential NIP', async () => {
    const em: Record<string, unknown> = { findOne: jest.fn(), create: jest.fn() }
    em.fork = () => em
    const ctx = {
      container: {
        resolve: (name: string) =>
          name === 'integrationCredentialsService'
            ? { getRaw: async () => ({ contextNip: '5555555555' }) }
            : name === 'em'
              ? em
              : undefined,
      },
      auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
      organizationScope: null,
      selectedOrganizationId: ORG,
      request: null,
    } as unknown as Parameters<typeof sendCommand.execute>[1]

    await expect(
      sendCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, contextNip: '5260001246', invoice: validInvoice },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'context_nip_mismatch' } })
    expect(em.findOne).not.toHaveBeenCalled()
  })

  it('returns the race winner when the partial unique index rejects a concurrent insert (23505)', async () => {
    let findOneCalls = 0
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => {
        findOneCalls += 1
        return findOneCalls === 1 ? null : { id: 'WINNER' }
      }),
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'LOSER', ...data })),
      persist: () => ({
        flush: async () => {
          throw Object.assign(
            new Error('duplicate key value violates unique constraint "financial_pl_ksef_submissions_active_unique"'),
            { code: '23505', constraint: 'financial_pl_ksef_submissions_active_unique' },
          )
        },
      }),
    }
    em.fork = () => em

    const result = await sendCommand.execute(
      { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, contextNip: '5260001246', invoice: validInvoice },
      makeCtx(em),
    )

    expect(result).toEqual({ submissionId: 'WINNER' })
    expect(findOneCalls).toBe(2)
  })
})
