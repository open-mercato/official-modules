import { expect, test } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { login } from '@open-mercato/core/helpers/integration/auth';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';

/**
 * TC-KSEF-UI-014: a REJECTED submission surfaces its rejected state in the UI.
 *
 * When KSeF rejects an invoice, the detail must show the Rejected status and the invoices list
 * must show the Rejected pill for the row, so the operator can act on it. Seeded via the test DB
 * (runtime fixture, cleaned up in `finally`); no live KSeF. `admin` holds `financial_pl.*`.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const CTX_NIP = '7980332920';

type SeedIds = { invoiceId: string; lineId: string; submissionId: string; invoiceNumber: string };

async function seedRejectedInvoice(scope: { organizationId: string; tenantId: string }): Promise<SeedIds> {
  const invoiceNumber = `OM-UI14-${suffix()}`;
  return withClient(async (client) => {
    const inv = await client.query<{ id: string }>(
      `insert into sales_invoices
         (id, organization_id, tenant_id, invoice_number, status, issue_date, due_date, currency_code,
          subtotal_net_amount, subtotal_gross_amount, tax_total_amount,
          grand_total_net_amount, grand_total_gross_amount, outstanding_amount, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, 'issued', now(), now(), 'PLN', 100, 123, 23, 100, 123, 123, now(), now())
       returning id`,
      [scope.organizationId, scope.tenantId, invoiceNumber],
    );
    const invoiceId = inv.rows[0].id;
    const line = await client.query<{ id: string }>(
      `insert into sales_invoice_lines
         (id, invoice_id, organization_id, tenant_id, line_number, kind, quantity, currency_code,
          unit_price_net, unit_price_gross, tax_rate, tax_amount, total_net_amount, total_gross_amount, normalized_quantity)
       values (gen_random_uuid(), $1, $2, $3, 1, 'product', 1, 'PLN', 100, 123, 23, 23, 100, 123, 1)
       returning id`,
      [invoiceId, scope.organizationId, scope.tenantId],
    );
    const sub = await client.query<{ id: string }>(
      `insert into financial_pl_ksef_submissions
         (id, organization_id, tenant_id, sales_invoice_id, document_kind, environment, mode,
          status, context_nip, attempt_count, last_error_code, last_error_message, last_status_code, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'invoice', 'test', 'online', 'rejected', $4, 1,
          '21201', 'Nieprawidłowa struktura FA(3)', 400, now())
       returning id`,
      [scope.organizationId, scope.tenantId, invoiceId, CTX_NIP],
    );
    return { invoiceId, lineId: line.rows[0].id, submissionId: sub.rows[0].id, invoiceNumber };
  });
}

async function cleanup(ids: SeedIds | null): Promise<void> {
  if (!ids) return;
  await withClient(async (client) => {
    await client.query('delete from financial_pl_ksef_submissions where id = $1', [ids.submissionId]);
    await client.query('delete from sales_invoice_lines where id = $1', [ids.lineId]);
    await client.query('delete from sales_invoices where id = $1', [ids.invoiceId]);
  }).catch(() => undefined);
}

test.describe('TC-KSEF-UI-014: rejected invoice UI state', () => {
  test('detail and list surface the Rejected status', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) test.skip(true, 'token does not expose orgId/tenantId for the DB fixture');
    let ids: SeedIds | null = null;
    try {
      ids = await seedRejectedInvoice({ organizationId, tenantId });

      await login(page, 'admin');
      await page.goto(`/backend/financial/invoices/${ids.invoiceId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(/rejected|odrzucona/i).first(), 'rejected status is shown on detail').toBeVisible();

      await page.goto('/backend/financial/invoices', { waitUntil: 'domcontentloaded' });
      const allTab = page.getByRole('button', { name: /all invoices|wszystkie faktury/i });
      if (await allTab.count()) await allTab.first().click();
      const row = page.getByRole('row', { name: new RegExp(ids.invoiceNumber, 'i') });
      await expect(row, 'the seeded invoice appears in the list').toBeVisible();
      await expect(row.getByText(/rejected|odrzucona/i), 'its KSeF status pill reads Rejected').toBeVisible();
    } finally {
      await cleanup(ids);
    }
  });
});
