import { resolveKsefEnvironment } from '../../config'
import { KsefClient, KsefApiError, createFetchTransport, type KsefTransport, type KsefTransportRequest } from '../ksef-client'

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

describe('KsefClient', () => {
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
