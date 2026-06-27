import { buildFa3Xml, type Fa3Document } from './fa3'
import type { Fa3InvoiceInput } from '../data/validators'

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
    },
    lines: input.lines,
  }
  return buildFa3Xml(document)
}
