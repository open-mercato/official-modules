import { expect, test } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { login } from '@open-mercato/core/helpers/integration/auth';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';

/**
 * TC-KSEF-UI-012: correction (KOR) authoring — net/gross price-mode toggle regression.
 *
 * The Faktura detail page of a KSeF-accepted invoice opens CorrectionForm in a dialog on demand.
 * It reuses <InvoiceLinesField>, including the net/gross ("netto"/"brutto") segmented toggle.
 * This guards both the on-demand UX and the controlled toggle wiring.
 *
 * The invoice + line + accepted submission are seeded directly via the test DB (a runtime fixture,
 * cleaned up in `finally`) so the test does not depend on the core `/api/sales/invoices` authoring
 * path — it exercises only the correction UI. `admin` holds `financial_pl.*`.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const CTX_NIP = '7980332920';

type SeedIds = { invoiceId: string; lineId: string; submissionId: string };

/** Seed an ACCEPTED invoice (header + one line + accepted KsefSubmission) for the correction UI. */
async function seedAcceptedInvoice(scope: { organizationId: string; tenantId: string }): Promise<SeedIds> {
  return withClient(async (client) => {
    const inv = await client.query<{ id: string }>(
      `insert into sales_invoices
         (id, organization_id, tenant_id, invoice_number, status, issue_date, due_date, currency_code,
          subtotal_net_amount, subtotal_gross_amount, tax_total_amount,
          grand_total_net_amount, grand_total_gross_amount, outstanding_amount, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, 'issued', now(), now(), 'PLN',
          100, 123, 23, 100, 123, 123, now(), now())
       returning id`,
      [scope.organizationId, scope.tenantId, `OM-UI12-${suffix()}`],
    );
    const invoiceId = inv.rows[0].id;
    const line = await client.query<{ id: string }>(
      `insert into sales_invoice_lines
         (id, invoice_id, organization_id, tenant_id, line_number, kind, quantity, currency_code,
          unit_price_net, unit_price_gross, tax_rate, tax_amount, total_net_amount, total_gross_amount,
          normalized_quantity)
       values (gen_random_uuid(), $1, $2, $3, 1, 'product', 1, 'PLN', 100, 123, 23, 23, 100, 123, 1)
       returning id`,
      [invoiceId, scope.organizationId, scope.tenantId],
    );
    const sub = await client.query<{ id: string }>(
      `insert into financial_pl_ksef_submissions
         (id, organization_id, tenant_id, sales_invoice_id, document_kind, environment, mode,
          status, context_nip, attempt_count, ksef_number, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'invoice', 'test', 'online', 'accepted', $4, 1, $5, now())
       returning id`,
      [scope.organizationId, scope.tenantId, invoiceId, CTX_NIP, `${CTX_NIP}-20260624-${suffix()}AAAA-BB`],
    );
    return { invoiceId, lineId: line.rows[0].id, submissionId: sub.rows[0].id };
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

test.describe('TC-KSEF-UI-012: correction (KOR) net/gross price-mode toggle', () => {
  test('the net/gross toggle in the correction form switches the active price mode', async ({ page, request }) => {
      const token = await getAuthToken(request, 'admin');
      const { organizationId, tenantId } = getTokenContext(token);
      if (!organizationId || !tenantId) {
        test.skip(true, 'token does not expose orgId/tenantId for the DB fixture');
      }
      let ids: SeedIds | null = null;
      try {
        ids = await seedAcceptedInvoice({ organizationId, tenantId });

        await login(page, 'admin');
        await page.goto(`/backend/financial/invoices/${ids.invoiceId}`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: /issue correction|wystaw korekt/i }).click();

        // The correction dialog exposes the segmented control as an accessible radio group.
        const priceGroup = page.getByRole('radiogroup', { name: /enter prices as|wprowadzaj ceny jako/i });
        await expect(priceGroup, 'the correction form renders the net/gross toggle').toBeVisible();

        const grossOption = priceGroup.getByRole('radio', { name: /gross|brutto/i });
        await expect(grossOption, 'there is an inactive gross option to switch to').not.toBeChecked();
        await grossOption.click();

        // A controlled toggle flips synchronously; fail at the control rather than
        // consuming the complete spec timeout if its wiring regresses.
        await expect(grossOption, 'the gross option becomes active after clicking it').toBeChecked({ timeout: 3000 });
      } finally {
        await cleanup(ids);
      }
    });
});
