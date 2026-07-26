import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';

/**
 * TC-KSEF-JPK-003: JPK_V7 filing lifecycle flow (stage → generate → list) plus a
 * regression guard for the "edit a submitted filing's period" hole.
 *
 * Covers the operator flow on the JPK_V7 page:
 *   POST /api/financial_pl/ksef/jpk/filings       (upsert a V7M filing header)
 *   POST /api/financial_pl/ksef/jpk/export?filingId=<id>  (generate → status 'generated', writes XML)
 *   GET  /api/financial_pl/ksef/jpk/filings        (the filing appears in the Deklaracje list)
 *
 * Regression (review finding): upsertFilingCommand's update branch has NO status guard, so the
 * period-defining header (year/month/variant/celZlozenia/contextNip) of an ALREADY-SUBMITTED filing
 * can be rewritten while its generated_xml / UPO / submissionReference still describe the old
 * period — a falsified compliance record. generateCommand does block regenerating a submitted
 * filing, so the asymmetry is the bug. This test asserts the DESIRED behaviour (409) and is marked
 * `test.fail()` so it stays green while the bug is open and turns red (unexpected pass) the moment
 * the guard is added — the signal to drop the annotation. See commands/jpk.ts:326 vs :428.
 *
 * `admin` holds `financial_pl.*`. Requires the @open-mercato/financial-pl module active.
 */
const CTX_NIP = '7980332920'; // valid test NIP (used across the module's suite)

function filingHeader(overrides: Record<string, unknown> = {}) {
  return {
    contextNip: CTX_NIP,
    variant: 'V7M' as const,
    year: 2026,
    month: 6,
    celZlozenia: 1 as const,
    correctionScope: 'both' as const,
    kodUrzedu: '1471', // 4-digit tax-office code (required before generation)
    ...overrides,
  };
}

async function deleteFilingRow(id: string | null): Promise<void> {
  if (!id) return;
  await withClient(async (client) => {
    await client.query('delete from financial_pl_jpk_filing where id = $1', [id]);
  }).catch(() => undefined);
}

async function markFilingSubmitted(id: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `update financial_pl_jpk_filing
         set status = 'submitted', submission_reference = $2, submitted_at = now()
       where id = $1`,
      [id, `JPK-REF-${id.slice(0, 8)}`],
    );
  });
}

test.describe('TC-KSEF-JPK-003: JPK_V7 filing stage → generate → list + submitted-period lock', () => {
  test('stages a V7M filing, generates it, and lists it', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    let filingId: string | null = null;
    try {
      const upsert = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
        token,
        data: filingHeader(),
      });
      if (upsert.status() === 403) {
        test.skip(true, 'admin lacks financial_pl.manage on this DB (run yarn mercato auth sync-role-acls)');
      }
      expect(upsert.status(), 'staging a JPK_V7 filing header returns 200').toBe(200);
      const upsertBody = (await upsert.json()) as { ok?: boolean; id?: string };
      expect(upsertBody.ok).toBe(true);
      filingId = upsertBody.id ?? null;
      expect(filingId, 'upsert returns the filing id').toBeTruthy();

      // Generate: builds the JPK_V7 XML for the (possibly empty/zerowa) period and flips status.
      const generate = await apiRequest(
        request,
        'POST',
        `/api/financial_pl/ksef/jpk/export?filingId=${encodeURIComponent(filingId as string)}`,
        { token },
      );
      expect(generate.status(), 'generate returns 200').toBe(200);
      const genBody = (await generate.json()) as { ok?: boolean; status?: string };
      expect(genBody.ok).toBe(true);
      expect(genBody.status, 'generate flips the filing to "generated"').toBe('generated');

      // The generated filing appears in the Deklaracje list for its period.
      const list = await apiRequest(
        request,
        'GET',
        '/api/financial_pl/ksef/jpk/filings?year=2026&month=6&variant=V7M',
        { token },
      );
      expect(list.status()).toBe(200);
      const items = ((await list.json()) as { items?: Array<Record<string, unknown>> }).items ?? [];
      const row = items.find((r) => r.id === filingId);
      expect(row, 'the staged filing appears in the list').toBeTruthy();
      expect((row as Record<string, unknown>).variant).toBe('V7M');
      expect((row as Record<string, unknown>).year).toBe(2026);
      expect((row as Record<string, unknown>).month).toBe(6);
    } finally {
      await deleteFilingRow(filingId);
    }
  });

  // REGRESSION GUARD (currently failing → test.fail keeps the suite green until the bug is fixed).
  // Editing the period of a SUBMITTED filing must be rejected; today upsertFilingCommand allows it.
  test.fail(
    'rejects a period change on an already-submitted filing (finding: no status guard on upsert update)',
    async ({ request }) => {
      const token = await getAuthToken(request, 'admin');
      getTokenContext(token);
      let filingId: string | null = null;
      try {
        const upsert = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
          token,
          data: filingHeader({ month: 3 }),
        });
        if (upsert.status() === 403) {
          test.skip(true, 'admin lacks financial_pl.manage on this DB');
        }
        expect(upsert.status()).toBe(200);
        filingId = ((await upsert.json()) as { id?: string }).id ?? null;
        expect(filingId).toBeTruthy();

        // Simulate a filing already filed with the Ministry (submit itself needs the MF gateway).
        await markFilingSubmitted(filingId as string);

        // Attempt to rewrite the period (month 3 → 4) of the submitted filing via the SAME id.
        const edit = await apiRequest(request, 'POST', '/api/financial_pl/ksef/jpk/filings', {
          token,
          data: filingHeader({ id: filingId, month: 4 }),
        });
        // DESIRED: a submitted filing's period is immutable → 409 (mirrors generateCommand's guard).
        // ACTUAL today: 200 (the update branch has no status check) → this expectation fails →
        // test.fail() marks the whole test as an expected failure (green). Remove test.fail once fixed.
        expect(edit.status(), 'editing a submitted filing period should be locked (409)').toBe(409);
      } finally {
        await deleteFilingRow(filingId);
      }
    },
  );
});
