import { resolveKsefEnvironment } from '../../config'
import { putToAbsoluteUrl } from '../http-put'
import { KsefClient, KsefApiError, createFetchTransport, type KsefTransport, type KsefTransportRequest } from '../ksef-client'

jest.mock('../http-put', () => ({ putToAbsoluteUrl: jest.fn() }))

function recordingTransport(
  handler: (req: KsefTransportRequest) => { status?: number; body?: unknown; text?: string },
): { transport: KsefTransport; calls: KsefTransportRequest[] } {
  const calls: KsefTransportRequest[] = []
  const transport: KsefTransport = async (req) => {
    calls.push(req)
    const out = handler(req)
    return {
      status: out.status ?? 200,
      headers: {},
      text: out.text ?? (out.body !== undefined ? JSON.stringify(out.body) : ''),
    }
  }
  return { transport, calls }
}

const env = resolveKsefEnvironment('test')
const mockedPutToAbsoluteUrl = putToAbsoluteUrl as jest.MockedFunction<typeof putToAbsoluteUrl>

describe('KsefClient', () => {
  beforeEach(() => {
    mockedPutToAbsoluteUrl.mockReset()
  })

  it('requests an anonymous challenge (no body) and prefers the integer timestampMs', async () => {
    const { transport, calls } = recordingTransport(() => ({
      body: { challenge: 'CH', timestamp: '2020-01-01T00:00:00.000Z', timestampMs: 1750000000000 },
    }))
    const client = new KsefClient(env, transport)
    const challenge = await client.requestChallenge()
    expect(challenge).toEqual({ challenge: 'CH', timestampMs: 1750000000000 })
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/auth/challenge')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toBeUndefined()
  })

  it('authenticates with a token, extracts the JWT from the TokenInfo object, and tags the public key', async () => {
    const { transport, calls } = recordingTransport(() => ({
      body: { referenceNumber: 'REF1', authenticationToken: { token: 'AUTH', validUntil: '2030-01-01T00:00:00Z' } },
    }))
    const client = new KsefClient(env, transport)
    const result = await client.authenticateWithToken({
      challenge: 'CH',
      contextNip: '7980332920',
      encryptedToken: 'ENC',
      publicKeyId: 'pk-token',
    })
    expect(result).toEqual({ referenceNumber: 'REF1', authenticationToken: 'AUTH' })
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/auth/ksef-token')
    expect(calls[0].headers.Authorization).toBeUndefined()
    const body = JSON.parse(calls[0].body as string)
    expect(body.encryptedToken).toBe('ENC')
    expect(body.contextIdentifier).toEqual({ type: 'Nip', value: '7980332920' })
    expect(body.publicKeyId).toBe('pk-token')
  })

  it('opens an online session with the FA(3) form code, bearer token, and key selector', async () => {
    const { transport, calls } = recordingTransport(() => ({ body: { referenceNumber: 'SESSION1', validUntil: 'X' } }))
    const client = new KsefClient(env, transport)
    const session = await client.openOnlineSession({
      accessToken: 'ACCESS',
      encryptedSymmetricKey: 'WRAPPED',
      initializationVector: 'IV',
      publicKeyId: 'pk-sym',
    })
    expect(session.referenceNumber).toBe('SESSION1')
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/sessions/online')
    expect(calls[0].headers.Authorization).toBe('Bearer ACCESS')
    const body = JSON.parse(calls[0].body as string)
    expect(body.formCode).toMatchObject({ systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' })
    expect(body.encryption).toMatchObject({ encryptedSymmetricKey: 'WRAPPED', initializationVector: 'IV', publicKeyId: 'pk-sym' })
  })

  it('sends an invoice to the session invoices endpoint', async () => {
    const { transport, calls } = recordingTransport(() => ({ body: { referenceNumber: 'INV1' } }))
    const client = new KsefClient(env, transport)
    const sent = await client.sendOnlineInvoice({
      accessToken: 'ACCESS',
      sessionReference: 'SESSION1',
      invoiceHash: 'h',
      invoiceSize: 10,
      encryptedDocumentHash: 'eh',
      encryptedDocumentSize: 16,
      encryptedDocumentContent: 'BASE64',
    })
    expect(sent.referenceNumber).toBe('INV1')
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/sessions/online/SESSION1/invoices')
    const body = JSON.parse(calls[0].body as string)
    expect(body).toMatchObject({
      invoiceHash: 'h',
      invoiceSize: 10,
      encryptedInvoiceHash: 'eh',
      encryptedInvoiceSize: 16,
      encryptedInvoiceContent: 'BASE64',
      offlineMode: false,
    })
  })

  it('opens a batch session and maps the part upload requests', async () => {
    const { transport, calls } = recordingTransport(() => ({
      body: {
        referenceNumber: 'BATCH1',
        partUploadRequests: [
          {
            ordinalNumber: 1,
            url: 'https://blob.example/upload-1',
            method: 'PUT',
            headers: { 'x-ms-blob-type': 'BlockBlob', ignored: 123 },
          },
        ],
      },
    }))
    const client = new KsefClient(env, transport)
    const result = await client.openBatchSession({
      accessToken: 'ACCESS',
      formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
      encryption: { encryptedSymmetricKey: 'WRAPPED', initializationVector: 'IV' },
      batchFile: { fileSize: 100, fileHash: 'ZIP-HASH' },
      fileParts: [{ ordinalNumber: 1, fileName: 'part-1.zip.enc', fileSize: 100, fileHash: 'PART-HASH' }],
    })

    expect(result).toEqual({
      referenceNumber: 'BATCH1',
      partUploadRequests: [
        {
          ordinalNumber: 1,
          url: 'https://blob.example/upload-1',
          method: 'PUT',
          headers: { 'x-ms-blob-type': 'BlockBlob' },
        },
      ],
    })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/sessions/batch')
    expect(calls[0].headers.Authorization).toBe('Bearer ACCESS')
    expect(JSON.parse(calls[0].body as string)).toEqual({
      formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
      encryption: { encryptedSymmetricKey: 'WRAPPED', initializationVector: 'IV' },
      batchFile: { fileSize: 100, fileHash: 'ZIP-HASH' },
      fileParts: [{ ordinalNumber: 1, fileName: 'part-1.zip.enc', fileSize: 100, fileHash: 'PART-HASH' }],
    })
  })

  it('uploads a batch part through the absolute-url PUT helper with response headers', async () => {
    mockedPutToAbsoluteUrl.mockResolvedValue({ ok: true, status: 201 })
    const client = new KsefClient(env, recordingTransport(() => ({ body: {} })).transport)
    const bytes = new Uint8Array([1, 2, 3])

    await client.uploadBatchPart(
      {
        ordinalNumber: 1,
        url: 'https://blob.example/upload-1',
        method: 'PATCH',
        headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-MD5': 'abc=' },
      },
      bytes,
    )

    expect(mockedPutToAbsoluteUrl).toHaveBeenCalledWith('https://blob.example/upload-1', bytes, {
      'x-ms-blob-type': 'BlockBlob',
      'Content-MD5': 'abc=',
    })
  })

  it('throws KsefApiError when a batch part upload fails', async () => {
    mockedPutToAbsoluteUrl.mockResolvedValue({ ok: false, status: 403, bodyText: 'denied' })
    const client = new KsefClient(env, recordingTransport(() => ({ body: {} })).transport)

    await expect(
      client.uploadBatchPart({ ordinalNumber: 1, url: 'https://blob.example/upload-1', method: 'PUT' }, Buffer.from('x')),
    ).rejects.toMatchObject({ status: 403, body: 'denied' })
  })

  it('closes a batch session by reference number', async () => {
    const { transport, calls } = recordingTransport(() => ({ body: {} }))
    const client = new KsefClient(env, transport)
    await client.closeBatchSession({ accessToken: 'ACCESS', referenceNumber: 'BATCH1' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/sessions/batch/BATCH1/close')
    expect(calls[0].headers.Authorization).toBe('Bearer ACCESS')
  })

  it('returns parsed session invoices JSON', async () => {
    const body = { invoices: [{ ksefNumber: 'KSEF-NO' }] }
    const { transport, calls } = recordingTransport(() => ({ body }))
    const client = new KsefClient(env, transport)

    await expect(client.getSessionInvoices({ accessToken: 'ACCESS', referenceNumber: 'BATCH1' })).resolves.toEqual(body)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/sessions/BATCH1/invoices')
    expect(calls[0].headers.Authorization).toBe('Bearer ACCESS')
  })

  it('parses invoice status code and ksefNumber', async () => {
    const { transport } = recordingTransport(() => ({ body: { status: { code: 200 }, ksefNumber: 'KSEF-NO' } }))
    const client = new KsefClient(env, transport)
    const status = await client.getInvoiceStatus({ accessToken: 'A', sessionReference: 'S', invoiceReference: 'I' })
    expect(status.code).toBe(200)
    expect(status.ksefNumber).toBe('KSEF-NO')
  })

  it('parses a 440 duplicate, reading the original references from status.extensions', async () => {
    const { transport } = recordingTransport(() => ({
      body: {
        status: {
          code: 440,
          description: 'Duplikat faktury',
          extensions: { originalKsefNumber: 'ORIG-NO', originalSessionReferenceNumber: 'ORIG-SESSION' },
        },
      },
    }))
    const client = new KsefClient(env, transport)
    const status = await client.getInvoiceStatus({ accessToken: 'A', sessionReference: 'S', invoiceReference: 'I' })
    expect(status.code).toBe(440)
    expect(status.originalKsefNumber).toBe('ORIG-NO')
    expect(status.originalSessionReference).toBe('ORIG-SESSION')
  })

  it('fetches a UPO by KSeF number from the original session', async () => {
    const { transport, calls } = recordingTransport(() => ({ text: '<UPO-ORIG/>' }))
    const client = new KsefClient(env, transport)
    const upo = await client.getInvoiceUpoByKsefNumber({ accessToken: 'A', sessionReference: 'ORIG-SESSION', ksefNumber: 'ORIG-NO' })
    expect(upo).toBe('<UPO-ORIG/>')
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/sessions/ORIG-SESSION/invoices/ksef/ORIG-NO/upo')
    expect(calls[0].headers.Accept).toBe('application/xml')
  })

  it('queries received invoice metadata with filters and default paging', async () => {
    const filters = {
      subjectType: 'Subject2' as const,
      dateRange: { dateType: 'PermanentStorage' as const, from: '2026-02-01T00:00:00Z', to: '2026-02-28T23:59:59Z' },
      sellerNip: '1111111111',
      invoiceTypes: ['VAT'],
      invoicingMode: 'Online' as const,
    }
    const { transport, calls } = recordingTransport(() => ({
      body: {
        hasMore: true,
        isTruncated: false,
        permanentStorageHwmDate: '2026-03-01T00:00:00Z',
        invoices: [
          {
            ksefNumber: 'KSEF-1',
            invoiceNumber: 'FV/1/2026',
            issueDate: '2026-02-10',
            acquisitionDate: '2026-02-11T10:00:00Z',
            seller: { nip: '1111111111', name: 'Seller' },
            buyer: { identifier: { type: 'Nip', value: '2222222222' }, name: 'Buyer' },
            netAmount: 100,
            grossAmount: 123,
            vatAmount: 23,
            currency: 'PLN',
            invoiceType: 'VAT',
            invoicingMode: 'Online',
            isSelfInvoicing: false,
            invoiceHash: 'HASH',
            hashOfCorrectedInvoice: 'CORRECTED',
          },
        ],
      },
    }))
    const client = new KsefClient(env, transport)

    const result = await client.queryReceivedInvoices({ accessToken: 'ACCESS', filters })

    expect(result).toEqual({
      hasMore: true,
      isTruncated: false,
      permanentStorageHwmDate: '2026-03-01T00:00:00Z',
      invoices: [
        {
          ksefNumber: 'KSEF-1',
          invoiceNumber: 'FV/1/2026',
          issueDate: '2026-02-10',
          acquisitionDate: '2026-02-11T10:00:00Z',
          seller: { nip: '1111111111', name: 'Seller' },
          buyer: { identifier: { type: 'Nip', value: '2222222222' }, name: 'Buyer' },
          netAmount: 100,
          grossAmount: 123,
          vatAmount: 23,
          currency: 'PLN',
          invoiceType: 'VAT',
          invoicingMode: 'Online',
          isSelfInvoicing: false,
          invoiceHash: 'HASH',
          hashOfCorrectedInvoice: 'CORRECTED',
        },
      ],
    })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe(
      'https://api-test.ksef.mf.gov.pl/v2/invoices/query/metadata?pageOffset=0&pageSize=10&sortOrder=Asc',
    )
    expect(calls[0].headers.Authorization).toBe('Bearer ACCESS')
    expect(JSON.parse(calls[0].body as string)).toEqual(filters)
  })

  it('downloads a received invoice by KSeF number as raw XML', async () => {
    const { transport, calls } = recordingTransport(() => ({ text: '<Faktura/>' }))
    const client = new KsefClient(env, transport)

    await expect(client.downloadInvoiceByKsefNumber({ accessToken: 'ACCESS', ksefNumber: 'KSEF/1' })).resolves.toBe('<Faktura/>')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://api-test.ksef.mf.gov.pl/v2/invoices/ksef/KSEF%2F1')
    expect(calls[0].headers.Authorization).toBe('Bearer ACCESS')
    expect(calls[0].headers.Accept).toBe('application/xml')
  })

  it('fetches the UPO as XML with an application/xml Accept header', async () => {
    const { transport, calls } = recordingTransport(() => ({ text: '<UPO/>' }))
    const client = new KsefClient(env, transport)
    expect(await client.getInvoiceUpo({ accessToken: 'A', sessionReference: 'S', invoiceReference: 'I' })).toBe('<UPO/>')
    expect(calls[0].headers.Accept).toBe('application/xml')
  })

  it('parses the public-key certificate list with an array usage field', async () => {
    const { transport } = recordingTransport(() => ({
      body: [{ publicKeyId: 'id1', certificate: 'CERT', usage: ['SymmetricKeyEncryption'], validFrom: '2026-01-01T00:00:00Z' }],
    }))
    const client = new KsefClient(env, transport)
    const certs = await client.getPublicKeyCertificates()
    expect(certs).toEqual([{ publicKeyId: 'id1', certificate: 'CERT', usage: ['SymmetricKeyEncryption'], validFrom: '2026-01-01T00:00:00Z' }])
  })

  it('extracts access and refresh JWTs from TokenInfo objects on redeem', async () => {
    const { transport } = recordingTransport(() => ({
      body: {
        accessToken: { token: 'ACCESS', validUntil: '2030-01-01T00:00:00Z' },
        refreshToken: { token: 'REFRESH', validUntil: '2030-01-08T00:00:00Z' },
      },
    }))
    const client = new KsefClient(env, transport)
    expect(await client.redeemToken('AUTH')).toEqual({ accessToken: 'ACCESS', refreshToken: 'REFRESH' })
  })

  it('tolerates a bare-string token form on redeem (resilience fallback)', async () => {
    const { transport } = recordingTransport(() => ({ body: { accessToken: 'ACCESS', refreshToken: 'REFRESH' } }))
    const client = new KsefClient(env, transport)
    expect(await client.redeemToken('AUTH')).toEqual({ accessToken: 'ACCESS', refreshToken: 'REFRESH' })
  })

  it('coerces a bare-string certificate usage into an array (resilience fallback)', async () => {
    const { transport } = recordingTransport(() => ({
      body: [{ publicKeyId: 'id1', certificate: 'CERT', usage: 'KsefTokenEncryption' }],
    }))
    const client = new KsefClient(env, transport)
    const certs = await client.getPublicKeyCertificates()
    expect(certs[0].usage).toEqual(['KsefTokenEncryption'])
  })

  it('refuses test-data onboarding outside the TEST environment', async () => {
    const { transport } = recordingTransport(() => ({ body: {} }))
    const client = new KsefClient(resolveKsefEnvironment('demo'), transport)
    await expect(client.createTestPerson({ nip: '7980332920', pesel: '00000000000' })).rejects.toThrow()
  })

  it('sends the required person fields when onboarding on TEST', async () => {
    const { transport, calls } = recordingTransport(() => ({ body: { referenceNumber: 'OK' } }))
    const client = new KsefClient(env, transport)
    await client.createTestPerson({ nip: '7980332920', pesel: '00000000000', description: 'ctx' })
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      nip: '7980332920',
      pesel: '00000000000',
      isBailiff: false,
      description: 'ctx',
    })
  })

  it('throws KsefApiError on a 4xx response', async () => {
    const { transport } = recordingTransport(() => ({ status: 400, body: { error: 'bad' } }))
    const client = new KsefClient(env, transport)
    await expect(client.requestChallenge()).rejects.toBeInstanceOf(KsefApiError)
  })

  it('aborts a live request that exceeds the configured timeout', async () => {
    const realFetch = global.fetch
    global.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })) as unknown as typeof fetch
    try {
      const transport = createFetchTransport(10)
      await expect(
        transport({
          method: 'GET',
          url: 'https://api-test.ksef.mf.gov.pl/v2/security/public-key-certificates',
          headers: {},
        }),
      ).rejects.toThrow(/timed out/)
    } finally {
      global.fetch = realFetch
    }
  })
})
