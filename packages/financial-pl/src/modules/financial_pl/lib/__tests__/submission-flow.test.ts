import { generateKeyPairSync } from 'node:crypto'
import type { KsefClient } from '../ksef-client'
import { KsefApiError } from '../ksef-client'
import { submitInvoiceToKsef, type KsefPollOptions } from '../submission-flow'

function spki(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64')
}

const noPoll: KsefPollOptions = {
  authMaxAttempts: 5,
  authDelayMs: 0,
  statusMaxAttempts: 5,
  statusDelayMs: 0,
  wait: async () => {},
}

type ClientOverrides = {
  authStatusCodes?: number[]
  invoiceStatusCode?: number
  invoiceKsefNumber?: string
  invoiceStatusDescription?: string
  originalKsefNumber?: string
  originalSessionReference?: string
  upoThrows?: boolean
}

function mockClient(overrides: ClientOverrides = {}): KsefClient {
  const authStatusCodes = overrides.authStatusCodes ?? [200]
  let authCall = 0
  const client = {
    getPublicKeyCertificates: async () => [
      { publicKeyId: 't', certificate: spki(), usage: ['KsefTokenEncryption'] },
      { publicKeyId: 's', certificate: spki(), usage: ['SymmetricKeyEncryption'] },
    ],
    requestChallenge: async () => ({ challenge: 'CH', timestampMs: 1750000000000 }),
    authenticateWithToken: async () => ({ referenceNumber: 'AUTHREF', authenticationToken: 'AUTHTOKEN' }),
    getAuthStatus: async () => {
      const code = authStatusCodes[Math.min(authCall, authStatusCodes.length - 1)]
      authCall += 1
      return { code }
    },
    redeemToken: async () => ({ accessToken: 'ACCESS', refreshToken: 'REFRESH' }),
    openOnlineSession: async () => ({ referenceNumber: 'SESSION1' }),
    sendOnlineInvoice: async () => ({ referenceNumber: 'INV1' }),
    closeOnlineSession: async () => {},
    getInvoiceStatus: async () => ({
      code: overrides.invoiceStatusCode ?? 200,
      ksefNumber: overrides.invoiceKsefNumber,
      description: overrides.invoiceStatusDescription,
      originalKsefNumber: overrides.originalKsefNumber,
      originalSessionReference: overrides.originalSessionReference,
    }),
    getInvoiceUpo: async () => {
      if (overrides.upoThrows) throw new Error('UPO not ready')
      return '<UPO/>'
    },
    getInvoiceUpoByKsefNumber: async () => {
      if (overrides.upoThrows) throw new Error('UPO not ready')
      return '<UPO-ORIGINAL/>'
    },
  }
  return client as unknown as KsefClient
}

const input = {
  auth: { method: 'token' as const, ksefToken: 'KSEF-TOKEN', contextNip: '7980332920' },
  invoiceXml: '<Faktura/>',
}

describe('submitInvoiceToKsef', () => {
  it('runs the full happy path to acceptance with UPO + KSeF number', async () => {
    const result = await submitInvoiceToKsef(mockClient({ invoiceKsefNumber: 'KSEF-NO' }), input, noPoll)
    expect(result.status).toBe('accepted')
    expect(result.ksefNumber).toBe('KSEF-NO')
    expect(result.upoXml).toBe('<UPO/>')
    expect(result.sessionReference).toBe('SESSION1')
    expect(result.invoiceReference).toBe('INV1')
    expect(result.duplicate).toBe(false)
  })

  it('polls auth until it succeeds', async () => {
    const result = await submitInvoiceToKsef(mockClient({ authStatusCodes: [100, 100, 200], invoiceKsefNumber: 'K' }), input, noPoll)
    expect(result.status).toBe('accepted')
  })

  it('fails fast when auth is rejected', async () => {
    const result = await submitInvoiceToKsef(mockClient({ authStatusCodes: [403] }), input, noPoll)
    expect(result.status).toBe('rejected')
    expect(result.errorMessage).toContain('auth failed')
  })

  it('fails fast (terminal) when GET /auth returns an HTTP 410 Gone instead of cycling the queue', async () => {
    const base = mockClient() as unknown as Record<string, unknown>
    const client = {
      ...base,
      getAuthStatus: async () => {
        throw new KsefApiError('KSeF GET /auth/AUTHREF failed with 410', 410, { code: 'Gone' })
      },
    } as unknown as KsefClient
    const result = await submitInvoiceToKsef(client, input, noPoll)
    expect(result.status).toBe('rejected')
    expect(result.errorMessage).toContain('410')
  })

  it('records a rejected invoice status without fetching UPO, surfacing the KSeF reason', async () => {
    const result = await submitInvoiceToKsef(
      mockClient({ invoiceStatusCode: 445, invoiceStatusDescription: 'Niezgodność z XSD: P_13_1' }),
      input,
      noPoll,
    )
    expect(result.status).toBe('rejected')
    expect(result.upoXml).toBeUndefined()
    expect(result.errorMessage).toContain('rejected')
    expect(result.errorMessage).toContain('Niezgodność z XSD: P_13_1')
  })

  it('recovers an accepted duplicate (status 440) via the original session + KSeF number', async () => {
    const result = await submitInvoiceToKsef(
      mockClient({
        invoiceStatusCode: 440,
        originalKsefNumber: 'ORIG-KSEF-NO',
        originalSessionReference: 'ORIG-SESSION',
      }),
      input,
      noPoll,
    )
    expect(result.status).toBe('accepted')
    expect(result.duplicate).toBe(true)
    expect(result.ksefNumber).toBe('ORIG-KSEF-NO')
    expect(result.upoXml).toBe('<UPO-ORIGINAL/>')
  })

  it('keeps a duplicate (440) in processing (not rejected) when the original references are missing', async () => {
    const result = await submitInvoiceToKsef(mockClient({ invoiceStatusCode: 440 }), input, noPoll)
    expect(result.status).toBe('processing')
    expect(result.duplicate).toBe(true)
    expect(result.upoXml).toBeUndefined()
  })

  it('keeps an accepted invoice (200) in processing when the UPO fetch fails (never accepted without a receipt)', async () => {
    const result = await submitInvoiceToKsef(
      mockClient({ invoiceStatusCode: 200, invoiceKsefNumber: 'KSEF-NO', upoThrows: true }),
      input,
      noPoll,
    )
    expect(result.status).toBe('processing')
    expect(result.upoXml).toBeUndefined()
    expect(result.errorMessage).toContain('UPO')
  })

  it('selects usage-matched certificates and threads their publicKeyId selectors', async () => {
    let tokenPublicKeyId: string | undefined
    let sessionPublicKeyId: string | undefined
    const base = mockClient({ invoiceKsefNumber: 'K' }) as unknown as Record<string, unknown>
    const client = {
      ...base,
      authenticateWithToken: async (params: { publicKeyId?: string }) => {
        tokenPublicKeyId = params.publicKeyId
        return { referenceNumber: 'AUTHREF', authenticationToken: 'AUTHTOKEN' }
      },
      openOnlineSession: async (params: { publicKeyId?: string }) => {
        sessionPublicKeyId = params.publicKeyId
        return { referenceNumber: 'SESSION1' }
      },
    } as unknown as KsefClient
    const result = await submitInvoiceToKsef(client, input, noPoll)
    expect(result.status).toBe('accepted')
    expect(tokenPublicKeyId).toBe('t')
    expect(sessionPublicKeyId).toBe('s')
  })

  it('matches certificates by usage even when the other usage has a newer validFrom', async () => {
    let tokenPublicKeyId: string | undefined
    let sessionPublicKeyId: string | undefined
    const base = mockClient({ invoiceKsefNumber: 'K' }) as unknown as Record<string, unknown>
    const client = {
      ...base,
      // Symmetric cert has the newer validFrom: a validFrom-only selection would pick
      // it for BOTH; usage matching must still route the token cert to token-auth.
      getPublicKeyCertificates: async () => [
        { publicKeyId: 't', certificate: spki(), usage: ['KsefTokenEncryption'], validFrom: '2020-01-01T00:00:00Z' },
        { publicKeyId: 's', certificate: spki(), usage: ['SymmetricKeyEncryption'], validFrom: '2030-01-01T00:00:00Z' },
      ],
      authenticateWithToken: async (params: { publicKeyId?: string }) => {
        tokenPublicKeyId = params.publicKeyId
        return { referenceNumber: 'AUTHREF', authenticationToken: 'AUTHTOKEN' }
      },
      openOnlineSession: async (params: { publicKeyId?: string }) => {
        sessionPublicKeyId = params.publicKeyId
        return { referenceNumber: 'SESSION1' }
      },
    } as unknown as KsefClient
    const result = await submitInvoiceToKsef(client, input, noPoll)
    expect(result.status).toBe('accepted')
    expect(tokenPublicKeyId).toBe('t')
    expect(sessionPublicKeyId).toBe('s')
  })

  it('fails fast with a clear error when no usage-matched certificate is present', async () => {
    const base = mockClient() as unknown as Record<string, unknown>
    const client = {
      ...base,
      getPublicKeyCertificates: async () => [{ publicKeyId: 'x', certificate: spki(), usage: ['SomethingElse'] }],
    } as unknown as KsefClient
    const result = await submitInvoiceToKsef(client, input, noPoll)
    expect(result.status).toBe('rejected')
    expect(result.errorMessage).toContain('public keys')
  })

  // --- SPEC-010: offline-mode deferred send threading + retroactive reconcile ---

  it('threads offlineMode:false to sendOnlineInvoice for an online send (byte-identical default)', async () => {
    let sentOfflineMode: boolean | undefined
    const base = mockClient({ invoiceKsefNumber: 'K' }) as unknown as Record<string, unknown>
    const client = {
      ...base,
      sendOnlineInvoice: async (params: { offlineMode?: boolean }) => {
        sentOfflineMode = params.offlineMode
        return { referenceNumber: 'INV1' }
      },
    } as unknown as KsefClient
    const result = await submitInvoiceToKsef(client, input, noPoll)
    expect(result.status).toBe('accepted')
    expect(sentOfflineMode).toBe(false)
  })

  it('threads offlineMode:true to sendOnlineInvoice for a deferred offline send', async () => {
    let sentOfflineMode: boolean | undefined
    const base = mockClient({ invoiceKsefNumber: 'K' }) as unknown as Record<string, unknown>
    const client = {
      ...base,
      sendOnlineInvoice: async (params: { offlineMode?: boolean }) => {
        sentOfflineMode = params.offlineMode
        return { referenceNumber: 'INV1' }
      },
    } as unknown as KsefClient
    const result = await submitInvoiceToKsef(client, { ...input, offlineMode: true }, noPoll)
    expect(result.status).toBe('accepted')
    expect(sentOfflineMode).toBe(true)
  })

  it('reconciles the retroactive KSeF number + UPO on a deferred offline send to acceptance', async () => {
    const result = await submitInvoiceToKsef(
      mockClient({ invoiceKsefNumber: 'KSEF-OFFLINE-NO' }),
      { ...input, offlineMode: true },
      noPoll,
    )
    expect(result.status).toBe('accepted')
    expect(result.ksefNumber).toBe('KSEF-OFFLINE-NO')
    expect(result.upoXml).toBe('<UPO/>')
  })

  it('keeps an offline send duplicate-safe: a 440 re-send heals to the original number + UPO', async () => {
    const result = await submitInvoiceToKsef(
      mockClient({ invoiceStatusCode: 440, originalKsefNumber: 'ORIG-OFFLINE', originalSessionReference: 'ORIG-SESSION' }),
      { ...input, offlineMode: true },
      noPoll,
    )
    expect(result.status).toBe('accepted')
    expect(result.duplicate).toBe(true)
    expect(result.ksefNumber).toBe('ORIG-OFFLINE')
    expect(result.upoXml).toBe('<UPO-ORIGINAL/>')
  })
})
