import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/helpers/integration/salesFixtures';

/**
 * TC-KSEF-READ-001: SPEC-016 detail read projection for editor round-trips.
 *
 * Covers GET /api/financial_pl/ksef/invoices/[id] returning the core invoice metadata used by
 * the Notes (Uwagi) editor field plus line-level sku and metadata.productId used by the product
 * picker link preservation rules.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const BUYER = {
  companyName: 'Nabywca Read Route Sp. z o.o.',
  nip: '5252344078',
  addressLine1: 'Ul. Read Route 1',
  postalCode: '00-001',
  city: 'Warszawa',
  countryCode: 'PL',
};

function invoiceWithNotesAndLinkedLine(productId: string, sku: string, notes: string) {
  return {
    invoiceNumber: `OM-READ-${suffix()}`,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    metadata: {
      notes,
      buyerSnapshot: { ...BUYER },
    },
    lines: [
      {
        name: 'Linked catalog service',
        quantity: 1,
        quantityUnit: 'kg',
        unitPriceNet: 100,
        taxRate: 23,
        currencyCode: 'PLN',
        sku,
        metadata: { productId, source: 'TC-KSEF-READ-001' },
      },
    ],
  };
}

test.describe('TC-KSEF-READ-001: invoice detail projection', () => {
  test('returns invoice metadata.notes plus line sku and metadata', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const productId = randomUUID();
    const sku = `SPEC016-SKU-${suffix()}`;
    const notes = `Uwagi SPEC-016 ${suffix()}`;
    let invoiceId: string | null = null;

    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', {
        token,
        data: invoiceWithNotesAndLinkedLine(productId, sku, notes),
      });
      if (createRes.status() === 403) test.skip(true, 'admin lacks sales.invoices.manage on this DB');
      expect(createRes.status(), 'author a core invoice with notes + linked line metadata').toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId, 'create returns the invoice id').toBeTruthy();

      const detailRes = await apiRequest(
        request,
        'GET',
        `/api/financial_pl/ksef/invoices/${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      if (detailRes.status() === 403) test.skip(true, 'admin lacks financial_pl.view on this DB');
      expect(detailRes.status(), 'detail route reads the authored invoice').toBe(200);

      const detail = (await detailRes.json()) as {
        invoice?: { metadata?: Record<string, unknown> | null };
        lines?: Array<{ sku?: string | null; metadata?: Record<string, unknown> | null }>;
      };
      expect(detail.invoice?.metadata?.notes, 'invoice.metadata.notes round-trips for edit prefill').toBe(notes);
      expect(Array.isArray(detail.lines), 'detail returns invoice lines').toBe(true);
      expect(detail.lines?.length, 'the authored line is projected').toBeGreaterThanOrEqual(1);

      const linkedLine = detail.lines?.find((line) => line.sku === sku);
      expect(linkedLine, 'detail route returns the line sku').toBeTruthy();
      expect(linkedLine?.metadata, 'detail route returns line metadata').toBeTruthy();
      expect(linkedLine?.metadata?.productId, 'line metadata preserves productId').toBe(productId);
      expect(linkedLine?.metadata?.source, 'line metadata preserves unrelated keys').toBe('TC-KSEF-READ-001');
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
