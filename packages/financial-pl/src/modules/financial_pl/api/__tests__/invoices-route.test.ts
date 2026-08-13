const mockCreateRequestContainer = jest.fn()
const mockGetAuthFromRequest = jest.fn()
const mockResolveOrganizationScopeForRequest = jest.fn()
const mockFindWithDecryption = jest.fn()

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
  findWithDecryption: (...args: unknown[]) => mockFindWithDecryption(...args),
}))

import { GET } from '../ksef/invoices/route'

const TENANT_ID = 'c7b4d0b3-2222-4333-9444-555566667777'
const ORGANIZATION_ID = 'b6a3c9a2-1111-4222-8333-444455556666'
const NULL_STATUS_ID = '10000000-0000-4000-8000-000000000001'
const QUEUED_ID = '10000000-0000-4000-8000-000000000002'
const ACCEPTED_ID = '10000000-0000-4000-8000-000000000003'

type FixtureInvoice = {
  id: string
  invoice_number: string
  issue_date: string
  due_date: string
  currency_code: string
  grand_total_net_amount: string
  grand_total_gross_amount: string
  status: null
  metadata: Record<string, unknown>
}

type FixtureSubmission = {
  id: string
  salesInvoiceId: string
  status: 'queued' | 'accepted'
  ksefNumber: string | null
  offlineSendDeadlineAt: null
  createdAt: Date
}

type QueryOptions = {
  tenantId: string
  organizationIds?: Array<string | null>
  filters?: Record<string, unknown>
  page?: { page: number; pageSize: number }
}

type FilterOperators = {
  $in?: string[]
  $nin?: string[]
  $ilike?: string
  $gte?: string
  $lte?: string
}

const invoices: FixtureInvoice[] = [
  {
    id: NULL_STATUS_ID,
    invoice_number: 'FV/NULL/2026',
    issue_date: '2026-08-10',
    due_date: '2026-08-20',
    currency_code: 'PLN',
    grand_total_net_amount: '100.00',
    grand_total_gross_amount: '123.00',
    status: null,
    metadata: {},
  },
  {
    id: QUEUED_ID,
    invoice_number: 'FV/QUEUED/2026',
    issue_date: '2026-08-11',
    due_date: '2026-08-21',
    currency_code: 'PLN',
    grand_total_net_amount: '200.00',
    grand_total_gross_amount: '246.00',
    status: null,
    metadata: {},
  },
  {
    id: ACCEPTED_ID,
    invoice_number: 'FV/ACCEPTED/2026',
    issue_date: '2026-08-12',
    due_date: '2026-08-22',
    currency_code: 'PLN',
    grand_total_net_amount: '300.00',
    grand_total_gross_amount: '369.00',
    status: null,
    metadata: {},
  },
]

const submissions: FixtureSubmission[] = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    salesInvoiceId: QUEUED_ID,
    status: 'queued',
    ksefNumber: null,
    offlineSendDeadlineAt: null,
    createdAt: new Date('2026-08-11T12:00:00.000Z'),
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    salesInvoiceId: ACCEPTED_ID,
    status: 'accepted',
    ksefNumber: 'accepted-ksef-number',
    offlineSendDeadlineAt: null,
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
  },
]

function filterInvoices(filters: Record<string, unknown> | undefined): FixtureInvoice[] {
  if (!filters) return invoices
  return invoices.filter((invoice) => {
    const id = filters.id as FilterOperators | undefined
    if (id?.$in && !id.$in.includes(invoice.id)) return false
    if (id?.$nin?.includes(invoice.id)) return false

    const number = filters.invoice_number as FilterOperators | undefined
    if (number?.$ilike) {
      const needle = number.$ilike.replaceAll('%', '').toLowerCase()
      if (!invoice.invoice_number.toLowerCase().includes(needle)) return false
    }

    const issueDate = filters.issue_date as FilterOperators | undefined
    if (issueDate?.$gte && invoice.issue_date < issueDate.$gte) return false
    if (issueDate?.$lte && invoice.issue_date > issueDate.$lte) return false
    return true
  })
}

function makeRequest(query: string): Request {
  return new Request(`http://localhost/api/financial_pl/ksef/invoices?${query}`)
}

describe('ksef/invoices document-status partition (Packet B)', () => {
  const mockQuery = jest.fn((_entityId: string, options: QueryOptions) => {
    const matched = filterInvoices(options.filters)
    const page = options.page ?? { page: 1, pageSize: 25 }
    const start = (page.page - 1) * page.pageSize
    return Promise.resolve({ items: matched.slice(start, start + page.pageSize), total: matched.length })
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateRequestContainer.mockResolvedValue({
      resolve: (name: string) => {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'queryEngine') return { query: mockQuery }
        throw new Error(`[internal] Unexpected dependency: ${name}`)
      },
    })
    mockGetAuthFromRequest.mockResolvedValue({
      tenantId: TENANT_ID,
      orgId: ORGANIZATION_ID,
      sub: 'user-1',
    })
    mockResolveOrganizationScopeForRequest.mockResolvedValue({ filterIds: [ORGANIZATION_ID] })
    mockFindWithDecryption.mockImplementation(
      (
        _em: unknown,
        entity: { name?: string },
        where: Record<string, unknown>,
      ) => {
        if (entity.name === 'SalesInvoicePlMeta') {
          const salesInvoiceId = where.salesInvoiceId as FilterOperators | undefined
          return Promise.resolve(
            invoices
              .filter((invoice) => !salesInvoiceId?.$in || salesInvoiceId.$in.includes(invoice.id))
              .map((invoice) => ({ salesInvoiceId: invoice.id, invoiceKind: 'vat' })),
          )
        }
        if (entity.name !== 'KsefSubmission') return Promise.resolve([])

        const status = where.status as FilterOperators | string | undefined
        const salesInvoiceId = where.salesInvoiceId as FilterOperators | undefined
        return Promise.resolve(
          submissions.filter((submission) => {
            if (typeof status === 'string' && submission.status !== status) return false
            if (typeof status === 'object' && status.$in && !status.$in.includes(submission.status)) return false
            if (salesInvoiceId?.$in && !salesInvoiceId.$in.includes(submission.salesInvoiceId)) return false
            return true
          }),
        )
      },
    )
  })

  it('lists only accepted/offline-issued invoice ids under Wystawiona', async () => {
    const response = await GET(makeRequest('documentStatus=issued&page=1&pageSize=25'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([ACCEPTED_ID])
    expect(body.total).toBe(1)
    expect(body.summary.count).toBe(1)
    expect(mockFindWithDecryption).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        status: { $in: ['accepted', 'offline_issued'] },
        documentKind: 'invoice',
        tenantId: TENANT_ID,
        organizationId: { $in: [ORGANIZATION_ID] },
        deletedAt: null,
      }),
      { fields: ['salesInvoiceId'] },
      { tenantId: TENANT_ID, organizationId: ORGANIZATION_ID },
    )
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tenantId: TENANT_ID,
        organizationIds: [ORGANIZATION_ID],
        filters: { id: { $in: [ACCEPTED_ID] } },
        page: { page: 1, pageSize: 25 },
      }),
    )
  })

  it('lists null-status and queued invoices under Robocza while excluding accepted invoices', async () => {
    const response = await GET(makeRequest('documentStatus=draft&page=1&pageSize=25'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([NULL_STATUS_ID, QUEUED_ID])
    expect(body.items.map((item: { id: string }) => item.id)).not.toContain(ACCEPTED_ID)
    expect(body.total).toBe(2)
    expect(body.summary.count).toBe(2)
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ filters: { id: { $nin: [ACCEPTED_ID] } } }),
    )
  })

  it('ANDs Robocza with kind, issue-date, and search filters for page data and totals', async () => {
    const response = await GET(
      makeRequest(
        'documentStatus=draft&kind=vat&search=QUEUED&issueDateFrom=2026-08-11&issueDateTo=2026-08-11&page=1&pageSize=1',
      ),
    )
    const body = await response.json()
    const expectedFilters = {
      invoice_number: { $ilike: '%QUEUED%' },
      id: { $in: [NULL_STATUS_ID, QUEUED_ID, ACCEPTED_ID], $nin: [ACCEPTED_ID] },
      issue_date: { $gte: '2026-08-11', $lte: '2026-08-11' },
    }

    expect(response.status).toBe(200)
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([QUEUED_ID])
    expect(body.total).toBe(1)
    expect(body.summary.count).toBe(1)
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        filters: expectedFilters,
        page: { page: 1, pageSize: 1 },
      }),
    )
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        filters: expectedFilters,
        page: { page: 1, pageSize: 1000 },
      }),
    )
  })
})
