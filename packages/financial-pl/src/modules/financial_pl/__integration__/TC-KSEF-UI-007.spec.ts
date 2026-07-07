import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures';
import { login } from '@open-mercato/core/helpers/integration/auth';

/**
 * TC-KSEF-UI-007: SPEC-016 invoice-editor IA + customer/product picker flows.
 *
 * Covers the live create-page behavior behind /backend/financial/invoices/create:
 *   - the advanced VAT/KSeF/JPK accordion is closed by default and JPK controls are not visible;
 *   - selecting a catalog product fills the line name + unit while preserving the current net price
 *     when the product's resolved price is in a different currency than the invoice;
 *   - selecting a customer company fills the buyer address fields while leaving NIP empty;
 *   - empty optional customers/catalog lists degrade to free-text entry without client errors.
 *
 * Test data is authored through public APIs and cleaned up in finally blocks. If an optional core
 * module is unavailable or the local role ACLs are unsynced, the affected picker test self-skips.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const CREATE_PAGE = '/backend/financial/invoices/create';
const USD_NET_PRICE = '49.99';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openCreateInvoicePage(page: Page) {
  await login(page, 'admin');
  await page.goto(CREATE_PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Create invoice/i })).toBeVisible();
}

async function readCreatedId(responseLabel: string, response: APIResponse) {
  const body = await readJsonSafe<{ id?: string; result?: { id?: string } }>(response);
  return expectId(body?.id ?? body?.result?.id, `${responseLabel} response should include id`);
}

test.describe('TC-KSEF-UI-007: SPEC-016 invoice editor picker flows', () => {
  test('keeps VAT, KSeF & JPK details collapsed until expanded', async ({ page }) => {
    await openCreateInvoicePage(page);

    const advanced = page.getByRole('button', { name: /VAT, KSeF & JPK details \(advanced\)/i });
    const gtuFilter = page.getByLabel('Filter GTU codes');
    const procedureFilter = page.getByLabel('Filter procedure markings');

    await expect(advanced, 'advanced VAT/KSeF/JPK accordion is present').toBeVisible();
    await expect(advanced, 'advanced VAT/KSeF/JPK accordion starts collapsed').toHaveAttribute('aria-expanded', 'false');
    await expect(gtuFilter, 'GTU controls are hidden from the default editor surface').toBeHidden();
    await expect(procedureFilter, 'procedure controls are hidden from the default editor surface').toBeHidden();

    await advanced.click();
    await expect(advanced, 'advanced VAT/KSeF/JPK accordion expands').toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByLabel('Taxpayer NIP'), 'core PL-VAT fields are revealed by the advanced accordion').toBeVisible();

    const jpkMarkings = page.getByRole('button', { name: /JPK markings/i });
    await expect(jpkMarkings, 'JPK markings are reachable from the expanded advanced area').toBeVisible();
    await jpkMarkings.click();
    await expect(gtuFilter, 'expanding JPK markings reveals GTU controls').toBeVisible();
    await expect(procedureFilter, 'expanding JPK markings reveals procedure controls').toBeVisible();
  });

  test('selecting a catalog product fills name and unit without cross-currency price fill', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const stamp = suffix();
    const productTitle = `QA SPEC016 USD Product ${stamp}`;
    const productSku = `SPEC016-USD-${stamp}`;
    const priceKindCode = `spec016_usd_${stamp.toLowerCase()}`;
    let productId: string | null = null;
    let priceKindId: string | null = null;
    let priceId: string | null = null;

    try {
      const productRes = await apiRequest(request, 'POST', '/api/catalog/products', {
        token,
        data: {
          title: productTitle,
          sku: productSku,
          description: 'SPEC-016 product picker integration fixture.',
          defaultUnit: 'kg',
          defaultSalesUnit: 'kg',
          taxRate: 8,
          primaryCurrencyCode: 'USD',
        },
      });
      if ([403, 404].includes(productRes.status())) test.skip(true, 'catalog products API unavailable for this DB');
      expect(productRes.status(), 'admin creates a catalog product fixture').toBe(201);
      productId = await readCreatedId('Product create', productRes);

      const priceKindRes = await apiRequest(request, 'POST', '/api/catalog/price-kinds', {
        token,
        data: {
          title: `SPEC-016 USD ${stamp}`,
          code: priceKindCode,
          displayMode: 'excluding-tax',
          currencyCode: 'USD',
        },
      });
      if ([403, 404].includes(priceKindRes.status())) test.skip(true, 'catalog pricing setup unavailable for this DB');
      expect(priceKindRes.status(), 'admin creates a USD price kind fixture').toBe(201);
      priceKindId = await readCreatedId('Price kind create', priceKindRes);

      const priceRes = await apiRequest(request, 'POST', '/api/catalog/prices', {
        token,
        data: {
          productId,
          priceKindId,
          currencyCode: 'USD',
          minQuantity: 1,
          unitPriceNet: USD_NET_PRICE,
          unitPriceGross: '61.49',
          taxRate: 8,
        },
      });
      if ([403, 404].includes(priceRes.status())) test.skip(true, 'catalog price setup unavailable for this DB');
      expect(priceRes.status(), 'admin creates a USD product price fixture').toBe(201);
      priceId = await readCreatedId('Price create', priceRes);

      await openCreateInvoicePage(page);
      await page.getByLabel('Currency').fill('PLN');

      const productInput = page.getByPlaceholder('Search products or type a name').first();
      const lineName = page.locator('#financial_pl-line-name-0');
      const lineUnit = page.locator('#financial_pl-line-unit-0');
      const linePrice = page.locator('#financial_pl-line-price-0');
      const initialPrice = await linePrice.inputValue();

      await productInput.fill(productTitle);
      const suggestion = page.getByRole('button', { name: new RegExp(escapeRegExp(productTitle)) }).first();
      await expect(suggestion, 'created catalog product appears in the product picker').toBeVisible();
      await suggestion.click();

      await expect(lineName, 'selecting a product fills the line name').toHaveValue(productTitle);
      await expect(lineUnit, 'selecting a product fills the default unit').toContainText('kg');
      await expect(linePrice, 'foreign-currency product pricing must not overwrite the invoice net price').toHaveValue(initialPrice);
      expect(Number.parseFloat((await linePrice.inputValue()) || '0'), 'USD net price is not imported into a PLN invoice').not.toBeCloseTo(
        Number.parseFloat(USD_NET_PRICE),
        2,
      );
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/catalog/prices', priceId);
      await deleteGeneralEntityIfExists(request, token, '/api/catalog/products', productId);
      await deleteGeneralEntityIfExists(request, token, '/api/catalog/price-kinds', priceKindId);
    }
  });

  test('selecting a customer company fills buyer address but leaves NIP empty', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const stamp = suffix();
    const companyName = `QA SPEC016 Buyer ${stamp}`;
    const addressLine1 = `Spec016 Street ${stamp}`;
    const city = `SpecCity${stamp}`;
    const postalCode = '00-016';
    let companyId: string | null = null;
    let addressId: string | null = null;

    try {
      const companyRes = await apiRequest(request, 'POST', '/api/customers/companies', {
        token,
        data: { displayName: companyName },
      });
      if ([403, 404].includes(companyRes.status())) test.skip(true, 'customers companies API unavailable for this DB');
      expect(companyRes.status(), 'admin creates a customer company fixture').toBe(201);
      companyId = await readCreatedId('Company create', companyRes);

      const addressRes = await apiRequest(request, 'POST', '/api/customers/addresses', {
        token,
        data: {
          entityId: companyId,
          name: 'Primary',
          purpose: 'Billing',
          addressLine1,
          city,
          postalCode,
          country: 'PL',
          isPrimary: true,
        },
      });
      if ([403, 404].includes(addressRes.status())) test.skip(true, 'customers addresses API unavailable for this DB');
      expect(addressRes.status(), 'admin creates a primary customer address fixture').toBe(201);
      addressId = await readCreatedId('Address create', addressRes);

      await openCreateInvoicePage(page);

      const buyerInput = page.getByPlaceholder('Search customers or type a name').first();
      await buyerInput.fill(companyName);
      const suggestion = page.getByRole('button', { name: new RegExp(escapeRegExp(companyName)) }).first();
      await expect(suggestion, 'created company appears in the buyer picker').toBeVisible();
      await suggestion.click();

      await expect(buyerInput, 'selecting a company keeps the buyer name visible').toHaveValue(companyName);
      await expect(page.locator('#financial_pl-buyer-line1'), 'customer primary address line is filled').toHaveValue(addressLine1);
      await expect(page.locator('#financial_pl-buyer-city'), 'customer primary address city is filled').toHaveValue(city);
      await expect(page.locator('#financial_pl-buyer-postal'), 'customer primary address postal code is filled').toHaveValue(postalCode);
      await expect(page.locator('#financial_pl-buyer-country'), 'customer primary address country is filled').toHaveValue('PL');
      await expect(page.locator('#financial_pl-buyer-nip'), 'NIP is not copied from the customer record').toHaveValue('');
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/customers/addresses', addressId);
      await deleteGeneralEntityIfExists(request, token, '/api/customers/companies', companyId);
    }
  });

  test('empty customer and catalog lists still allow free-text buyer and product entry', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await login(page, 'admin');
    await page.route('**/api/customers/companies**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/catalog/products**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
        return;
      }
      await route.continue();
    });

    await page.goto(CREATE_PAGE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Create invoice/i })).toBeVisible();

    const buyerInput = page.getByPlaceholder('Search customers or type a name').first();
    await buyerInput.fill('Manual SPEC016 Buyer');
    await buyerInput.press('Enter');
    await expect(buyerInput, 'buyer combobox accepts free text when customers list is empty').toHaveValue('Manual SPEC016 Buyer');

    const productInput = page.getByPlaceholder('Search products or type a name').first();
    await productInput.fill('Manual SPEC016 Product');
    await productInput.press('Enter');
    await expect(page.locator('#financial_pl-line-name-0'), 'product combobox accepts free text when catalog list is empty').toHaveValue(
      'Manual SPEC016 Product',
    );

    await expect(page.getByText(/Application error|Something went wrong/i)).toHaveCount(0);
    expect(pageErrors, 'empty optional picker lists should not throw a client-side exception').toEqual([]);
  });
});
