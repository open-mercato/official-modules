// DHL Parcel Gateway API adapter — implements the ShippingAdapter contract.
// API docs: https://api-gw.dhlparcel.nl/docs/combined.json

import { v4 as uuid } from 'uuid'
import type {
  ShippingAdapter,
  ShippingRate,
  CreateShipmentInput,
  CreateShipmentResult,
  TrackingResult,
  ShippingWebhookEvent,
  UnifiedShipmentStatus,
  DropOffPoint,
  SearchDropOffPointsInput,
} from '@open-mercato/core/modules/shipping_carriers/lib/adapter'
import { dhlRequest, dhlRequestRaw, resolveAccountNumber } from '../client'
import { mapDhlStatus } from '../status-map'
import { resolveDhlRates } from '../rate-resolver'
import { dhlErrors } from '../errors'

// ──────────────────────────────────────────────
// Internal DHL API response types
// ──────────────────────────────────────────────

type DhlName = {
  firstName?: string
  lastName?: string
  companyName?: string
}

type DhlAddress = {
  countryCode: string
  postalCode: string
  city: string
  street: string
  number: string
}

type DhlContactInfo = {
  name: DhlName
  address: DhlAddress
  email?: string
  phoneNumber?: string
}

type DhlPiece = {
  labelId?: string
  trackerCode?: string
  parcelType?: string
  [key: string]: unknown
}

type DhlShipmentResponse = {
  shipmentId: string
  shipmentTrackerCode?: string
  pieces?: DhlPiece[]
  orderReference?: string
  [key: string]: unknown
}

type DhlTrackingEvent = {
  timestamp?: string
  category?: string
  status?: string
  description?: string
  [key: string]: unknown
}

type DhlTrackingPiece = {
  barcode?: string
  statusCode?: string
  status?: string
  events?: DhlTrackingEvent[]
  [key: string]: unknown
}

type DhlParcelShopAddress = {
  countryCode?: string
  postalCode?: string
  city?: string
  street?: string
  number?: string
  [key: string]: unknown
}

type DhlParcelShop = {
  id?: string
  name?: string
  shopType?: string
  keyword?: string
  address?: DhlParcelShopAddress
  geoLocation?: { latitude?: number; longitude?: number }
  [key: string]: unknown
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildShipperContact(origin: CreateShipmentInput['origin'], credentials: Record<string, unknown>): DhlContactInfo {
  return {
    name: {
      companyName: stringOrEmpty(credentials.senderCompanyName) || undefined,
      firstName: stringOrEmpty(credentials.senderFirstName) || undefined,
      lastName: stringOrEmpty(credentials.senderLastName) || undefined,
    },
    address: {
      countryCode: origin.countryCode,
      postalCode: origin.postalCode,
      city: origin.city,
      street: origin.line1,
      number: origin.line2 ?? '1',
    },
    ...(stringOrEmpty(credentials.senderEmail) ? { email: stringOrEmpty(credentials.senderEmail) } : {}),
    ...(stringOrEmpty(credentials.senderPhone) ? { phoneNumber: stringOrEmpty(credentials.senderPhone) } : {}),
  }
}

function buildReceiverContact(destination: CreateShipmentInput['destination'], credentials: Record<string, unknown>): DhlContactInfo {
  return {
    name: {
      companyName: stringOrEmpty(credentials.receiverCompanyName) || undefined,
      firstName: stringOrEmpty(credentials.receiverFirstName) || undefined,
      lastName: stringOrEmpty(credentials.receiverLastName) || undefined,
    },
    address: {
      countryCode: destination.countryCode,
      postalCode: destination.postalCode,
      city: destination.city,
      street: destination.line1,
      number: destination.line2 ?? '1',
    },
    ...(stringOrEmpty(credentials.receiverEmail) ? { email: stringOrEmpty(credentials.receiverEmail) } : {}),
    ...(stringOrEmpty(credentials.receiverPhone) ? { phoneNumber: stringOrEmpty(credentials.receiverPhone) } : {}),
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

async function fetchLabel(
  credentials: Record<string, unknown>,
  labelId: string,
  labelFormat: CreateShipmentInput['labelFormat'],
): Promise<string | undefined> {
  const accept = labelFormat === 'zpl' ? 'application/zpl' : 'application/pdf'
  try {
    const buffer = await dhlRequestRaw(
      credentials,
      `/labels/${encodeURIComponent(labelId)}`,
      accept,
    )
    return arrayBufferToBase64(buffer)
  } catch {
    // Label fetch failure is non-fatal — return undefined, core handles gracefully
    return undefined
  }
}

// ──────────────────────────────────────────────
// Adapter implementation
// ──────────────────────────────────────────────

export const dhlParcelAdapterV1: ShippingAdapter = {
  providerKey: 'dhl_parcel',

  async calculateRates(input): Promise<ShippingRate[]> {
    return resolveDhlRates(input.credentials, input.origin, input.destination, input.packages)
  },

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const accountId = resolveAccountNumber(input.credentials)
    const shipmentId = uuid()
    const shipper = buildShipperContact(input.origin, input.credentials)
    const receiver = buildReceiverContact(input.destination, input.credentials)

    const pkg = input.packages[0]
    const pieces = pkg
      ? [
          {
            parcelType: input.serviceCode,
            quantity: 1,
            weight: pkg.weightKg,
            dimensions: {
              length: Math.round(pkg.lengthCm),
              width: Math.round(pkg.widthCm),
              height: Math.round(pkg.heightCm),
            },
          },
        ]
      : [{ parcelType: input.serviceCode, quantity: 1, weight: 1 }]

    const body = {
      shipmentId,
      accountId,
      shipper,
      receiver,
      pieces,
      options: [],
      orderReference: input.orderId,
    }

    const response = await dhlRequest<DhlShipmentResponse>(input.credentials, '/shipments', {
      method: 'POST',
      body,
    })

    const returnedShipmentId = response.shipmentId ?? shipmentId
    const firstPiece = response.pieces?.[0]
    const trackingNumber =
      firstPiece?.trackerCode ?? response.shipmentTrackerCode ?? returnedShipmentId
    const labelId = firstPiece?.labelId

    const labelData = labelId
      ? await fetchLabel(input.credentials, labelId, input.labelFormat)
      : undefined

    return {
      shipmentId: returnedShipmentId,
      trackingNumber,
      ...(labelData ? { labelData } : {}),
    }
  },

  async getTracking(input): Promise<TrackingResult> {
    const identifier = input.trackingNumber ?? input.shipmentId
    if (!identifier) {
      throw dhlErrors.missingTrackingIdentifier()
    }

    // DHL track-trace key format: trackerCode or trackerCode+postalCode.
    // We use the tracking number alone when no postalCode is available.
    const response = await dhlRequest<DhlTrackingPiece[]>(input.credentials, '/track-trace', {
      query: { key: identifier },
    })

    const pieces: DhlTrackingPiece[] = Array.isArray(response) ? response : []
    const firstPiece = pieces[0]

    const events = (firstPiece?.events ?? []).map((ev) => ({
      status: mapDhlStatus(ev.category ?? 'UNKNOWN') as UnifiedShipmentStatus,
      occurredAt: ev.timestamp ?? new Date().toISOString(),
      // DHL status text is rendered as escaped text (never dangerouslySetInnerHTML)
      ...(ev.status ? { location: ev.status } : {}),
    }))

    // Latest status: last event's category (most recent is last in DHL response)
    const lastEvent = firstPiece?.events?.[firstPiece.events.length - 1]
    const status: UnifiedShipmentStatus = lastEvent?.category
      ? mapDhlStatus(lastEvent.category)
      : 'label_created'

    return {
      trackingNumber: firstPiece?.barcode ?? identifier,
      status,
      events,
    }
  },

  async cancelShipment(_input): Promise<{ status: UnifiedShipmentStatus }> {
    // DHL Parcel Gateway API does not expose a cancellation endpoint.
    // Operators must cancel shipments manually via DHL Manager.
    throw dhlErrors.cancellationNotSupported()
  },

  async verifyWebhook(_input): Promise<ShippingWebhookEvent> {
    // Phase 2: implement DHL Track-Trace Pusher webhook verification.
    // Phase 1 stub — returns an unknown event to satisfy the interface.
    return {
      eventType: 'dhl_parcel.webhook.unverified',
      eventId: uuid(),
      idempotencyKey: uuid(),
      data: {},
      timestamp: new Date(),
    }
  },

  mapStatus(carrierStatus: string): UnifiedShipmentStatus {
    return mapDhlStatus(carrierStatus)
  },

  async searchDropOffPoints(input: SearchDropOffPointsInput): Promise<DropOffPoint[]> {
    const countryCode = input.credentials.senderCountryCode ?? 'NL'
    const query: Record<string, string> = { limit: '20' }
    if (input.postCode && input.postCode.trim().length > 0) {
      query['q'] = input.postCode.trim()
    } else if (input.query && input.query.trim().length > 0) {
      query['q'] = input.query.trim()
    }

    const shops = await dhlRequest<DhlParcelShop[]>(
      input.credentials,
      `/parcel-shop-locations/${encodeURIComponent(String(countryCode))}`,
      { query },
    ).catch((): DhlParcelShop[] => [])

    return shops.map((shop) => {
      const addr = shop.address ?? {}
      return {
        id: shop.id ?? shop.keyword ?? shop.name ?? '',
        name: shop.name ?? '',
        type: shop.shopType ?? 'parcel_shop',
        city: addr.city ?? '',
        postalCode: addr.postalCode ?? '',
        street: [addr.street, addr.number].filter(Boolean).join(' '),
        ...(shop.geoLocation?.latitude !== undefined ? { latitude: shop.geoLocation.latitude } : {}),
        ...(shop.geoLocation?.longitude !== undefined ? { longitude: shop.geoLocation.longitude } : {}),
      }
    })
  },
}
