import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures';
import {
  createOrganizationInDb,
  deleteIntegrationCredentialsInDb,
  deleteOrganizationInDb,
  withClient,
} from '@open-mercato/core/helpers/integration/dbFixtures';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-KSEF-001: KSeF submission API — queue + list + auth gate.
 * Covers: POST/GET /api/financial_pl/ksef/submissions, org/tenant scoping, RBAC.
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the
 * test env (yarn official-modules add financial-pl).
 * The async send to KSeF is performed by a subscriber and is NOT asserted here
 * (it requires the external Ministry of Finance TEST API + credentials); this
 * test verifies the HTTP queueing/listing/authorization contract only.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function samplePayload(salesInvoiceId: string) {
  return {
    salesInvoiceId,
    contextNip: '7980332920',
    environment: 'test',
    invoice: {
      invoiceNumber: `OM-${suffix()}`,
      issueDate: '2026-06-22',
      currencyCode: 'PLN',
      seller: { nip: '7980332920', name: 'QA Seller', countryCode: 'PL', addressLine1: 'ul. Testowa 1, 00-001 Warszawa' },
      buyer: { nip: '3755747347', name: 'QA Buyer', countryCode: 'PL', addressLine1: 'ul. Kliencka 2, 00-002 Kraków' },
      vatBreakdown: [{ rate: 23, net: '100.00', vat: '23.00' }],
      totalGross: '123.00',
      lines: [
        { lineNumber: 1, name: 'Usługa testowa', unit: 'szt', quantity: '1', unitNetPrice: '100.00', netValue: '100.00', vatRate: 23 },
      ],
    },
  };
}

test.describe('TC-KSEF-001: KSeF submission API', () => {
  test('queues a submission and lists it (org/tenant scoped)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const { tenantId } = getTokenContext(token);
    if (!tenantId) test.skip(true, 'token does not expose tenantId for the isolated organization fixture');
    const organizationId = await createOrganizationInDb({ name: `KSeF queue QA ${suffix()}`, tenantId });
    const salesInvoiceId = randomUUID();

    try {
      const createRes = await apiRequestWithSelectedOrg(request, 'POST', '/api/financial_pl/ksef/submissions', {
        token,
        selectedOrgId: organizationId,
        data: samplePayload(salesInvoiceId),
      });
      expect(createRes.status(), 'queue returns 202').toBe(202);
      const submissionId = ((await createRes.json()) as { submissionId?: string }).submissionId ?? null;
      expect(submissionId).toBeTruthy();

      const listRes = await apiRequestWithSelectedOrg(
        request,
        'GET',
        `/api/financial_pl/ksef/submissions?salesInvoiceId=${encodeURIComponent(salesInvoiceId)}`,
        { token, selectedOrgId: organizationId },
      );
      expect(listRes.status()).toBe(200);
      const body = (await listRes.json()) as { items?: Array<Record<string, unknown>> };
      const found = (body.items ?? []).find((row) => row.id === submissionId);
      expect(found, 'queued submission appears in the scoped list').toBeTruthy();
      expect(found?.salesInvoiceId).toBe(salesInvoiceId);
    } finally {
      await withClient(async (client) => {
        await client.query('delete from financial_pl_ksef_submissions where organization_id = $1', [organizationId]);
      });
      await deleteIntegrationCredentialsInDb(organizationId);
      await deleteOrganizationInDb(organizationId);
    }
  });

  test('rejects validation errors and unauthenticated reads', async ({ request }) => {
    // Login sets a session cookie on Playwright's request context. Exercise the
    // anonymous boundary before minting a token so this really is unauthenticated.
    const anonRes = await request.get('/api/financial_pl/ksef/submissions');
    expect(anonRes.status(), 'unauthenticated read is rejected').toBe(401);

    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions', {
      token,
      data: { salesInvoiceId: 'not-a-uuid', contextNip: '123' },
    });
    expect(badRes.status(), 'invalid payload returns 400').toBe(400);
  });
});
