const mockCreateRequestContainer = jest.fn()
const mockGetAuthFromRequest = jest.fn()
const mockResolveOrganizationScopeForRequest = jest.fn()
const mockFindOneWithDecryption = jest.fn()
const mockValidateCrudMutationGuard = jest.fn()
const mockRunCrudMutationGuardAfterSuccess = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => mockGetAuthFromRequest(...args),
}))
jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: (...args: unknown[]) => mockResolveOrganizationScopeForRequest(...args),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => mockFindOneWithDecryption(...args),
}))
jest.mock('@open-mercato/shared/lib/crud/mutation-guard', () => ({
  validateCrudMutationGuard: (...args: unknown[]) => mockValidateCrudMutationGuard(...args),
  runCrudMutationGuardAfterSuccess: (...args: unknown[]) => mockRunCrudMutationGuardAfterSuccess(...args),
}))
jest.mock('@open-mercato/shared/lib/crud/optimistic-lock-command', () => ({
  enforceCommandOptimisticLock: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn().mockResolvedValue({
    translate: (_key: string, fallback: string) => fallback,
  }),
}))

import { interceptors } from '../interceptors'
import {
  KSEF_LOCKED_STATUSES,
  PUT,
  metadata,
} from '../ksef/invoice-meta/route'

const SALES_INVOICE_ID = '350f2660-ee63-424e-902f-72793f97f034'
const TENANT_ID = 'c7b4d0b3-2222-4333-9444-555566667777'
const ORGANIZATION_ID = 'b6a3c9a2-1111-4222-8333-444455556666'
const EMPLOYEE_FEATURES = new Set(['financial_pl.view', 'sales.invoices.manage'])

function makePutRequest(): Request {
  return new Request('http://localhost/api/financial_pl/ksef/invoice-meta', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ salesInvoiceId: SALES_INVOICE_ID }),
  })
}

describe('invoice-meta PUT Packet A guards', () => {
  let lockedStatus: string | null
  let count: jest.Mock
  let fork: {
    count: jest.Mock
    create: jest.Mock
    persist: jest.Mock
    flush: jest.Mock
  }

  beforeEach(() => {
    jest.clearAllMocks()
    lockedStatus = null
    count = jest.fn((_entity: unknown, where: Record<string, unknown>) => {
      const statuses = (where.status as { $in?: readonly string[] } | undefined)?.$in ?? []
      return Promise.resolve(lockedStatus && statuses.includes(lockedStatus) ? 1 : 0)
    })
    fork = {
      count,
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'meta-1', ...data })),
      persist: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    }
    mockCreateRequestContainer.mockResolvedValue({
      resolve: (name: string) => {
        if (name !== 'em') throw new Error(`[internal] Unexpected dependency: ${name}`)
        return { fork: () => fork }
      },
    })
    mockGetAuthFromRequest.mockResolvedValue({
      tenantId: TENANT_ID,
      orgId: ORGANIZATION_ID,
      sub: 'employee-1',
      features: [...EMPLOYEE_FEATURES],
    })
    mockResolveOrganizationScopeForRequest.mockResolvedValue({ selectedId: ORGANIZATION_ID })
    mockFindOneWithDecryption.mockResolvedValue(null)
    mockValidateCrudMutationGuard.mockResolvedValue(null)
  })

  it('requires the employee-compatible feature pair', () => {
    expect(metadata.PUT.requireFeatures).toEqual(['financial_pl.view', 'sales.invoices.manage'])
    expect(metadata.PUT.requireFeatures.every((feature) => EMPLOYEE_FEATURES.has(feature))).toBe(true)
  })

  async function driveEmployeePut(restrictInvoiceWrite: boolean): Promise<Response> {
    if (!metadata.PUT.requireFeatures.every((feature) => EMPLOYEE_FEATURES.has(feature))) {
      return new Response(null, { status: 403 })
    }
    const permissionInterceptor = interceptors.find(
      (interceptor) => interceptor.id === 'financial_pl.invoice-write-permission.invoice-meta',
    )
    if (!permissionInterceptor?.before) throw new Error('[internal] Missing invoice-meta write interceptor')
    const guard = await permissionInterceptor.before(
      {
        url: '/api/financial_pl/ksef/invoice-meta',
        method: 'PUT',
        query: {},
        body: { salesInvoiceId: SALES_INVOICE_ID },
      } as Parameters<typeof permissionInterceptor.before>[0],
      {
        userId: 'employee-1',
        tenantId: TENANT_ID,
        organizationId: ORGANIZATION_ID,
        em: { fork: () => ({ findOne: async () => ({ restrictInvoiceWrite }) }) },
        container: {
          resolve: (name: string) => {
            if (name !== 'rbacService') throw new Error(`[internal] Unexpected dependency: ${name}`)
            return { userHasAllFeatures: async () => EMPLOYEE_FEATURES.has('financial_pl.invoices.manage') }
          },
        },
      } as unknown as Parameters<typeof permissionInterceptor.before>[1],
    )
    if (guard && !guard.ok) return new Response(null, { status: guard.statusCode })
    return PUT(makePutRequest())
  }

  it('returns 200 for an employee-shaped principal when the optional restriction is OFF', async () => {
    const response = await driveEmployeePut(false)
    expect(response.status).toBe(200)
  })

  it('returns 403 via invoiceWriteGuard when restriction is ON and invoices.manage is absent', async () => {
    const response = await driveEmployeePut(true)
    expect(response.status).toBe(403)
  })

  it('returns 409 when an offline_issued submission exists', async () => {
    lockedStatus = 'offline_issued'
    const response = await PUT(makePutRequest())

    expect(response.status).toBe(409)
    expect(KSEF_LOCKED_STATUSES).toEqual(['accepted', 'offline_issued', 'processing', 'queued'])
    expect(count).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        salesInvoiceId: SALES_INVOICE_ID,
        documentKind: 'invoice',
        status: { $in: KSEF_LOCKED_STATUSES },
        organizationId: ORGANIZATION_ID,
        tenantId: TENANT_ID,
        deletedAt: null,
      }),
    )
  })
})
