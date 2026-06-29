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

import { resolveJpkFiling, type ResolveJpkDeps } from '../resolve-jpk-filing'
import type { JpkVatFiling } from '../../../data/entities'

type Row = Record<string, unknown>
type Rows = Record<string, Row[]>

// Minimal filter matcher honouring the $eq/$gte/$lte/$in operators the resolver uses, so a
// period (issue_date range) / document_kind / id lookup returns only the matching rows.
function matchesFilters(row: Row, filters: Record<string, unknown> = {}): boolean {
  for (const [field, cond] of Object.entries(filters)) {
    const v = row[field]
    if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>
      if ('$eq' in c && v !== c.$eq) return false
      if ('$gte' in c && !(typeof v === 'string' && v >= (c.$gte as string))) return false
      if ('$lte' in c && !(typeof v === 'string' && v <= (c.$lte as string))) return false
      if ('$in' in c && !(c.$in as unknown[]).includes(v)) return false
    } else if (v !== cond) {
      return false
    }
  }
  return true
}

function makeQueryEngine(rowsByEntity: Rows): ResolveJpkDeps['queryEngine'] {
  return {
    async query(entityId: string, opts: Record<string, unknown>) {
      const filters = (opts?.filters as Record<string, unknown>) ?? {}
      let items = (rowsByEntity[entityId] ?? []).filter((r) => matchesFilters(r, filters))
      const sort = (opts?.sort as Array<{ field: string; dir: 'asc' | 'desc' }>) ?? []
      if (sort.length) {
        const { field, dir } = sort[0]
        items = [...items].sort((a, b) => {
          const av = String(a[field] ?? '')
          const bv = String(b[field] ?? '')
          return dir === 'desc' ? (av < bv ? 1 : av > bv ? -1 : 0) : av < bv ? -1 : av > bv ? 1 : 0
        })
      }
      return { items }
    },
  } as ResolveJpkDeps['queryEngine']
}

// Stub EntityManager.find(PurchaseVatRecord, where): filters the in-memory purchase rows by the
// scope/period (and contextNip when the resolver narrows by NIP).
function makeEm(purchaseRows: Row[]): ResolveJpkDeps['em'] {
  return {
    async find(_entity: unknown, where: Record<string, unknown>) {
      return purchaseRows.filter((r) => {
        if (where.organizationId !== undefined && r.organizationId !== where.organizationId) return false
        if (where.tenantId !== undefined && r.tenantId !== where.tenantId) return false
        if (where.year !== undefined && r.year !== where.year) return false
        if (where.month !== undefined && r.month !== where.month) return false
        if (where.deletedAt === null && r.deletedAt != null) return false
        if (where.contextNip !== undefined && r.contextNip !== where.contextNip) return false
        return true
      })
    },
  } as unknown as ResolveJpkDeps['em']
}

function deps(rows: Rows, purchases: Row[]): ResolveJpkDeps {
  return {
    queryEngine: makeQueryEngine(rows),
    em: makeEm(purchases),
    contextNip: '2481632647',
    seller: { name: 'Sprzedawca Sp. z o.o.' },
  } as ResolveJpkDeps
}

function makeFiling(overrides: Partial<JpkVatFiling>): JpkVatFiling {
  return {
    variant: 'V7M',
    year: 2026,
    month: 6,
    quarter: null,
    celZlozenia: 1,
    correctionScope: 'both',
    kodUrzedu: '0202',
    contextNip: null,
    declarationInputs: null,
    ...overrides,
  } as JpkVatFiling
}

const ORG = 'org-1'
const TEN = 'ten-1'
const args = (filing: JpkVatFiling) => ({ filing, organizationId: ORG, tenantId: TEN })

// A captured purchase record with deductible "other" VAT (K_42/K_43 → P_42/P_43 → P_48).
function purchase(month: number, vatOther: string, extra: Partial<Row> = {}): Row {
  return {
    organizationId: ORG,
    tenantId: TEN,
    year: 2026,
    month,
    contextNip: null,
    documentNumber: `FZ/${month}`,
    purchaseDate: `2026-0${month}-10`,
    imp: false,
    transactionClass: 'domestic',
    netOther: '1000.00',
    vatOther,
    deletedAt: null,
    ...extra,
  }
}

describe('resolveJpkFiling — V7M / V7K declaration emission (H3)', () => {
  it('V7M: emits a Deklaracja for the filing month', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const result = await resolveJpkFiling(deps({}, [purchase(6, '100.00')]), args(filing))
    expect(result.deklaracja).toBeDefined()
    expect(result.ewidencja!.zakup).toHaveLength(1)
    // Single month: P_48 (input tax total) = the one row's K_43.
    expect(result.deklaracja!.pozycje.P_48).toBe('100')
  })

  it('V7K month 1: Ewidencja only — NO Deklaracja (evidence-only filing)', async () => {
    const filing = makeFiling({ variant: 'V7K', month: 1, quarter: 1 })
    const result = await resolveJpkFiling(deps({}, [purchase(1, '100.00')]), args(filing))
    expect(result.deklaracja).toBeUndefined()
    expect(result.ewidencja!.zakup).toHaveLength(1)
  })

  it('V7K month 3: Deklaracja aggregates the WHOLE quarter; Ewidencja stays month-3 only', async () => {
    const filing = makeFiling({ variant: 'V7K', month: 3, quarter: 1 })
    const purchases = [purchase(1, '100.00'), purchase(2, '100.00'), purchase(3, '100.00')]
    const result = await resolveJpkFiling(deps({}, purchases), args(filing))
    expect(result.deklaracja).toBeDefined()
    expect(result.deklaracja!.kwartal).toBe(1)
    // Declaration sums all three months; the Ewidencja + its control sum cover only month 3.
    expect(result.deklaracja!.pozycje.P_48).toBe('300')
    expect(result.ewidencja!.zakup).toHaveLength(1)
    expect(result.ewidencja!.zakupCtrl.podatek).toBe('100.00')
  })
})

describe('resolveJpkFiling — multi-NIP purchase scoping (H4)', () => {
  it('narrows the purchase register to the filing contextNip', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 5, contextNip: '2481632647' })
    const purchases = [
      purchase(5, '100.00', { contextNip: '2481632647', documentNumber: 'FZ/A' }),
      purchase(5, '200.00', { contextNip: '9999999999', documentNumber: 'FZ/B' }),
    ]
    const result = await resolveJpkFiling(deps({}, purchases), args(filing))
    expect(result.ewidencja!.zakup).toHaveLength(1)
    expect(result.ewidencja!.zakup[0].dowodZakupu).toBe('FZ/A')
    // Podmiot1 NIP is the filing's own NIP.
    expect(result.podmiot1.nip).toBe('2481632647')
  })
})

describe('resolveJpkFiling — credit-memo gating + NrKSeF (M3 / M4)', () => {
  const invoice = {
    id: 'inv-1',
    invoice_number: 'FV/2026/06/1',
    issue_date: '2026-06-20',
    grand_total_net_amount: '100.0000',
    tax_total_amount: '23.0000',
    is_immutable: true,
    document_type: 'invoice',
    deleted_at: null,
    metadata: { buyerSnapshot: { nip: '3755747347', companyName: 'Nabywca' } },
  }

  it('M3: a draft credit memo is excluded from the register', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const rows: Rows = {
      'sales:sales_invoice': [invoice],
      'sales:sales_invoice_line': [
        { line_number: 1, invoice_id: 'inv-1', total_net_amount: '100.0000', tax_amount: '23.0000', tax_rate: '23.0000', deleted_at: null },
      ],
      'sales:sales_credit_memo': [
        { id: 'cm-1', invoice_id: 'inv-1', credit_memo_number: 'KOR/1', issue_date: '2026-06-27', grand_total_net_amount: '40.0000', tax_total_amount: '9.2000', status: 'draft', deleted_at: null },
      ],
      'sales:sales_credit_memo_line': [
        { line_number: 1, credit_memo_id: 'cm-1', total_net_amount: '40.0000', tax_amount: '9.2000', tax_rate: '23.0000', deleted_at: null },
      ],
      'financial_pl:ksef_submission': [
        { sales_invoice_id: 'inv-1', document_kind: 'invoice', status: 'accepted', ksef_number: 'INV-NR', deleted_at: null, created_at: '2026-06-20' },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(filing))
    // Only the invoice row — the draft memo is gated out.
    expect(result.ewidencja!.sprzedaz).toHaveLength(1)
    expect(result.ewidencja!.sprzedaz[0].dowodSprzedazy).toBe('FV/2026/06/1')
  })

  it('M4: a finalized memo reports its OWN credit_memo NrKSeF, not the original invoice number', async () => {
    // Original issued in a prior month (not gathered as an invoice this period); memo issued in-period.
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const rows: Rows = {
      'sales:sales_invoice': [],
      'sales:sales_credit_memo': [
        { id: 'cm-1', invoice_id: 'inv-1', credit_memo_number: 'KOR/1', issue_date: '2026-06-27', grand_total_net_amount: '40.0000', tax_total_amount: '9.2000', status: 'issued', deleted_at: null },
      ],
      'sales:sales_credit_memo_line': [
        { line_number: 1, credit_memo_id: 'cm-1', total_net_amount: '40.0000', tax_amount: '9.2000', tax_rate: '23.0000', deleted_at: null },
      ],
      'financial_pl:ksef_submission': [
        { credit_memo_id: 'cm-1', document_kind: 'credit_memo', status: 'accepted', ksef_number: 'MEMO-NR', deleted_at: null, created_at: '2026-06-27' },
        { sales_invoice_id: 'inv-1', document_kind: 'invoice', status: 'accepted', ksef_number: 'INV-NR', deleted_at: null, created_at: '2026-06-20' },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(filing))
    expect(result.ewidencja!.sprzedaz).toHaveLength(1)
    const node = result.ewidencja!.sprzedaz[0].ksef
    expect(node.kind).toBe('NrKSeF')
    expect(node.kind === 'NrKSeF' ? node.value : '').toBe('MEMO-NR')
  })
})

describe('resolveJpkFiling — guards', () => {
  it('skips an invoice with no determinate KSeF marking (pending)', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const rows: Rows = {
      'sales:sales_invoice': [{ id: 'inv-1', invoice_number: 'FV/1', issue_date: '2026-06-10', grand_total_net_amount: '100.0000', tax_total_amount: '23.0000', is_immutable: true, document_type: 'invoice', metadata: {} }],
      'sales:sales_credit_memo': [],
      'financial_pl:ksef_submission': [], // no submission ⇒ pending ⇒ skipped
      'financial_pl:sales_invoice_pl_meta': [],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(filing))
    expect(result.ewidencja!.sprzedaz).toHaveLength(0)
  })

  it('throws when the filing has no valid 4-digit KodUrzedu', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6, kodUrzedu: null })
    await expect(resolveJpkFiling(deps({}, []), args(filing))).rejects.toThrow(/KodUrzedu/)
  })
})
