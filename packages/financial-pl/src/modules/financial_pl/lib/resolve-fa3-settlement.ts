import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Fa3InvoiceInput } from '../data/validators'
import { buildAdvanceRefs, scaled4ToMoney2dp, toScaled4, type Fa3MappingDeps } from './fa3-mapping'

const SETTLEMENT_REFS_REQUIRED_DEFAULT =
  'A settlement invoice (ROZ) requires references to the prior advance invoices it nets. Set the advance references before submitting it to KSeF.'

/**
 * Resolve the ROZ-specific FA(3) fragment for a settlement (faktura rozliczeniowa/końcowa,
 * art. 106f ust. 3): the `FakturaZaliczkowa` references to the prior advances (from the PL-meta
 * `advance_refs`) and `P_15` (`totalGross`) = the RESIDUAL amount remaining to pay = the full
 * invoice gross (from the emitted VAT buckets) − Σ of the already-invoiced advances.
 *
 * The netting invariant `ROZ P_15 = full gross − Σ advances` is asserted here (the residual is
 * never negative) and re-derived with the shared BigInt money math so it reconciles exactly with
 * the summary the serializer emits.
 */
export function resolveFa3Settlement(
  meta: Record<string, unknown> | undefined,
  fullGross: string,
  deps: Fa3MappingDeps,
): {
  advanceInvoiceRefs: NonNullable<Fa3InvoiceInput['advanceInvoiceRefs']>
  residualGross: string
} {
  const advanceInvoiceRefs = buildAdvanceRefs(meta?.advance_refs)
  if (advanceInvoiceRefs.length === 0) {
    const message =
      deps.translate?.('financial_pl.errors.settlement_refs_required', SETTLEMENT_REFS_REQUIRED_DEFAULT) ??
      SETTLEMENT_REFS_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'settlement_refs_required' })
  }

  // Σ advances from the same PL-meta snapshot that drives the FakturaZaliczkowa references. Each
  // advance ref optionally carries the already-invoiced gross amount (`amount`/`grossAmount`); when
  // none is present the residual equals the full gross (no prior advance amount to net).
  const advanceRows = Array.isArray(meta?.advance_refs) ? (meta?.advance_refs as unknown[]) : []
  const advancesScaled = advanceRows.reduce<bigint>((sum, raw) => {
    if (!raw || typeof raw !== 'object') return sum
    const row = raw as Record<string, unknown>
    const amount = row.amount ?? row.grossAmount ?? row.gross_amount ?? row.value
    return amount === undefined || amount === null ? sum : sum + toScaled4(amount)
  }, 0n)

  const residualScaled = toScaled4(fullGross) - advancesScaled
  if (residualScaled < 0n) {
    const message =
      deps.translate?.('financial_pl.errors.settlement_refs_required', SETTLEMENT_REFS_REQUIRED_DEFAULT) ??
      SETTLEMENT_REFS_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'settlement_refs_required' })
  }

  return { advanceInvoiceRefs, residualGross: scaled4ToMoney2dp(residualScaled) }
}
