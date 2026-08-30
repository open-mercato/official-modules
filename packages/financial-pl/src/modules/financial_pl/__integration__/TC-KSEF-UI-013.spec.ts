import { expect, test, type Page } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { login } from '@open-mercato/core/helpers/integration/auth';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';

/**
 * TC-KSEF-UI-013: an ACCEPTED invoice surfaces its accepted state in the UI.
 *
 * The end state of the "author → send to KSeF" flow: once a submission is accepted, the invoice
 * detail must show the Accepted status, its KSeF number, and the Download UPO / Download PDF
 * actions — and MUST NOT still offer "Send to KSeF". The invoices list must show the Accepted
 * status pill for the row. (The live send itself is exercised by the env-gated ksef-live tests;
 * this test asserts the accepted-state rendering deterministically, with no live KSeF.)
 *
 * The invoice + line + accepted submission are seeded via the test DB (a runtime fixture cleaned up
 * in `finally`). `admin` holds `financial_pl.*`.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const CTX_NIP = '7980332920';

type SeedIds = { invoiceId: string; lineId: string; submissionId: string; ksefNumber: string; invoiceNumber: string };

async function seedInvoice(
  scope: { organizationId: string; tenantId: string },
  submission: { status: 'accepted' | 'rejected'; ksefNumber: string | null; lastError: string | null },
): Promise<SeedIds> {
  const invoiceNumber = `OM-UI13-${suffix()}`;
  const ksefNumber = submission.ksefNumber ?? '';
  return withClient(async (client) => {
    const inv = await client.query<{ id: string }>(
      `insert into sales_invoices
         (id, organization_id, tenant_id, invoice_number, status, issue_date, due_date, currency_code,
          subtotal_net_amount, subtotal_gross_amount, tax_total_amount,
          grand_total_net_amount, grand_total_gross_amount, outstanding_amount, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, 'issued', now(), now(), 'PLN',
          100, 123, 23, 100, 123, 123, now(), now())
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
          status, context_nip, attempt_count, ksef_number, last_error_message, last_status_code, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'invoice', 'test', 'online', $4, $5, 1, $6, $7, $8, now())
       returning id`,
      [
        scope.organizationId, scope.tenantId, invoiceId, submission.status, CTX_NIP,
        submission.ksefNumber, submission.lastError, submission.status === 'accepted' ? 200 : 400,
      ],
    );
    return { invoiceId, lineId: line.rows[0].id, submissionId: sub.rows[0].id, ksefNumber, invoiceNumber };
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

async function requireContext(page: Page): Promise<void> {
  await login(page, 'admin');
}

test.describe('TC-KSEF-UI-013: accepted invoice UI state', () => {
  test('detail shows Accepted + KSeF number + downloads and hides "Send to KSeF"', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) test.skip(true, 'token does not expose orgId/tenantId for the DB fixture');
    let ids: SeedIds | null = null;
    try {
      const ksefNumber = `${CTX_NIP}-20260624-${suffix()}AAAA-BB`;
      ids = await seedInvoice({ organizationId, tenantId }, { status: 'accepted', ksefNumber, lastError: null });

      await requireContext(page);
      await page.goto(`/backend/financial/invoices/${ids.invoiceId}`, { waitUntil: 'domcontentloaded' });

      await expect(page.getByText(/accepted|przyjęta/i).first(), 'accepted status is shown').toBeVisible();
      await expect(page.getByText(ksefNumber), 'the KSeF number is shown').toBeVisible();
      await expect(
        page.getByRole('button', { name: /download (invoice )?pdf|pobierz faktur/i }),
        'the Download PDF action is offered',
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: /send to ksef|wyślij do ksef/i }),
        'an accepted invoice no longer offers "Send to KSeF"',
      ).toHaveCount(0);
    } finally {
      await cleanup(ids);
    }
  });

  test('the invoices list shows the Accepted status for the row', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    if (!organizationId || !tenantId) test.skip(true, 'token does not expose orgId/tenantId for the DB fixture');
    let ids: SeedIds | null = null;
    try {
      const ksefNumber = `${CTX_NIP}-20260624-${suffix()}AAAA-BB`;
      ids = await seedInvoice({ organizationId, tenantId }, { status: 'accepted', ksefNumber, lastError: null });

      await requireContext(page);
      // "All invoices" view avoids month-scoping the seeded row out.
      await page.goto('/backend/financial/invoices', { waitUntil: 'domcontentloaded' });
      const allTab = page.getByRole('button', { name: /all invoices|wszystkie faktury/i });
      if (await allTab.count()) await allTab.first().click();

      const row = page.getByRole('row', { name: new RegExp(ids.invoiceNumber, 'i') });
      await expect(row, 'the seeded invoice appears in the list').toBeVisible();
      await expect(row.getByText(/accepted|przyjęta/i), 'its KSeF status pill reads Accepted').toBeVisible();
    } finally {
      await cleanup(ids);
    }
  });
});
