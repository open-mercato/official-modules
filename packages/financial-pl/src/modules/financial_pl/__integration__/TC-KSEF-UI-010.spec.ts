import { expect, test, type Page } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';
import { login } from '@open-mercato/core/modules/core/__integration__/helpers/auth';
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures';

const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const CREATE_PAGE = '/backend/financial/invoices/create';

type ApiRequestContextParam = Parameters<typeof apiRequest>[0];
type JsonRecord = Record<string, unknown>;

type StoredLine = {
  discount_amount: string | null;
  discount_percent: string | null;
  tax_amount: string | null;
  total_net_amount: string | null;
  total_gross_amount: string | null;
};

async function openCreateInvoicePage(page: Page) {
  await login(page, 'admin');
  await page.goto(CREATE_PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Create invoice/i })).toBeVisible();
}

async function skipIfFinancialInvoicesUnavailable(request: ApiRequestContextParam, token: string) {
  const probe = await apiRequest(request, 'GET', '/api/financial_pl/ksef/invoices?pageSize=1', { token });
  if (probe.status() === 403) {
    test.skip(true, 'admin lacks financial_pl.view or sales.invoices.manage on this DB');
  }
  if (probe.status() === 404) {
    test.skip(true, 'financial_pl invoices API unavailable for this DB');
  }
  expect(probe.status(), 'financial invoices API availability probe').toBe(200);
}

async function prepareCreateInvoiceTest(request: ApiRequestContextParam) {
  const token = await getAuthToken(request, 'admin');
  getTokenContext(token);
  await skipIfFinancialInvoicesUnavailable(request, token);
  return token;
}

async function fillBuyer(page: Page, stamp: string) {
  const buyerName = `QA SPEC009 Buyer ${stamp}`;
  const buyerInput = page.getByPlaceholder('Search customers or type a name').first();
  await buyerInput.fill(buyerName);
  await buyerInput.press('Enter');
  await expect(buyerInput, 'buyer combobox accepts the manual buyer name').toHaveValue(buyerName);

  await page.locator('#financial_pl-buyer-line1').fill(`Spec009 Street ${stamp}`);
  await page.locator('#financial_pl-buyer-postal').fill('00-009');
  await page.locator('#financial_pl-buyer-city').fill('Warszawa');
  await page.locator('#financial_pl-buyer-country').fill('PL');
}

async function fillCommittedProductLine(page: Page, stamp: string) {
  const lineName = `QA SPEC009 Discount Line ${stamp}`;
  const productInput = page.getByPlaceholder('Search products or type a name').first();
  await productInput.fill(lineName);
  await productInput.press('Enter');
  await expect(page.locator('#financial_pl-line-name-0'), 'product combobox commits custom line name').toHaveValue(
    lineName,
  );

  await page.locator('#financial_pl-line-qty-0').fill('2');
  await page.locator('#financial_pl-line-price-0').fill('100');
  await page.locator('#financial_pl-line-discount-0').fill('10');
}

function invoiceIdFromEditUrl(page: Page): string | null {
  const path = new URL(page.url()).pathname;
  const match = path.match(/\/backend\/financial\/invoices\/([^/]+)\/edit$/);
  return match?.[1] ? expectId(match[1], 'create redirects to the new invoice edit page') : null;
}

function items(body: JsonRecord): JsonRecord[] {
  return Array.isArray(body.items) ? (body.items as JsonRecord[]) : [];
}

function money(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return Number.NaN;
}

function field(row: JsonRecord, snake: string, camel: string): unknown {
  return row[snake] ?? row[camel];
}

async function readStoredLine(invoiceId: string): Promise<StoredLine> {
  return withClient(async (client) => {
    const res = await client.query<StoredLine>(
      `select
         discount_amount::text,
         discount_percent::text,
         tax_amount::text,
         total_net_amount::text,
         total_gross_amount::text
       from sales_invoice_lines
       where invoice_id = $1
       order by line_number asc
       limit 1`,
      [invoiceId],
    );
    expect(res.rows.length, 'one persisted invoice line is readable from DB because no public line API exposes discounts').toBe(1);
    return res.rows[0];
  });
}

test.describe('TC-KSEF-UI-010: discounted invoice authoring', () => {
  test('rabat percent computes line totals and persists explicit line/header totals', async ({ page, request }) => {
    const token = await prepareCreateInvoiceTest(request);
    const stamp = suffix();
    let invoiceId: string | null = null;

    try {
      await openCreateInvoicePage(page);
      await fillBuyer(page, stamp);
      await fillCommittedProductLine(page, stamp);

      await expect(page.getByText(/Net:\s*180\.00\s+PLN/i), 'discounted line net is shown live').toBeVisible();
      await expect(page.getByText(/Total discount:\s*20\.00\s+PLN/i), 'discount total is shown live').toBeVisible();

      await page.getByRole('button', { name: /^Create invoice$/i }).click();
      await expect(page, 'create redirects to edit page').toHaveURL(
        /\/backend\/financial\/invoices\/[0-9a-f-]+\/edit(?:\?.*)?$/i,
      );
      invoiceId = invoiceIdFromEditUrl(page);
      expect(invoiceId, 'created invoice id is present in the edit URL').toBeTruthy();

      const line = await readStoredLine(invoiceId as string);
      expect(money(line.discount_percent), 'stored line discountPercent').toBeCloseTo(10, 2);
      expect(money(line.discount_amount), 'stored line discountAmount').toBeCloseTo(20, 2);
      expect(money(line.total_net_amount), 'stored line totalNetAmount').toBeCloseTo(180, 2);
      expect(money(line.tax_amount), 'stored line taxAmount').toBeCloseTo(41.4, 2);
      expect(money(line.total_gross_amount), 'stored line totalGrossAmount').toBeCloseTo(221.4, 2);

      const coreRead = await apiRequest(
        request,
        'GET',
        `/api/sales/invoices?id=${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      expect(coreRead.status(), 'core invoice read succeeds').toBe(200);
      const body = (await readJsonSafe<JsonRecord>(coreRead)) ?? {};
      const row = items(body).find((item) => item.id === invoiceId);
      expect(row, 'created invoice is present in the core read').toBeTruthy();
      const invoice = row as JsonRecord;
      expect(money(field(invoice, 'grand_total_net_amount', 'grandTotalNetAmount')), 'header grandTotalNetAmount').toBeCloseTo(180, 2);
      expect(money(field(invoice, 'tax_total_amount', 'taxTotalAmount')), 'header taxTotalAmount').toBeCloseTo(41.4, 2);
      expect(money(field(invoice, 'grand_total_gross_amount', 'grandTotalGrossAmount')), 'header grandTotalGrossAmount').toBeCloseTo(221.4, 2);
      expect(money(field(invoice, 'discount_total_amount', 'discountTotalAmount')), 'header discountTotalAmount').toBeCloseTo(20, 2);
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
