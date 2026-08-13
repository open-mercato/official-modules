import {
  computeLineTotals,
  convertLinesPriceMode,
  normalizeStoredLine,
  type InvoiceLineInput,
} from '../InvoiceLinesField'
import { applyMarginSchemeToMeta } from '../PlVatMetaForm'

const baseLine: InvoiceLineInput = {
  name: 'Towar',
  quantity: '2',
  quantityUnit: 'szt.',
  unitPriceNet: '100.00',
  unitPriceGross: '123.00',
  taxRate: '23',
  currencyCode: 'PLN',
  kind: 'product',
}

describe('InvoiceLinesField pricing helpers', () => {
  it('computes discount-aware totals in net mode', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '10' }, 'net')

    expect(totals.discountAmount).toBe('20.00')
    expect(totals.totalNetAmount).toBe('180.00')
    expect(totals.taxAmount).toBe('41.40')
    expect(totals.totalGrossAmount).toBe('221.40')
  })

  it('computes discount-aware totals in gross mode using VAT-from-gross math', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '10' }, 'gross')

    expect(totals.discountAmount).toBe('24.60')
    expect(totals.totalGrossAmount).toBe('221.40')
    expect(totals.taxAmount).toBe('41.40')
    expect(totals.totalNetAmount).toBe('180.00')
  })

  it('round-trips 123.00 gross at 23% to 100.00 net and back', () => {
    const grossLines = convertLinesPriceMode([{ ...baseLine, unitPriceNet: '100.00', unitPriceGross: '' }], 'gross')
    expect(grossLines[0]?.unitPriceGross).toBe('123.00')

    const netLines = convertLinesPriceMode([{ ...grossLines[0]!, unitPriceGross: '123.00' }], 'net')
    expect(netLines[0]?.unitPriceNet).toBe('100.00')
    expect(netLines[0]?.unitPriceGross).toBe('123.00')
  })

  it('treats marża as gross-only and sets the matching MR marking', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '10' }, 'net', 'used_goods')
    expect(totals.taxAmount).toBe('')
    expect(totals.totalNetAmount).toBe('221.40')
    expect(totals.totalGrossAmount).toBe('221.40')

    const meta = applyMarginSchemeToMeta({ procedureMarkings: { TP: true, MR_T: true } }, 'used_goods')
    expect(meta.marginScheme).toBe('used_goods')
    expect(meta.marginVatRate).toBe(23)
    expect(meta.procedureMarkings).toEqual({ TP: true, MR_T: false, MR_UZ: true })
  })
})

describe('InvoiceLinesField — QA #36: DB full-scale stored decimals must not blank totals', () => {
  // A persisted discount comes back at full DB scale ("0.0000"/"12.5000"). Previously the ≤2-decimal
  // validator rejected it, parseDiscountPercent returned null, and computeLineTotals blanked every
  // total. It must now parse (trailing zeros normalized) and compute for standard, gross, and margin.
  it('standard (net): a "0.0000" discount computes instead of blanking', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '0.0000' }, 'net')
    expect(totals.discountAmount).toBe('0.00')
    expect(totals.totalNetAmount).toBe('200.00')
    expect(totals.taxAmount).toBe('46.00')
    expect(totals.totalGrossAmount).toBe('246.00')
  })

  it('standard (net): a "12.5000" discount computes at 12.5%', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '12.5000' }, 'net')
    expect(totals.discountAmount).toBe('25.00')
    expect(totals.totalNetAmount).toBe('175.00')
    expect(totals.totalGrossAmount).toBe('215.25')
  })

  it('gross mode: a "0.0000" discount computes VAT-from-gross', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '0.0000' }, 'gross')
    expect(totals.totalGrossAmount).toBe('246.00')
    expect(totals.taxAmount).toBe('46.00')
    expect(totals.totalNetAmount).toBe('200.00')
  })

  it('margin scheme: a "0.0000" discount computes gross-only', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '0.0000' }, 'net', 'used_goods')
    expect(totals.taxAmount).toBe('')
    expect(totals.totalGrossAmount).toBe('246.00')
    expect(totals.totalNetAmount).toBe('246.00')
  })

  it('normalizeStoredLine trims DB-scale decimals to displayable scale', () => {
    const line = normalizeStoredLine({
      ...baseLine,
      quantity: '2.0000',
      unitPriceNet: '100.0000',
      discountPercent: '0.0000',
      discountAmount: '0.00',
    })
    expect(line.quantity).toBe('2')
    expect(line.unitPriceNet).toBe('100')
    expect(line.discountPercent).toBe('0')
  })

  it('rejects (blanks) a genuinely over-precise discount rather than silently rounding it', () => {
    const totals = computeLineTotals({ ...baseLine, discountPercent: '12.567' }, 'net')
    expect(totals.totalNetAmount).toBe('')
  })

  it('normalizeStoredLine strips trailing zeros WITHOUT rounding (over-precise value preserved)', () => {
    const line = normalizeStoredLine({ ...baseLine, discountPercent: '12.567', unitPriceNet: '100.5000' })
    expect(line.discountPercent).toBe('12.567')
    expect(line.unitPriceNet).toBe('100.5')
  })
})
