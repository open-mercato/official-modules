import type { UnifiedShipmentStatus } from '@open-mercato/core/modules/shipping_carriers/lib/adapter'

// DHL event category → UnifiedShipmentStatus mapping.
// Source: DHL Parcel Gateway API OpenAPI spec (api-gw.dhlparcel.nl).
// Unknown categories fall through to 'unknown' via the fallback in mapDhlStatus.
const DHL_CATEGORY_MAP: Record<string, UnifiedShipmentStatus> = {
  DATA_RECEIVED: 'label_created',
  UNDERWAY: 'in_transit',
  LEG: 'in_transit',
  IN_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  EXCEPTION: 'failed_delivery',
  PROBLEM: 'failed_delivery',
  INTERVENTION: 'failed_delivery',
  CUSTOMS: 'in_transit',
  UNKNOWN: 'unknown',
}

export function mapDhlStatus(category: string): UnifiedShipmentStatus {
  return DHL_CATEGORY_MAP[category] ?? 'unknown'
}
