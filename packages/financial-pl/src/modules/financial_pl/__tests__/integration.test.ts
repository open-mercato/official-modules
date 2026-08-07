import { integration } from '../integration'

describe('KSeF integration credential contract', () => {
  it('allows certificate-only credentials without a transitional KSeF token', () => {
    const fields = new Map(integration.credentials.fields.map((field) => [field.key, field]))

    expect(fields.get('contextNip')?.required).toBe(true)
    expect(fields.get('ksefToken')?.required).toBe(false)
    expect(fields.get('certificatePem')?.required).toBe(false)
    expect(fields.get('certificatePrivateKeyPem')?.required).toBe(false)
  })
})
