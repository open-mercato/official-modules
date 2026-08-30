import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures';
import {
  createOrganizationInDb,
  deleteIntegrationCredentialsInDb,
  deleteOrganizationInDb,
} from '@open-mercato/core/helpers/integration/dbFixtures';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-KSEF-008: KSeF offline mode — Offline-certificate enrollment + offline issuance
 * (offline24 / awaryjny) HTTP contract (SPEC-010).
 *
 * Covers: POST /api/financial_pl/ksef/certificates/enroll (certificateType: 'Offline')
 *         POST /api/financial_pl/ksef/submissions/issue-offline
 *
 * Requires the @open-mercato/financial-pl official module to be activated in the test
 * env (yarn official-modules add financial-pl). `admin` holds `financial_pl.*`;
 * `employee` holds only `financial_pl.view` (see setup.ts) — used for the 403 below.
 *
 * Asserts the self-contained HTTP contract only (no live Ministry of Finance KSeF API,
 * no enrolled Offline certificate, no issued-invoice fixture chain): authentication,
 * feature-gating, and zod payload validation. The Offline enrollment runbook
 * (auth -> CSR -> enroll(certificateType:'Offline') -> poll -> retrieve into the
 * separate offlineCertificate* credential, and the 409
 * certificate_auth_required_for_enrollment outcome) plus the full offline issuance flow
 * (build XML now, KOD I "OFFLINE" + cert-signed KOD II, the computed statutory deadline,
 * and the accepted `offline_issued` shape echoing the deadline + KOD I/II URLs) are
 * proven by the unit tests (cert-enrollment.test.ts, ksef-qr-cert.test.ts,
 * offline-deadline.test.ts, offline-issue.test.ts) and the env-gated live offline
 * round-trip (ksef-live.test.ts). Without an enrolled Offline certificate, a valid
 * issue-offline payload for an unknown invoice is a clear non-2xx (409
 * credentials_missing / offline_certificate_required), never a live offline issue.
 */
test.describe('TC-KSEF-008: KSeF offline mode (Offline cert + issue-offline) API', () => {
  // --- certificates/enroll (Offline) ---

  test('rejects an unauthenticated Offline certificate enrollment', async ({ request }) => {
    const anonRes = await request.post('/api/financial_pl/ksef/certificates/enroll', {
      data: { certificateName: 'OM Offline Cert', certificateType: 'Offline' },
    });
    expect(anonRes.status(), 'unauthenticated Offline enrollment is rejected').toBe(401);
  });

  test('rejects an Offline enrollment without the manage feature (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/certificates/enroll', {
      token,
      data: { certificateName: 'OM Offline Cert', certificateType: 'Offline' },
    });
    expect(res.status(), 'employee (view-only) cannot enroll a certificate').toBe(403);
  });

  test('rejects an invalid Offline enrollment payload (400)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/certificates/enroll', {
      token,
      data: { certificateName: '', certificateType: 'Offline' },
    });
    expect(badRes.status(), 'empty certificateName returns 400').toBe(400);
  });

  test('rejects an unknown certificateType (400)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const badRes = await apiRequest(request, 'POST', '/api/financial_pl/ksef/certificates/enroll', {
      token,
      data: { certificateName: 'OM Offline Cert', certificateType: 'NotAType' },
    });
    expect(badRes.status(), 'an unknown certificateType returns 400').toBe(400);
  });

  test('Offline enrollment without an auth credential does not live-enroll (non-2xx contract)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const { tenantId } = getTokenContext(token);
    if (!tenantId) test.skip(true, 'token does not expose tenantId for the isolated organization fixture');
    const organizationId = await createOrganizationInDb({ name: `KSeF no-credential QA ${randomUUID()}`, tenantId });

    try {
      const res = await apiRequestWithSelectedOrg(request, 'POST', '/api/financial_pl/ksef/certificates/enroll', {
        token,
        selectedOrgId: organizationId,
        data: { certificateName: 'OM Offline Cert', certificateType: 'Offline' },
      });
      // Enrolling any certificate (incl. Offline) presupposes an existing XAdES-capable
      // certificate credential. The isolated org intentionally has none, regardless of
      // whether a developer configured live credentials on their normal sandbox org.
      expect(res.status(), 'Offline enrollment without an auth credential is a clear non-2xx').not.toBeLessThan(400);
      expect([400, 409, 422, 502], 'Offline enrollment without an auth credential is a clear non-2xx').toContain(res.status());
    } finally {
      await deleteIntegrationCredentialsInDb(organizationId);
      await deleteOrganizationInDb(organizationId);
    }
  });

  // --- submissions/issue-offline ---

  test('rejects an unauthenticated offline issuance', async ({ request }) => {
    const anonRes = await request.post('/api/financial_pl/ksef/submissions/issue-offline', {
      data: { salesInvoiceId: randomUUID(), mode: 'offline24' },
    });
    expect(anonRes.status(), 'unauthenticated offline issuance is rejected').toBe(401);
  });

  test('rejects an offline issuance without the manage feature (403)', async ({ request }) => {
    const token = await getAuthToken(request, 'employee');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/issue-offline', {
      token,
      data: { salesInvoiceId: randomUUID(), mode: 'offline24' },
    });
    expect(res.status(), 'employee (view-only) cannot issue offline').toBe(403);
  });

  test('rejects an unknown offline mode (400)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/issue-offline', {
      token,
      data: { salesInvoiceId: randomUUID(), mode: 'not_a_mode' },
    });
    expect(res.status(), 'an unknown offline mode returns 400').toBe(400);
  });

  test('rejects an awaryjny issuance without failureEndsAt (400, offline_mode_invalid)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/issue-offline', {
      token,
      // awaryjny REQUIRES the MF-announced failure-end timestamp; omitting it is
      // offline_mode_invalid so the +7-business-day deadline is never silently mis-computed.
      data: { salesInvoiceId: randomUUID(), mode: 'awaryjny' },
    });
    expect(res.status(), 'awaryjny without failureEndsAt returns 400').toBe(400);
  });

  test('rejects an offline24 issuance carrying failureEndsAt (400, offline_mode_invalid)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/issue-offline', {
      token,
      // offline24 MUST NOT carry a failure-end (its deadline is the next business day).
      data: { salesInvoiceId: randomUUID(), mode: 'offline24', failureEndsAt: new Date().toISOString() },
    });
    expect(res.status(), 'offline24 with failureEndsAt returns 400').toBe(400);
  });

  test('offline24 issuance without an Offline certificate does not live-issue (non-2xx contract)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/issue-offline', {
      token,
      data: { salesInvoiceId: randomUUID(), mode: 'offline24' },
    });
    // Offline issuance requires an enrolled, currently-valid Offline certificate (KOD II
    // signing). Without one (and no issued-invoice fixture, no live KSeF), this is a clear
    // non-2xx — 409 credentials_missing / offline_certificate_required — never an accepted
    // (202 offline_issued) issue. The 202 shape (deadline + KOD I/II URLs echoed) is proven
    // by the offline-issue / KOD II / deadline unit tests and the env-gated live block.
    expect([404, 409, 422], 'offline24 issuance without an Offline cert is a clear non-2xx').toContain(res.status());
  });

  test('awaryjny issuance with a valid failureEndsAt but no Offline certificate does not live-issue (non-2xx contract)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    getTokenContext(token);
    const res = await apiRequest(request, 'POST', '/api/financial_pl/ksef/submissions/issue-offline', {
      token,
      data: {
        salesInvoiceId: randomUUID(),
        mode: 'awaryjny',
        failureEndsAt: new Date().toISOString(),
      },
    });
    expect([404, 409, 422], 'awaryjny issuance without an Offline cert is a clear non-2xx').toContain(res.status());
  });
});
