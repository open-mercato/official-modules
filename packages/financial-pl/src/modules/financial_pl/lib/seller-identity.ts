export type SellerIdentity = {
  name: string | null
  nip: string | null
  addressLine1: string | null
  addressLine2: string | null
}

type CredentialContainer = {
  resolve: (key: string) => unknown
}

/**
 * Read only printable seller fields from the organization's KSeF credential. This is deliberately
 * shared by both saved- and draft-invoice previews so the two documents cannot disagree. Tokens,
 * private keys, certificates, and every other credential field stay server-side.
 */
export async function readSellerIdentity(
  container: CredentialContainer,
  scope: { organizationId: string; tenantId: string },
): Promise<SellerIdentity | null> {
  try {
    const service = container.resolve('integrationCredentialsService') as {
      getRaw: (key: string, scope: { organizationId: string; tenantId: string }) => Promise<Record<string, unknown> | null>
    }
    const creds = await service.getRaw('ksef_pl', scope)
    if (!creds) return null
    const str = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)
    const nipDigits = typeof creds.contextNip === 'string' ? creds.contextNip.replace(/\D/g, '') : ''
    const identity: SellerIdentity = {
      name: str(creds.sellerName),
      nip: /^[0-9]{10}$/.test(nipDigits) ? nipDigits : null,
      addressLine1: str(creds.sellerAddressLine1),
      addressLine2: str(creds.sellerAddressLine2),
    }
    return identity.name || identity.nip || identity.addressLine1 ? identity : null
  } catch {
    // A missing or unreadable credential must never make invoice settings/details unavailable.
    return null
  }
}
