import { invoiceWriteGuard } from '../interceptors'

type GuardResult = { ok: boolean; statusCode?: number }

function makeContext(opts: {
  restrict?: boolean | null | 'no-row'
  userId?: string
  hasFeature?: boolean
  rbacThrows?: boolean
  tenantId?: string | null
  organizationId?: string | null
}) {
  const {
    restrict = false,
    userId = 'user-1',
    hasFeature = false,
    rbacThrows = false,
    tenantId = 'tenant-1',
    organizationId = 'org-1',
  } = opts
  return {
    userId,
    tenantId,
    organizationId,
    em: {
      fork: () => ({
        findOne: async () => (restrict === 'no-row' ? null : { restrictInvoiceWrite: restrict }),
      }),
    },
    container: {
      resolve: (name: string) => {
        if (name !== 'rbacService') throw new Error(`unexpected resolve ${name}`)
        return {
          userHasAllFeatures: async () => {
            if (rbacThrows) throw new Error('boom')
            return hasFeature
          },
        }
      },
    },
  } as unknown as Parameters<typeof invoiceWriteGuard>[1]
}

const req = {} as Parameters<typeof invoiceWriteGuard>[0]

describe('invoiceWriteGuard (QA #35 — feature-based invoice-write permission)', () => {
  it('allows the write when restriction is OFF (backward compatible when unset)', async () => {
    const r = (await invoiceWriteGuard(req, makeContext({ restrict: false }))) as GuardResult
    expect(r.ok).toBe(true)
  })

  it('allows when there is no settings row at all (unrestricted default)', async () => {
    const r = (await invoiceWriteGuard(req, makeContext({ restrict: 'no-row' }))) as GuardResult
    expect(r.ok).toBe(true)
  })

  it('allows when restriction is ON and the caller HAS financial_pl.invoices.manage', async () => {
    const r = (await invoiceWriteGuard(req, makeContext({ restrict: true, hasFeature: true }))) as GuardResult
    expect(r.ok).toBe(true)
  })

  it('denies (403) when restriction is ON and the caller LACKS the feature', async () => {
    const r = (await invoiceWriteGuard(req, makeContext({ restrict: true, hasFeature: false }))) as GuardResult
    expect(r).toMatchObject({ ok: false, statusCode: 403 })
  })

  it('fails closed (403) when restriction is ON but there is no resolvable userId', async () => {
    const r = (await invoiceWriteGuard(req, makeContext({ restrict: true, userId: '' }))) as GuardResult
    expect(r).toMatchObject({ ok: false, statusCode: 403 })
  })

  it('fails closed (403) when RBAC resolution throws', async () => {
    const r = (await invoiceWriteGuard(req, makeContext({ restrict: true, rbacThrows: true }))) as GuardResult
    expect(r).toMatchObject({ ok: false, statusCode: 403 })
  })

  it('does not restrict when tenant/org scope is missing (route auth still applies)', async () => {
    const r = (await invoiceWriteGuard(req, makeContext({ restrict: true, tenantId: null }))) as GuardResult
    expect(r.ok).toBe(true)
  })
})
