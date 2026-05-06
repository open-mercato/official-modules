import Chance from 'chance'
import { mapDhlStatus } from '../lib/status-map'

const chance = new Chance()

describe('mapDhlStatus', () => {
  const cases: Array<[string, string]> = [
    ['DATA_RECEIVED', 'label_created'],
    ['UNDERWAY', 'in_transit'],
    ['LEG', 'in_transit'],
    ['IN_DELIVERY', 'out_for_delivery'],
    ['DELIVERED', 'delivered'],
    ['EXCEPTION', 'failed_delivery'],
    ['PROBLEM', 'failed_delivery'],
    ['INTERVENTION', 'failed_delivery'],
    ['CUSTOMS', 'in_transit'],
    ['UNKNOWN', 'unknown'],
  ]

  it.each(cases)('maps DHL category "%s" to unified status "%s"', (category, expected) => {
    expect(mapDhlStatus(category)).toBe(expected)
  })

  it('returns "unknown" for unrecognized categories', () => {
    expect(mapDhlStatus(chance.word())).toBe('unknown')
    expect(mapDhlStatus(`FUTURE_${chance.word().toUpperCase()}_STATUS`)).toBe('unknown')
    expect(mapDhlStatus('')).toBe('unknown')
  })

  it('is case-sensitive — lowercase categories map to "unknown"', () => {
    expect(mapDhlStatus('data_received')).toBe('unknown')
    expect(mapDhlStatus('delivered')).toBe('unknown')
    expect(mapDhlStatus('in_delivery')).toBe('unknown')
  })

  it('covers all 10 documented DHL event categories', () => {
    const allCategories = [
      'DATA_RECEIVED',
      'UNDERWAY',
      'LEG',
      'IN_DELIVERY',
      'DELIVERED',
      'EXCEPTION',
      'PROBLEM',
      'INTERVENTION',
      'CUSTOMS',
      'UNKNOWN',
    ]
    const validStatuses = new Set([
      'label_created',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'failed_delivery',
      'unknown',
    ])
    for (const cat of allCategories) {
      const result = mapDhlStatus(cat)
      expect(validStatuses.has(result)).toBe(true)
    }
  })
})
