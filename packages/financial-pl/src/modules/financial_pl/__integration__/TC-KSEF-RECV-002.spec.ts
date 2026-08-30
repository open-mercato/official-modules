import { expect, test } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { login } from '@open-mercato/core/helpers/integration/auth';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';

/**
 * TC-KSEF-RECV-002: the Received invoices page lists inbound KSeF invoices and offers Sync.
 *
 * Seeds a received-invoice row via the test DB (only the plaintext display columns; fa3_xml is
 * encrypted-at-rest and left null) and asserts the "Faktury otrzymane" grid renders it and exposes
 * the Sync action. No live KSeF. `admin` holds `financial_pl.*`.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const CTX_NIP = '7980332920';

type SeedIds = { id: string; ksefNumber: string; issuerName: string };

async function seedReceivedInvoice(scope: { organizationId: string; tenantId: string }): Promise<SeedIds> {
  const ksefNumber = `1234567890-20260615-${suffix()}A1B2-44`;
  const issuerName = `Dostawca ${suffix()} Sp. z o.o.`;
  return withClient(async (client) => {
    const res = await client.query<{ id: string }>(
      `insert into financial_pl_received_invoice
         (id, organization_id, tenant_id, context_nip, ksef_number, issuer_nip, issuer_name,
          buyer_identifier_type, buyer_identifier_value, issue_date, acquisition_date,
          invoice_type, currency, net_amount, gross_amount, vat_amount, fetched_at, created_at)
       values (gen_random_uuid(), $1, $2, $3, $4, '1234567890', $5,
          'onip', $3, date '2026-06-15', date '2026-06-16', 'VAT', 'PLN', '1000.00', '1230.00', '230.00', now(), now())
       returning id`,
      [scope.organizationId, scope.tenantId, CTX_NIP, ksefNumber, issuerName],
    );
    return { id: res.rows[0].id, ksefNumber, issuerName };
  });
}

async function cleanup(ids: SeedIds | null): Promise<void> {
  if (!ids) return;
  await withClient(async (client) => {
    await client.query('delete from financial_pl_received_invoice where id = $1', [ids.id]);
  }).catch(() => undefined);
}

test.describe('TC-KSEF-RECV-002: received invoices list + sync', () => {
  test('lists a seeded received invoice and exposes the Sync action', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) test.skip(true, 'token does not expose orgId/tenantId for the DB fixture');
    let ids: SeedIds | null = null;
    try {
      ids = await seedReceivedInvoice({ organizationId, tenantId });

      await login(page, 'admin');
      await page.goto('/backend/financial/received', { waitUntil: 'domcontentloaded' });

      await expect(page.getByText(ids.issuerName), 'the seeded issuer appears in the list').toBeVisible();
      await expect(
        page.getByRole('button', { name: /^sync$|synchronizuj/i }).first(),
        'the Sync action is offered',
      ).toBeVisible();
    } finally {
      await cleanup(ids);
    }
  });
});
