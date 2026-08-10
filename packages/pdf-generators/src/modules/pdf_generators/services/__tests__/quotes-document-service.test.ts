import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { QuotesDocumentService, type QuoteRecord } from '../quotes-document-service'

const mockedFind = findOneWithDecryption as jest.Mock

const auth = { tenantId: 't-1', orgId: 'o-1' } as unknown as AuthContext
// container.resolve is only asked for names; the actual values are irrelevant
// because findOneWithDecryption is mocked.
const container = { resolve: jest.fn(() => ({})) } as unknown as AppContainer

function makeQuoteRecord(overrides: Partial<QuoteRecord> = {}): QuoteRecord {
  return {
    id: 'q-1',
    quoteNumber: 'Q-2026-0007',
    currencyCode: 'PLN',
    validFrom: new Date('2026-05-09T00:00:00.000Z'),
    validUntil: new Date('2026-06-09T00:00:00.000Z'),
    comments: 'Thanks for your business',
    grandTotalNetAmount: '100.00',
    grandTotalGrossAmount: '123.00',
    taxTotalAmount: '23.00',
    customerSnapshot: { customer: { displayName: 'Acme Sp. z o.o.', primaryEmail: 'buyer@acme.test' } },
    billingAddressSnapshot: { addressLine1: 'ul. Testowa 1', city: 'Warszawa', postalCode: '00-001', country: 'PL' },
    lines: [
      {
        id: 'l-1', name: 'Widget', description: 'A widget', quantity: '2',
        unitPriceNet: '50.00', unitPriceGross: '61.50', totalNetAmount: '100.00',
        totalGrossAmount: '123.00', taxRate: '23', currencyCode: 'PLN',
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('QuotesDocumentService.fetchData', () => {
  it('throws when auth context is missing but an id is present (tenant-isolation guard)', async () => {
    const service = new QuotesDocumentService()
    await expect(
      service.fetchData({ data: { id: 'q-1' } }, { container, auth: null }),
    ).rejects.toThrow('Missing auth context')
    expect(mockedFind).not.toHaveBeenCalled()
  })

  it('returns the raw data untouched when no id is supplied', async () => {
    const service = new QuotesDocumentService()
    const data = { foo: 'bar' }
    await expect(service.fetchData({ data }, { container, auth })).resolves.toBe(data)
    expect(mockedFind).not.toHaveBeenCalled()
  })

  it('scopes the query by id, tenantId and organizationId (C1)', async () => {
    const service = new QuotesDocumentService()
    mockedFind.mockResolvedValueOnce({
      id: 'q-1', quoteNumber: 'Q-1', currencyCode: 'PLN',
      validFrom: null, validUntil: null, comments: null,
      grandTotalNetAmount: '0', grandTotalGrossAmount: '0', taxTotalAmount: '0',
      customerSnapshot: null, billingAddressSnapshot: { addressLine1: 'x' },
      customerEntityId: null, lines: { getItems: () => [] },
    })

    await service.fetchData({ data: { id: 'q-1' } }, { container, auth })

    expect(mockedFind).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { id: 'q-1', tenantId: 't-1', organizationId: 'o-1' },
      { populate: ['lines'] },
    )
  })
})

describe('QuotesDocumentService.toTemplateData', () => {
  it('normalizes a record with object snapshots', () => {
    const service = new QuotesDocumentService()
    const out = service.toTemplateData({ data: makeQuoteRecord() })

    expect(out.document).toMatchObject({ id: 'q-1', number: 'Q-2026-0007' })
    expect((out.document as Record<string, string>).date).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
    expect(out.client).toMatchObject({ name: 'Acme Sp. z o.o.', email: 'buyer@acme.test' })
    expect(out.totals).toEqual({ subtotal: 100, tax: 23, total: 123, currency: 'PLN' })
    expect((out.lines as unknown[])).toHaveLength(1)
    expect((out.client as Record<string, string>).address).toContain('ul. Testowa 1')
  })

  it('parses snapshots that arrive as JSON strings (string branch)', () => {
    const service = new QuotesDocumentService()
    const record = makeQuoteRecord({
      customerSnapshot: JSON.stringify({ customer: { displayName: 'Acme Sp. z o.o.', primaryEmail: 'buyer@acme.test' } }) as unknown as QuoteRecord['customerSnapshot'],
      billingAddressSnapshot: JSON.stringify({ addressLine1: 'ul. Testowa 1', city: 'Warszawa', postalCode: '00-001', country: 'PL' }) as unknown as QuoteRecord['billingAddressSnapshot'],
    })

    const out = service.toTemplateData({ data: record })

    expect(out.client).toMatchObject({ name: 'Acme Sp. z o.o.', email: 'buyer@acme.test' })
    expect((out.client as Record<string, string>).address).toContain('Warszawa')
  })
})

describe('QuotesDocumentService.filename', () => {
  it('includes the document number when present', () => {
    const service = new QuotesDocumentService()
    expect(service.filename({ data: { document: { number: 'Q-9' } } })).toBe('offer-Q-9.pdf')
  })

  it('falls back to offer.pdf when the number is missing', () => {
    const service = new QuotesDocumentService()
    expect(service.filename({ data: {} })).toBe('offer.pdf')
  })
})

describe('QuotesDocumentService.resourceLabel', () => {
  it('returns the document number as the history label', () => {
    const service = new QuotesDocumentService()
    expect(service.resourceLabel({ data: { document: { number: 'Q-9' } } })).toBe('Q-9')
  })

  it('returns undefined when the number is missing', () => {
    const service = new QuotesDocumentService()
    expect(service.resourceLabel({ data: {} })).toBeUndefined()
  })
})

describe('QuotesDocumentService.resourceId', () => {
  it('returns the canonical quote id from normalized data', () => {
    const service = new QuotesDocumentService()
    expect(service.resourceId({ data: { document: { id: 'q-9' } } })).toBe('q-9')
  })

  it('returns undefined when the id is missing', () => {
    const service = new QuotesDocumentService()
    expect(service.resourceId({ data: {} })).toBeUndefined()
  })
})
