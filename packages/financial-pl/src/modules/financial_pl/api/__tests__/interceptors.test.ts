import { interceptors } from '../interceptors'
import type { InterceptorContext, InterceptorRequest } from '@open-mercato/shared/lib/crud/api-interceptor'

const salesGuard = interceptors.find((i) => i.id === 'financial_pl.ksef-immutability.sales-invoices')!

function makeRequest(body: Record<string, unknown>): InterceptorRequest {
  return { url: '/api/sales/invoices', method: 'PUT', body, query: {} } as unknown as InterceptorRequest
}

function makeContext(overrides: Partial<{ organizationId: string; tenantId: string }>, em?: unknown): InterceptorContext {
  return {
    organizationId: overrides.organizationId,
    tenantId: overrides.tenantId,
    em: em ?? {
      fork() {
        throw new Error('em.fork must not be called for unscoped callers')
      },
    },
  } as unknown as InterceptorContext
}

describe('financial_pl ksef-immutability interceptor — tenant scope guard', () => {
  const invoiceId = '350f2660-ee63-424e-902f-72793f97f034'
  const selectedOrganizationId = 'b6a3c9a2-1111-4222-8333-444455556666'
  const invoiceOrganizationId = 'd8c5e1c4-3333-4444-a555-666677778888'
  const tenantId = 'c7b4d0b3-2222-4333-9444-555566667777'

  it.each([
    ['empty tenantId', { organizationId: selectedOrganizationId, tenantId: '' }],
    ['missing tenantId', { organizationId: selectedOrganizationId }],
    ['missing scope entirely', {}],
  ])('fails closed (409, no query) when the caller has %s', async (_label, scope) => {
    const result = await salesGuard.before!(makeRequest({ id: invoiceId }), makeContext(scope))
    expect(result).toMatchObject({ ok: false, statusCode: 409 })
  })

  it('still queries when the caller has tenant scope but no selected organization', async () => {
    const count = jest.fn().mockResolvedValue(0)
    const em = { fork: () => ({ count }) }
    const result = await salesGuard.before!(makeRequest({ id: invoiceId }), makeContext({ organizationId: '', tenantId }, em))
    expect(result).toMatchObject({ ok: true })
    expect(count).toHaveBeenCalledTimes(1)
  })

  it('still queries and passes through for a scoped caller with no locking submission', async () => {
    const em = { fork: () => ({ count: jest.fn().mockResolvedValue(0) }) }
    const result = await salesGuard.before!(
      makeRequest({ id: invoiceId }),
      makeContext({ organizationId: selectedOrganizationId, tenantId }, em),
    )
    expect(result).toMatchObject({ ok: true })
  })

  it('blocks a scoped caller when a locking submission exists', async () => {
    const em = { fork: () => ({ count: jest.fn().mockResolvedValue(1) }) }
    const result = await salesGuard.before!(
      makeRequest({ id: invoiceId }),
      makeContext({ organizationId: selectedOrganizationId, tenantId }, em),
    )
    expect(result).toMatchObject({ ok: false, statusCode: 409 })
  })

  it('blocks a tenant-scoped caller when a locking submission belongs to a different selected organization', async () => {
    const submission = {
      salesInvoiceId: invoiceId,
      documentKind: 'invoice',
      status: 'accepted',
      organizationId: invoiceOrganizationId,
      tenantId,
      deletedAt: null,
    }
    const count = jest.fn((_entity: unknown, where: Record<string, unknown>) => {
      const status = where.status as { $in?: readonly string[] } | undefined
      const hasOrganizationFilter = Object.prototype.hasOwnProperty.call(where, 'organizationId')
      const matches =
        where.salesInvoiceId === submission.salesInvoiceId &&
        where.documentKind === submission.documentKind &&
        status?.$in?.includes(submission.status) === true &&
        where.tenantId === submission.tenantId &&
        where.deletedAt === submission.deletedAt &&
        (!hasOrganizationFilter || where.organizationId === submission.organizationId)
      return Promise.resolve(matches ? 1 : 0)
    })
    const em = { fork: () => ({ count }) }

    const result = await salesGuard.before!(
      makeRequest({ id: invoiceId }),
      makeContext({ organizationId: selectedOrganizationId, tenantId }, em),
    )

    expect(result).toMatchObject({ ok: false, statusCode: 409 })
    expect(count.mock.calls[0]?.[1]).not.toHaveProperty('organizationId')
  })
})
