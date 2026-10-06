import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from './helpers/api'

/**
 * TC-ENRICH-001: treg enrichment registration and access control
 *
 * The integration is listed in the marketplace, and the module's API rejects
 * anonymous callers, malformed input, and subjects outside the caller's scope.
 */
test.describe('TC-ENRICH-001: registration and access control', () => {
  test('lists the integration in the marketplace', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'GET', '/api/integrations/enrichment_treg', { token })
    expect(response.status()).toBe(200)
    expect(JSON.stringify(await response.json())).toContain('treg Enrichment')
  })

  test('rejects anonymous callers', async ({ request }) => {
    const records = await request.get('/api/enrichment_treg/records?subjectType=person&subjectId=00000000-0000-4000-8000-000000000000')
    expect([401, 403]).toContain(records.status())
    const enrich = await request.post('/api/enrichment_treg/enrich', {
      data: { subjectType: 'person', subjectId: '00000000-0000-4000-8000-000000000000' },
    })
    expect([401, 403]).toContain(enrich.status())
  })

  test('validates input', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const badType = await apiRequest(request, 'POST', '/api/enrichment_treg/enrich', { token, data: { subjectType: 'deal', subjectId: 'x' } })
    expect(badType.status()).toBe(400)
    const badQuery = await apiRequest(request, 'GET', '/api/enrichment_treg/records?subjectType=person&subjectId=nope', { token })
    expect(badQuery.status()).toBe(400)
    const badApplied = await apiRequest(request, 'POST', '/api/enrichment_treg/records/not-a-uuid/applied', { token, data: { fields: ['jobTitle'] } })
    expect(badApplied.status()).toBe(400)
  })

  test('returns 404 for a record outside the caller scope', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'POST', '/api/enrichment_treg/records/00000000-0000-4000-8000-000000000000/applied', {
      token,
      data: { fields: ['jobTitle'] },
    })
    expect(response.status()).toBe(404)
  })
})
