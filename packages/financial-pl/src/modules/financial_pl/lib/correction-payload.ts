/**
 * Pure builder for the correction (KOR) credit-memo create body posted to core
 * `POST /api/sales/credit-memos`. Extracted from the client `CorrectionForm` so the integration
 * suite can drive the EXACT payload the form produces without pulling React/UI into the test runtime.
 *
 * Contract (core `creditMemoCreateSchema`): top-level `currencyCode` is REQUIRED and `issueDate` is
 * accepted; each line REQUIRES `currencyCode` and a non-negative `quantity` (`decimal({ min: 0 })`,
 * so a negated quantity is rejected with 422 — credit-memo semantics come from the document type,
 * not from negative quantities). `name` is optional but always carried for FA(3) KOR serialization.
 */

/** Structural shape of a correction line (a superset-compatible subset of `InvoiceLineInput`). */
export type CorrectionLineInput = {
  name: string
  quantity: string
  quantityUnit?: string
  unitPriceNet?: string
  taxRate?: string
  taxAmount?: string
  totalNetAmount?: string
  totalGrossAmount?: string
  currencyCode: string
  lineNumber?: number
}

/** Shape of the credit-memo create body posted to `POST /api/sales/credit-memos`. */
export type CreditMemoCreatePayload = {
  invoiceId: string
  reason: string
  currencyCode: string
  issueDate: string
  lines: Array<{
    name: string
    quantity: string
    quantityUnit?: string
    unitPriceNet?: string
    taxRate?: string
    taxAmount?: string
    totalNetAmount?: string
    totalGrossAmount?: string
    currencyCode: string
    lineNumber: number
  }>
}

/**
 * Build the exact credit-memo create body. Includes the required top-level `currencyCode` +
 * `issueDate`, and the required per-line `currencyCode` + non-negative `quantity`, so it satisfies
 * core's `creditMemoCreateSchema`. A blank/empty `currencyCode` (top-level or per-line) defaults to
 * `PLN` so the `/^[A-Z]{3}$/` validator never 422s on a null-currency invoice.
 */
export function buildCreditMemoPayload(input: {
  invoiceId: string
  reason: string
  currencyCode: string
  lines: CorrectionLineInput[]
  issueDate?: string
}): CreditMemoCreatePayload {
  const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10)
  // core's currencyCode validator requires /^[A-Z]{3}$/, so a blank/empty value would 422.
  // Default to PLN (the only statutory settlement currency for a Polish KOR) both top-level
  // and per-line when the caller leaves it empty.
  const currencyCode = input.currencyCode.trim() || 'PLN'
  return {
    invoiceId: input.invoiceId,
    reason: input.reason,
    currencyCode,
    issueDate,
    lines: input.lines.map((line, index) => {
      const row: CreditMemoCreatePayload['lines'][number] = {
        name: line.name,
        quantity: line.quantity,
        currencyCode: line.currencyCode.trim() || currencyCode,
        lineNumber: line.lineNumber ?? index + 1,
      }
      if (line.quantityUnit && line.quantityUnit.trim()) row.quantityUnit = line.quantityUnit.trim()
      if (line.unitPriceNet != null && line.unitPriceNet !== '') row.unitPriceNet = line.unitPriceNet
      if (line.taxRate != null && line.taxRate !== '') row.taxRate = line.taxRate
      if (line.taxAmount) row.taxAmount = line.taxAmount
      if (line.totalNetAmount) row.totalNetAmount = line.totalNetAmount
      if (line.totalGrossAmount) row.totalGrossAmount = line.totalGrossAmount
      return row
    }),
  }
}
