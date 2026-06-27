jest.mock('@open-mercato/core/generated-shims/entities.ids.generated', () => ({
  E: {
    sales: {
      sales_invoice: 'sales:sales_invoice',
      sales_invoice_line: 'sales:sales_invoice_line',
      sales_credit_memo: 'sales:sales_credit_memo',
      sales_credit_memo_line: 'sales:sales_credit_memo_line',
    },
  },
  M: {},
}))

import { resolveFa3FromCreditMemo } from '../resolve-fa3-from-credit-memo'
import type { ResolveFa3QueryEngine } from '../resolve-fa3-from-invoice'

type Rows = Record<string, Array<Record<string, unknown>>>

function makeQueryEngine(rowsByEntity: Rows): ResolveFa3QueryEngine {
  return {
    async query(entityId) {
      return { items: rowsByEntity[entityId] ?? [] }
    },
  }
}

const SELLER = { name: 'Sprzedawca Sp. z o.o.', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' }
const ORIGINAL_INVOICE = {
  id: 'inv-1',
  invoice_number: 'FV/2026/06/1',
  issue_date: '2026-06-20',
  currency_code: 'PLN',
  metadata: { buyerSnapshot: { companyName: 'Nabywca Sp. z o.o.', nip: '3755747347', addressLine1: 'ul. Kliencka 2', city: 'Krakow', postalCode: '00-002' } },
}
const CREDIT_MEMO = {
  id: 'cm-1',
  invoice_id: 'inv-1',
  credit_memo_number: 'KOR/2026/06/1',
  reason: 'Zwrot 1 szt',
  issue_date: '2026-06-27',
  currency_code: 'PLN',
  grand_total_net_amount: '40.0000',
  tax_total_amount: '9.2000',
}
const CREDIT_MEMO_LINE = {
  line_number: 1,
  name: 'Usluga',
  quantity: '1',
  quantity_unit: 'szt',
  unit_price_net: '40.0000',
  total_net_amount: '40.0000',
  tax_amount: '9.2000',
  tax_rate: '23.0000',
}

const baseRows = (overrides: Partial<Rows> = {}): Rows => ({
  'sales:sales_credit_memo': [CREDIT_MEMO],
  'sales:sales_invoice': [ORIGINAL_INVOICE],
  'sales:sales_credit_memo_line': [CREDIT_MEMO_LINE],
  'financial_pl:ksef_submission': [],
  'financial_pl:sales_invoice_pl_meta': [],
  ...overrides,
})

const args = { creditMemoId: 'cm-1', organizationId: 'org-1', tenantId: 'ten-1' }

describe('resolveFa3FromCreditMemo', () => {
  it('builds a KOR referencing the in-KSeF original by NrKSeFFaKorygowanej, with NEGATED amounts', async () => {
    const rows = baseRows({
      'financial_pl:ksef_submission': [
        { document_kind: 'invoice', status: 'accepted', ksef_number: '2481632647-20260620-AABBCC-DDEEFF-11', deleted_at: null, created_at: '2026-06-20' },
      ],
    })
    const { invoice, correctedInvoiceId } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER },
      args,
    )
    expect(correctedInvoiceId).toBe('inv-1')
    expect(invoice.invoiceKind).toBe('KOR')
    expect(invoice.correction?.correctedInvoices[0].correctedKsefNumber).toBe('2481632647-20260620-AABBCC-DDEEFF-11')
    expect(invoice.correction?.correctedInvoices[0].correctedInvoiceNumber).toBe('FV/2026/06/1')
    expect(invoice.correction?.reason).toBe('Zwrot 1 szt')
    // Credit memo stores +40.00 / +9.20; the correction files them as negative differences.
    expect(invoice.vatBreakdown[0].net).toBe('-40.00')
    expect(invoice.vatBreakdown[0].vat).toBe('-9.20')
    expect(invoice.totalGross).toBe('-49.20')
    // The reduction sign is on the QUANTITY (−1), with a POSITIVE unit price, and the line
    // net is negative (the standard faktura korygująca representation; P_11 = P_8B × P_9A).
    expect(invoice.lines[0].quantity).toBe('-1')
    expect(invoice.lines[0].unitNetPrice).toBe('40.00')
    expect(invoice.lines[0].netValue).toBe('-40.00')
  })

  it('emits NrKSeFN (no correctedKsefNumber) for an outside-KSeF original when explicitly confirmed', async () => {
    const { invoice } = await resolveFa3FromCreditMemo(
      { queryEngine: makeQueryEngine(baseRows()), contextNip: '2481632647', seller: SELLER },
      { ...args, originalOutsideKsef: true },
    )
    expect(invoice.correction?.correctedInvoices[0].correctedKsefNumber).toBeUndefined()
  })

  it('rejects (409) when the original has a non-accepted submission (never mislabels as legacy)', async () => {
    const rows = baseRows({
      'financial_pl:ksef_submission': [{ document_kind: 'invoice', status: 'processing', ksef_number: null, deleted_at: null, created_at: '2026-06-26' }],
    })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 409, body: { code: 'original_not_accepted' } })
  })

  it('rejects (422) when the original has no KSeF number and is not confirmed outside-KSeF', async () => {
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(baseRows()), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 422, body: { code: 'original_ksef_number_unknown' } })
  })

  it('rejects (422) a credit memo with no reason', async () => {
    const rows = baseRows({ 'sales:sales_credit_memo': [{ ...CREDIT_MEMO, reason: null }] })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, { ...args, originalOutsideKsef: true }),
    ).rejects.toMatchObject({ status: 422, body: { code: 'correction_reason_required' } })
  })

  it('rejects (422) a credit memo not linked to an invoice', async () => {
    const rows = baseRows({ 'sales:sales_credit_memo': [{ ...CREDIT_MEMO, invoice_id: null }] })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 422, body: { code: 'credit_memo_not_linked' } })
  })

  it('rejects (422) a credit memo with no lines', async () => {
    const rows = baseRows({
      'sales:sales_credit_memo_line': [],
      'financial_pl:ksef_submission': [{ document_kind: 'invoice', status: 'accepted', ksef_number: 'X', deleted_at: null, created_at: '2026-06-20' }],
    })
    await expect(
      resolveFa3FromCreditMemo({ queryEngine: makeQueryEngine(rows), contextNip: '2481632647', seller: SELLER }, args),
    ).rejects.toMatchObject({ status: 422, body: { code: 'correction_lines_required' } })
  })
})
