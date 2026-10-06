import { expect, test } from '@playwright/test'
import { getAuthToken } from './helpers/api'
import {
  configureTreg,
  createCompany,
  deleteSubject,
  isTregConfigured,
  resetTreg,
  startEnrichment,
  startTregStub,
  waitForRecord,
  type TregStub,
} from './helpers/fixtures'

/**
 * TC-ENRICH-003: company enrichment, missing subjects and provider failures
 *
 * A company lookup sends the CRM domain and maps firmographics into the
 * proposal; an unknown subject returns 404; a treg 402 marks the record
 * failed with `out_of_balance` instead of throwing.
 */
test.describe('TC-ENRICH-003: company enrichment and failures', () => {
  test('maps company firmographics, rejects unknown subjects and records provider failures', async ({ request }) => {
    test.setTimeout(420_000)
    const token = await getAuthToken(request, 'admin')
    test.skip(await isTregConfigured(request, token), 'treg already configured on this tenant; not overwriting real credentials')

    const suffix = `${Date.now()}`
    let stub: TregStub | null = null
    let companyId: string | null = null
    try {
      stub = await startTregStub()
      stub.respond('/call/treg.companies.enrich', {
        status: 200,
        body: {
          output: { name: 'Treg Test Co', domain: `treg-${suffix}.example`, website: `https://treg-${suffix}.example`, industry: 'Software', employees: '51-200', founded: 2019 },
        },
        headers: { 'x-treg-cost-micro': '1800', 'x-treg-served-by': 'stub-apollo' },
      })
      companyId = await createCompany(request, token, suffix)
      await configureTreg(request, token, stub.baseUrl)

      const missing = await startEnrichment(request, token, 'company', '00000000-0000-4000-8000-000000000000')
      expect(missing.status).toBe(404)

      expect((await startEnrichment(request, token, 'company', companyId)).status).toBe(202)
      const record = await waitForRecord(request, token, 'company', companyId)
      expect(record.status).toBe('completed')
      expect(record.proposal).toMatchObject({ industry: 'Software', sizeBucket: '51-200', websiteUrl: `https://treg-${suffix}.example` })
      const call = stub.calls.find((entry) => entry.url === '/call/treg.companies.enrich')
      expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ domain: `treg-${suffix}.example` })

      stub.respond('/call/treg.companies.enrich', { status: 402, body: { error: 'insufficient balance' } })
      expect((await startEnrichment(request, token, 'company', companyId)).status).toBe(202)
      await expect
        .poll(async () => (await waitForRecord(request, token, 'company', companyId as string)).id !== record.id, { timeout: 170_000 })
        .toBe(true)
      const failed = await waitForRecord(request, token, 'company', companyId)
      expect(failed.status).toBe('failed')
      expect(failed.failureReason).toBe('out_of_balance')
    } finally {
      if (companyId) await deleteSubject(request, token, 'company', companyId)
      await resetTreg(request, token)
      await stub?.close()
    }
  })
})
