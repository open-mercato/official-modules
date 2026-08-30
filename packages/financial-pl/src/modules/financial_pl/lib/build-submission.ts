import { PAYMENT_METHOD_FORMA_CODE, type Fa3InvoiceInput, type InvoicePaymentInput } from '../data/validators'
import { buildFa3Xml, type Fa3Document, type Fa3Payment } from './fa3'

function mapPaymentInputToModel(p: InvoicePaymentInput): Fa3Payment {
  const common = {
    terminDate: p.terminDate ?? undefined,
    paidDate: p.paid ? (p.paidDate ?? undefined) : undefined,
    bankAccount: p.bankAccount ?? undefined,
    bankName: p.bankName ?? undefined,
    swift: p.swift ?? undefined,
  }
  if (p.method === 'other') {
    return {
      ...common,
      otherDescription: p.methodOther ?? undefined,
    }
  }
  return {
    ...common,
    formaCode: PAYMENT_METHOD_FORMA_CODE[p.method],
  }
}

/** Build the FA(3) XML document from a validated invoice payload. */
export function buildFa3XmlFromInput(input: Fa3InvoiceInput, opts: { systemInfo?: string } = {}): string {
  const document: Fa3Document = {
    model: {
      // buildFa3Xml normalises DataWytworzeniaFa to a second-precision xsd:dateTime
      // (drops the milliseconds fraction the strict FA(3) XSD rejects), so passing the raw
      // ISO instant here is fine.
      createdAt: new Date().toISOString(),
      systemInfo: opts.systemInfo ?? 'Open Mercato',
      seller: input.seller,
      buyer: input.buyer,
      invoiceNumber: input.invoiceNumber,
      issueDate: input.issueDate,
      saleDate: input.saleDate,
      currencyCode: input.currencyCode,
      invoiceKind: input.invoiceKind,
      vatBreakdown: input.vatBreakdown,
      totalGross: input.totalGross,
      annotations: input.annotations,
      correction: input.correction,
      // Advanced document-type blocks (SPEC-009) — MUST be threaded through or ZAL files with
      // no Zamowienie (and throws "must have at least one line"), ROZ files with no
      // FakturaZaliczkowa, and KOR_ZAL drops its corrected order. The serializer emits each only
      // when present, so a plain VAT/KOR document is byte-identical.
      advancePayments: input.advancePayments,
      advanceInvoiceRefs: input.advanceInvoiceRefs,
      order: input.order,
      selfBilling: input.selfBilling,
      payment: input.payment ? mapPaymentInputToModel(input.payment) : undefined,
    },
    lines: input.lines,
  }
  return buildFa3Xml(document)
}
