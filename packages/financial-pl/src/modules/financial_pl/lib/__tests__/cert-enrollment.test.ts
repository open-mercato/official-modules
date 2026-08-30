/**
 * Pure unit tests for runCertificateEnrollment (SPEC-007) + assertCertificateValidNow
 * and the Offline/Authentication persistence branch of the enroll command (SPEC-010).
 *
 * The KSeF transport (`client`) and the crypto primitives (`generateKeyPair`,
 * `buildCsr`, `wait`) are all injected, so the full enrollment runbook is driven
 * deterministically with an object-literal mock client (no network, no real crypto).
 * Critically, these tests prove the issued result carries the GENERATED private key
 * and that the private key never leaks into a log line.
 */
import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import * as x509 from '@peculiar/x509'
import type { KsefCertificateType, KsefClient } from '../ksef-client'
import {
  assertCertificateValidNow,
  CertificateValidityError,
  runCertificateEnrollment,
  type CertificateEnrollmentDeps,
} from '../cert-enrollment'

// The enroll command builds a real KsefClient + authenticates over the network; mock
// both so the command-level persistence branch test runs offline. The pure
// runCertificateEnrollment tests above never call `new KsefClient`, so they are
// unaffected (they cast object literals). cert-enrollment itself is NOT mocked — the
// command runs the real enrollment runbook against the mocked client instance.
const mockEnrollClientHandlers = {
  getCertificateEnrollmentData: jest.fn(async () => ({
    commonName: 'KSeF Test',
    countryName: 'PL',
    givenName: 'Jan',
    surname: 'Kowalski',
    organizationName: 'Open Mercato',
    serialNumber: '2481632647',
    uniqueIdentifier: undefined,
    organizationIdentifier: undefined,
    raw: {},
  })),
  enrollCertificate: jest.fn(async () => ({ referenceNumber: 'ENROLL-REF-CMD' })),
  getCertificateEnrollmentStatus: jest.fn(async () => ({
    code: 200,
    certificateSerialNumber: 'OFFLINE-SERIAL-9',
  })),
  retrieveCertificates: jest.fn(async () => ({
    certificates: [{ certificateSerialNumber: 'OFFLINE-SERIAL-9', certificate: CERT_PEM }],
  })),
}
jest.mock('../ksef-client', () => ({
  KsefClient: jest.fn().mockImplementation(() => mockEnrollClientHandlers),
}))
jest.mock('../../config', () => ({
  resolveKsefEnvironment: jest.fn(() => 'test'),
}))
jest.mock('../ksef-auth', () => ({
  authenticate: jest.fn(async () => ({ ok: true, accessToken: 'ACCESS-TOKEN' })),
}))

// Imported AFTER the jest.mock calls above (which are hoisted) so the command picks
// up the mocked client/auth/config.
import { enrollCommand } from '../../commands/ksef-certificate'

const GENERATED_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----'
// No trailing newline: runCertificateEnrollment normalizes (trims) the retrieved
// PEM, so the issued result.certificatePem is this exact value (SPEC-007 path).
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
const SERIAL = 'CERT-SERIAL-0001'

const deps: CertificateEnrollmentDeps = {
  wait: async () => {},
  generateKeyPair: async () => ({
    privateKeyPem: GENERATED_PRIVATE_KEY,
    publicKeyPem: 'pk',
    algorithm: 'RSA',
  }),
  buildCsr: async () => 'CSRB64',
}

type EnrollmentStatus = { code: number; description?: string; certificateSerialNumber?: string }

type MockOptions = {
  statusCodes?: EnrollmentStatus[]
  retrieved?: unknown
}

/**
 * Build an object-literal stand-in for KsefClient exposing exactly the four methods
 * runCertificateEnrollment calls. `getCertificateEnrollmentStatus` walks `statusCodes`
 * so a pending-then-success / terminal-failure sequence can be driven precisely.
 */
function mockClient(options: MockOptions = {}): {
  client: KsefClient
  calls: { enroll: number; retrieve: number; status: number }
  enrolledType: () => KsefCertificateType | undefined
} {
  const statusCodes = options.statusCodes ?? [{ code: 200, certificateSerialNumber: SERIAL }]
  const calls = { enroll: 0, retrieve: 0, status: 0 }
  let enrolledType: KsefCertificateType | undefined
  const client = {
    getCertificateEnrollmentData: async () => ({
      commonName: 'KSeF Test',
      countryName: 'PL',
      givenName: 'Jan',
      surname: 'Kowalski',
      organizationName: 'Open Mercato',
      serialNumber: '2481632647',
      uniqueIdentifier: undefined,
      organizationIdentifier: undefined,
      raw: {},
    }),
    enrollCertificate: async (args: { certificateType: KsefCertificateType }) => {
      calls.enroll += 1
      enrolledType = args.certificateType
      return { referenceNumber: 'ENROLL-REF-1' }
    },
    getCertificateEnrollmentStatus: async () => {
      const next = statusCodes[Math.min(calls.status, statusCodes.length - 1)]
      calls.status += 1
      return next
    },
    retrieveCertificates: async () => {
      calls.retrieve += 1
      return options.retrieved ?? { certificates: [{ certificateSerialNumber: SERIAL, certificate: CERT_PEM }] }
    },
  } as unknown as KsefClient
  return { client, calls, enrolledType: () => enrolledType }
}

describe('runCertificateEnrollment', () => {
  const params = { certificateName: 'OM Auth Cert', pollMaxAttempts: 5, pollDelayMs: 0 }

  it('happy path: enrollment data -> enroll -> status 200 -> retrieve -> issued with cert + key + serial', async () => {
    const { client, calls } = mockClient()
    const result = await runCertificateEnrollment(client, 'ACCESS', params, deps)

    expect(result.status).toBe('issued')
    if (result.status !== 'issued') throw new Error('expected issued')
    expect(result.serial).toBe(SERIAL)
    expect(result.certificatePem).toContain('BEGIN CERTIFICATE')
    // The returned private key MUST be exactly the generated one.
    expect(result.privateKeyPem).toBe(GENERATED_PRIVATE_KEY)
    expect(calls.enroll).toBe(1)
    expect(calls.retrieve).toBe(1)
  })

  it('defaults certificateType to Authentication when unspecified', async () => {
    const { client, enrolledType } = mockClient()
    const result = await runCertificateEnrollment(client, 'ACCESS', params, deps)
    expect(result.status).toBe('issued')
    expect(enrolledType()).toBe('Authentication')
  })

  it('threads certificateType=Offline through to client.enrollCertificate', async () => {
    const { client, enrolledType } = mockClient()
    const result = await runCertificateEnrollment(
      client,
      'ACCESS',
      { ...params, certificateType: 'Offline' },
      deps,
    )
    expect(result.status).toBe('issued')
    expect(enrolledType()).toBe('Offline')
  })

  it('terminal failure: status code 400 -> failed with a reason (no retrieve)', async () => {
    const { client, calls } = mockClient({
      statusCodes: [{ code: 400, description: 'CSR rejected' }],
    })
    const result = await runCertificateEnrollment(client, 'ACCESS', params, deps)

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected failed')
    expect(result.reason).toContain('400')
    expect(result.reason).toContain('CSR rejected')
    expect(calls.retrieve).toBe(0)
  })

  it('pending-then-success: status 100 then 200 -> issued', async () => {
    const { client, calls } = mockClient({
      statusCodes: [{ code: 100 }, { code: 200, certificateSerialNumber: SERIAL }],
    })
    const result = await runCertificateEnrollment(client, 'ACCESS', params, deps)

    expect(result.status).toBe('issued')
    expect(calls.status).toBe(2)
    expect(calls.retrieve).toBe(1)
  })

  it('issued but no serial: status 200 without certificateSerialNumber -> failed', async () => {
    const { client, calls } = mockClient({
      statusCodes: [{ code: 200 }],
    })
    const result = await runCertificateEnrollment(client, 'ACCESS', params, deps)

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected failed')
    expect(result.reason).toContain('serial')
    expect(calls.retrieve).toBe(0)
  })

  it('retrieve empty: status 200 + serial but retrieve returns no material -> failed', async () => {
    const { client, calls } = mockClient({
      statusCodes: [{ code: 200, certificateSerialNumber: SERIAL }],
      retrieved: { certificates: [] },
    })
    const result = await runCertificateEnrollment(client, 'ACCESS', params, deps)

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected failed')
    expect(result.reason).toContain('certificate material')
    expect(calls.retrieve).toBe(1)
  })

  it('never logs the private key', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client } = mockClient()
      const result = await runCertificateEnrollment(client, 'ACCESS', params, deps)
      expect(result.status).toBe('issued')
      const allLogged = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join('\n')
      expect(allLogged).not.toContain(GENERATED_PRIVATE_KEY)
      expect(allLogged).not.toContain('BEGIN PRIVATE KEY')
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

/** Generate a self-signed cert PEM whose validity window is [notBefore, notAfter]. */
async function selfSignedCertPem(notBefore: Date, notAfter: Date): Promise<string> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const keys = (await webcrypto.subtle.generateKey(alg as never, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '0A',
    name: 'CN=KSeF Offline Test, 2.5.4.5=2481632647, C=PL',
    notBefore,
    notAfter,
    keys: keys as never,
    signingAlgorithm: alg,
  })
  return cert.toString('pem')
}

describe('assertCertificateValidNow', () => {
  it('accepts a certificate whose validity window straddles now', async () => {
    const pem = await selfSignedCertPem(new Date('2026-01-01'), new Date('2028-01-01'))
    await expect(assertCertificateValidNow(pem, new Date('2026-06-29'))).resolves.toBeUndefined()
  })

  it('rejects an expired certificate', async () => {
    const pem = await selfSignedCertPem(new Date('2024-01-01'), new Date('2025-01-01'))
    await expect(assertCertificateValidNow(pem, new Date('2026-06-29'))).rejects.toBeInstanceOf(
      CertificateValidityError,
    )
    await expect(assertCertificateValidNow(pem, new Date('2026-06-29'))).rejects.toThrow(/expired/)
  })

  it('rejects a not-yet-valid certificate', async () => {
    const pem = await selfSignedCertPem(new Date('2027-01-01'), new Date('2029-01-01'))
    await expect(assertCertificateValidNow(pem, new Date('2026-06-29'))).rejects.toBeInstanceOf(
      CertificateValidityError,
    )
    await expect(assertCertificateValidNow(pem, new Date('2026-06-29'))).rejects.toThrow(/not yet valid/)
  })

  it('rejects an unparseable PEM', async () => {
    await expect(
      assertCertificateValidNow('-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n'),
    ).rejects.toBeInstanceOf(CertificateValidityError)
  })
})

describe('enrollCommand certificateType persistence (SPEC-010)', () => {
  const ORG = '11111111-1111-4111-8111-111111111111'
  const TEN = '22222222-2222-4222-8222-222222222222'

  // A pre-existing Authentication credential the enroll precondition (409) needs, plus
  // the contextNip. The Offline enrollment must NEVER clobber these.
  const existingRaw = {
    contextNip: '5260001246',
    authMethod: 'certificate',
    certificatePem: '-----BEGIN CERTIFICATE-----\nAUTH\n-----END CERTIFICATE-----\n',
    certificatePrivateKeyPem: '-----BEGIN PRIVATE KEY-----\nAUTHKEY\n-----END PRIVATE KEY-----',
    certificateSerialNumber: 'AUTH-SERIAL-1',
    environment: 'test',
  }

  beforeEach(() => {
    mockEnrollClientHandlers.enrollCertificate.mockClear()
    mockEnrollClientHandlers.getCertificateEnrollmentStatus.mockClear()
    mockEnrollClientHandlers.retrieveCertificates.mockClear()
    mockEnrollClientHandlers.getCertificateEnrollmentData.mockClear()
  })

  type SaveMock = jest.Mock<Promise<unknown>, [string, Record<string, unknown>, unknown]>

  function makeCtx(save: SaveMock) {
    const svc = { getRaw: jest.fn(async () => ({ ...existingRaw })), save }
    return {
      container: { resolve: (name: string) => (name === 'integrationCredentialsService' ? svc : undefined) },
      auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
      organizationScope: null,
      selectedOrganizationId: ORG,
      organizationIds: [ORG],
      request: null,
    } as unknown as Parameters<typeof enrollCommand.execute>[1]
  }

  it('Offline type persists the separate offlineCertificate* fields and preserves the Authentication credential', async () => {
    const save: SaveMock = jest.fn(
      async (_id: string, _creds: Record<string, unknown>, _scope: unknown) => ({}),
    )
    const result = await enrollCommand.execute(
      { certificateName: 'OM Offline Cert', certificateType: 'Offline' },
      makeCtx(save),
    )

    expect(result).toEqual({ serial: 'OFFLINE-SERIAL-9', status: 'issued' })
    expect(mockEnrollClientHandlers.enrollCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ certificateType: 'Offline' }),
    )
    const saved = save.mock.calls[0][1]
    // Offline triple written.
    expect(saved.offlineCertificatePem).toBe(CERT_PEM)
    expect(saved.offlineCertificateSerialNumber).toBe('OFFLINE-SERIAL-9')
    expect(typeof saved.offlineCertificatePrivateKeyPem).toBe('string')
    // Authentication credential untouched.
    expect(saved.certificatePem).toBe(existingRaw.certificatePem)
    expect(saved.certificatePrivateKeyPem).toBe(existingRaw.certificatePrivateKeyPem)
    expect(saved.certificateSerialNumber).toBe(existingRaw.certificateSerialNumber)
  })

  it('Authentication type (default) writes the Authentication triple and no offline fields', async () => {
    const save: SaveMock = jest.fn(
      async (_id: string, _creds: Record<string, unknown>, _scope: unknown) => ({}),
    )
    await enrollCommand.execute({ certificateName: 'OM Auth Cert' }, makeCtx(save))

    expect(mockEnrollClientHandlers.enrollCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ certificateType: 'Authentication' }),
    )
    const saved = save.mock.calls[0][1]
    expect(saved.certificatePem).toBe(CERT_PEM)
    expect(saved.certificateSerialNumber).toBe('OFFLINE-SERIAL-9')
    expect(saved.offlineCertificatePem).toBeUndefined()
    expect(saved.offlineCertificatePrivateKeyPem).toBeUndefined()
    expect(saved.offlineCertificateSerialNumber).toBeUndefined()
  })
})
