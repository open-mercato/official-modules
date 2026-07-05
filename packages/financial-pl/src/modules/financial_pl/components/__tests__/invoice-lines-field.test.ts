import {
  computeLineTotals,
  convertLinesPriceMode,
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
