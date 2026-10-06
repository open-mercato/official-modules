import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from './helpers/api'
import {
  configureTreg,
  createPerson,
  deleteSubject,
  isTregConfigured,
  resetTreg,
  startEnrichment,
  startTregStub,
  waitForRecord,
  type TregStub,
} from './helpers/fixtures'

/**
 * TC-ENRICH-002: person enrichment end to end against a stub treg server
 *
 * Disabled integration is refused; once enabled, a lookup is queued, the worker
 * stores a normalized proposal, the user applies it through the customers API,
 * and the applied fields are recorded. Fields outside the proposal are rejected.
 */
test.describe('TC-ENRICH-002: person enrichment', () => {
  test('enriches a person, applies the proposal and records it', async ({ request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    test.skip(await isTregConfigured(request, token), 'treg already configured on this tenant; not overwriting real credentials')

    const suffix = `${Date.now()}`
    let stub: TregStub | null = null
    let personId: string | null = null
    try {
      stub = await startTregStub()
      stub.respond('/call/treg.people.enrich', {
        status: 200,
        body: {
          output: { full_name: 'Treg Test', title: 'Head of Data', linkedin_url: 'https://www.linkedin.com/in/treg-test', company: 'Enrichment Inc', location: 'Lisbon' },
          raw: { stub: true },
        },
        headers: { 'x-treg-cost-micro': '2634', 'x-treg-served-by': 'stub-pdl', 'x-treg-call-id': 'call_1' },
      })
      personId = await createPerson(request, token, suffix)

      const disabled = await startEnrichment(request, token, 'person', personId)
      expect(disabled.status).toBe(422)
      expect(disabled.body.error).toBe('integration_disabled')

      await configureTreg(request, token, stub.baseUrl)
      const started = await startEnrichment(request, token, 'person', personId)
      expect(started.status).toBe(202)

      const record = await waitForRecord(request, token, 'person', personId)
      expect(record.status).toBe('completed')
      expect(record.proposal).toEqual({ jobTitle: 'Head of Data', linkedInUrl: 'https://www.linkedin.com/in/treg-test' })
      expect(record.costMicro).toBe(2634)
      expect(record.servedBy).toBe('stub-pdl')

      const call = stub.calls.find((entry) => entry.url === '/call/treg.people.enrich')
      expect(call?.headers['x-treg-token']).toBe('trg_integration_test')
      expect(call?.headers['x-treg-route-max-cost']).toBe('0.02')
      expect(call?.headers['idempotency-key']).toBe(`om-enrichment-${record.id}`)
      expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ email: `treg.test.${suffix}@enrichment.example` })

      const outside = await apiRequest(request, 'POST', `/api/enrichment_treg/records/${record.id}/applied`, { token, data: { fields: ['industry'] } })
      expect(outside.status()).toBe(400)

      const update = await apiRequest(request, 'PUT', '/api/customers/people', { token, data: { id: personId, jobTitle: record.proposal?.jobTitle } })
      expect(update.status()).toBe(200)
      const applied = await apiRequest(request, 'POST', `/api/enrichment_treg/records/${record.id}/applied`, { token, data: { fields: ['jobTitle'] } })
      expect(applied.status()).toBe(200)
      expect((await applied.json()).record.appliedFields).toEqual(['jobTitle'])

      const person = await apiRequest(request, 'GET', `/api/customers/people/${personId}`, { token })
      expect((await person.json()).profile.jobTitle).toBe('Head of Data')
    } finally {
      if (personId) await deleteSubject(request, token, 'person', personId)
      await resetTreg(request, token)
      await stub?.close()
    }
  })
})
