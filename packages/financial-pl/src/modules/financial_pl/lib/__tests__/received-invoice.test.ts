import type { ReceivedInvoiceMetadata } from '../ksef-client'
import {
  mapMetadataToReceivedInvoice,
  mapReceivedInvoiceToPurchaseRecord,
  type ReceivedInvoiceFields,
} from '../received-invoice'

describe('received-invoice mappers', () => {
  it('maps standard received-invoice metadata to ReceivedInvoiceFields', () => {
    const metadata: ReceivedInvoiceMetadata = {
      ksefNumber: 'KSEF-2026-0001',
      invoiceNumber: 'FV/1/2026',
      issueDate: '2026-02-10',
      acquisitionDate: '2026-02-11T10:00:00Z',
      seller: { nip: '1111111111', name: 'Seller Sp. z o.o.' },
      buyer: { identifier: { type: 'Nip', value: '2222222222' }, name: 'Buyer Sp. z o.o.' },
      netAmount: 123.4,
      grossAmount: 151.78,
      vatAmount: 28.38,
      currency: 'PLN',
      invoiceType: 'VAT',
      isSelfInvoicing: false,
      invoiceHash: 'HASH-1',
    }

    const received = mapMetadataToReceivedInvoice(metadata)

    expect(received).toEqual({
      ksefNumber: 'KSEF-2026-0001',
      issuerNip: '1111111111',
      issuerName: 'Seller Sp. z o.o.',
      buyerIdentifierType: 'Nip',
      buyerIdentifierValue: '2222222222',
      issueDate: '2026-02-10',
      acquisitionDate: '2026-02-11',
      invoiceType: 'VAT',
      currency: 'PLN',
      netAmount: '123.40',
      grossAmount: '151.78',
      vatAmount: '28.38',
      invoiceHash: 'HASH-1',
      correctedKsefNumber: null,
    })
    expect(mapReceivedInvoiceToPurchaseRecord(received).documentNumber).toBe('FV/1/2026')
  })

  it('derives purchase-record period from receipt date and falls documentNumber back to ksefNumber', () => {
    const received: ReceivedInvoiceFields = {
      ksefNumber: 'KSEF-2026-0002',
      issuerNip: '1111111111',
      issuerName: 'Supplier',
      buyerIdentifierType: 'Nip',
      buyerIdentifierValue: '2222222222',
      issueDate: '2026-01-31',
      acquisitionDate: '2026-02-03',
      invoiceType: 'VAT',
      currency: 'PLN',
      netAmount: '200.00',
      grossAmount: '246.00',
      vatAmount: '46.00',
      invoiceHash: 'HASH-2',
      correctedKsefNumber: null,
    }

    expect(mapReceivedInvoiceToPurchaseRecord(received)).toEqual({
      year: 2026,
      month: 2,
      supplierNip: '1111111111',
      supplierName: 'Supplier',
      supplierCountryCode: null,
      documentNumber: 'KSEF-2026-0002',
      purchaseDate: '2026-01-31',
      receiptDate: '2026-02-03',
      nrKsef: 'KSEF-2026-0002',
      netOther: '200.00',
      vatOther: '46.00',
    })
  })

  it('keeps correction links and signed amounts', () => {
    const metadata: ReceivedInvoiceMetadata = {
      ksefNumber: 'KSEF-2026-KOR-1',
      invoiceNumber: 'KOR/1/2026',
      issueDate: '2026-03-10',
      acquisitionDate: '2026-03-12',
      seller: { nip: '1111111111', name: 'Supplier' },
      netAmount: -10.5,
      grossAmount: -12.92,
      vatAmount: -2.42,
      currency: 'PLN',
      invoiceType: 'KOR',
      invoiceHash: 'HASH-KOR',
      hashOfCorrectedInvoice: 'HASH-CORRECTED',
    }

    const received = mapMetadataToReceivedInvoice(metadata)

    expect(received.correctedKsefNumber).toBe('HASH-CORRECTED')
    expect(received.netAmount).toBe('-10.50')
    expect(received.grossAmount).toBe('-12.92')
    expect(received.vatAmount).toBe('-2.42')
    expect(mapReceivedInvoiceToPurchaseRecord(received)).toEqual({
      year: 2026,
      month: 3,
      supplierNip: '1111111111',
      supplierName: 'Supplier',
      supplierCountryCode: null,
      documentNumber: 'KOR/1/2026',
      purchaseDate: '2026-03-10',
      receiptDate: '2026-03-12',
      nrKsef: 'KSEF-2026-KOR-1',
      netOther: '-10.50',
      vatOther: '-2.42',
    })
  })

  it('maps missing or empty optional fields to nulls without throwing', () => {
    const metadata: ReceivedInvoiceMetadata = {
      ksefNumber: 'KSEF-EMPTY',
      invoiceNumber: '',
      issueDate: '',
      invoicingDate: '',
      acquisitionDate: '',
      seller: { nip: '', name: '' },
      buyer: { identifier: { type: '', value: '' }, name: '' },
      currency: '',
      invoiceType: '',
      invoiceHash: '',
      hashOfCorrectedInvoice: '',
    }

    const received = mapMetadataToReceivedInvoice(metadata)

    expect(received).toEqual({
      ksefNumber: 'KSEF-EMPTY',
      issuerNip: null,
      issuerName: null,
      buyerIdentifierType: null,
      buyerIdentifierValue: null,
      issueDate: null,
      acquisitionDate: null,
      invoiceType: null,
      currency: null,
      netAmount: null,
      grossAmount: null,
      vatAmount: null,
      invoiceHash: null,
      correctedKsefNumber: null,
    })
    expect(() => mapReceivedInvoiceToPurchaseRecord(received)).not.toThrow()
    expect(mapReceivedInvoiceToPurchaseRecord(received)).toEqual({
      year: 0,
      month: 0,
      supplierNip: null,
      supplierName: null,
      supplierCountryCode: null,
      documentNumber: 'KSEF-EMPTY',
      purchaseDate: '',
      receiptDate: null,
      nrKsef: 'KSEF-EMPTY',
      netOther: null,
      vatOther: null,
    })
  })
})
