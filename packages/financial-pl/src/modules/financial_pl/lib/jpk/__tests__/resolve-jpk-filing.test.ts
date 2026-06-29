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

describe('resolveJpkFiling — multi-NIP SALES scoping (H4)', () => {
  it('includes only sales invoices whose PL-meta context_nip matches the filing NIP', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6, contextNip: '2481632647' })
    const rows: Rows = {
      'sales:sales_invoice': [
        { id: 'inv-a', invoice_number: 'FV/A', issue_date: '2026-06-10', grand_total_net_amount: '100.0000', tax_total_amount: '23.0000', status: 'issued', document_type: 'invoice', deleted_at: null, metadata: {} },
        { id: 'inv-b', invoice_number: 'FV/B', issue_date: '2026-06-11', grand_total_net_amount: '200.0000', tax_total_amount: '46.0000', status: 'issued', document_type: 'invoice', deleted_at: null, metadata: {} },
      ],
      'sales:sales_invoice_line': [
        { line_number: 1, invoice_id: 'inv-a', total_net_amount: '100.0000', tax_amount: '23.0000', tax_rate: '23.0000', deleted_at: null },
        { line_number: 1, invoice_id: 'inv-b', total_net_amount: '200.0000', tax_amount: '46.0000', tax_rate: '23.0000', deleted_at: null },
      ],
      'financial_pl:ksef_submission': [
        { sales_invoice_id: 'inv-a', document_kind: 'invoice', status: 'accepted', ksef_number: 'A-NR', deleted_at: null, created_at: '2026-06-10' },
        { sales_invoice_id: 'inv-b', document_kind: 'invoice', status: 'accepted', ksef_number: 'B-NR', deleted_at: null, created_at: '2026-06-11' },
      ],
      'financial_pl:sales_invoice_pl_meta': [
        { sales_invoice_id: 'inv-a', context_nip: '2481632647', deleted_at: null },
        { sales_invoice_id: 'inv-b', context_nip: '9999999999', deleted_at: null },
      ],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(filing))
    expect(result.ewidencja!.sprzedaz).toHaveLength(1)
    expect(result.ewidencja!.sprzedaz[0].dowodSprzedazy).toBe('FV/A')
  })
})

describe('resolveJpkFiling — purchase org isolation (M12)', () => {
  it('excludes a purchase record owned by another organization', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const purchases = [
      purchase(6, '100.00', { documentNumber: 'FZ/MINE' }),
      purchase(6, '200.00', { organizationId: 'other-org', documentNumber: 'FZ/OTHER' }),
    ]
    const result = await resolveJpkFiling(deps({}, purchases), args(filing))
    expect(result.ewidencja!.zakup).toHaveLength(1)
    expect(result.ewidencja!.zakup[0].dowodZakupu).toBe('FZ/MINE')
  })
})

describe('resolveJpkFiling — foreign-currency conversion to PLN (H2)', () => {
  const fxRows = (withRate: boolean): Rows => ({
    'sales:sales_invoice': [
      { id: 'inv-1', invoice_number: 'FV/EUR', issue_date: '2026-06-10', currency_code: 'EUR', grand_total_net_amount: '100.0000', tax_total_amount: '23.0000', status: 'issued', document_type: 'invoice', deleted_at: null, metadata: {} },
    ],
    'sales:sales_invoice_line': [
      { line_number: 1, invoice_id: 'inv-1', total_net_amount: '100.0000', tax_amount: '23.0000', tax_rate: '23.0000', deleted_at: null },
    ],
    'financial_pl:ksef_submission': [
      { sales_invoice_id: 'inv-1', document_kind: 'invoice', status: 'accepted', ksef_number: 'NR', deleted_at: null, created_at: '2026-06-10' },
    ],
    'financial_pl:sales_invoice_pl_meta': [
      withRate ? { sales_invoice_id: 'inv-1', exchange_rate: '4.0000', deleted_at: null } : { sales_invoice_id: 'inv-1', deleted_at: null },
    ],
  })

  it('converts a EUR invoice net+VAT to PLN at the meta exchange rate', async () => {
    const result = await resolveJpkFiling(deps(fxRows(true), []), args(makeFiling({ variant: 'V7M', month: 6 })))
    // 100 EUR × 4.0 = 400 PLN (K_19); 23 EUR × 4.0 = 92 PLN (K_20)
    expect(result.ewidencja!.sprzedaz[0].k).toEqual({ K_19: '400.00', K_20: '92.00' })
  })

  it('throws for a foreign-currency invoice with no exchange rate (cannot file a PLN amount)', async () => {
    await expect(resolveJpkFiling(deps(fxRows(false), []), args(makeFiling({ variant: 'V7M', month: 6 })))).rejects.toThrow(
      /exchange_rate|PLN/,
    )
  })
})

describe('resolveJpkFiling — line-less credit memo rate (M1)', () => {
  it('derives the rate from the header magnitude (8%), not the old 23% fallback', async () => {
    const rows: Rows = {
      'sales:sales_invoice': [],
      'sales:sales_credit_memo': [
        { id: 'cm-1', invoice_id: 'inv-orig', credit_memo_number: 'KOR/8', issue_date: '2026-06-20', grand_total_net_amount: '100.0000', tax_total_amount: '8.0000', status: 'issued', deleted_at: null, metadata: {} },
      ],
      'sales:sales_credit_memo_line': [], // no lines → header fallback
      'financial_pl:ksef_submission': [
        { credit_memo_id: 'cm-1', document_kind: 'credit_memo', status: 'accepted', ksef_number: 'MEMO-NR', deleted_at: null, created_at: '2026-06-20' },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(makeFiling({ variant: 'V7M', month: 6 })))
    expect(result.ewidencja!.sprzedaz).toHaveLength(1)
    // |8 / 100| → 8% → K_17/K_18 (negated), NOT K_19/K_20.
    expect(result.ewidencja!.sprzedaz[0].k).toEqual({ K_17: '-100.00', K_18: '-8.00' })
  })
})

describe('resolveJpkFiling — credit-memo gating + NrKSeF (M3 / M4)', () => {
  const invoice = {
    id: 'inv-1',
    invoice_number: 'FV/2026/06/1',
    issue_date: '2026-06-20',
    grand_total_net_amount: '100.0000',
    tax_total_amount: '23.0000',
    status: 'issued',
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

describe('resolveJpkFiling — art. 89a bad-debt relief (M3)', () => {
  it('emits a NEGATED KorektaPodstawyOpodt correction row and aggregates P_68/P_69 (<= 0)', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const rows: Rows = {
      // Original issued in March (NOT in the June normal-sales gather — no double count).
      'sales:sales_invoice': [
        { id: 'inv-orig', invoice_number: 'FV/ORIG', issue_date: '2026-03-10', grand_total_net_amount: '1000.0000', tax_total_amount: '230.0000', status: 'issued', document_type: 'invoice', deleted_at: null, metadata: { buyerSnapshot: { nip: '3755747347', companyName: 'Nabywca' } } },
      ],
      'sales:sales_invoice_line': [
        { line_number: 1, invoice_id: 'inv-orig', total_net_amount: '1000.0000', tax_amount: '230.0000', tax_rate: '23.0000', deleted_at: null },
      ],
      'sales:sales_credit_memo': [],
      'financial_pl:ksef_submission': [
        { sales_invoice_id: 'inv-orig', document_kind: 'invoice', status: 'accepted', ksef_number: 'ORIG-NR', deleted_at: null, created_at: '2026-03-10' },
      ],
      'financial_pl:sales_invoice_pl_meta': [
        { sales_invoice_id: 'inv-orig', bad_debt_relief_period: '2026-06', bad_debt_termin_platnosci: '2026-03-15', deleted_at: null },
      ],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(filing))
    expect(result.ewidencja!.sprzedaz).toHaveLength(1)
    const row = result.ewidencja!.sprzedaz[0]
    expect(row.k).toEqual({ K_19: '-1000.00', K_20: '-230.00' })
    expect(row.korektaPodstawyOpodt).toBe(true)
    expect(row.terminPlatnosci).toBe('2026-03-15')
    // Declaration: bad-debt relief reduces output tax, so P_68/P_69 are negative.
    expect(result.deklaracja!.pozycje.P_68).toBe('-1000')
    expect(result.deklaracja!.pozycje.P_69).toBe('-230')
  })
})

describe('resolveJpkFiling — guards', () => {
  it('skips an invoice with no determinate KSeF marking (pending)', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const rows: Rows = {
      'sales:sales_invoice': [{ id: 'inv-1', invoice_number: 'FV/1', issue_date: '2026-06-10', grand_total_net_amount: '100.0000', tax_total_amount: '23.0000', status: 'issued', document_type: 'invoice', metadata: {} }],
      'sales:sales_credit_memo': [],
      'financial_pl:ksef_submission': [], // no submission ⇒ pending ⇒ skipped
      'financial_pl:sales_invoice_pl_meta': [],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(filing))
    expect(result.ewidencja!.sprzedaz).toHaveLength(0)
  })

  it('H1: a draft (non-issued) invoice is excluded from the register', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6 })
    const rows: Rows = {
      'sales:sales_invoice': [{ id: 'inv-1', invoice_number: 'FV/1', issue_date: '2026-06-10', grand_total_net_amount: '100.0000', tax_total_amount: '23.0000', status: 'draft', document_type: 'invoice', metadata: {} }],
      'sales:sales_credit_memo': [],
      'financial_pl:ksef_submission': [
        { sales_invoice_id: 'inv-1', document_kind: 'invoice', status: 'accepted', ksef_number: 'INV-NR', deleted_at: null, created_at: '2026-06-10' },
      ],
      'financial_pl:sales_invoice_pl_meta': [],
    }
    const result = await resolveJpkFiling(deps(rows, []), args(filing))
    // Even with an accepted KSeF marking, a draft invoice is not yet immutable ⇒ excluded.
    expect(result.ewidencja!.sprzedaz).toHaveLength(0)
  })

  it('throws when the filing has no valid 4-digit KodUrzedu', async () => {
    const filing = makeFiling({ variant: 'V7M', month: 6, kodUrzedu: null })
    await expect(resolveJpkFiling(deps({}, []), args(filing))).rejects.toThrow(/KodUrzedu/)
  })
})
