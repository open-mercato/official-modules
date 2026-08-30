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
 *
 * Certificate-auth round-trip (SPEC-007): gated SEPARATELY on
 *   OM_KSEF_TEST_CERT_PEM=<KSeF Authentication certificate, PEM> \
 *   OM_KSEF_TEST_CERT_KEY=<the certificate's private key, PEM>
 * (plus OM_KSEF_TEST_NIP). When those are set, the cert-auth block submits a sample
 * FA(3) invoice via the XAdES (certificate) auth path instead of the token path.
 */
import { resolveKsefEnvironment } from '../../config'
import { KsefClient } from '../ksef-client'
import { buildFa3Xml, type Fa3Document, type Fa3Party } from '../fa3'
import { submitInvoiceToKsef, DEFAULT_POLL_OPTIONS } from '../submission-flow'
import type { KsefAuthConfig } from '../ksef-auth'
import { authenticate } from '../ksef-auth'

const TEST_TOKEN = process.env.OM_KSEF_TEST_TOKEN
const TEST_NIP = process.env.OM_KSEF_TEST_NIP
const TEST_CERT_PEM = process.env.OM_KSEF_TEST_CERT_PEM
const TEST_CERT_KEY = process.env.OM_KSEF_TEST_CERT_KEY
const liveDescribe = TEST_TOKEN && TEST_NIP ? describe : describe.skip
// The certificate-auth path needs a NIP + an enrolled cert + its key. It is gated
// independently of the token path so a token-only run still exercises the rest.
const certDescribe = TEST_NIP && TEST_CERT_PEM && TEST_CERT_KEY ? describe : describe.skip

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

/**
 * A sample FA(3) KOR correction (RodzajFaktury=KOR) referencing a corrected original
 * by its KSeF number. Amounts are filed as negative differences (a credit memo is a
 * reduction). When `correctedKsefNumber` is omitted the NrKSeFN legacy marker is used;
 * here we pass a placeholder so the in-KSeF NrKSeF branch is exercised structurally.
 */
function sampleCorrectionXml(sellerNip: string, correctedKsefNumber: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const doc: Fa3Document = {
    model: {
      createdAt: new Date().toISOString(),
      seller: { nip: sellerNip, name: 'Open Mercato Test Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1, 00-001 Warszawa' },
      buyer: { nip: '3755747347', name: 'Open Mercato Test Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
      invoiceNumber: `OM-KOR-${Date.now()}`,
      issueDate: today,
      currencyCode: 'PLN',
      invoiceKind: 'KOR',
      vatBreakdown: [{ rate: 23, net: '-100.00', vat: '-23.00' }],
      totalGross: '-123.00',
      correction: {
        reason: 'Korekta ilości — test integracyjny',
        correctedInvoices: [
          {
            correctedIssueDate: today,
            correctedInvoiceNumber: 'OM-SMOKE-ORIGINAL',
            correctedKsefNumber,
          },
        ],
      },
    },
    lines: [
      { lineNumber: 1, name: 'Usługa testowa', unit: 'szt', quantity: '-1', unitNetPrice: '100.00', netValue: '-100.00', vatRate: 23 },
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
    const auth: KsefAuthConfig = { method: 'token', ksefToken: TEST_TOKEN as string, contextNip: TEST_NIP as string }
    const result = await submitInvoiceToKsef(client, {
      auth,
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

  it('submits a sample FA(3) KOR correction and resolves to a terminal status', async () => {
    const client = new KsefClient(env)
    const auth: KsefAuthConfig = { method: 'token', ksefToken: TEST_TOKEN as string, contextNip: TEST_NIP as string }
    // The corrected original's KSeF number is supplied via env when available; otherwise
    // a placeholder exercises the NrKSeF structural branch (KSeF may reject an unknown
    // reference — a real correction round-trip uses an actually-accepted original number).
    const correctedKsefNumber = process.env.OM_KSEF_TEST_CORRECTED_KSEF_NUMBER ?? `${TEST_NIP}-20260101-PLACEHOLDER`
    const result = await submitInvoiceToKsef(client, {
      auth,
      invoiceXml: sampleCorrectionXml(TEST_NIP as string, correctedKsefNumber),
    })
    // eslint-disable-next-line no-console
    console.log('[ksef-live] correction result', {
      status: result.status,
      ksefNumber: result.ksefNumber,
      lastStatusCode: result.lastStatusCode,
      error: result.errorMessage,
      upoBytes: result.upoXml?.length,
    })
    // The auth must succeed and the correction must reach a terminal/processing
    // outcome (not stuck pre-auth). Acceptance of a correction depends on a real
    // accepted original being referenced, so by default we only require the send
    // pipeline to run; OM_KSEF_TEST_STRICT=1 with a real corrected number tightens it.
    expect(['accepted', 'processing', 'rejected']).toContain(result.status)
    expect(result.sessionReference).toBeTruthy()
    if (process.env.OM_KSEF_TEST_STRICT === '1' && process.env.OM_KSEF_TEST_CORRECTED_KSEF_NUMBER) {
      expect(result.status).toBe('accepted')
      expect(result.ksefNumber).toBeTruthy()
      expect(result.upoXml && result.upoXml.length > 0).toBe(true)
    }
  })
})

/**
 * SPEC-009 document-type live coverage. Each `it` builds one of the NEW FA(3)
 * document types via `buildFa3Xml` (mirroring the known-good serializer-snapshot
 * shapes in fa3.test.ts) and submits it via the token auth path, exactly like the
 * baseline VAT/KOR smoke tests above. The seller NIP is always the context NIP so
 * the document authenticates against the credential the token was issued for.
 *
 * Gated identically to `liveDescribe` (OM_KSEF_TEST_TOKEN + OM_KSEF_TEST_NIP). Each
 * test asserts only that a TERMINAL outcome is reached (accepted OR a logged
 * rejection) and logs the resolved status + KSeF number + the exact KSeF error, so a
 * 450 schema/semantic rejection surfaces as a clear, diagnosable finding rather than
 * a hang. A standalone advance/settlement (ZAL referencing nothing yet, or an OSS
 * EUR sale) can legitimately be rejected by KSeF on a business rule the minimal
 * sample does not satisfy — that is recorded, not masked.
 */
liveDescribe('KSeF TEST live smoke — SPEC-009 document types', () => {
  jest.setTimeout(180000)
  const env = resolveKsefEnvironment(process.env.OM_KSEF_ENVIRONMENT ?? 'test')
  const auth = (): KsefAuthConfig => ({ method: 'token', ksefToken: TEST_TOKEN as string, contextNip: TEST_NIP as string })
  const seller = (): Fa3Party => ({
    nip: TEST_NIP as string,
    name: 'Open Mercato Test Seller',
    countryCode: 'PL',
    addressLine1: 'ul. Testowa 1, 00-001 Warszawa',
  })

  async function submitAndLog(label: string, xml: string): Promise<void> {
    const client = new KsefClient(env)
    const result = await submitInvoiceToKsef(client, { auth: auth(), invoiceXml: xml })
    // eslint-disable-next-line no-console
    console.log(`[ksef-live] ${label} result`, {
      status: result.status,
      ksefNumber: result.ksefNumber,
      lastStatusCode: result.lastStatusCode,
      error: result.errorMessage,
      upoBytes: result.upoXml?.length,
    })
    // Auth + send must run end-to-end (sessionReference proves we got past auth and
    // opened a session); the outcome must be terminal/processing — a KSeF rejection
    // (450) is an accepted, logged finding for these new types, not a test failure.
    expect(['accepted', 'processing', 'rejected']).toContain(result.status)
    expect(result.sessionReference).toBeTruthy()
  }

  async function submitAndExpectAccepted(label: string, xml: string): Promise<void> {
    const client = new KsefClient(env)
    const result = await submitInvoiceToKsef(client, { auth: auth(), invoiceXml: xml })
    // eslint-disable-next-line no-console
    console.log(`[ksef-live] ${label} result`, {
      status: result.status,
      ksefNumber: result.ksefNumber,
      lastStatusCode: result.lastStatusCode,
      error: result.errorMessage,
      upoBytes: result.upoXml?.length,
    })
    expect(result.status).toBe('accepted')
    expect(result.sessionReference).toBeTruthy()
    if (process.env.OM_KSEF_TEST_STRICT === '1') {
      expect(result.ksefNumber).toBeTruthy()
      expect(result.upoXml && result.upoXml.length > 0).toBe(true)
    }
  }

  it('(a) ZAL — advance invoice (ZaliczkaCzesciowa + Zamowienie, no FaWiersz)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: seller(),
        buyer: { nip: '3755747347', name: 'Open Mercato Test Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
        invoiceNumber: `OM-ZAL-${Date.now()}`,
        issueDate: today,
        currencyCode: 'PLN',
        invoiceKind: 'ZAL',
        vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
        totalGross: '123.00',
        advancePayments: [{ receivedDate: today, amount: '123.00' }],
        order: {
          totalValue: '123.00',
          lines: [
            {
              lineNumber: 1,
              name: 'Zamówiona usługa',
              unit: 'szt',
              quantity: '1',
              unitNetPrice: '100.00',
              netValue: '100.00',
              vatValue: '23.00',
              vatRate: 23,
            },
          ],
        },
      },
      lines: [],
    }
    await submitAndLog('ZAL advance', buildFa3Xml(doc))
  })

  it('(b) UPR — simplified invoice (NIP-only buyer, no Nazwa/Adres)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: seller(),
        // UPR: a NIP-only Podmiot2 — Nazwa/Adres are omitted, only the NIP identity
        // (+ the mandatory trailing JST/GV flags the serializer adds) is emitted.
        buyer: { nip: '3755747347', countryCode: 'PL' },
        invoiceNumber: `OM-UPR-${Date.now()}`,
        issueDate: today,
        currencyCode: 'PLN',
        invoiceKind: 'UPR',
        vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
        totalGross: '123.00',
      },
      lines: [
        { lineNumber: 1, name: 'Usługa testowa', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
      ],
    }
    await submitAndLog('UPR simplified', buildFa3Xml(doc))
  })

  it('(c) Self-billed VAT invoice (selfBilling:true → P_17=1)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: seller(),
        buyer: { nip: '3755747347', name: 'Open Mercato Test Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
        invoiceNumber: `OM-SELF-${Date.now()}`,
        issueDate: today,
        currencyCode: 'PLN',
        invoiceKind: 'VAT',
        // Self-billing (samofakturowanie, art. 106d) — the top-level shortcut folds into
        // Adnotacje and drives P_17=1.
        selfBilling: true,
        vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
        totalGross: '123.00',
      },
      lines: [
        { lineNumber: 1, name: 'Usługa testowa (samofakturowanie)', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
      ],
    }
    await submitAndLog('self-billed VAT', buildFa3Xml(doc))
  })

  it('(d) OSS EUR — distance sale (ossRate + Procedura=WSTO_EE + KodWaluty=EUR + P_13_5/P_14_5)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: seller(),
        // OSS distance sale to a German consumer (EU VAT id, no PL NIP) — the buyer is a
        // non-PL consumer; the OSS summary rolls into the dedicated P_13_5/P_14_5 bucket.
        buyer: { euVatId: 'DE123456789', name: 'Endkunde GmbH', countryCode: 'DE', addressLine1: 'Hauptstraße 1, 10115 Berlin' },
        invoiceNumber: `OM-OSS-${Date.now()}`,
        issueDate: today,
        currencyCode: 'EUR',
        invoiceKind: 'VAT',
        vatBreakdown: [{ rate: 'oss', net: '100.00', vat: '19.00' }],
        totalGross: '119.00',
      },
      lines: [
        {
          lineNumber: 1,
          name: 'Distance sale to DE',
          unit: 'szt',
          quantity: '1',
          unitNetPrice: '100.00',
          netValue: '100.00',
          vatRate: 23,
          ossRate: '19',
          procedure: 'WSTO_EE',
          fxRate: '4.3000',
        },
      ],
    }
    await submitAndLog('OSS EUR', buildFa3Xml(doc))
  })

  it('(e) VAT invoice with a discounted line (P_10) is accepted', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: seller(),
        buyer: { nip: '3755747347', name: 'Open Mercato Test Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
        invoiceNumber: `OM-DISC-${Date.now()}`,
        issueDate: today,
        currencyCode: 'PLN',
        invoiceKind: 'VAT',
        vatBreakdown: [{ rate: 23, net: '180.00', vat: '41.40' }],
        totalGross: '221.40',
      },
      lines: [
        {
          lineNumber: 1,
          name: 'Discounted goods',
          unit: 'szt',
          quantity: '2',
          unitNetPrice: '100.00',
          discount: '20.00',
          netValue: '180.00',
          vatRate: 23,
        },
      ],
    }
    await submitAndExpectAccepted('discounted VAT', buildFa3Xml(doc))
  })

  it('(f) gross-mode VAT invoice (P_9B/P_11A) is accepted', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: seller(),
        buyer: { nip: '3755747347', name: 'Open Mercato Test Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
        invoiceNumber: `OM-GROSS-${Date.now()}`,
        issueDate: today,
        currencyCode: 'PLN',
        invoiceKind: 'VAT',
        vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
        totalGross: '123.00',
      },
      lines: [
        {
          lineNumber: 1,
          name: 'Gross-price goods',
          unit: 'szt',
          quantity: '1',
          unitNetPrice: '100.00',
          unitGrossPrice: '123.00',
          netValue: '100.00',
          grossValue: '123.00',
          vatRate: 23,
        },
      ],
    }
    await submitAndExpectAccepted('gross-mode VAT', buildFa3Xml(doc))
  })

  it('(g) used-goods VAT margin invoice (PMarzy + P_13_11) is accepted', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const doc: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: seller(),
        buyer: { nip: '3755747347', name: 'Open Mercato Test Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
        invoiceNumber: `OM-MARGIN-${Date.now()}`,
        issueDate: today,
        currencyCode: 'PLN',
        invoiceKind: 'VAT',
        annotations: { marginScheme: 'used_goods' },
        vatBreakdown: [{ rate: 'margin', net: '123.00', vat: '0.00' }],
        totalGross: '123.00',
      },
      lines: [
        {
          lineNumber: 1,
          name: 'Used goods margin sale',
          unit: 'szt',
          quantity: '1',
          unitNetPrice: '123.00',
          unitGrossPrice: '123.00',
          netValue: '123.00',
          grossValue: '123.00',
          vatRate: 23,
          marginRow: true,
        },
      ],
    }
    await submitAndExpectAccepted('used-goods margin VAT', buildFa3Xml(doc))
  })
})

certDescribe('KSeF TEST live smoke — certificate (XAdES) auth', () => {
  jest.setTimeout(120000)
  const env = resolveKsefEnvironment(process.env.OM_KSEF_ENVIRONMENT ?? 'test')

  it('submits a sample FA(3) invoice authenticated with a KSeF certificate', async () => {
    const client = new KsefClient(env)
    const auth: KsefAuthConfig = {
      method: 'certificate',
      contextNip: TEST_NIP as string,
      certificatePem: TEST_CERT_PEM as string,
      privateKeyPem: TEST_CERT_KEY as string,
    }
    const result = await submitInvoiceToKsef(client, {
      auth,
      invoiceXml: sampleInvoiceXml(TEST_NIP as string),
    })
    // eslint-disable-next-line no-console
    console.log('[ksef-live] cert-auth result', {
      status: result.status,
      ksefNumber: result.ksefNumber,
      lastStatusCode: result.lastStatusCode,
      error: result.errorMessage,
      upoBytes: result.upoXml?.length,
    })
    // Certificate auth must reach the same terminal/processing outcomes as the token
    // path (proving the XAdES challenge-signing path authenticates against the live API).
    expect(['accepted', 'processing']).toContain(result.status)
    expect(result.sessionReference).toBeTruthy()
    if (process.env.OM_KSEF_TEST_STRICT === '1') {
      expect(result.status).toBe('accepted')
      expect(result.ksefNumber).toBeTruthy()
      expect(result.upoXml && result.upoXml.length > 0).toBe(true)
    }
  })
})

/**
 * SPEC-015 F1 — inbound RECEIVE round-trip (live). Sends a SELF-ADDRESSED invoice
 * (seller NIP == buyer NIP == context NIP — the FA(3) XSD allows it and the connector's
 * seller==contextNip invariant holds), then re-authenticates and queries it as Subject2
 * (buyer) via the new session-less receive endpoints, and downloads its FA(3) XML.
 * Gated like liveDescribe (OM_KSEF_TEST_TOKEN + OM_KSEF_TEST_NIP).
 */
liveDescribe('KSeF TEST live — SPEC-015 inbound receive round-trip', () => {
  jest.setTimeout(240000)
  const env = resolveKsefEnvironment(process.env.OM_KSEF_ENVIRONMENT ?? 'test')

  it('sends a self-addressed invoice, then queries + downloads it as Subject2 (buyer)', async () => {
    const nip = TEST_NIP as string
    const client = new KsefClient(env)
    const auth: KsefAuthConfig = { method: 'token', ksefToken: TEST_TOKEN as string, contextNip: nip }
    const selfAddressed: Fa3Document = {
      model: {
        createdAt: new Date().toISOString(),
        seller: { nip, name: 'Open Mercato Self', countryCode: 'PL', addressLine1: 'ul. Testowa 1, 00-001 Warszawa' },
        buyer: { nip, name: 'Open Mercato Self', countryCode: 'PL', addressLine1: 'ul. Testowa 1, 00-001 Warszawa' },
        invoiceNumber: `OM-RECV-${Date.now()}`,
        issueDate: new Date().toISOString().slice(0, 10),
        currencyCode: 'PLN',
        vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
        totalGross: '123.00',
      },
      lines: [{ lineNumber: 1, name: 'Usługa testowa', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 }],
    }
    const sent = await submitInvoiceToKsef(client, { auth, invoiceXml: buildFa3Xml(selfAddressed) })
    // eslint-disable-next-line no-console
    console.log('[recv] self-addressed send', { status: sent.status, ksefNumber: sent.ksefNumber, error: sent.errorMessage })
    expect(sent.status).toBe('accepted')
    const ksefNumber = sent.ksefNumber as string

    // Receive is session-LESS: re-authenticate for a fresh access token.
    const certs = await client.getPublicKeyCertificates()
    const tokenCert = [...certs.filter((c) => c.usage.some((u) => u.toLowerCase().includes('token')))]
      .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0]
    const authed = await authenticate(client, tokenCert, auth, DEFAULT_POLL_OPTIONS)
    expect(authed.ok).toBe(true)
    const accessToken = (authed as { ok: true; accessToken: string }).accessToken

    const today = new Date().toISOString().slice(0, 10)
    let found: boolean = false
    for (let i = 0; i < 8 && !found; i += 1) {
      const q = await client.queryReceivedInvoices({
        accessToken,
        filters: { subjectType: 'Subject2', dateRange: { dateType: 'Invoicing', from: `${today}T00:00:00Z`, to: `${today}T23:59:59Z` } },
        pageSize: 100,
      })
      // eslint-disable-next-line no-console
      console.log('[recv] Subject2 query', { count: q.invoices.length, hasMore: q.hasMore, isTruncated: q.isTruncated })
      found = q.invoices.some((inv) => inv.ksefNumber === ksefNumber)
      if (!found) await new Promise((r) => setTimeout(r, 6000))
    }
    expect(found).toBe(true)

    const xml = await client.downloadInvoiceByKsefNumber({ accessToken, ksefNumber })
    // eslint-disable-next-line no-console
    console.log('[recv] downloaded FA(3) bytes', xml.length)
    expect(xml.length).toBeGreaterThan(0)
    expect(xml).toContain('Faktura')
  })
})
