/**
 * Pure buyer (Nabywca) ⇄ `metadata.buyerSnapshot` mapping (SPEC-014). Kept React-free so it is
 * unit-testable and reusable by the editor, the edit-prefill loader and the detail page. The keys
 * are EXACTLY those `lib/fa3-mapping.ts` `buildBuyer` / `composeCityLine` read, so what the editor
 * captures flows straight into the FA(3) Podmiot2 with no resolver change.
 */

export type BuyerValue = {
  companyName?: string
  nip?: string
  addressLine1?: string
  addressLine2?: string
  postalCode?: string
  city?: string
  countryCode?: string
}

const BUYER_KEYS = ['companyName', 'nip', 'addressLine1', 'addressLine2', 'postalCode', 'city', 'countryCode'] as const

/** Build the `buyerSnapshot` object (omitting empty fields), or undefined when the buyer is empty.
 *  The NIP is normalised to bare digits and the country to upper-case so what is persisted is exactly
 *  what FA(3) expects — `buildBuyer` passes `snapshot.nip` straight to the `^[0-9]{10}$` party schema,
 *  so a dashed/spaced NIP would otherwise 422 on send (code-jury r2, Kimi). */
export function buyerToSnapshot(buyer: BuyerValue): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const key of BUYER_KEYS) {
    const raw = buyer[key]
    let v = typeof raw === 'string' ? raw.trim() : ''
    if (key === 'nip') v = v.replace(/\D/g, '')
    if (key === 'countryCode') v = v.toUpperCase()
    if (v) out[key] = v
  }
  // A buyer carrying ONLY a (defaulted) countryCode and no identifying field — name / NIP / address /
  // postal / city — is empty: omit the snapshot entirely rather than persist a meaningless
  // { countryCode } (the editor defaults countryCode to 'PL' on a fresh, unfilled buyer) (code-jury, Kimi).
  const hasIdentifying = BUYER_KEYS.some((key) => key !== 'countryCode' && out[key])
  return hasIdentifying ? out : undefined
}

/** Project a stored `buyerSnapshot` (any historical key casing `buildBuyer` accepts) into BuyerValue. */
export function snapshotToBuyer(snapshot: unknown): BuyerValue {
  const s = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    companyName: str(s.companyName ?? s.company_name ?? s.name),
    nip: str(s.nip ?? s.taxId ?? s.tax_id),
    addressLine1: str(s.addressLine1 ?? s.address_line1),
    addressLine2: str(s.addressLine2 ?? s.address_line2),
    postalCode: str(s.postalCode ?? s.postal_code),
    city: str(s.city),
    countryCode: (str(s.countryCode ?? s.country ?? s.country_code) || 'PL').toUpperCase(),
  }
}

/** Read `metadata.buyerSnapshot` (or the legacy `metadata.buyer`) into BuyerValue. */
export function buyerFromMetadata(metadata: unknown): BuyerValue {
  const m = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  return snapshotToBuyer(m.buyerSnapshot ?? m.buyer)
}
