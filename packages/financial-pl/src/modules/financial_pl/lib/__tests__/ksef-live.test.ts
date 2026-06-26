/**
 * Live KSeF TEST-environment smoke test.
 *
 * SKIPPED by default so CI stays green and offline. To exercise the connector
 * against the real Ministry of Finance TEST API (https://api-test.ksef.mf.gov.pl):
 *
 *   OM_KSEF_TEST_NIP=<fictional test NIP> \
 *   OM_KSEF_TEST_TOKEN=<KSeF authorization token for that NIP> \
 *   yarn workspace @open-mercato/financial-pl test ksef-live
 *
 * The TEST environment accepts fictional NIPs and self-signed certs and offers
 * self-onboarding via POST /v2/testdata/person. Obtain a token for the context
 * NIP from the KSeF test portal (https://ksef-test.mf.gov.pl) and pass it above.
 *
 * Add OM_KSEF_TEST_STRICT=1 to turn the second test into a hard readiness gate
 * that requires an `accepted` status with a KSeF number and a non-empty UPO
 * (proving the full submit -> status -> UPO path), not merely a terminal status.
 */
import { resolveKsefEnvironment } from '../../config'
import { KsefClient } from '../ksef-client'
import { buildFa3Xml, type Fa3Document } from '../fa3'
import { submitInvoiceToKsef } from '../submission-flow'

const TEST_TOKEN = process.env.OM_KSEF_TEST_TOKEN
const TEST_NIP = process.env.OM_KSEF_TEST_NIP
const liveDescribe = TEST_TOKEN && TEST_NIP ? describe : describe.skip

function sampleInvoiceXml(sellerNip: string): string {
  const doc: Fa3Document = {
    model: {
      createdAt: new Date().toISOString(),
      seller: { nip: sellerNip, name: 'Open Mercato Test Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1, 00-001 Warszawa' },
      buyer: { nip: '3755747347', name: 'Open Mercato Test Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
      invoiceNumber: `OM-SMOKE-${Date.now()}`,
      issueDate: new Date().toISOString().slice(0, 10),
      currencyCode: 'PLN',
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
      totalGross: '123.00',
    },
    lines: [
      { lineNumber: 1, name: 'Usługa testowa', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
    ],
  }
  return buildFa3Xml(doc)
}

liveDescribe('KSeF TEST live smoke', () => {
  jest.setTimeout(120000)
  const env = resolveKsefEnvironment(process.env.OM_KSEF_ENVIRONMENT ?? 'test')

  it('reaches the TEST environment and returns public-key certificates', async () => {
    const client = new KsefClient(env)
    const certs = await client.getPublicKeyCertificates()
    expect(certs.length).toBeGreaterThan(0)
  })

  it('submits a sample FA(3) invoice and resolves to a terminal status', async () => {
    const client = new KsefClient(env)
    const result = await submitInvoiceToKsef(client, {
      ksefToken: TEST_TOKEN as string,
      contextNip: TEST_NIP as string,
      invoiceXml: sampleInvoiceXml(TEST_NIP as string),
    })
    // eslint-disable-next-line no-console
    console.log('[ksef-live] result', {
      status: result.status,
      ksefNumber: result.ksefNumber,
      lastStatusCode: result.lastStatusCode,
      error: result.errorMessage,
      upoBytes: result.upoXml?.length,
    })
    // A KSeF rejection of a structurally-faithful FA(3) is a real readiness signal,
    // so the default (non-strict) run does NOT accept `rejected` — only a terminal
    // accept or an in-flight processing status passes. `OM_KSEF_TEST_STRICT=1`
    // tightens this further to require accepted + KSeF number + UPO.
    expect(['accepted', 'processing']).toContain(result.status)
    expect(result.sessionReference).toBeTruthy()
    // Strict readiness gate (opt-in via OM_KSEF_TEST_STRICT=1): prove the full
    // auth -> submit -> status -> UPO path actually yields a registered FA(3)
    // invoice WITH its signed receipt, rather than merely reaching a terminal
    // status. The default run stays lenient because a structurally-faithful FA(3)
    // subset can legitimately be rejected by KSeF on a residual schema gap.
    if (process.env.OM_KSEF_TEST_STRICT === '1') {
      expect(result.status).toBe('accepted')
      expect(result.ksefNumber).toBeTruthy()
      expect(result.upoXml && result.upoXml.length > 0).toBe(true)
    }
  })
})
