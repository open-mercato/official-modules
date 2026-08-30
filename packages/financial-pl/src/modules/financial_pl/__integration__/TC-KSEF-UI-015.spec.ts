import { expect, test } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { login } from '@open-mercato/core/helpers/integration/auth';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';

/**
 * TC-KSEF-UI-015: the "Send to KSeF" entry point + irreversible-action confirmation.
 *
 * An issued invoice with no active submission offers "Send to KSeF"; clicking it must open a
 * confirmation dialog (KSeF submission is an irreversible statutory filing) before anything is sent.
 * This asserts the send ENTRY POINT deterministically without contacting KSeF — the accepted/
 * rejected outcomes are covered by TC-KSEF-UI-013 / TC-KSEF-UI-014, and the live round-trip by the
 * env-gated ksef-live tests. Seeded via the test DB. `admin` holds `financial_pl.*`.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

type SeedIds = { invoiceId: string; lineId: string };

async function seedIssuedInvoice(scope: { organizationId: string; tenantId: string }): Promise<SeedIds> {
  return withClient(async (client) => {
    const inv = await client.query<{ id: string }>(
      `insert into sales_invoices
         (id, organization_id, tenant_id, invoice_number, status, issue_date, due_date, currency_code,
          subtotal_net_amount, subtotal_gross_amount, tax_total_amount,
          grand_total_net_amount, grand_total_gross_amount, outstanding_amount, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, 'issued', now(), now(), 'PLN', 100, 123, 23, 100, 123, 123, now(), now())
       returning id`,
      [scope.organizationId, scope.tenantId, `OM-UI15-${suffix()}`],
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
    return { invoiceId, lineId: line.rows[0].id };
  });
}

async function cleanup(ids: SeedIds | null): Promise<void> {
  if (!ids) return;
  await withClient(async (client) => {
    await client.query('delete from sales_invoice_lines where id = $1', [ids.lineId]);
    await client.query('delete from sales_invoices where id = $1', [ids.invoiceId]);
  }).catch(() => undefined);
}

test.describe('TC-KSEF-UI-015: send-to-KSeF entry point', () => {
  test('an issued invoice offers "Send to KSeF" and confirms before sending', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) test.skip(true, 'token does not expose orgId/tenantId for the DB fixture');
    let ids: SeedIds | null = null;
    try {
      ids = await seedIssuedInvoice({ organizationId, tenantId });

      await login(page, 'admin');
      await page.goto(`/backend/financial/invoices/${ids.invoiceId}`, { waitUntil: 'domcontentloaded' });

      const sendButton = page.getByRole('button', { name: /^send to ksef|^wyślij do ksef/i });
      await expect(sendButton, 'an issued, unsent invoice offers "Send to KSeF"').toBeVisible();
      await sendButton.click();

      // An irreversible statutory submission must confirm first — a dialog, not an immediate POST.
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
      await expect(dialog, 'a confirmation dialog opens before sending').toBeVisible();
      await expect(dialog.getByRole('button', { name: /send to ksef|wyślij do ksef/i }), 'the dialog confirms the send').toBeVisible();

      // Cancel — do not actually submit to KSeF from the test.
      const cancel = dialog.getByRole('button', { name: /cancel|anuluj/i });
      if (await cancel.count()) await cancel.first().click();
      else await page.keyboard.press('Escape');
    } finally {
      await cleanup(ids);
    }
  });
});
