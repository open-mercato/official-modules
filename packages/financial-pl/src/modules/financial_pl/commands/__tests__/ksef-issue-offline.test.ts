/**
 * Command tests for financial_pl.ksef_submission.issue_offline (SPEC-010).
 *
 * Covers the offline-issuance guards + persistence: 409 offline_certificate_required,
 * 409 offline_certificate_invalid (jury delta #3), the offline_mode_invalid zod gate
 * (jury delta #1), and the happy path persisting an `offline_issued` row with the KOD
 * I/II URLs + the computed statutory deadline. The FA(3) resolver/builder are mocked
 * at the module boundary (proven by their own tests) so this focuses on the lifecycle.
 */
// `@peculiar/x509` pulls in tsyringe, which requires the reflect-metadata polyfill to
// be evaluated FIRST. The app registers it globally at runtime; the jest env does not,
// so load it here as the very first import (mirrors cert-enrollment.test.ts).
import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import * as x509 from '@peculiar/x509'

// The resolver + serializer are exercised by their own suites; mock them so this test
// is about the offline lifecycle (cert checks, deadline, persistence), not the FA(3) build.
jest.mock('../../lib/resolve-fa3-from-invoice', () => ({
  resolveFa3FromSalesInvoice: jest.fn(async () => ({
    invoiceNumber: 'FV/2026/OFF/1',
    issueDate: '2026-06-25',
    currencyCode: 'PLN',
    seller: { nip: '5260001246', name: 'Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1' },
    buyer: { nip: '7342867148', name: 'Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2' },
    vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
    totalGross: '123.00',
    lines: [{ lineNumber: 1, name: 'Item', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
  })),
}))
jest.mock('../../lib/build-submission', () => ({
  buildFa3XmlFromInput: jest.fn(() => '<Faktura>OFFLINE</Faktura>'),
}))
// The command resolves i18n translations via the shared server helper, which needs the
// module registry bootstrapped at runtime. This lifecycle test is not about translations,
// so mock the helper to return the fallback translator (translate(key, fallback) => fallback).
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  })),
}))

import { issueOfflineCommand } from '../ksef-submission'
// The resolver is mocked above; import the (mocked) fn so a single test can make it yield a
// self-billed payload and assert the offline path's self-billing guard fires.
import { resolveFa3FromSalesInvoice } from '../../lib/resolve-fa3-from-invoice'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const INV = '33333333-3333-4333-8333-333333333333'

/** A self-signed cert PEM + the matching RSA private key PEM, valid around now. */
async function rsaCertAndKey(notBefore: Date, notAfter: Date): Promise<{ certPem: string; keyPem: string }> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const keys = (await webcrypto.subtle.generateKey(alg as never, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '0A',
    name: 'CN=KSeF Offline Test, C=PL',
    notBefore,
    notAfter,
    keys: keys as never,
    signingAlgorithm: alg,
  })
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')}\n-----END PRIVATE KEY-----\n`
  return { certPem: cert.toString('pem'), keyPem }
}

type Creds = Record<string, unknown> | null

function makeCtx(opts: { creds?: Creds; em?: Record<string, unknown> }) {
  const em = opts.em ?? {
    findOne: jest.fn(async () => null),
    create: jest.fn((_e: unknown, data: Record<string, unknown>) => ({ id: 'NEW', ...data })),
    persist: () => ({ flush: async () => {} }),
  }
  ;(em as Record<string, unknown>).fork = () => em
  return {
    container: {
      resolve: (name: string) => {
        if (name === 'em') return em
        if (name === 'queryEngine') return { query: jest.fn(async () => ({ items: [] })) }
        if (name === 'integrationCredentialsService') return { getRaw: async () => opts.creds ?? null }
        return undefined
      },
    },
    auth: { tenantId: TEN, orgId: ORG, sub: 'user', isSuperAdmin: false },
    organizationScope: null,
    selectedOrganizationId: ORG,
    request: null,
  } as unknown as Parameters<typeof issueOfflineCommand.execute>[1]
}

describe('financial_pl.ksef_submission.issue_offline (SPEC-010)', () => {
  it('rejects (400 offline_mode_invalid) when offline24 carries a failureEndsAt', async () => {
    await expect(
      issueOfflineCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, mode: 'offline24', failureEndsAt: '2026-06-30T00:00:00.000Z' },
        makeCtx({ creds: { contextNip: '5260001246' } }),
      ),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ params: expect.objectContaining({ code: 'offline_mode_invalid' }) }),
      ]),
    })
  })

  it('rejects (400 offline_mode_invalid) when awaryjny omits failureEndsAt', async () => {
    await expect(
      issueOfflineCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, mode: 'awaryjny' },
        makeCtx({ creds: { contextNip: '5260001246' } }),
      ),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ params: expect.objectContaining({ code: 'offline_mode_invalid' }) }),
      ]),
    })
  })

  it('rejects (409 offline_certificate_required) when no Offline certificate is enrolled', async () => {
    await expect(
      issueOfflineCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, mode: 'offline24' },
        makeCtx({ creds: { contextNip: '5260001246' } }),
      ),
    ).rejects.toMatchObject({ status: 409, body: { code: 'offline_certificate_required' } })
  })

  it('rejects (409 offline_certificate_invalid) when the Offline certificate is expired (jury #3)', async () => {
    const { certPem, keyPem } = await rsaCertAndKey(new Date('2020-01-01'), new Date('2021-01-01'))
    await expect(
      issueOfflineCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, mode: 'offline24' },
        makeCtx({
          creds: {
            contextNip: '5260001246',
            offlineCertificatePem: certPem,
            offlineCertificatePrivateKeyPem: keyPem,
            offlineCertificateSerialNumber: '0A',
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, body: { code: 'offline_certificate_invalid' } })
  })

  it('persists an offline_issued row with KOD I/II + deadline on the happy path (offline24)', async () => {
    const now = Date.now()
    const { certPem, keyPem } = await rsaCertAndKey(new Date(now - 86_400_000), new Date(now + 31_536_000_000))
    const created: Record<string, unknown>[] = []
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => null),
      create: jest.fn((_e: unknown, data: Record<string, unknown>) => {
        const row = { id: 'NEW', ...data }
        created.push(row)
        return row
      }),
      persist: () => ({ flush: async () => {} }),
    }
    const result = await issueOfflineCommand.execute(
      { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, mode: 'offline24' },
      makeCtx({
        creds: {
          contextNip: '5260001246',
          environment: 'test',
          offlineCertificatePem: certPem,
          offlineCertificatePrivateKeyPem: keyPem,
          offlineCertificateSerialNumber: '0A',
        },
        em,
      }),
    )

    expect(result.status).toBe('offline_issued')
    expect(result.submissionId).toBe('NEW')
    expect(typeof result.deadline).toBe('string')
    const row = created[0]
    expect(row.status).toBe('offline_issued')
    expect(row.mode).toBe('offline24')
    expect(row.invoiceXml).toBe('<Faktura>OFFLINE</Faktura>')
    expect(row.offlineCertificateSerial).toBe('0A')
    expect(String(row.kodIUrl)).toContain('/invoice/')
    expect(String(row.kodIiUrl)).toContain('/certificate/Nip/')
    expect(row.offlineIssuedAt).toBeInstanceOf(Date)
    expect(row.offlineSendDeadlineAt).toBeInstanceOf(Date)
  })

  it('rejects (422 self_billing_unsupported) a self-billed invoice before building KOD II / persisting a row', async () => {
    const now = Date.now()
    const { certPem, keyPem } = await rsaCertAndKey(new Date(now - 86_400_000), new Date(now + 31_536_000_000))
    // The resolver yields a self-billed payload (P_17) — invalid for a self-issued invoice
    // (KSeF rejects it 410). The offline path must reject it BEFORE issuing (no KOD II, no row),
    // exactly like the online sendCommand path — both call the shared assertNotSelfBilled guard.
    ;(resolveFa3FromSalesInvoice as jest.Mock).mockResolvedValueOnce({
      invoiceNumber: 'FV/2026/OFF/SB',
      issueDate: '2026-06-25',
      currencyCode: 'PLN',
      seller: { nip: '5260001246', name: 'Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1' },
      buyer: { nip: '7342867148', name: 'Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2' },
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
      totalGross: '123.00',
      lines: [{ lineNumber: 1, name: 'Item', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
      selfBilling: true,
    })
    const create = jest.fn()
    const em: Record<string, unknown> = { findOne: jest.fn(async () => null), create, persist: () => ({ flush: async () => {} }) }
    await expect(
      issueOfflineCommand.execute(
        { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, mode: 'offline24' },
        makeCtx({
          creds: {
            contextNip: '5260001246',
            environment: 'test',
            offlineCertificatePem: certPem,
            offlineCertificatePrivateKeyPem: keyPem,
            offlineCertificateSerialNumber: '0A',
          },
          em,
        }),
      ),
    ).rejects.toMatchObject({ status: 422, body: { code: 'self_billing_unsupported' } })
    // The guard fires after cert validation but before persistence — no offline_issued row created.
    expect(create).not.toHaveBeenCalled()
  })

  it('returns the existing active offline_issued row instead of creating a duplicate', async () => {
    const now = Date.now()
    const { certPem, keyPem } = await rsaCertAndKey(new Date(now - 86_400_000), new Date(now + 31_536_000_000))
    const create = jest.fn()
    const em: Record<string, unknown> = {
      findOne: jest.fn(async () => ({ id: 'EXISTING', offlineSendDeadlineAt: new Date('2026-06-30T00:00:00.000Z') })),
      create,
      persist: () => ({ flush: async () => {} }),
    }
    const result = await issueOfflineCommand.execute(
      { organizationId: ORG, tenantId: TEN, salesInvoiceId: INV, mode: 'offline24' },
      makeCtx({
        creds: {
          contextNip: '5260001246',
          offlineCertificatePem: certPem,
          offlineCertificatePrivateKeyPem: keyPem,
          offlineCertificateSerialNumber: '0A',
        },
        em,
      }),
    )
    expect(result.submissionId).toBe('EXISTING')
    expect(result.status).toBe('offline_issued')
    expect(create).not.toHaveBeenCalled()
  })
})
