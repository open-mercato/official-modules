import type { ReceivedInvoiceMetadata } from './ksef-client'

export type ReceivedInvoiceFields = {
  ksefNumber: string
  issuerNip: string | null
  issuerName: string | null
  buyerIdentifierType: string | null
  buyerIdentifierValue: string | null
  issueDate: string | null
  acquisitionDate: string | null
  invoiceType: string | null
  currency: string | null
  netAmount: string | null
  grossAmount: string | null
  vatAmount: string | null
  invoiceHash: string | null
  correctedKsefNumber: string | null
}

export type PurchaseRecordFields = {
  year: number
  month: number
  supplierNip: string | null
  supplierName: string | null
  supplierCountryCode: string | null
  documentNumber: string
  purchaseDate: string
  receiptDate: string | null
  nrKsef: string | null
  netOther: string | null
  vatOther: string | null
}

type ReceivedInvoiceWithDocumentNumber = ReceivedInvoiceFields & {
  readonly invoiceNumber?: unknown
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function textOrEmpty(value: unknown): string {
  return textOrNull(value) ?? ''
}

function dateOnlyOrNull(value: unknown): string | null {
  const text = textOrNull(value)
  if (!text) {
    return null
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function amountOrNull(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toFixed(2) : null
  }

  const text = textOrNull(value)
  if (!text) {
    return null
  }

  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null
}

function attachInvoiceNumber(fields: ReceivedInvoiceFields, invoiceNumber: string | null): ReceivedInvoiceFields {
  if (!invoiceNumber) {
    return fields
  }

  Object.defineProperty(fields, 'invoiceNumber', {
    value: invoiceNumber,
    enumerable: false,
    configurable: true,
  })

  return fields
}

function parsePeriod(date: string | null): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date ?? '')
  if (!match) {
    return { year: 0, month: 0 }
  }

  return { year: Number(match[1]), month: Number(match[2]) }
}

/** Map a KSeF received-invoice metadata record (Subject2 query) -> the ReceivedInvoice entity field set. */
export function mapMetadataToReceivedInvoice(meta: ReceivedInvoiceMetadata): ReceivedInvoiceFields {
  const invoiceNumber = textOrNull(meta.invoiceNumber)
  const issueDate = dateOnlyOrNull(meta.issueDate) ?? dateOnlyOrNull(meta.invoicingDate)
  const fields: ReceivedInvoiceFields = {
    ksefNumber: textOrEmpty(meta.ksefNumber),
    issuerNip: textOrNull(meta.seller?.nip),
    issuerName: textOrNull(meta.seller?.name),
    buyerIdentifierType: textOrNull(meta.buyer?.identifier?.type),
    buyerIdentifierValue: textOrNull(meta.buyer?.identifier?.value),
    issueDate,
    acquisitionDate: dateOnlyOrNull(meta.acquisitionDate),
    invoiceType: textOrNull(meta.invoiceType),
    currency: textOrNull(meta.currency),
    netAmount: amountOrNull(meta.netAmount),
    grossAmount: amountOrNull(meta.grossAmount),
    vatAmount: amountOrNull(meta.vatAmount),
    invoiceHash: textOrNull(meta.invoiceHash),
    correctedKsefNumber: textOrNull(meta.hashOfCorrectedInvoice),
  }

  return attachInvoiceNumber(fields, invoiceNumber)
}

/** Materialize a purchase-ledger record from a stored received invoice (SPEC-015 F1). */
export function mapReceivedInvoiceToPurchaseRecord(received: ReceivedInvoiceFields): PurchaseRecordFields {
  const receivedWithDocument = received as ReceivedInvoiceWithDocumentNumber
  const receiptDate = dateOnlyOrNull(received.acquisitionDate)
  const purchaseDate = dateOnlyOrNull(received.issueDate) ?? receiptDate
  const period = parsePeriod(receiptDate ?? purchaseDate)

  return {
    year: period.year,
    month: period.month,
    supplierNip: textOrNull(received.issuerNip),
    supplierName: textOrNull(received.issuerName),
    supplierCountryCode: null,
    documentNumber: textOrNull(receivedWithDocument.invoiceNumber) ?? textOrEmpty(received.ksefNumber),
    purchaseDate: purchaseDate ?? '',
    receiptDate,
    nrKsef: textOrNull(received.ksefNumber),
    netOther: textOrNull(received.netAmount),
    vatOther: textOrNull(received.vatAmount),
  }
}
