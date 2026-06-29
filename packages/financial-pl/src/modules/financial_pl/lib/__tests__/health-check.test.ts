import { createKsefHealthCheck } from '../health-check'
import type { KsefTransport } from '../ksef-client'

// L7: health-check.ts is wired into the integration definition/DI but previously had zero tests.
describe('createKsefHealthCheck', () => {
  it('reports healthy when KSeF returns public-key certificates', async () => {
    const transport: KsefTransport = async () => ({
      status: 200,
      headers: {},
      text: JSON.stringify([{ publicKeyId: 'k1', certificate: 'c1' }]),
    })
    const result = await createKsefHealthCheck(transport).check({ environment: 'test' })
    expect(result.status).toBe('healthy')
    expect(result.details.publicKeys).toBe(1)
    expect(result.details.environment).toBe('test')
    expect(result.checkedAt).toBeInstanceOf(Date)
  })

  it('reports unhealthy when KSeF returns no certificates', async () => {
    const transport: KsefTransport = async () => ({ status: 200, headers: {}, text: '[]' })
    const result = await createKsefHealthCheck(transport).check({ environment: 'test' })
    expect(result.status).toBe('unhealthy')
    expect(result.message).toMatch(/no public keys/)
  })

  it('reports unhealthy when the transport throws (connection failure)', async () => {
    const transport: KsefTransport = async () => {
      throw new Error('network down')
    }
    const result = await createKsefHealthCheck(transport).check({ environment: 'test' })
    expect(result.status).toBe('unhealthy')
    expect(result.message).toMatch(/KSeF connection failed/)
    expect(result.details.error).toBe('network down')
  })
})
