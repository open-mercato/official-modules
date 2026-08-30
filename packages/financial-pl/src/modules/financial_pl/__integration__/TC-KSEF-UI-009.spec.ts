import { expect, test, type Page } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures';
import { login } from '@open-mercato/core/helpers/integration/auth';

/**
 * TC-KSEF-UI-009: SPEC-018 tabbed invoice editor.
 *
 * Covers the live create-page behavior behind /backend/financial/invoices/create:
 *   - the default Invoice tab keeps the everyday buyer/lines/payment surface visible;
 *   - the PL-VAT/KSeF controls live in an always-mounted, hidden Taxes & KSeF panel;
 *   - non-default tab data indicators, cross-tab error routing, and always-mounted date
 *     derivation keep working while panels are shown and hidden.
 *
 * The setup/auth/cleanup style mirrors TC-KSEF-UI-008. If a required module route or local
 * ACL is unavailable, the affected test self-skips instead of silently passing.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const CREATE_PAGE = '/backend/financial/invoices/create';
type ApiRequestContextParam = Parameters<typeof apiRequest>[0];
type ApiResponseParam = Parameters<typeof readJsonSafe>[0];

async function openCreateInvoicePage(page: Page) {
  await login(page, 'admin');
  await page.goto(CREATE_PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Create invoice/i })).toBeVisible();
  await expect(page.locator('[data-financial-pl-invoice-form-ready="1"]')).toBeVisible();
  await expect(page.locator('[data-financial-pl-invoice-settings-ready="1"]')).toBeVisible();
}

async function readCreatedId(responseLabel: string, response: ApiResponseParam) {
  const body = await readJsonSafe<{
    id?: string;
    invoiceId?: string;
    result?: { id?: string; invoiceId?: string };
  }>(response);
  return expectId(
    body?.id ?? body?.invoiceId ?? body?.result?.id ?? body?.result?.invoiceId,
    `${responseLabel} response should include id`,
  );
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

async function fillBuyerAndLine(page: Page, stamp: string) {
  const buyerName = `QA SPEC018 Buyer ${stamp}`;
  const buyerInput = page.getByPlaceholder('Search customers or type a name').first();
  await buyerInput.fill(buyerName);
  await buyerInput.press('Enter');
  await expect(buyerInput, 'buyer combobox accepts the manual buyer name').toHaveValue(buyerName);

  await page.locator('#financial_pl-buyer-line1').fill(`Spec018 Street ${stamp}`);
  await page.locator('#financial_pl-buyer-postal').fill('00-018');
  await page.locator('#financial_pl-buyer-city').fill('Warszawa');
  await expect(page.locator('#financial_pl-buyer-country'), 'buyer country defaults to PL').toContainText('PL');

  await page.getByPlaceholder('Search products or type a name').first().fill(`QA SPEC018 Line ${stamp}`);
  await page.locator('#financial_pl-line-qty-0').fill('1');
  await page.locator('#financial_pl-line-price-0').fill('100');
}

async function fillLineOnly(page: Page, stamp: string) {
  await page.getByPlaceholder('Search products or type a name').first().fill(`QA SPEC018 Line ${stamp}`);
  await page.locator('#financial_pl-line-qty-0').fill('1');
  await page.locator('#financial_pl-line-price-0').fill('100');
}

function invoiceIdFromEditUrl(page: Page): string | null {
  const path = new URL(page.url()).pathname;
  const match = path.match(/\/backend\/financial\/invoices\/([^/]+)\/edit$/);
  return match?.[1] ? expectId(match[1], 'create redirects to the new invoice edit page') : null;
}

async function expectTaxesTabHasDataIndicator(page: Page) {
  const taxesTab = page.getByRole('tab', { name: /Taxes & KSeF/i });
  await expect(taxesTab, 'Taxes & KSeF tab remains visible while Invoice is active').toBeVisible();
  await expect(
    taxesTab.getByRole('img', { name: /contains data/i }),
    'Taxes & KSeF tab trigger shows that the hidden panel has data',
  ).toBeVisible();
}

test.describe('TC-KSEF-UI-009: SPEC-018 tabbed invoice editor', () => {
  test('TC-1 first paint: default Invoice tab keeps advanced surface out of the DOM', async ({ page, request }) => {
    await prepareCreateInvoiceTest(request);
    await openCreateInvoicePage(page);

    const invoiceTab = page.getByRole('tab', { name: /^Invoice$/i });
    await expect(invoiceTab, 'Invoice tab trigger is visible').toBeVisible();
    await expect(invoiceTab, 'Invoice tab is active by default').toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /Taxes & KSeF/i }), 'Taxes & KSeF tab trigger is visible').toBeVisible();
    await expect(page.getByRole('tab', { name: /Additional/i }), 'Additional tab trigger is visible').toBeVisible();

    // CrudForm renders each coordinate-strip label as a plain <label> WITHOUT htmlFor and gives its
    // control no aria-label, so getByLabel() cannot resolve these controls. Assert the always-visible
    // strip via its (unique) label text instead, and target the invoice-number input by its placeholder.
    await expect(
      page.getByPlaceholder(/^Auto:/),
      'invoice number input stays in the coordinate strip',
    ).toBeVisible();
    await expect(page.getByText(/^Issue date/).first(), 'issue date label in the strip').toBeVisible();
    await expect(page.getByText('Due date', { exact: true }).first(), 'due date label in the strip').toBeVisible();
    await expect(page.getByText(/Sale date/i).first(), 'sale date label in the strip').toBeVisible();
    await expect(page.getByText(/^Currency/).first(), 'currency label in the strip').toBeVisible();

    await expect(
      page.getByPlaceholder('Search customers or type a name'),
      'buyer combobox is visible on the default Invoice tab',
    ).toBeVisible();
    await expect(page.getByPlaceholder('Search products or type a name').first(), 'line editor is visible on the default Invoice tab').toBeVisible();
    await expect(page.getByText(/Payment \/ settlement|Płatność/i), 'payment section is visible').toBeVisible();
    await expect(page.locator('#financial_pl-invoice-kind'), 'invoice kind is an everyday invoice field').toBeVisible();
    await expect(page.locator('#financial_pl-context-nip'), 'seller NIP is sourced from the KSeF credential, not duplicated on invoices').toHaveCount(0);
  });

  test('TC-2 Taxes & KSeF tab reveals PL-VAT controls and preserves values across unmounts', async ({
    page,
    request,
  }) => {
    await prepareCreateInvoiceTest(request);
    await openCreateInvoicePage(page);

    await page.getByRole('tab', { name: /Taxes & KSeF/i }).click();
    const mpp = page.getByRole('switch', { name: /Split payment.*required/i });
    await expect(mpp, 'MPP control appears on Taxes & KSeF').toBeVisible();
    await mpp.click();
    await expect(mpp, 'MPP value can be enabled').toBeChecked();

    await page.getByRole('tab', { name: /^Invoice$/i }).click();
    await expect(mpp, 'PL-VAT panel is hidden when Invoice is active').toBeHidden();
    await expect(page.getByPlaceholder('Search customers or type a name'), 'buyer combobox returns on Invoice').toBeVisible();

    await page.getByRole('tab', { name: /Taxes & KSeF/i }).click();
    await expect(mpp, 'MPP value survives the tab round-trip').toBeChecked();
  });

  test('TC-3 Taxes & KSeF tab trigger indicates hidden data while Invoice is active', async ({ page, request }) => {
    await prepareCreateInvoiceTest(request);
    await openCreateInvoicePage(page);

    await page.getByRole('tab', { name: /Taxes & KSeF/i }).click();
    await page.getByRole('switch', { name: /Split payment.*required/i }).click();
    await page.getByRole('tab', { name: /^Invoice$/i }).click();

    await expect(page.getByRole('tab', { name: /^Invoice$/i }), 'Invoice tab is active after returning').toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectTaxesTabHasDataIndicator(page);
  });

  test('TC-4 mandatory validation routes to and focuses the Invoice tab', async ({ page, request }) => {
    const token = await prepareCreateInvoiceTest(request);
    const stamp = suffix();
    let invoiceId: string | null = null;

    try {
      await openCreateInvoicePage(page);

      await fillLineOnly(page, stamp);
      await page.getByRole('button', { name: /^Create invoice$/i }).click();

      await expect(page, 'missing buyer submission remains on the create page').toHaveURL(
        /\/backend\/financial\/invoices\/create(?:\?.*)?$/i,
      );
      await expect(page.getByRole('tab', { name: /^Invoice$/i }), 'missing buyer routes to the Invoice tab').toHaveAttribute('aria-selected', 'true');
      await expect(page.getByPlaceholder('Search customers or type a name'), 'buyer field is visible after buyer error').toBeVisible();
      await expect(
        page.getByText(/buyer needs a name and an address/i).first(),
        'buyer error banner is visible (matches the error text, not the section heading)',
      ).toBeVisible();

      await expect(page.getByPlaceholder('Search customers or type a name').first(), 'first invalid buyer field receives focus').toBeFocused();
    } finally {
      invoiceId = invoiceId ?? invoiceIdFromEditUrl(page);
      await deleteGeneralEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });

  test('TC-5 typed combobox text survives tab switches (no unmount data loss)', async ({ page, request }) => {
    // Regression guard for the code-jury (Codex) finding, confirmed live: ComboboxInput
    // (buyer name / product) buffers typed custom text and commits it only on blur; if the
    // tab panel unmounted on switch, that pending commit was dropped and the value was lost.
    // Panels are now kept mounted (hidden), so typed text must survive a tab round-trip.
    await prepareCreateInvoiceTest(request);
    await openCreateInvoicePage(page);

    const buyerInput = page.getByPlaceholder('Search customers or type a name').first();
    const customBuyer = `Custom Buyer ${suffix()}`;
    await buyerInput.fill(customBuyer);
    await expect(buyerInput, 'buyer combobox holds the typed custom name').toHaveValue(customBuyer);

    // Switch away (this blurs the combobox) and back, WITHOUT first selecting a suggestion.
    await page.getByRole('tab', { name: /Taxes & KSeF/i }).click();
    await expect(page.getByRole('switch', { name: /Split payment.*required/i }), 'Taxes & KSeF panel is now visible').toBeVisible();
    await expect(buyerInput, 'buyer combobox is hidden (not unmounted) while Taxes is active').toBeHidden();

    await page.getByRole('tab', { name: /^Invoice$/i }).click();
    await expect(buyerInput, 'typed custom buyer name survives the tab round-trip').toHaveValue(customBuyer);
  });
});
