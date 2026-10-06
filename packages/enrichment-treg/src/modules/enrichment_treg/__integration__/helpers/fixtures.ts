import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest } from './api'

export type StubCall = { url: string; headers: http.IncomingHttpHeaders; body: string }

export type StubResponse = { status: number; body: unknown; headers?: Record<string, string> }

export type TregStub = {
  baseUrl: string
  calls: StubCall[]
  respond(endpointPath: string, response: StubResponse): void
  close(): Promise<void>
}

export async function startTregStub(): Promise<TregStub> {
  const calls: StubCall[] = []
  const responses = new Map<string, StubResponse>([['/billing', { status: 200, body: { balance_micro: 1_000_000 } }]])
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      calls.push({ url: req.url ?? '', headers: req.headers, body })
      const response = responses.get(req.url ?? '') ?? { status: 404, body: { error: 'not found' } }
      res.writeHead(response.status, { 'content-type': 'application/json', ...(response.headers ?? {}) })
      res.end(JSON.stringify(response.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    respond(endpointPath, response) {
      responses.set(endpointPath, response)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function readJson(response: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const value = await response.json()
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function isTregConfigured(request: APIRequestContext, token: string): Promise<boolean> {
  const response = await apiRequest(request, 'GET', '/api/integrations/enrichment_treg/credentials', { token })
  if (!response.ok()) return false
  const body = await readJson(response)
  const credentials = (body.credentials ?? {}) as Record<string, unknown>
  return Object.values(credentials).some((value) => typeof value === 'string' && value.length > 0)
}

export async function configureTreg(request: APIRequestContext, token: string, baseUrl: string): Promise<void> {
  const credentials = await apiRequest(request, 'PUT', '/api/integrations/enrichment_treg/credentials', {
    token,
    data: { credentials: { apiToken: 'trg_integration_test', maxCostPerCallUsd: '0.02', apiBaseUrl: baseUrl } },
  })
  expect(credentials.ok(), 'save stub treg credentials').toBeTruthy()
  await setTregEnabled(request, token, true)
}

export async function setTregEnabled(request: APIRequestContext, token: string, isEnabled: boolean): Promise<void> {
  const state = await apiRequest(request, 'PUT', '/api/integrations/enrichment_treg/state', { token, data: { isEnabled } })
  expect(state.ok(), `set treg enabled=${isEnabled}`).toBeTruthy()
}

export async function resetTreg(request: APIRequestContext, token: string): Promise<void> {
  await apiRequest(request, 'PUT', '/api/integrations/enrichment_treg/credentials', { token, data: { credentials: {} } })
  await apiRequest(request, 'PUT', '/api/integrations/enrichment_treg/state', { token, data: { isEnabled: false } })
}

export async function createPerson(request: APIRequestContext, token: string, suffix: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/customers/people', {
    token,
    data: { firstName: 'Treg', lastName: `Test${suffix}`, displayName: `Treg Test${suffix}`, primaryEmail: `treg.test.${suffix}@enrichment.example` },
  })
  expect(response.status(), 'create person fixture').toBe(201)
  return String((await readJson(response)).id)
}

export async function createCompany(request: APIRequestContext, token: string, suffix: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/customers/companies', {
    token,
    data: { displayName: `Treg Test Co ${suffix}`, domain: `treg-${suffix}.example` },
  })
  expect(response.status(), 'create company fixture').toBe(201)
  return String((await readJson(response)).id)
}

export async function deleteSubject(request: APIRequestContext, token: string, subjectType: 'person' | 'company', id: string): Promise<void> {
  const collection = subjectType === 'person' ? 'people' : 'companies'
  await apiRequest(request, 'DELETE', `/api/customers/${collection}?id=${encodeURIComponent(id)}`, { token })
}

export type EnrichmentRecordBody = {
  id: string
  status: string
  failureReason: string | null
  servedBy: string | null
  costMicro: number
  proposal: Record<string, string> | null
  appliedFields: string[] | null
}

export async function startEnrichment(
  request: APIRequestContext,
  token: string,
  subjectType: 'person' | 'company',
  subjectId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await apiRequest(request, 'POST', '/api/enrichment_treg/enrich', { token, data: { subjectType, subjectId } })
  return { status: response.status(), body: await readJson(response) }
}

export async function waitForRecord(
  request: APIRequestContext,
  token: string,
  subjectType: 'person' | 'company',
  subjectId: string,
): Promise<EnrichmentRecordBody> {
  let latest: EnrichmentRecordBody | null = null
  await expect
    .poll(
      async () => {
        const response = await apiRequest(
          request,
          'GET',
          `/api/enrichment_treg/records?subjectType=${subjectType}&subjectId=${subjectId}&pageSize=1`,
          { token },
        )
        const items = ((await readJson(response)).items ?? []) as EnrichmentRecordBody[]
        latest = items[0] ?? null
        return latest?.status ?? 'missing'
      },
      { timeout: 170_000, intervals: [1000, 2000] },
    )
    .not.toMatch(/^(missing|pending|running)$/)
  return latest as unknown as EnrichmentRecordBody
}
