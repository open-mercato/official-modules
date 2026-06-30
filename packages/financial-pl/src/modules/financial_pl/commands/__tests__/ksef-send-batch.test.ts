import type { KsefTransport, KsefTransportRequest } from '../../lib/ksef-client'

const mockAuthenticate = jest.fn()
const mockBuildBatchPackage = jest.fn()
const mockBuildFa3XmlFromInput = jest.fn()
const mockResolveFa3FromSalesInvoice = jest.fn()
const mockPutToAbsoluteUrl = jest.fn()

jest.mock('../../lib/ksef-auth', () => ({
  authenticate: (...args: unknown[]) => mockAuthenticate(...args),
}))

jest.mock('../../lib/batch-package', () => ({
  buildBatchPackage: (...args: unknown[]) => mockBuildBatchPackage(...args),
}))

jest.mock('../../lib/build-submission', () => ({
  buildFa3XmlFromInput: (...args: unknown[]) => mockBuildFa3XmlFromInput(...args),
}))

jest.mock('../../lib/resolve-fa3-from-invoice', () => ({
  resolveFa3FromSalesInvoice: (...args: unknown[]) => mockResolveFa3FromSalesInvoice(...args),
}))

jest.mock('../../lib/http-put', () => ({
  putToAbsoluteUrl: (...args: unknown[]) => mockPutToAbsoluteUrl(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback: string) => fallback }),
}))

import { sendBatchCommand } from '../ksef-submission'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const INV_1 = '33333333-3333-4333-8333-333333333333'
const INV_2 = '44444444-4444-4444-8444-444444444444'
const SELF_BILLED = '55555555-5555-4555-8555-555555555555'

function json(body: unknown) {
  return { status: 200, headers: {}, text: JSON.stringify(body) }
}

function makeTransport(): { transport: KsefTransport; calls: KsefTransportRequest[] } {
  const calls: KsefTransportRequest[] = []
  const transport: KsefTransport = async (req) => {
    calls.push(req)
    const path = new URL(req.url).pathname
    if (path.endsWith('/security/public-key-certificates')) {
      return json([
        { publicKeyId: 'TOKEN', certificate: 'TOKEN-CERT', usage: ['token'], validFrom: '2026-01-01' },
        { publicKeyId: 'SYM', certificate: 'PUBLIC-SYMMETRIC', usage: ['symmetric'], validFrom: '2026-01-02' },
      ])
    }
    if (path.endsWith('/sessions/batch')) {
      return json({
        referenceNumber: 'BATCH-REF-1',
        partUploadRequests: [
          {
            ordinalNumber: 1,
            url: 'https://upload.example.test/batch-part-1',
            method: 'PUT',
            headers: { 'x-ms-blob-type': 'BlockBlob' },
          },
        ],
      })
    }
    if (path.endsWith('/sessions/batch/BATCH-REF-1/close')) {
      return json({})
    }
    throw new Error(`unexpected KSeF request: ${req.method} ${path}`)
  }
  return { transport, calls }
}

function makeEm() {
  const persisted: Array<Record<string, unknown>> = []
  const flush = jest.fn(async () => {})
  const em: Record<string, unknown> = {
    findOne: jest.fn(async () => null),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({
      id: `sub-${String(data.salesInvoiceId)}`,
      ...data,
    })),
    persist: jest.fn((entities: Array<Record<string, unknown>>) => {
      persisted.push(...entities)
      return { flush }
    }),
  }
  em.fork = () => em
  return { em, persisted, flush }
}

function makeCtx(em: unknown, transport: KsefTransport) {
  const credentials = {
    contextNip: '5260001246',
    environment: 'test',
    authMethod: 'token',
    ksefToken: 'TOKEN',
    sellerName: 'Seller',
    sellerAddressLine1: 'ul. Testowa 1',
  }
  return {
    container: {
      resolve: (name: string) => {
        if (name === 'em') return em
        if (name === 'queryEngine') return {}
        if (name === 'ksefTransport') return transport
        if (name === 'integrationCredentialsService') return { getRaw: async () => credentials }
        throw new Error(`unknown dependency: ${name}`)
      },
    },
    auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
    organizationScope: null,
    selectedOrganizationId: ORG,
    organizationIds: [ORG],
    request: null,
  } as unknown as Parameters<typeof sendBatchCommand.execute>[1]
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuthenticate.mockResolvedValue({ ok: true, accessToken: 'ACCESS' })
  mockBuildFa3XmlFromInput.mockImplementation((invoice: { invoiceNumber?: string }) => `<FA>${invoice.invoiceNumber ?? 'INV'}</FA>`)
  mockResolveFa3FromSalesInvoice.mockImplementation(
    async (_deps: unknown, args: { salesInvoiceId: string }) => ({
      invoiceNumber: args.salesInvoiceId,
      selfBilling: args.salesInvoiceId === SELF_BILLED,
      seller: { nip: '5260001246' },
    }),
  )
  mockBuildBatchPackage.mockReturnValue({
    encryptedZip: Buffer.from('encrypted zip'),
    encryption: { encryptedSymmetricKey: 'wrapped-key', initializationVector: 'iv' },
    batchFile: { fileSize: 123, fileHash: 'zip-hash' },
    fileParts: [{ ordinalNumber: 1, fileName: 'batch.zip.enc', fileSize: 13, fileHash: 'part-hash' }],
    invoiceHashes: [],
  })
  mockPutToAbsoluteUrl.mockResolvedValue({ ok: true, status: 200 })
})

describe('financial_pl.ksef_submission.send_batch', () => {
  it('opens, uploads, closes, and creates one batch submission row per invoice', async () => {
    const { em, persisted } = makeEm()
    const { transport, calls } = makeTransport()

    const result = await sendBatchCommand.execute({ invoiceIds: [INV_1, INV_2] }, makeCtx(em, transport))

    expect(result).toEqual({ batchReference: 'BATCH-REF-1', count: 2 })
    expect(mockBuildBatchPackage).toHaveBeenCalledWith(
      [
        { fileName: `${INV_1}.xml`, xml: `<FA>${INV_1}</FA>` },
        { fileName: `${INV_2}.xml`, xml: `<FA>${INV_2}</FA>` },
      ],
      'PUBLIC-SYMMETRIC',
    )
    expect(calls.some((req) => req.method === 'POST' && new URL(req.url).pathname.endsWith('/sessions/batch'))).toBe(true)
    expect(mockPutToAbsoluteUrl).toHaveBeenCalledWith(
      'https://upload.example.test/batch-part-1',
      Buffer.from('encrypted zip'),
      { 'x-ms-blob-type': 'BlockBlob' },
    )
    expect(calls.some((req) => req.method === 'POST' && new URL(req.url).pathname.endsWith('/sessions/batch/BATCH-REF-1/close'))).toBe(true)
    expect(persisted).toHaveLength(2)
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          salesInvoiceId: INV_1,
          mode: 'batch',
          status: 'processing',
          batchReference: 'BATCH-REF-1',
          sessionReference: 'BATCH-REF-1',
          invoiceXml: `<FA>${INV_1}</FA>`,
        }),
        expect.objectContaining({
          salesInvoiceId: INV_2,
          mode: 'batch',
          status: 'processing',
          batchReference: 'BATCH-REF-1',
          sessionReference: 'BATCH-REF-1',
          invoiceXml: `<FA>${INV_2}</FA>`,
        }),
      ]),
    )
  })

  it('rejects a self-billed invoice before packaging or opening a batch session', async () => {
    const { em } = makeEm()
    const { transport, calls } = makeTransport()

    await expect(sendBatchCommand.execute({ invoiceIds: [SELF_BILLED, INV_1] }, makeCtx(em, transport))).rejects.toMatchObject({
      status: 422,
      body: { code: 'self_billing_unsupported' },
    })

    expect(mockBuildBatchPackage).not.toHaveBeenCalled()
    expect(mockPutToAbsoluteUrl).not.toHaveBeenCalled()
    expect(calls.some((req) => new URL(req.url).pathname.endsWith('/sessions/batch'))).toBe(false)
    expect((em as Record<string, jest.Mock>).persist).not.toHaveBeenCalled()
  })
})
