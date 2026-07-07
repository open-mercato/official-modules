import { expect, test, type Page } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures';
import { login } from '@open-mercato/core/helpers/integration/auth';

const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const CREATE_PAGE = '/backend/financial/invoices/create';

type ApiRequestContextParam = Parameters<typeof apiRequest>[0];
type MetaBody = {
  item?: {
    marginScheme?: string | null;
    marginVatRate?: number | null;
    procedureMarkings?: Record<string, boolean>;
  } | null;
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
  const buyerName = `QA SPEC009 Margin Buyer ${stamp}`;
  const buyerInput = page.getByPlaceholder('Search customers or type a name').first();
  await buyerInput.fill(buyerName);
  await buyerInput.press('Enter');
  await expect(buyerInput, 'buyer combobox accepts the manual buyer name').toHaveValue(buyerName);

  await page.locator('#financial_pl-buyer-line1').fill(`Spec009 Margin Street ${stamp}`);
  await page.locator('#financial_pl-buyer-postal').fill('00-011');
  await page.locator('#financial_pl-buyer-city').fill('Warszawa');
  await page.locator('#financial_pl-buyer-country').fill('PL');
}

async function fillCommittedProductLine(page: Page, stamp: string) {
  const lineName = `QA SPEC009 Gross Margin Line ${stamp}`;
  const productInput = page.getByPlaceholder('Search products or type a name').first();
  await productInput.fill(lineName);
  await productInput.press('Enter');
  await expect(page.locator('#financial_pl-line-name-0'), 'product combobox commits custom line name').toHaveValue(
    lineName,
  );
  await page.locator('#financial_pl-line-qty-0').fill('1');
}

async function selectUsedGoodsMargin(page: Page) {
  await page.getByRole('tab', { name: /Taxes & KSeF/i }).click();
  const jpkAccordion = page.getByRole('button', { name: /JPK markings/i }).first();
  if ((await jpkAccordion.getAttribute('aria-expanded')) !== 'true') {
    await jpkAccordion.click();
  }
  await expect(page.locator('#financial_pl-margin-scheme'), 'margin scheme select is visible').toBeVisible();
  await page.locator('#financial_pl-margin-scheme').click();
  const usedGoodsOption = page.getByRole('option', { name: /second-hand goods/i });
  if ((await usedGoodsOption.count()) > 0) {
    await usedGoodsOption.first().click();
  } else {
    await page.getByText('second-hand goods', { exact: true }).click();
  }
}

function invoiceIdFromEditUrl(page: Page): string | null {
  const path = new URL(page.url()).pathname;
  const match = path.match(/\/backend\/financial\/invoices\/([^/]+)\/edit$/);
  return match?.[1] ? expectId(match[1], 'create redirects to the new invoice edit page') : null;
}

test.describe('TC-KSEF-UI-011: gross-mode and VAT marża lock', () => {
  test('brutto entry derives net, margin scheme locks gross mode, and MR_UZ persists', async ({ page, request }) => {
    const token = await prepareCreateInvoiceTest(request);
    const stamp = suffix();
    let invoiceId: string | null = null;

    try {
      await openCreateInvoicePage(page);
      await fillBuyer(page, stamp);
      await fillCommittedProductLine(page, stamp);

      await page.getByRole('button', { name: /^gross$/i }).click();
      await expect(page.getByRole('button', { name: /^gross$/i }), 'gross mode is selected').toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.locator('#financial_pl-line-price-0').fill('123.00');
      await expect(page.getByText(/Net:\s*100\.00\s+PLN/i), 'gross 123 at 23% derives net 100').toBeVisible();

      await selectUsedGoodsMargin(page);
      await page.getByRole('tab', { name: /^Invoice$/i }).click();
      await expect(page.getByRole('button', { name: /^gross$/i }), 'gross mode remains selected under margin').toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByRole('button', { name: /^net$/i }), 'margin mode locks the net toggle').toBeDisabled();
      await expect(page.getByText(/VAT:\s*margin/i), 'VAT display switches to margin label').toBeVisible();

      await page.getByRole('button', { name: /^Create invoice$/i }).click();
      await expect(page, 'create redirects to edit page').toHaveURL(
        /\/backend\/financial\/invoices\/[0-9a-f-]+\/edit(?:\?.*)?$/i,
      );
      invoiceId = invoiceIdFromEditUrl(page);
      expect(invoiceId, 'created invoice id is present in the edit URL').toBeTruthy();

      const metaRes = await apiRequest(
        request,
        'GET',
        `/api/financial_pl/ksef/invoice-meta?salesInvoiceId=${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      expect(metaRes.status(), 'invoice meta read succeeds').toBe(200);
      const metaBody = await readJsonSafe<MetaBody>(metaRes);
      expect(metaBody?.item?.marginScheme, 'used-goods margin scheme persisted').toBe('used_goods');
      expect(metaBody?.item?.marginVatRate, 'margin VAT rate defaults to 23').toBe(23);
      expect(metaBody?.item?.procedureMarkings?.MR_UZ, 'used-goods margin auto-sets MR_UZ').toBe(true);
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
