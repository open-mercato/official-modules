import { buildKsefAuthConfig, readKsefCredentials } from '../credentials'

describe('buildKsefAuthConfig — auth method is EXPLICIT (no back-door cert activation)', () => {
  const NIP = '2481632647'

  it('uses token when authMethod is unset and a token is present', () => {
    const cfg = buildKsefAuthConfig({ ksefToken: 'TKN' }, NIP)
    expect(cfg).toEqual({ method: 'token', ksefToken: 'TKN', contextNip: NIP })
  })

  it('does NOT auto-switch to certificate when cert material is present but authMethod is unset', () => {
    // Regression guard (cross-model jury, DeepSeek): enrollment stores cert+key
    // without activating; a token org that enrolled a cert must NOT silently switch.
    const cfg = buildKsefAuthConfig({ certificatePem: 'CERT', certificatePrivateKeyPem: 'KEY' }, NIP)
    // No token + method defaults to token → null (rejected), NEVER a certificate config.
    expect(cfg).toBeNull()
  })

  it('keeps token when authMethod is unset and BOTH token and cert are present', () => {
    const cfg = buildKsefAuthConfig(
      { ksefToken: 'TKN', certificatePem: 'CERT', certificatePrivateKeyPem: 'KEY' },
      NIP,
    )
    expect(cfg).toEqual({ method: 'token', ksefToken: 'TKN', contextNip: NIP })
  })

  it('keeps token when authMethod=token and cert material is present', () => {
    const cfg = buildKsefAuthConfig(
      { authMethod: 'token', ksefToken: 'TKN', certificatePem: 'CERT', certificatePrivateKeyPem: 'KEY' },
      NIP,
    )
    expect(cfg).toEqual({ method: 'token', ksefToken: 'TKN', contextNip: NIP })
  })

  it('uses certificate ONLY when explicitly activated (authMethod=certificate) with material', () => {
    const cfg = buildKsefAuthConfig(
      { authMethod: 'certificate', certificatePem: 'CERT', certificatePrivateKeyPem: 'KEY' },
      NIP,
    )
    expect(cfg).toEqual({ method: 'certificate', contextNip: NIP, certificatePem: 'CERT', privateKeyPem: 'KEY' })
  })

  it('returns null when certificate is activated but material is missing', () => {
    expect(buildKsefAuthConfig({ authMethod: 'certificate', certificatePem: 'CERT' }, NIP)).toBeNull()
    expect(buildKsefAuthConfig({ authMethod: 'certificate' }, NIP)).toBeNull()
  })

  it('returns null when token is selected but no token is configured', () => {
    expect(buildKsefAuthConfig({ authMethod: 'token' }, NIP)).toBeNull()
    expect(buildKsefAuthConfig({}, NIP)).toBeNull()
  })

  it('prefers certificate when authMethod=auto and certificate material is present', () => {
    const cfg = buildKsefAuthConfig(
      { authMethod: 'auto', ksefToken: 'TKN', certificatePem: 'CERT', certificatePrivateKeyPem: 'KEY' },
      NIP,
    )
    expect(cfg).toEqual({ method: 'certificate', contextNip: NIP, certificatePem: 'CERT', privateKeyPem: 'KEY' })
  })

  it('falls back to token when authMethod=auto and certificate material is incomplete', () => {
    const cfg = buildKsefAuthConfig({ authMethod: 'auto', ksefToken: 'TKN', certificatePem: 'CERT' }, NIP)
    expect(cfg).toEqual({ method: 'token', ksefToken: 'TKN', contextNip: NIP })
  })

  it('returns null when authMethod=auto has no usable credentials', () => {
    expect(buildKsefAuthConfig({ authMethod: 'auto' }, NIP)).toBeNull()
  })

  it('normalizes authMethod=auto from stored credentials', async () => {
    const service = { getRaw: async () => ({ authMethod: 'auto' }) }
    const creds = await readKsefCredentials(
      { resolve: <T = unknown>(_name: string): T => service as T },
      { organizationId: 'org_1', tenantId: 'tenant_1' },
    )
    expect(creds.authMethod).toBe('auto')
  })
})
