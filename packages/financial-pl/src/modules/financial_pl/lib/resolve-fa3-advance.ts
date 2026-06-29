import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Fa3InvoiceInput } from '../data/validators'
import {
  asString,
  buildAdvancePayments,
  buildZamowienie,
  scaled4ToMoney2dp,
  toScaled4,
  type Fa3MappingDeps,
} from './fa3-mapping'

const ADVANCE_DATA_REQUIRED_DEFAULT =
  'An advance invoice (ZAL) requires the order (Zamowienie) data. Set the order snapshot before submitting it to KSeF.'

/**
 * Resolve the ZAL-specific FA(3) fragment for an advance (faktura zaliczkowa, art. 106f ust. 4):
 * the `Zamowienie` order block (from the PL-meta `order_snapshot`), the `ZaliczkaCzesciowa`
 * received-payment rows (from `advance_payments`), and `P_15` (`totalGross`) = the amount PAID
 * documented by this advance = Σ of the received-payment amounts. FaWiersz is OPTIONAL for a ZAL —
 * the line detail lives in the order block — so a ZAL with no first-class lines is valid.
 */
export function resolveFa3Advance(
  meta: Record<string, unknown> | undefined,
  deps: Fa3MappingDeps,
): {
  order: NonNullable<Fa3InvoiceInput['order']>
  advancePayments: Fa3InvoiceInput['advancePayments']
  paidGross: string
} {
  const order = buildZamowienie(meta?.order_snapshot)
  if (!order) {
    const message =
      deps.translate?.('financial_pl.errors.advance_data_required', ADVANCE_DATA_REQUIRED_DEFAULT) ??
      ADVANCE_DATA_REQUIRED_DEFAULT
    throw new CrudHttpError(422, { error: message, code: 'advance_data_required' })
  }
  const advancePayments = buildAdvancePayments(meta?.advance_payments)
  // P_15 on a ZAL is the AMOUNT PAID this invoice documents = Σ ZaliczkaCzesciowa/P_15Z, computed
  // with the shared BigInt money math so the document is internally consistent by construction.
  const paidScaled = advancePayments.reduce((sum, payment) => sum + toScaled4(payment.amount), 0n)
  const paidGross = scaled4ToMoney2dp(paidScaled)
  return { order, advancePayments, paidGross }
}

/** Resolve the optional per-invoice FX rate carried on the PL-meta (→ KursWaluty / P_14_xW). */
export function resolveMetaExchangeRate(meta: Record<string, unknown> | undefined): string | undefined {
  return asString(meta?.exchange_rate) ?? undefined
}
