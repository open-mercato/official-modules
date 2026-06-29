import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';
import { deleteSalesEntityIfExists } from '@open-mercato/core/modules/core/__integration__/helpers/salesFixtures';
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures';

/**
 * TC-KSEF-UI-002: invoice authoring + PL-VAT meta + edit-prefill + the KSeF-immutability
 * interceptor (SPEC-013).
 * Covers: POST/GET /api/sales/invoices (core, lines persisted via the graph create),
 *         GET/PUT /api/financial_pl/ksef/invoice-meta,
 *         GET /api/financial_pl/ksef/invoices and /api/financial_pl/ksef/invoices/<id>,
 *         the api/interceptors.ts fail-closed 409 lock on PUT + DELETE-by-query invoice,
 *         and the route-local 409 lock inside the hand-written PUT invoice-meta handler.
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the test env
 * (yarn official-modules add financial-pl). `admin` holds `financial_pl.*` + core
 * `sales.invoices.manage`.
 *
 * Asserts the full authoring round-trip — author an invoice (header + ≥1 line) over the
 * core API, write the full PL-VAT meta (incl. invoiceKind + a GTU code + a procedure marking)
 * and read it back, confirm it appears in the list, and confirm the edit-prefill detail route
 * returns the lines (core GET is header-only; the module's own [id] route reads lines via the
 * QueryEngine). Then it proves the SERVER-SIDE immutability interceptor: with an `accepted`
 * KsefSubmission row landed for the invoice (the data path dbFixtures uses for state the API
 * cannot reach — the public submissions POST only ever lands `queued`), PUT
 * /api/sales/invoices, DELETE /api/sales/invoices?id=<id> (the canonical empty-body delete shape),
 * AND PUT invoice-meta must all return 409 — not merely a disabled button — while a fresh
 * (non-accepted) invoice still allows the same PUT + DELETE.
 */
const suffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function invoicePayload() {
  return {
    invoiceNumber: `OM-UI2-${suffix()}`,
    currencyCode: 'PLN',
    issueDate: '2026-06-22',
    grandTotalNetAmount: 100,
    grandTotalGrossAmount: 123,
    lines: [
      { name: 'Usługa A', quantity: 2, unitPriceNet: 50, taxRate: 23 },
    ],
  };
}

/** The full PL-VAT meta field set (a subset incl. invoiceKind + a GTU code + a procedure marking). */
function metaPayload(salesInvoiceId: string) {
  const procedureMarkings = {
    WSTO_EE: false, IED: false, TP: true, TT_WNT: false, TT_D: false, MR_T: false,
    MR_UZ: false, I_42: false, I_63: false, B_SPV: false, B_SPV_DOSTAWA: false, B_MPV_PROWIZJA: false,
  };
  return {
    salesInvoiceId,
    contextNip: '7980332920',
    mppRequired: true,
    invoiceKind: 'vat',
    selfBilling: false,
    reverseCharge: false,
    ossProcedure: false,
    gtuCodes: ['GTU_12'],
    procedureMarkings,
    typDokumentu: 'WEW',
  };
}

/**
 * Land a KsefSubmission row directly via the test DB (the data path dbFixtures uses): the
 * public submissions POST goes through the send command and only ever lands `queued`, so an
 * `accepted` row — the interceptor's lock precondition — must be inserted directly. Mirrors
 * the entity contract in data/entities.ts (financial_pl_ksef_submissions): the NOT-NULL
 * columns are organization_id, tenant_id, sales_invoice_id, document_kind, environment, mode,
 * status, context_nip, attempt_count, created_at. Returns the row id for cleanup.
 */
async function landAcceptedSubmission(input: {
  organizationId: string;
  tenantId: string;
  salesInvoiceId: string;
}): Promise<string> {
  return withClient(async (client) => {
    const res = await client.query<{ id: string }>(
      `insert into financial_pl_ksef_submissions
         (id, organization_id, tenant_id, sales_invoice_id, document_kind, environment, mode,
          status, context_nip, attempt_count, ksef_number, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'invoice', 'test', 'online',
          'accepted', '7980332920', 1, $4, now())
       returning id`,
      [input.organizationId, input.tenantId, input.salesInvoiceId, `1111111111-20260622-${suffix()}AAAA-BB`],
    );
    return res.rows[0].id;
  });
}

async function deleteSubmissionRow(id: string | null): Promise<void> {
  if (!id) return;
  await withClient(async (client) => {
    await client.query('delete from financial_pl_ksef_submissions where id = $1', [id]);
  }).catch(() => undefined);
}

test.describe('TC-KSEF-UI-002: invoice authoring + meta + edit-prefill + immutability', () => {
  test('authors an invoice + meta, lists it, and edit-prefill returns the lines', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let invoiceId: string | null = null;
    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      if (createRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(createRes.status(), 'admin authors a core invoice (header + line)').toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId, 'create returns the invoice id').toBeTruthy();

      // Write the full PL-VAT meta and assert the full field set persisted.
      const metaRes = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
        token,
        data: metaPayload(invoiceId as string),
      });
      expect(metaRes.status(), 'meta write returns 200').toBe(200);
      const metaBody = (await metaRes.json()) as { ok?: boolean; item?: Record<string, unknown> };
      expect(metaBody.ok).toBe(true);
      const saved = metaBody.item ?? {};
      expect(saved.invoiceKind, 'invoiceKind persisted').toBe('vat');
      expect(saved.contextNip).toBe('7980332920');
      expect(saved.mppRequired).toBe(true);
      expect(saved.gtuCodes, 'a GTU code persisted').toEqual(['GTU_12']);
      expect((saved.procedureMarkings as Record<string, boolean>).TP, 'a procedure marking persisted').toBe(true);
      expect(saved.typDokumentu).toBe('WEW');

      // GET echoes the same meta (the editor reads it back to prefill the PL-VAT section).
      const getMeta = await apiRequest(
        request,
        'GET',
        `/api/financial_pl/ksef/invoice-meta?salesInvoiceId=${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      expect(getMeta.status()).toBe(200);
      const fetchedMeta = ((await getMeta.json()) as { item?: Record<string, unknown> }).item ?? {};
      expect(fetchedMeta.invoiceKind).toBe('vat');
      expect(fetchedMeta.gtuCodes).toEqual(['GTU_12']);
      expect((fetchedMeta.procedureMarkings as Record<string, boolean>).TP).toBe(true);

      // It appears in the KSeF invoices list with the persisted PL invoice kind joined.
      const listRes = await apiRequest(request, 'GET', '/api/financial_pl/ksef/invoices?pageSize=100', { token });
      expect(listRes.status()).toBe(200);
      const listed = ((await listRes.json()) as { items?: Array<Record<string, unknown>> }).items ?? [];
      const row = listed.find((r) => r.id === invoiceId);
      expect(row, 'authored invoice appears in the list').toBeTruthy();
      expect((row as Record<string, unknown>).invoiceKind, 'list joins the PL invoice kind').toBe('vat');

      // Edit-prefill: the module's own detail route returns the LINES (core GET is header-only).
      const detailRes = await apiRequest(
        request,
        'GET',
        `/api/financial_pl/ksef/invoices/${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      expect(detailRes.status(), 'detail/edit-prefill read succeeds').toBe(200);
      const detail = (await detailRes.json()) as {
        invoice?: { id?: string };
        lines?: Array<Record<string, unknown>>;
        meta?: Record<string, unknown> | null;
      };
      expect(detail.invoice?.id).toBe(invoiceId);
      expect(Array.isArray(detail.lines), 'detail returns a lines array').toBe(true);
      expect((detail.lines ?? []).length, 'the authored line is read back for the editor').toBeGreaterThanOrEqual(1);
      expect((detail.lines ?? [])[0]).toHaveProperty('name');
      expect((detail.lines ?? [])[0]).toHaveProperty('quantity');
      expect(detail.meta, 'the PL-VAT meta is read back for prefill').toBeTruthy();
      expect((detail.meta as Record<string, unknown>).invoiceKind).toBe('vat');
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });

  test('a NON-accepted invoice still allows PUT + DELETE (invoice + meta)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let invoiceId: string | null = null;
    // A second invoice exercised only by the destructive DELETE-by-query assertion, so the PUT
    // assertions above keep a stable target.
    let deletableInvoiceId: string | null = null;
    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      if (createRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(createRes.status()).toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId).toBeTruthy();

      // No accepted/processing submission ⇒ the guard passes ⇒ the meta PUT is allowed.
      const metaRes = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
        token,
        data: { salesInvoiceId: invoiceId, invoiceKind: 'vat', mppRequired: true },
      });
      expect(metaRes.status(), 'meta PUT is allowed on a non-locked invoice').toBe(200);

      // The invoice PUT is also allowed (the interceptor passes); we only assert it is NOT 409.
      const putRes = await apiRequest(request, 'PUT', '/api/sales/invoices', {
        token,
        data: { id: invoiceId, grandTotalNetAmount: 110, grandTotalGrossAmount: 135 },
      });
      expect(putRes.status(), 'invoice PUT is not locked (interceptor passes) on a non-accepted invoice').not.toBe(409);

      // DELETE ?id= of a non-accepted invoice is allowed (the interceptor passes — it must not
      // fail closed on every delete, only on locked ones).
      const createDeletable = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      expect(createDeletable.status()).toBe(201);
      deletableInvoiceId = ((await createDeletable.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(deletableInvoiceId).toBeTruthy();
      const deleteByQuery = await apiRequest(
        request,
        'DELETE',
        `/api/sales/invoices?id=${encodeURIComponent(deletableInvoiceId as string)}`,
        { token },
      );
      expect(deleteByQuery.status(), 'DELETE ?id= is not locked (interceptor passes) on a non-accepted invoice').not.toBe(409);
    } finally {
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', deletableInvoiceId);
    }
  });

  test('the immutability interceptor returns 409 on PUT invoice + PUT meta once accepted (server-side)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const { organizationId, tenantId } = getTokenContext(token);
    let invoiceId: string | null = null;
    let submissionRowId: string | null = null;
    try {
      const createRes = await apiRequest(request, 'POST', '/api/sales/invoices', { token, data: invoicePayload() });
      if (createRes.status() === 403) {
        test.skip(true, 'admin lacks sales.invoices.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(createRes.status()).toBe(201);
      invoiceId = ((await createRes.json()) as { invoiceId?: string }).invoiceId ?? null;
      expect(invoiceId).toBeTruthy();
      // Skip cleanly if we cannot read the org/tenant from the token (cookie-scoped instances).
      if (!organizationId || !tenantId) {
        test.skip(true, 'token does not expose orgId/tenantId for the direct submission fixture');
      }

      // Land an `accepted` submission for THIS invoice via the test DB (the public submissions
      // POST cannot land `accepted`). This is the interceptor's lock precondition.
      submissionRowId = await landAcceptedSubmission({
        organizationId,
        tenantId,
        salesInvoiceId: invoiceId as string,
      });

      // PUT the core invoice → the fail-closed interceptor rejects with 409 (server-side lock).
      const putInvoice = await apiRequest(request, 'PUT', '/api/sales/invoices', {
        token,
        data: { id: invoiceId, grandTotalNetAmount: 200, grandTotalGrossAmount: 246 },
      });
      expect(putInvoice.status(), 'PUT a KSeF-accepted invoice is locked (409)').toBe(409);

      // PUT the PL-VAT meta → also rejected with 409 (the route-local KSeF-immutability guard:
      // this is a hand-written route, so the module's `before` interceptor never runs for it — the
      // guard lives INSIDE the PUT handler).
      const putMeta = await apiRequest(request, 'PUT', '/api/financial_pl/ksef/invoice-meta', {
        token,
        data: { salesInvoiceId: invoiceId, invoiceKind: 'vat', mppRequired: false },
      });
      expect(putMeta.status(), 'PUT the meta of a KSeF-accepted invoice is locked (409)').toBe(409);

      // DELETE the core invoice by query (`?id=`, EMPTY body) → also 409. This is the canonical
      // delete shape; the interceptor must resolve the id from the URL searchParams (not just the
      // body) or it fails open. Asserting 409 also leaves the invoice intact for cleanup.
      const deleteByQuery = await apiRequest(
        request,
        'DELETE',
        `/api/sales/invoices?id=${encodeURIComponent(invoiceId as string)}`,
        { token },
      );
      expect(deleteByQuery.status(), 'DELETE ?id= of a KSeF-accepted invoice is locked (409)').toBe(409);
    } finally {
      await deleteSubmissionRow(submissionRowId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/invoices', invoiceId);
    }
  });
});
