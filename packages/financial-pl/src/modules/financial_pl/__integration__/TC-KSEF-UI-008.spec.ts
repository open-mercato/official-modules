import { randomUUID } from 'node:crypto';
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
type BankAccountSetting = {
  id: string;
  label?: string | null;
  accountNumber: string;
  bankName?: string | null;
  swift?: string | null;
  isDefault?: boolean;
};

async function openCreateInvoicePage(page: Page) {
  await login(page, 'admin');
  await page.goto(CREATE_PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Create invoice/i })).toBeVisible();
  await expect(page.locator('[data-financial-pl-invoice-form-ready="1"]')).toBeVisible();
  await expect(page.locator('[data-financial-pl-invoice-settings-ready="1"]')).toBeVisible();
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

const datePickerIndex = { issue: 0, sale: 1, due: 2 } as const;

function datePicker(page: Page, field: keyof typeof datePickerIndex) {
  return page.locator('[data-slot="date-picker-trigger"]').nth(datePickerIndex[field]);
}

function displayedDate(isoDate: string) {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function uniquePolishIban() {
  const suffix = String(Date.now()).slice(-6);
  const domesticBody = `${BANK_ACCOUNT.slice(4, -6)}${suffix}`;
  const checksum = String(98n - (BigInt(`${domesticBody}252100`) % 97n)).padStart(2, '0');
  return `PL${checksum}${domesticBody}`;
}

async function setDatePicker(page: Page, field: keyof typeof datePickerIndex, isoDate: string) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
  await datePicker(page, field).click();
  const dialog = page.locator('[role="dialog"]:visible').last();
  const dayButton = dialog.getByRole('button', {
    name: new RegExp(`${monthName} ${day}(?:st|nd|rd|th), ${year}$`, 'i'),
  });
  // The controlled DatePicker replaces its calendar cell once the draft date changes. Force skips
  // Playwright's stability wait but still awaits the real React click handler and state commit.
  await dayButton.click({ force: true });
  await page.getByRole('button', { name: /^Apply$/i }).last().click({ force: true });
  await expect(datePicker(page, field)).toContainText(displayedDate(isoDate));
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
  await expect(page.locator('#financial_pl-buyer-country'), 'buyer country defaults to PL').toContainText('PL');

  await page.getByPlaceholder('Search products or type a name').first().fill(`QA SPEC017 Line ${stamp}`);
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
    test.slow();
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    await skipIfFinancialInvoicesUnavailable(request, token);

    let invoiceId: string | null = null;
    const stamp = suffix();
    let originalAccounts: BankAccountSetting[] = [];

    try {
      const settingsRes = await apiRequest(request, 'GET', '/api/financial_pl/invoice-settings', { token });
      expect(settingsRes.status(), 'invoice settings can be read for the payment fixture').toBe(200);
      const settingsBody = await readJsonSafe<{ settings?: { bankAccounts?: BankAccountSetting[] } }>(settingsRes);
      originalAccounts = settingsBody?.settings?.bankAccounts ?? [];
      const accountLabel = `QA SPEC017 Account ${stamp}`;
      const accountNumber = uniquePolishIban();
      const fixtureAccount: BankAccountSetting = {
        id: randomUUID(),
        label: accountLabel,
        accountNumber,
        bankName: 'Santander Bank Polska',
        swift: 'WBKPPLPP',
        isDefault: originalAccounts.length === 0,
      };
      const saveSettings = await apiRequest(request, 'PUT', '/api/financial_pl/invoice-settings', {
        token,
        data: { bankAccounts: [...originalAccounts, fixtureAccount] },
      });
      expect(saveSettings.status(), 'bank account fixture is configured').toBe(200);

      await openCreateInvoicePage(page);
      await fillBuyerAndLine(page, stamp);

      await expect(page.getByText(/Płatność \/ Payment|Payment \/ settlement/i), 'payment section is visible').toBeVisible();
      await setDatePicker(page, 'issue', '2026-08-01');
      await expect(datePicker(page, 'sale'), 'untouched sale date follows the issue date').toContainText('01.08.2026');
      await page.getByRole('button', { name: /^7 days$/i }).click();
      const paymentMethod = await selectPaymentMethod(page, /Bank transfer|Transfer/i);
      await expect(paymentMethod, 'payment method is set to transfer').toContainText(/Bank transfer|Transfer/i);
      await page.locator('#financial_pl-payment-account-pick').click();
      await page.getByRole('option', { name: accountLabel }).click();
      await expect(page.locator('#financial_pl-payment-account-pick')).toContainText(accountLabel);

      await Promise.all([
        page.waitForURL(/\/backend\/financial\/invoices\/[0-9a-f-]+\/edit(?:\?.*)?$/i),
        page.getByRole('button', { name: /^Create invoice$/i }).click(),
      ]);
      invoiceId = invoiceIdFromEditUrl(page);
      await expect(page.getByRole('heading', { name: /Edit invoice/i })).toBeVisible();
      await expect(page.locator('[data-financial-pl-invoice-form-ready="1"]')).toBeVisible();

      await expect(page.getByLabel('Payment method'), 'saved payment method is rebound on edit').toContainText(
        /Bank transfer|Transfer/i,
      );
      await expect(page.locator('#financial_pl-payment-account-pick'), 'saved bank account is rebound on edit').toContainText(
        accountLabel,
      );
      await expect(datePicker(page, 'due'), 'saved seven-day term is reflected in the due date').toContainText('08.08.2026');
      await expect(datePicker(page, 'sale'), 'saved sale date is rebound on edit').toContainText('01.08.2026');
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
      await apiRequest(request, 'PUT', '/api/financial_pl/invoice-settings', {
        token,
        data: { bankAccounts: originalAccounts },
      }).catch(() => undefined);
    }
  });

  test('line items are read-only on edit; payment and due date stay editable', async ({ page, request }) => {
    test.slow();
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
      await expect(page.locator('[data-financial-pl-invoice-form-ready="1"]')).toBeVisible();

      await expect(
        page.getByText(/^Line items can't be changed after the invoice is created/),
        'edit mode explains why invoice lines are read-only',
      ).toBeVisible();
      await expect(page.getByPlaceholder('Search products or type a name').first(), 'line name is not editable on edit').toBeDisabled();
      await expect(page.locator('#financial_pl-line-qty-0'), 'line quantity is not editable on edit').toBeDisabled();
      await expect(
        page.getByText('100.0000', { exact: true }),
        'line unit price is rendered as read-only text on edit',
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Add line/i }), 'add-line control is not enabled on edit').toBeDisabled();

      const paymentMethod = page.getByLabel('Payment method');
      await expect(paymentMethod, 'payment method remains editable on edit').toBeEnabled();
      await paymentMethod.click();
      await page.getByRole('option', { name: /Cash/i }).click();
      await expect(paymentMethod, 'payment method can be changed on edit').toContainText(/Cash/i);

      const dueDate = datePicker(page, 'due');
      await expect(dueDate, 'due date remains editable on edit').toBeEnabled();
      await setDatePicker(page, 'due', '2026-08-09');
      await expect(dueDate, 'due date accepts an edit').toContainText('09.08.2026');
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });

  test('due date derives from issue date + term and respects manual override', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    await skipIfFinancialInvoicesUnavailable(request, token);

    await openCreateInvoicePage(page);

    const dueDate = datePicker(page, 'due');
    const initialDueDate = await dueDate.textContent();
    expect(initialDueDate, 'create form starts with a date-shaped default due date').toMatch(/^\d{2}\.\d{2}\.\d{4}$/);

    await setDatePicker(page, 'issue', '2026-08-01');
    await page.getByRole('button', { name: /^7 days$/i }).click();
    await expect(dueDate, 'due date follows issue date + payment term while untouched').toContainText('08.08.2026');

    await setDatePicker(page, 'due', '2026-09-01');
    await expect(dueDate, 'manual due-date override is accepted').toContainText('01.09.2026');
    await setDatePicker(page, 'issue', '2026-08-15');
    await expect(dueDate, 'manual due-date override is not overwritten by later issue-date edits').toContainText(
      '01.09.2026',
    );
  });
});
