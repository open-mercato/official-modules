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

describe('financial_pl ksef-immutability interceptor — caller scope guard', () => {
  const invoiceId = '350f2660-ee63-424e-902f-72793f97f034'

  it.each([
    ['empty organizationId', { organizationId: '', tenantId: 'b6a3c9a2-1111-4222-8333-444455556666' }],
    ['empty tenantId', { organizationId: 'b6a3c9a2-1111-4222-8333-444455556666', tenantId: '' }],
    ['missing scope entirely', {}],
  ])('fails closed (409, no query) when the caller has %s', async (_label, scope) => {
    const result = await salesGuard.before!(makeRequest({ id: invoiceId }), makeContext(scope))
    expect(result).toMatchObject({ ok: false, statusCode: 409 })
  })

  it('still queries and passes through for a scoped caller with no locking submission', async () => {
    const em = { fork: () => ({ count: jest.fn().mockResolvedValue(0) }) }
    const result = await salesGuard.before!(
      makeRequest({ id: invoiceId }),
      makeContext({ organizationId: 'b6a3c9a2-1111-4222-8333-444455556666', tenantId: 'c7b4d0b3-2222-4333-9444-555566667777' }, em),
    )
    expect(result).toMatchObject({ ok: true })
  })

  it('blocks a scoped caller when a locking submission exists', async () => {
    const em = { fork: () => ({ count: jest.fn().mockResolvedValue(1) }) }
    const result = await salesGuard.before!(
      makeRequest({ id: invoiceId }),
      makeContext({ organizationId: 'b6a3c9a2-1111-4222-8333-444455556666', tenantId: 'c7b4d0b3-2222-4333-9444-555566667777' }, em),
    )
    expect(result).toMatchObject({ ok: false, statusCode: 409 })
  })
})
