import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';
import { login } from '@open-mercato/core/modules/core/__integration__/helpers/auth';

/**
 * TC-KSEF-UI-008: SPEC-017 payment fields, sale-date capture, smart due-date defaults and
 * honest line-edit safety.
 *
 * Covers the live create/edit page behavior behind /backend/financial/invoices/create and
 * /backend/financial/invoices/:id/edit:
 *   - payment method, term, bank account and sale date persist through create -> edit;
 *   - existing invoice lines are read-only on edit, while payment + due date stay editable;
 *   - due date follows issue date + payment term until the operator manually overrides it.
 *
 * Test data is authored through public APIs or the public UI flow under test and cleaned up in
 * finally blocks. If a required core/module route or local ACL is unavailable, the affected test
 * self-skips in the same style as TC-KSEF-UI-007.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const CREATE_PAGE = '/backend/financial/invoices/create';
const BANK_ACCOUNT = 'PL61109010140000071219812874';

type ApiRequestContextParam = Parameters<typeof apiRequest>[0];

async function openCreateInvoicePage(page: Page) {
  await login(page, 'admin');
  await page.goto(CREATE_PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Create invoice/i })).toBeVisible();
}

async function readCreatedId(responseLabel: string, response: APIResponse) {
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

function invoicePayload(stamp: string) {
  return {
    invoiceNumber: `OM-UI8-${stamp}`,
    currencyCode: 'PLN',
    issueDate: '2026-08-01',
    dueDate: '2026-08-08',
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    metadata: {
      buyerSnapshot: {
        companyName: `QA SPEC017 Buyer ${stamp}`,
        addressLine1: `Spec017 Street ${stamp}`,
        postalCode: '00-017',
        city: 'Warszawa',
        countryCode: 'PL',
      },
      saleDate: '2026-07-31',
      payment: {
        method: 'transfer',
        termDays: 7,
        bankAccount: BANK_ACCOUNT,
      },
    },
    lines: [
      {
        name: `QA SPEC017 Line ${stamp}`,
        quantity: 1,
        unitPriceNet: 100,
        taxRate: 23,
        currencyCode: 'PLN',
      },
    ],
  };
}

async function selectPaymentMethod(page: Page, optionName: RegExp) {
  const method = page.getByLabel('Payment method');
  await method.click();
  await page.getByRole('option', { name: optionName }).click();
  return method;
}

async function fillBuyerAndLine(page: Page, stamp: string) {
  const buyerName = `QA SPEC017 Buyer ${stamp}`;
  const buyerInput = page.getByPlaceholder('Search customers or type a name').first();
  await buyerInput.fill(buyerName);
  await buyerInput.press('Enter');
  await expect(buyerInput, 'buyer combobox accepts the manual buyer name').toHaveValue(buyerName);

  await page.locator('#financial_pl-buyer-line1').fill(`Spec017 Street ${stamp}`);
  await page.locator('#financial_pl-buyer-postal').fill('00-017');
  await page.locator('#financial_pl-buyer-city').fill('Warszawa');
  await page.locator('#financial_pl-buyer-country').fill('PL');

  await page.locator('#financial_pl-line-name-0').fill(`QA SPEC017 Line ${stamp}`);
  await page.locator('#financial_pl-line-qty-0').fill('1');
  await page.locator('#financial_pl-line-price-0').fill('100');
}

function invoiceIdFromEditUrl(page: Page): string {
  const path = new URL(page.url()).pathname;
  const match = path.match(/\/backend\/financial\/invoices\/([^/]+)\/edit$/);
  return expectId(match?.[1], 'create redirects to the new invoice edit page');
}

test.describe('TC-KSEF-UI-008: SPEC-017 payment + sale date + line-edit safety', () => {
  test('payment + sale date persist on create', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    await skipIfFinancialInvoicesUnavailable(request, token);

    let invoiceId: string | null = null;
    const stamp = suffix();

    try {
      await openCreateInvoicePage(page);
      await fillBuyerAndLine(page, stamp);

      await expect(page.getByText(/Płatność \/ Payment|Payment \/ settlement/i), 'payment section is visible').toBeVisible();
      await page.getByLabel('Issue date').fill('2026-08-02');
      await page.getByLabel(/Sale date/i).fill('2026-08-01');
      const paymentMethod = await selectPaymentMethod(page, /Bank transfer|Transfer/i);
      await expect(paymentMethod, 'payment method is set to transfer').toContainText(/Bank transfer|Transfer/i);
      await page.getByLabel(/Payment term \(days\)|Termin \(dni\)/i).fill('7');
      await page.getByLabel(/Bank account|Numer konta/i).fill(BANK_ACCOUNT);

      await Promise.all([
        page.waitForURL(/\/backend\/financial\/invoices\/[0-9a-f-]+\/edit(?:\?.*)?$/i),
        page.getByRole('button', { name: /^Create invoice$/i }).click(),
      ]);
      invoiceId = invoiceIdFromEditUrl(page);
      await expect(page.getByRole('heading', { name: /Edit invoice/i })).toBeVisible();

      await expect(page.getByLabel('Payment method'), 'saved payment method is rebound on edit').toContainText(
        /Bank transfer|Transfer/i,
      );
      await expect(page.getByLabel(/Bank account|Numer konta/i), 'saved bank account is rebound on edit').toHaveValue(
        BANK_ACCOUNT,
      );
      await expect(page.getByLabel(/Payment term \(days\)|Termin \(dni\)/i), 'saved payment term is rebound on edit').toHaveValue(
        '7',
      );
      await expect(page.getByLabel(/Sale date/i), 'saved sale date is rebound on edit').toHaveValue('2026-08-01');
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });

  test('line items are read-only on edit; payment and due date stay editable', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const stamp = suffix();
    let invoiceId: string | null = null;

    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', {
        token,
        data: invoicePayload(stamp),
      });
      if ([403, 404].includes(createRes.status())) test.skip(true, 'sales invoices API unavailable for this DB');
      expect(createRes.status(), 'admin creates a core invoice fixture').toBe(201);
      invoiceId = await readCreatedId('Invoice create', createRes);

      const detailRes = await apiRequest(
        request,
        'GET',
        `/api/financial_pl/ksef/invoices/${encodeURIComponent(invoiceId)}`,
        { token },
      );
      if ([403, 404].includes(detailRes.status())) test.skip(true, 'financial_pl invoice edit prefill unavailable for this DB');
      expect(detailRes.status(), 'financial_pl detail route is available for edit prefill').toBe(200);

      await login(page, 'admin');
      await page.goto(`/backend/financial/invoices/${encodeURIComponent(invoiceId)}/edit`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByRole('heading', { name: /Edit invoice/i })).toBeVisible();

      await expect(
        page.getByText(/^Line items can't be changed after the invoice is created/),
        'edit mode explains why invoice lines are read-only',
      ).toBeVisible();
      await expect(page.locator('#financial_pl-line-name-0'), 'line name is not editable on edit').toBeDisabled();
      await expect(page.locator('#financial_pl-line-qty-0'), 'line quantity is not editable on edit').toBeDisabled();
      await expect(page.locator('#financial_pl-line-price-0'), 'line unit price is not editable on edit').toBeDisabled();
      await expect(page.getByRole('button', { name: /Add line/i }), 'add-line control is not enabled on edit').toBeDisabled();

      const paymentMethod = page.getByLabel('Payment method');
      await expect(paymentMethod, 'payment method remains editable on edit').toBeEnabled();
      await paymentMethod.click();
      await page.getByRole('option', { name: /Cash/i }).click();
      await expect(paymentMethod, 'payment method can be changed on edit').toContainText(/Cash/i);

      const dueDate = page.getByLabel('Due date');
      await expect(dueDate, 'due date remains editable on edit').toBeEnabled();
      await dueDate.fill('2026-08-09');
      await expect(dueDate, 'due date accepts an edit').toHaveValue('2026-08-09');
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });

  test('due date derives from issue date + term and respects manual override', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    await skipIfFinancialInvoicesUnavailable(request, token);

    await openCreateInvoicePage(page);

    const dueDate = page.getByLabel('Due date');
    const initialDueDate = await dueDate.inputValue();
    expect(initialDueDate, 'create form starts with a date-shaped default due date').toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await page.getByLabel(/Payment term \(days\)|Termin \(dni\)/i).fill('7');
    await page.getByLabel('Issue date').fill('2026-08-01');
    await expect(dueDate, 'due date follows issue date + payment term while untouched').toHaveValue('2026-08-08');

    await dueDate.fill('2026-09-01');
    await expect(dueDate, 'manual due-date override is accepted').toHaveValue('2026-09-01');
    await page.getByLabel('Issue date').fill('2026-08-15');
    await expect(dueDate, 'manual due-date override is not overwritten by later issue-date edits').toHaveValue(
      '2026-09-01',
    );
  });
});
