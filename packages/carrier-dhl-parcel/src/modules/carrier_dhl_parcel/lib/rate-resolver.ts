// DHL Parcel rate resolution:
// 1. Fetch /capabilities/business and /parcel-types/business/{fromCountry} in parallel.
// 2. Filter parcel types where the requested weight fits within [minWeightKg, maxWeightKg]
//    and all requested dimensions fit within the parcel type's dimension limits (each axis ≤ max).
// 3. Join each passing parcel type with matching capability entries (same parcelType key).
// 4. Emit one ShippingRate per matched (parcelType, product.key) pair.
//    If DHL returns a price on the parcel type, use it; otherwise amount is 0 (quote at shipment time).
// Unmatched parcel types are silently dropped.

import type { ShippingRate, Address, PackageInfo } from '@open-mercato/core/modules/shipping_carriers/lib/adapter'
import { dhlRequest } from './client'

type DhlCapability = {
  product: { key: string; name?: string }
  parcelType: string
  options?: string[]
  deliveryArea?: string
  [key: string]: unknown
}

type DhlParcelTypeDimensions = {
  maxLength?: number
  maxWidth?: number
  maxHeight?: number
  [key: string]: unknown
}

type DhlParcelType = {
  key: string
  minWeightKg?: number
  maxWeightKg?: number
  dimensions?: DhlParcelTypeDimensions
  price?: number | null
  [key: string]: unknown
}

function dimensionsFit(
  pkg: PackageInfo,
  dims: DhlParcelTypeDimensions | undefined,
): boolean {
  if (!dims) return true
  const { maxLength, maxWidth, maxHeight } = dims
  if (maxLength !== undefined && pkg.lengthCm > maxLength) return false
  if (maxWidth !== undefined && pkg.widthCm > maxWidth) return false
  if (maxHeight !== undefined && pkg.heightCm > maxHeight) return false
  return true
}

export async function resolveDhlRates(
  credentials: Record<string, unknown>,
  origin: Address,
  destination: Address,
  packages: PackageInfo[],
): Promise<ShippingRate[]> {
  const fromCountry = origin.countryCode
  const toCountry = destination.countryCode

  const [capabilities, parcelTypes] = await Promise.all([
    dhlRequest<DhlCapability[]>(credentials, '/capabilities/business', {
      query: { fromCountry, toCountry, carrier: 'DHL-PARCEL' },
    }).catch((): DhlCapability[] => []),
    dhlRequest<DhlParcelType[]>(credentials, `/parcel-types/business/${encodeURIComponent(fromCountry)}`, {
      query: { toCountry, carrier: 'DHL-PARCEL' },
    }).catch((): DhlParcelType[] => []),
  ])

  if (capabilities.length === 0 || parcelTypes.length === 0) {
    return []
  }

  // Build a lookup map from parcelType.key → capabilities
  const capabilityMap = new Map<string, DhlCapability[]>()
  for (const cap of capabilities) {
    const key = cap.parcelType
    if (!key) continue
    const existing = capabilityMap.get(key) ?? []
    existing.push(cap)
    capabilityMap.set(key, existing)
  }

  const pkg = packages[0]
  const requestedWeight = pkg?.weightKg ?? 0
  const rates: ShippingRate[] = []

  for (const parcelType of parcelTypes) {
    const { key: ptKey, minWeightKg = 0, maxWeightKg = Infinity, dimensions, price } = parcelType

    // Weight check
    if (requestedWeight < minWeightKg || requestedWeight > maxWeightKg) continue

    // Dimension check (only if pkg dimensions are provided)
    if (pkg && !dimensionsFit(pkg, dimensions)) continue

    // Find matching capabilities
    const matchingCaps = capabilityMap.get(ptKey) ?? []
    if (matchingCaps.length === 0) continue

    for (const cap of matchingCaps) {
      const productKey = cap.product?.key ?? ptKey
      const productName = cap.product?.name ?? `DHL Parcel ${ptKey}`
      const amount = typeof price === 'number' ? Math.round(price * 100) : 0

      rates.push({
        serviceCode: ptKey,
        serviceName: `${productName} (${ptKey})`,
        amount,
        currencyCode: 'EUR',
      })

      // One rate per parcel type (first product match) to avoid duplicates for same parcelType
      break
    }
  }

  return rates
}
