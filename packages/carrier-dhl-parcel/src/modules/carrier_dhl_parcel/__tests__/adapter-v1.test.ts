import Chance from 'chance'
import { dhlParcelAdapterV1 } from '../lib/adapters/v1'
import { clearTokenCache } from '../lib/client'
import type { CreateShipmentInput } from '@open-mercato/core/modules/shipping_carriers/lib/adapter'

const chance = new Chance()

function makeCredentials(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: chance.guid(),
    apiKey: chance.guid(),
    accountNumber: chance.integer({ min: 10000000, max: 99999999 }).toString(),
    senderFirstName: 'Test',
    senderLastName: 'Sender',
    senderCompanyName: 'Acme BV',
    ...overrides,
  }
}

function makeAddress() {
  return {
    line1: `${chance.street()}`,
    line2: '1',
    city: chance.city(),
    postalCode: '1234AB',
    countryCode: chance.pickone(['NL', 'DE', 'BE', 'FR']),
  }
}

function makePackage() {
  return {
    weightKg: chance.floating({ min: 0.1, max: 30, fixed: 2 }),
    lengthCm: chance.integer({ min: 5, max: 60 }),
    widthCm: chance.integer({ min: 5, max: 60 }),
    heightCm: chance.integer({ min: 5, max: 60 }),
  }
}

function makeShipmentInput(overrides: Partial<CreateShipmentInput> = {}): CreateShipmentInput {
  return {
    credentials: makeCredentials(),
    orderId: chance.guid(),
    serviceCode: 'SMALL',
    origin: makeAddress(),
    destination: makeAddress(),
    packages: [makePackage()],
    ...overrides,
  }
}

function makeAuthFetch(accessToken = chance.guid()) {
  const now = Math.floor(Date.now() / 1000)
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        accessToken,
        accessTokenExpiration: now + 900,
        refreshToken: chance.guid(),
        refreshTokenExpiration: now + 604800,
      }),
  }
}

beforeEach(() => {
  clearTokenCache()
  jest.resetAllMocks()
})

describe('dhlParcelAdapterV1.calculateRates', () => {
  it('returns empty array when capabilities endpoint returns empty', async () => {
    const input = {
      credentials: makeCredentials(),
      origin: makeAddress(),
      destination: makeAddress(),
      packages: [makePackage()],
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch()) // auth
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) }) // capabilities
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) }) // parcel types

    const rates = await dhlParcelAdapterV1.calculateRates(input)
    expect(rates).toEqual([])
  })

  it('returns empty array when parcel types endpoint returns empty', async () => {
    const input = {
      credentials: makeCredentials(),
      origin: { ...makeAddress(), countryCode: 'NL' },
      destination: { ...makeAddress(), countryCode: 'DE' },
      packages: [makePackage()],
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { product: { key: 'DHL_PARCEL_CONNECT' }, parcelType: 'SMALL' },
          ]),
      }) // capabilities
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) }) // parcel types empty

    const rates = await dhlParcelAdapterV1.calculateRates(input)
    expect(rates).toEqual([])
  })

  it('filters out parcel types where weight exceeds maxWeightKg', async () => {
    const pkg = { weightKg: 35, lengthCm: 30, widthCm: 20, heightCm: 10 }
    const input = {
      credentials: makeCredentials(),
      origin: { ...makeAddress(), countryCode: 'NL' },
      destination: { ...makeAddress(), countryCode: 'DE' },
      packages: [pkg],
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { product: { key: 'DHL_PARCEL_CONNECT', name: 'DHL Parcel Connect' }, parcelType: 'SMALL' },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { key: 'SMALL', minWeightKg: 0, maxWeightKg: 20, dimensions: {}, price: 9.99 },
          ]),
      })

    const rates = await dhlParcelAdapterV1.calculateRates(input)
    expect(rates).toEqual([]) // 35kg > maxWeightKg 20
  })

  it('returns a ShippingRate for matching parcel type and capability', async () => {
    const pkg = { weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 10 }
    const input = {
      credentials: makeCredentials(),
      origin: { ...makeAddress(), countryCode: 'NL' },
      destination: { ...makeAddress(), countryCode: 'DE' },
      packages: [pkg],
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { product: { key: 'DHL_PARCEL_CONNECT', name: 'DHL Parcel Connect' }, parcelType: 'SMALL' },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { key: 'SMALL', minWeightKg: 0, maxWeightKg: 20, dimensions: { maxLength: 40, maxWidth: 30, maxHeight: 20 }, price: 7.50 },
          ]),
      })

    const rates = await dhlParcelAdapterV1.calculateRates(input)
    expect(rates).toHaveLength(1)
    expect(rates[0].serviceCode).toBe('SMALL')
    expect(rates[0].amount).toBe(750) // €7.50 in cents
    expect(rates[0].currencyCode).toBe('EUR')
  })

  it('silently drops parcel types with no matching capability', async () => {
    const pkg = { weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 }
    const input = {
      credentials: makeCredentials(),
      origin: { ...makeAddress(), countryCode: 'NL' },
      destination: { ...makeAddress(), countryCode: 'DE' },
      packages: [pkg],
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { product: { key: 'DHL_PARCEL_CONNECT', name: 'DHL Parcel Connect' }, parcelType: 'LARGE' },
          ]),
      }) // capability for LARGE only
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { key: 'SMALL', minWeightKg: 0, maxWeightKg: 20, dimensions: {}, price: 7.50 },
          ]),
      }) // parcel type for SMALL only — no matching capability

    const rates = await dhlParcelAdapterV1.calculateRates(input)
    expect(rates).toEqual([]) // SMALL has no LARGE capability match
  })
})

describe('dhlParcelAdapterV1.createShipment', () => {
  it('generates a UUID shipmentId and sends correct request body', async () => {
    const input = makeShipmentInput({
      credentials: makeCredentials({ senderCompanyName: 'Acme BV' }),
      serviceCode: 'SMALL',
    })

    const shipmentResponse = {
      shipmentId: chance.guid(),
      pieces: [{ labelId: chance.guid(), trackerCode: 'JVGL0123456789', parcelType: 'SMALL' }],
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch()) // auth
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve(shipmentResponse) }) // POST /shipments
      .mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve('Not Found') }) // label fetch (graceful fail)

    const result = await dhlParcelAdapterV1.createShipment(input)

    expect(result.shipmentId).toBe(shipmentResponse.shipmentId)
    expect(result.trackingNumber).toBe('JVGL0123456789')

    // Verify POST /shipments body
    const calls = (global.fetch as jest.Mock).mock.calls
    const shipmentCall = calls.find(
      ([url]: [string]) => typeof url === 'string' && url.includes('/shipments') && !url.includes('/labels'),
    )
    expect(shipmentCall).toBeDefined()
    const body = JSON.parse(shipmentCall![1].body as string)
    expect(body.accountId).toBe(input.credentials.accountNumber)
    expect(body.orderReference).toBe(input.orderId)
    expect(body.pieces[0].parcelType).toBe('SMALL')
    expect(body.shipper.name.companyName).toBe('Acme BV')
  })

  it('includes labelData when label fetch succeeds', async () => {
    const input = makeShipmentInput()
    const labelId = chance.guid()
    const shipmentResponse = {
      shipmentId: chance.guid(),
      pieces: [{ labelId, trackerCode: 'JVGL0123456789' }],
    }
    const fakePdfBytes = new Uint8Array([37, 80, 68, 70]) // %PDF magic bytes

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve(shipmentResponse) })
      .mockResolvedValueOnce({ // GET /labels/{id}
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(fakePdfBytes.buffer),
      })

    const result = await dhlParcelAdapterV1.createShipment(input)
    expect(result.labelData).toBeDefined()
    expect(typeof result.labelData).toBe('string')
  })

  it('omits labelData when label fetch fails (non-fatal)', async () => {
    const input = makeShipmentInput()
    const shipmentResponse = {
      shipmentId: chance.guid(),
      pieces: [{ labelId: chance.guid(), trackerCode: 'JVGL' }],
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve(shipmentResponse) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve('Not Found') })

    const result = await dhlParcelAdapterV1.createShipment(input)
    expect(result.shipmentId).toBe(shipmentResponse.shipmentId)
    expect(result.labelData).toBeUndefined()
  })
})

describe('dhlParcelAdapterV1.getTracking', () => {
  it('maps last event category to unified status', async () => {
    const credentials = makeCredentials()
    const trackingNumber = 'JVGL0123456789'

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            {
              barcode: trackingNumber,
              events: [
                { category: 'DATA_RECEIVED', timestamp: '2026-01-01T10:00:00Z', status: 'Label created' },
                { category: 'UNDERWAY', timestamp: '2026-01-02T08:00:00Z', status: 'In transit' },
                { category: 'IN_DELIVERY', timestamp: '2026-01-03T09:00:00Z', status: 'Out for delivery' },
              ],
            },
          ]),
      })

    const result = await dhlParcelAdapterV1.getTracking({ trackingNumber, credentials })
    expect(result.status).toBe('out_for_delivery') // last event
    expect(result.trackingNumber).toBe(trackingNumber)
    expect(result.events).toHaveLength(3)
    expect(result.events[0].status).toBe('label_created')
    expect(result.events[1].status).toBe('in_transit')
    expect(result.events[2].status).toBe('out_for_delivery')
  })

  it('returns label_created status when no events are present', async () => {
    const credentials = makeCredentials()
    const trackingNumber = 'JVGL9999'

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeAuthFetch())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ barcode: trackingNumber, events: [] }]),
      })

    const result = await dhlParcelAdapterV1.getTracking({ trackingNumber, credentials })
    expect(result.status).toBe('label_created')
    expect(result.events).toHaveLength(0)
  })

  it('throws when neither trackingNumber nor shipmentId is provided', async () => {
    const credentials = makeCredentials()
    await expect(
      dhlParcelAdapterV1.getTracking({ credentials }),
    ).rejects.toThrow('trackingNumber or shipmentId is required')
  })
})

describe('dhlParcelAdapterV1.cancelShipment', () => {
  it('throws a not-supported error', async () => {
    const credentials = makeCredentials()
    await expect(
      dhlParcelAdapterV1.cancelShipment({ shipmentId: chance.guid(), credentials }),
    ).rejects.toThrow('DHL Parcel does not support shipment cancellation via API')
  })
})

describe('dhlParcelAdapterV1.mapStatus', () => {
  it('maps known DHL categories correctly', () => {
    expect(dhlParcelAdapterV1.mapStatus('DELIVERED')).toBe('delivered')
    expect(dhlParcelAdapterV1.mapStatus('EXCEPTION')).toBe('failed_delivery')
    expect(dhlParcelAdapterV1.mapStatus('DATA_RECEIVED')).toBe('label_created')
  })

  it('returns "unknown" for unrecognized categories', () => {
    expect(dhlParcelAdapterV1.mapStatus('WHATEVER')).toBe('unknown')
    expect(dhlParcelAdapterV1.mapStatus('')).toBe('unknown')
  })
})
