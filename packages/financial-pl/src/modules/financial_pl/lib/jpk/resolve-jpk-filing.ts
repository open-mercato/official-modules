/**
 * Resolve a complete `BuildJpkXmlInput` for a single JPK_V7M/V7K(3) filing (SPEC-012). Mirrors the
 * FA(3) resolvers (`resolve-fa3-from-invoice` / `-from-credit-memo`): sales data is read ONLY through
 * the platform query engine (no cross-module ORM relation, §4); the buyer-side evidence is read from
 * the local `PurchaseVatRecord` table via the EntityManager.
 *
 * Pipeline:
 *   (1) Sales invoices issued in the period → per-rate vatBreakdown (shared `buildVatBreakdown`) →
 *       `buildSprzedazRow`. Each invoice's KSeF node is derived from its latest invoice submission +
 *       PL-meta (`deriveJpkVatMarking`); a still-undetermined (pending) marking is skipped — an
 *       un-markable invoice cannot lawfully appear in the register. Purely-OSS invoices are excluded.
 *   (2) Credit memos issued in the period → `buildSprzedazRow` with SIGNED (negated) buckets.
 *   (3) `PurchaseVatRecord` rows for (org, tenant, year, month) → `buildZakupRows`; collect the zakup
 *       rows + any self-assessment sprzedaz rows (WNT / import / reverse-charge output side).
 *   (4) `computeJpkDeclaration` over all rows + the filing's declaration inputs.
 *   (5) podmiot1 from contextNip + the credential seller identity + email.
 *   (6) Assemble `BuildJpkXmlInput`.
 *
 * Pure-ish: the only I/O is the query engine + the EntityManager reads; the math lives in the shared
 * builders so the XML and the declaration are internally consistent by construction.
 */
import { E } from '@open-mercato/core/generated-shims/entities.ids.generated'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { EntityManager } from '@mikro-orm/postgresql'
import { PurchaseVatRecord, type JpkVatFiling } from '../../data/entities'
import {
  asRecord,
  asString,
  buildVatBreakdown,
  lineCarriesTaxRate,
  normalizeMarginScheme,
  scaled4ToMoney2dp,
  toIsoDate,
  toScaled4,
  type Fa3MappingDeps,
  type InvoiceLineRow,
  type InvoiceRow,
} from '../fa3-mapping'
import { deriveJpkVatMarking } from '../jpk-vat-marking'
import { type ResolveFa3QueryEngine } from '../resolve-fa3-from-invoice'
import { resolveMetaExchangeRate } from '../resolve-fa3-advance'
import { isInvoiceIssued } from '../invoice-status'
import type { BuildJpkXmlInput, JpkPodmiot1 } from './build-jpk-xml'
import { buildSprzedazRow, type BuildSprzedazInput, type JpkVatBucket } from './build-sprzedaz'
import { buildZakupRows, type JpkTransactionClass } from './build-zakup'
import { computeJpkDeclaration, type JpkCtrlSums, type JpkDeclarationInputs } from './compute-declaration'
import type {
  JpkKsefNode,
  JpkSprzedazRow,
  JpkZakupRow,
  JpkTypDokumentu,
  JpkSprzedazProcedure,
  JpkDokumentZakupu,
  JpkDeclaration,
} from './jpk-codes'

// The query-engine surface is identical to the FA(3) resolvers'; re-exported under the JPK name so
// the command can `resolve('queryEngine') as ResolveJpkQueryEngine` (matches the FA(3) call site).
export type ResolveJpkQueryEngine = ResolveFa3QueryEngine

export type ResolveJpkDeps = Fa3MappingDeps & {
  queryEngine: ResolveJpkQueryEngine
  /** Forked EntityManager for the local PurchaseVatRecord reads. */
  em: EntityManager
  /** Podmiot1 email (declaration contact); falls back to a synthetic NIP-based address. */
  email?: string
}

export type ResolveJpkArgs = {
  filing: JpkVatFiling
  organizationId: string
  tenantId: string
}

/** Earliest DataWytworzeniaJPK accepted by the JPK(3) XSD (brochure: schema live from 2026-02-01). */
const MIN_DATA_WYTWORZENIA = Date.parse('2026-02-01T00:00:00Z')

/** PL-meta procedure-boolean column → the JPK SprzedazWiersz procedure marker (XSD order in codes). */
const META_PROCEDURE_FIELDS: Array<[keyof MetaRow, JpkSprzedazProcedure]> = [
  ['wsto_ee', 'WSTO_EE'],
  ['ied', 'IED'],
  ['tp', 'TP'],
  ['tt_wnt', 'TT_WNT'],
  ['tt_d', 'TT_D'],
  ['mr_t', 'MR_T'],
  ['mr_uz', 'MR_UZ'],
  ['i_42', 'I_42'],
  ['i_63', 'I_63'],
  ['b_spv', 'B_SPV'],
  ['b_spv_dostawa', 'B_SPV_DOSTAWA'],
  ['b_mpv_prowizja', 'B_MPV_PROWIZJA'],
]

type MetaRow = Record<string, unknown>

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const text = asString(value)
  return text === 'true' || text === '1'
}

/** Format a 4-dp-scaled BigInt back to a signed decimal string with 4 fraction digits, so the
 *  shared `buildVatBreakdown` (`toScaled4`) re-parses it exactly (no precision loss before summing). */
function scaled4ToString4dp(scaled4: bigint): string {
  const negative = scaled4 < 0n
  const magnitude = negative ? -scaled4 : scaled4
  const whole = magnitude / 10000n
  const frac = (magnitude % 10000n).toString().padStart(4, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`
}

/** Convert a numeric(18,4) amount to PLN at the given 4-dp-scaled FX rate, returning a 4-dp string
 *  (amount[4dp] × fx[4dp] = 8dp → /1e4 = 4dp). JPK_V7 amounts are statutorily in PLN. */
function toPlnString4dp(amount: unknown, fxScaled4: bigint): string {
  return scaled4ToString4dp((toScaled4(amount) * fxScaled4) / 10000n)
}

function readMarginVatRate(value: unknown): 0 | 5 | 8 | 23 {
  const numeric = typeof value === 'number' ? value : Number(asString(value))
  return numeric === 0 || numeric === 5 || numeric === 8 || numeric === 23 ? numeric : 23
}

function buildMarginVatBreakdown(meta: MetaRow | undefined, signedGross: string): JpkVatBucket[] {
  const purchaseCost = asString(meta?.margin_purchase_cost)
  if (!purchaseCost) return []
  const marginScaled = toScaled4(signedGross) - toScaled4(purchaseCost)
  if (marginScaled <= 0n) return []
  const rate = readMarginVatRate(meta?.margin_vat_rate)
  const baseScaled = rate === 0 ? marginScaled : (marginScaled * 100n) / BigInt(100 + rate)
  const base = scaled4ToMoney2dp(baseScaled)
  const vat = scaled4ToMoney2dp(marginScaled - toScaled4(base))
  return [{ rate, net: base, vat }]
}

/** Read the buyer/supplier party from a sales document's plaintext `metadata.buyerSnapshot`. */
function readBuyer(invoice: InvoiceRow): BuildSprzedazInput['buyer'] {
  const metadata = asRecord(invoice.metadata)
  const snapshot = asRecord(metadata.buyerSnapshot ?? metadata.buyer)
  return {
    nip: asString(snapshot.nip ?? snapshot.taxId ?? snapshot.tax_id),
    name:
      asString(snapshot.companyName) ?? asString(snapshot.company_name) ?? asString(snapshot.name),
    countryCode: asString(snapshot.countryCode ?? snapshot.country_code ?? snapshot.country),
  }
}

/** Page through sales-document lines for one document id (mirrors the FA(3) resolver's loop). */
async function loadLines(
  queryEngine: ResolveJpkQueryEngine,
  scope: { tenantId: string; organizationIds: Array<string | null> },
  entityId: string,
  idField: string,
  documentId: string,
): Promise<InvoiceLineRow[]> {
  const rows: InvoiceLineRow[] = []
  const pageSize = 100
  for (let page = 1; ; page++) {
    const res = await queryEngine.query<InvoiceLineRow>(entityId, {
      ...scope,
      filters: { [idField]: { $eq: documentId }, deleted_at: { $eq: null } },
      page: { page, pageSize },
      sort: [{ field: 'line_number', dir: 'asc' }],
    })
    const batch = res.items ?? []
    rows.push(...batch)
    if (batch.length < pageSize) break
  }
  return rows
}

/** First/last day of the filing period as `YYYY-MM-DD` strings, for the issue-date range filter. */
function periodRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` }
}

/**
 * Derive the JPK KSeF node for a sales document from a KSeF submission keyed by `lookup` + PL-meta.
 * Returns `null` when the marking is still pending (queued/processing/no submission) — such a row is
 * not yet lawfully reportable and is skipped (the caller may then fall back to another source).
 *
 * `useMetaKsefFallback` controls whether the PL-meta's own ksef_status/ksef_number may stand in when
 * there is no submission. It is `true` for an invoice (the meta belongs to that invoice) and `false`
 * for a credit memo's OWN lookup (the meta belongs to the corrected ORIGINAL invoice — using its
 * number for the memo would report the wrong NrKSeF).
 */
async function resolveSubmissionMarking(
  deps: ResolveJpkDeps,
  scope: { tenantId: string; organizationIds: Array<string | null> },
  lookup: { idField: 'sales_invoice_id' | 'credit_memo_id'; id: string; documentKind: 'invoice' | 'credit_memo' },
  meta: MetaRow | undefined,
  useMetaKsefFallback: boolean,
): Promise<JpkKsefNode | null> {
  const subRes = await deps.queryEngine.query<Record<string, unknown>>('financial_pl:ksef_submission', {
    ...scope,
    filters: { [lookup.idField]: { $eq: lookup.id }, document_kind: { $eq: lookup.documentKind }, deleted_at: { $eq: null } },
    page: { page: 1, pageSize: 1 },
    sort: [{ field: 'created_at', dir: 'desc' }],
  })
  const submission = subRes.items?.[0]
  const result = deriveJpkVatMarking({
    ksefStatus: asString(submission?.status) ?? (useMetaKsefFallback ? asString(meta?.ksef_status) : undefined) ?? null,
    ksefNumber: asString(submission?.ksef_number) ?? (useMetaKsefFallback ? asString(meta?.ksef_number) : undefined) ?? null,
    mode: asString(submission?.mode) ?? null,
    issuedOutsideKsef: isTruthyFlag(meta?.issued_outside_ksef),
  })
  if (result.marking === null) return null
  if (result.marking === 'NrKSeF') return { kind: 'NrKSeF', value: result.ksefNumber ?? '' }
  return { kind: result.marking }
}

/** Map a PL-meta row's GTU/procedure/doc-type markers into the SprzedazWiersz inputs. */
function readSalesMarkers(meta: MetaRow | undefined): {
  gtu: string[]
  procedures: Partial<Record<JpkSprzedazProcedure, boolean>>
  typDokumentu: JpkTypDokumentu | null
} {
  const rawGtu = meta?.gtu_codes
  const gtu = Array.isArray(rawGtu) ? rawGtu.filter((g): g is string => typeof g === 'string') : []
  const procedures: Partial<Record<JpkSprzedazProcedure, boolean>> = {}
  for (const [field, code] of META_PROCEDURE_FIELDS) {
    if (isTruthyFlag(meta?.[field as string])) procedures[code] = true
  }
  const docTypeRaw = asString(meta?.doc_type)
  const typDokumentu =
    docTypeRaw === 'RO' || docTypeRaw === 'WEW' || docTypeRaw === 'FP' ? (docTypeRaw as JpkTypDokumentu) : null
  return { gtu, procedures, typDokumentu }
}

/**
 * Resolve a sales document (invoice OR credit memo) into a SprzedazWiersz, or `null` to skip it.
 * `sign` is +1 for an invoice and -1 for a credit memo (corrections file the negated difference).
 */
async function resolveSalesRow(
  deps: ResolveJpkDeps,
  scope: { tenantId: string; organizationIds: Array<string | null> },
  doc: InvoiceRow,
  opts: {
    lineEntityId: string
    lineIdField: string
    docId: string
    dowodSprzedazy: string
    sign: 1 | -1
    /** When set, the filing is scoped to a single NIP — a document stamped with a different
     *  context_nip (on its PL-meta) belongs to another taxpayer and is excluded (H4). */
    contextNip: string | null
  },
): Promise<JpkSprzedazRow | null> {
  // PL-meta is keyed by the (corrected) sales invoice id; a credit memo's correction reuses the
  // original invoice's meta (markers/OSS), so credit memos read meta via their `invoice_id`.
  const metaInvoiceId = opts.sign === 1 ? opts.docId : asString(doc.invoice_id)
  let meta: MetaRow | undefined
  if (metaInvoiceId) {
    const metaRes = await deps.queryEngine.query<MetaRow>('financial_pl:sales_invoice_pl_meta', {
      ...scope,
      filters: { sales_invoice_id: { $eq: metaInvoiceId }, deleted_at: { $eq: null } },
      page: { page: 1, pageSize: 1 },
    })
    meta = metaRes.items?.[0]
  }

  // Multi-NIP (H4): a filing scoped to a single NIP includes ONLY documents stamped with that NIP
  // on their PL-meta. A credit memo inherits its corrected original's meta, so it is scoped by the
  // original's context_nip — consistent with the purchase-side narrowing. When the filing carries
  // no contextNip (single-NIP org) no scoping is applied.
  if (opts.contextNip && asString(meta?.context_nip) !== opts.contextNip) return null

  // OSS invoices are excluded from JPK_V7M (reported in VIU-DO); skip them wholesale.
  if (isTruthyFlag(meta?.oss_procedure)) return null
  const marginScheme = normalizeMarginScheme(meta?.margin_scheme)

  // The issue date places the row in the register. Fall back through the alternative date columns
  // (issued_at, then the metadata sale date) before dropping a document — silently dropping a
  // finalized correction would understate output VAT (M2).
  const issueDate =
    toIsoDate(doc.issue_date) ?? toIsoDate(doc.issued_at) ?? toIsoDate(asRecord(doc.metadata).saleDate)
  if (!issueDate) return null // an un-dated document cannot be placed in the register

  // KSeF node. An invoice reports its own submission. A credit memo (faktura korygująca) reports
  // its OWN credit_memo submission number when it has one, inheriting only the marker TYPE/OSS from
  // the corrected original's meta; it falls back to the original invoice's marking only when the
  // memo has no determinate submission of its own. A pending/un-markable source means the row is
  // not yet reportable.
  let ksef: JpkKsefNode | null = null
  if (opts.sign === 1) {
    ksef = await resolveSubmissionMarking(
      deps,
      scope,
      { idField: 'sales_invoice_id', id: opts.docId, documentKind: 'invoice' },
      meta,
      true,
    )
  } else {
    ksef = await resolveSubmissionMarking(
      deps,
      scope,
      { idField: 'credit_memo_id', id: opts.docId, documentKind: 'credit_memo' },
      meta,
      false,
    )
    if (!ksef && metaInvoiceId) {
      ksef = await resolveSubmissionMarking(
        deps,
        scope,
        { idField: 'sales_invoice_id', id: metaInvoiceId, documentKind: 'invoice' },
        meta,
        true,
      )
    }
  }
  if (!ksef) return null

  const lines = await loadLines(deps.queryEngine, scope, opts.lineEntityId, opts.lineIdField, opts.docId)
  const currencyCode = (asString(doc.currency_code) ?? 'PLN').toUpperCase()
  if (marginScheme) {
    if (currencyCode !== 'PLN') throw new Error('marginSchemeRequiresPln')
    if (lines.some(lineCarriesTaxRate)) throw new Error('marginSchemeMixedLines')
  }
  // Per-rate buckets; a credit memo's stored magnitudes are negated so the correction files the
  // negative difference (consistent with the FA(3) KOR path).
  const headerNet = opts.sign === 1 ? doc.grand_total_net_amount : scaled4ToMoney2dp(-toScaled4(doc.grand_total_net_amount))
  const headerVat = opts.sign === 1 ? doc.tax_total_amount : scaled4ToMoney2dp(-toScaled4(doc.tax_total_amount))
  const headerGross =
    opts.sign === 1
      ? scaled4ToMoney2dp(toScaled4(doc.grand_total_gross_amount) || toScaled4(doc.grand_total_net_amount) + toScaled4(doc.tax_total_amount))
      : scaled4ToMoney2dp(
          -(toScaled4(doc.grand_total_gross_amount) || toScaled4(doc.grand_total_net_amount) + toScaled4(doc.tax_total_amount)),
        )
  const signedLines: InvoiceLineRow[] =
    opts.sign === 1
      ? lines
      : lines.map((line) => ({
          ...line,
          total_net_amount: scaled4ToMoney2dp(-toScaled4(line.total_net_amount)),
          tax_amount: scaled4ToMoney2dp(-toScaled4(line.tax_amount)),
        }))

  // JPK_V7 amounts are statutorily in PLN. A foreign-currency document is converted at the stored
  // per-invoice exchange rate (PL-meta `exchange_rate`) — BOTH net and VAT, unlike the FA(3) path
  // which converts only the output VAT (`P_14_xW`). A foreign-currency document with no resolvable
  // rate cannot be lawfully placed in the register, so generation fails loud rather than filing a
  // foreign-currency amount under a PLN field (H2). OSS rows are already excluded above.
  let plnLines = signedLines
  let plnHeaderNet = headerNet
  let plnHeaderVat = headerVat
  if (currencyCode !== 'PLN') {
    const fxRate = resolveMetaExchangeRate(meta)
    const fxScaled = fxRate ? toScaled4(fxRate) : 0n
    if (fxScaled <= 0n) {
      throw new Error(
        `[internal] JPK: foreign-currency document ${opts.dowodSprzedazy} (${currencyCode}) has no exchange_rate; cannot convert to PLN`,
      )
    }
    plnLines = signedLines.map((line) => ({
      ...line,
      total_net_amount: toPlnString4dp(line.total_net_amount, fxScaled),
      tax_amount: toPlnString4dp(line.tax_amount, fxScaled),
    }))
    plnHeaderNet = toPlnString4dp(headerNet, fxScaled)
    plnHeaderVat = toPlnString4dp(headerVat, fxScaled)
  }
  const vatBreakdown = marginScheme ? buildMarginVatBreakdown(meta, headerGross) : (buildVatBreakdown(plnLines, plnHeaderNet, plnHeaderVat) as JpkVatBucket[])

  const { gtu, procedures, typDokumentu } = readSalesMarkers(meta)
  return buildSprzedazRow({
    buyer: readBuyer(doc),
    dowodSprzedazy: opts.dowodSprzedazy,
    dataWystawienia: issueDate,
    dataSprzedazy: toIsoDate(asRecord(doc.metadata).saleDate) ?? undefined,
    ksef,
    vatBreakdown,
    ...(marginScheme ? { margGross: headerGross } : {}),
    // A credit memo (faktura korygująca) must NOT inherit the corrected invoice's TypDokumentu —
    // an original marked FP would otherwise tag the correction FP and exclude it from the
    // declaration/control aggregates (double-count guard), understating the corrected totals.
    typDokumentu: opts.sign === 1 ? typDokumentu : undefined,
    gtu,
    procedures,
  })
}

/**
 * Resolve a NEGATED art. 89a ust. 1 bad-debt-relief correction row (M3) for an invoice flagged on
 * its PL-meta with `bad_debt_relief_period` === the filing period. The row reverses the original
 * sale's per-rate buckets (negated) and carries KorektaPodstawyOpodt + TerminPlatnosci so the
 * declaration aggregates the output-VAT reduction into P_68/P_69 (and the negated K_ fields reduce
 * P_37/P_38). The KSeF node references the original invoice. Returns null when un-markable / no due
 * date. Bad-debt relief is a domestic VAT-rated correction — no FX path here.
 */
async function resolveBadDebtRow(
  deps: ResolveJpkDeps,
  scope: { tenantId: string; organizationIds: Array<string | null> },
  invoice: InvoiceRow,
  meta: MetaRow,
): Promise<JpkSprzedazRow | null> {
  const terminPlatnosci = toIsoDate(meta.bad_debt_termin_platnosci)
  if (!terminPlatnosci) return null
  const docId = asString(invoice.id)
  if (!docId) return null
  const ksef = await resolveSubmissionMarking(
    deps,
    scope,
    { idField: 'sales_invoice_id', id: docId, documentKind: 'invoice' },
    meta,
    true,
  )
  if (!ksef) return null
  const lines = await loadLines(deps.queryEngine, scope, E.sales.sales_invoice_line, 'invoice_id', docId)
  const negatedLines: InvoiceLineRow[] = lines.map((line) => ({
    ...line,
    total_net_amount: scaled4ToMoney2dp(-toScaled4(line.total_net_amount)),
    tax_amount: scaled4ToMoney2dp(-toScaled4(line.tax_amount)),
  }))
  const headerNet = scaled4ToMoney2dp(-toScaled4(invoice.grand_total_net_amount))
  const headerVat = scaled4ToMoney2dp(-toScaled4(invoice.tax_total_amount))
  const vatBreakdown = buildVatBreakdown(negatedLines, headerNet, headerVat) as JpkVatBucket[]
  return buildSprzedazRow({
    buyer: readBuyer(invoice),
    dowodSprzedazy: asString(invoice.invoice_number) ?? docId,
    dataWystawienia: toIsoDate(invoice.issue_date) ?? toIsoDate(invoice.issued_at) ?? terminPlatnosci,
    ksef,
    vatBreakdown,
    korekta: { terminPlatnosci },
  })
}

/** Map a stored `PurchaseVatRecord` into the JPK KSeF node (buyer-side `NrKSeF`/`OFF`/`BFK`/`DI`). */
function purchaseKsefNode(record: PurchaseVatRecord): JpkKsefNode {
  if (record.ksefMarking === 'NrKSeF') return { kind: 'NrKSeF', value: record.nrKsef ?? '' }
  if (record.ksefMarking === 'OFF' || record.ksefMarking === 'BFK' || record.ksefMarking === 'DI') {
    return { kind: record.ksefMarking }
  }
  // No explicit marking: a NrKSeF with a captured number, else conservatively BFK (outside KSeF).
  return record.nrKsef ? { kind: 'NrKSeF', value: record.nrKsef } : { kind: 'BFK' }
}

/** Credit-memo statuses that are NOT yet finalized and must stay out of the JPK register. */
const MEMO_DRAFT_STATUSES = new Set(['draft', 'void', 'voided', 'cancelled', 'canceled', 'pending'])

type MonthEvidence = { sprzedaz: JpkSprzedazRow[]; zakup: JpkZakupRow[] }

/**
 * Gather one month's evidence rows — sales `SprzedazWiersz`, credit-memo corrections (signed), and
 * `PurchaseVatRecord` `ZakupWiersz` + self-assessment — for (organization, tenant, year, month).
 * When `contextNip` is set the purchase side is narrowed to that single taxpayer (a filing is
 * scoped to one NIP).
 */
async function gatherMonthEvidence(
  deps: ResolveJpkDeps,
  organizationId: string,
  tenantId: string,
  year: number,
  month: number,
  contextNip: string | null,
): Promise<MonthEvidence> {
  const scope = { tenantId, organizationIds: [organizationId] as Array<string | null> }
  const { from, to } = periodRange(year, month)
  const issuedInPeriod = { issue_date: { $gte: from, $lte: to }, deleted_at: { $eq: null } }

  const sprzedaz: JpkSprzedazRow[] = []
  const zakup: JpkZakupRow[] = []

  // --- (1) Sales invoices issued in the period --------------------------------------------------
  const invPageSize = 200
  for (let page = 1; ; page++) {
    const res = await deps.queryEngine.query<InvoiceRow>(E.sales.sales_invoice, {
      ...scope,
      filters: { ...issuedInPeriod },
      page: { page, pageSize: invPageSize },
      sort: [{ field: 'issue_date', dir: 'asc' }],
    })
    const batch = res.items ?? []
    for (const invoice of batch) {
      // Issued (immutable), non-proforma only — mirrors the send command's gate. Core has no
      // `is_immutable` column; immutability is derived from the invoice's lifecycle `status`.
      if (asString(invoice.document_type) === 'proforma') continue
      if (!isInvoiceIssued(invoice.status)) continue
      const id = asString(invoice.id)
      if (!id) continue
      const row = await resolveSalesRow(deps, scope, invoice, {
        lineEntityId: E.sales.sales_invoice_line,
        lineIdField: 'invoice_id',
        docId: id,
        dowodSprzedazy: asString(invoice.invoice_number) ?? id,
        sign: 1,
        contextNip,
      })
      if (row) sprzedaz.push(row)
    }
    if (batch.length < invPageSize) break
  }

  // --- (2) Credit memos issued in the period (signed/negated buckets) ---------------------------
  for (let page = 1; ; page++) {
    const res = await deps.queryEngine.query<InvoiceRow>(E.sales.sales_credit_memo, {
      ...scope,
      filters: issuedInPeriod,
      page: { page, pageSize: invPageSize },
      sort: [{ field: 'issue_date', dir: 'asc' }],
    })
    const batch = res.items ?? []
    for (const memo of batch) {
      const id = asString(memo.id)
      if (!id) continue
      // SalesCreditMemo has no is_immutable flag, so gate on status to keep not-yet-finalized
      // (draft/void) memos out of the register — a draft correction must not file negative VAT.
      const status = asString((memo as Record<string, unknown>).status)?.toLowerCase()
      if (status && MEMO_DRAFT_STATUSES.has(status)) continue
      const row = await resolveSalesRow(deps, scope, memo, {
        lineEntityId: E.sales.sales_credit_memo_line,
        lineIdField: 'credit_memo_id',
        docId: id,
        dowodSprzedazy: asString(memo.credit_memo_number) ?? id,
        sign: -1,
        contextNip,
      })
      if (row) sprzedaz.push(row)
    }
    if (batch.length < invPageSize) break
  }

  // --- (3) Purchase records for the period (optionally NIP-scoped) -------------------------------
  const purchases = await findWithDecryption(
    deps.em,
    PurchaseVatRecord,
    {
      organizationId,
      tenantId,
      year,
      month,
      deletedAt: null,
      ...(contextNip ? { contextNip } : {}),
    },
    undefined,
    { organizationId, tenantId },
  )
  for (const record of purchases) {
    const { zakup: zakupRow, sprzedaz: selfAssess } = buildZakupRows({
      supplier: { nip: record.supplierNip, name: record.supplierName, countryCode: record.supplierCountryCode },
      dowodZakupu: record.documentNumber,
      dataZakupu: record.purchaseDate,
      dataWplywu: record.receiptDate,
      ksef: purchaseKsefNode(record),
      dokumentZakupu: (record.documentType ?? null) as JpkDokumentZakupu | null,
      imp: record.imp,
      transactionClass: record.transactionClass as JpkTransactionClass,
      netFixedAssets: record.netFixedAssets,
      vatFixedAssets: record.vatFixedAssets,
      netOther: record.netOther,
      vatOther: record.vatOther,
      corrFixedAssets: record.corrFixedAssets,
      corrOther: record.corrOther,
      corr89b1: record.corr89b1,
      corr89b4: record.corr89b4,
      marginGross: record.marginGross,
      selfAssessedNet: record.selfAssessedNet,
      selfAssessedVat: record.selfAssessedVat,
      selfAssessedRate: record.selfAssessedRate,
    })
    zakup.push(zakupRow)
    if (selfAssess) sprzedaz.push(selfAssess)
  }

  // --- (4) art. 89a ust. 1 bad-debt-relief corrections claimed in THIS period (M3) -------------
  // Invoices flagged on their PL-meta with `bad_debt_relief_period` === this period emit a NEGATED
  // KorektaPodstawyOpodt SprzedazWiersz. The original invoice was issued in an earlier period, so
  // this never double-counts the normal in-period sales gather. NIP-scoped like every other read.
  const reliefPeriod = `${year}-${String(month).padStart(2, '0')}`
  const reliefMetaRes = await deps.queryEngine.query<MetaRow>('financial_pl:sales_invoice_pl_meta', {
    ...scope,
    filters: {
      bad_debt_relief_period: { $eq: reliefPeriod },
      deleted_at: { $eq: null },
      ...(contextNip ? { context_nip: { $eq: contextNip } } : {}),
    },
    page: { page: 1, pageSize: 500 },
  })
  for (const reliefMeta of reliefMetaRes.items ?? []) {
    const invoiceId = asString(reliefMeta.sales_invoice_id)
    if (!invoiceId) continue
    const invRes = await deps.queryEngine.query<InvoiceRow>(E.sales.sales_invoice, {
      ...scope,
      filters: { id: { $eq: invoiceId }, deleted_at: { $eq: null } },
      page: { page: 1, pageSize: 1 },
    })
    const invoice = invRes.items?.[0]
    if (!invoice) continue
    const row = await resolveBadDebtRow(deps, scope, invoice, reliefMeta)
    if (row) sprzedaz.push(row)
  }

  return { sprzedaz, zakup }
}

export async function resolveJpkFiling(deps: ResolveJpkDeps, args: ResolveJpkArgs): Promise<BuildJpkXmlInput> {
  const { filing, organizationId, tenantId } = args
  const contextNip = filing.contextNip ?? null
  const declarationInputs = (filing.declarationInputs ?? undefined) as JpkDeclarationInputs | undefined

  // The Ewidencja is always the FILING month's evidence (JPK_V7K files records per month).
  const { sprzedaz, zakup } = await gatherMonthEvidence(deps, organizationId, tenantId, filing.year, filing.month, contextNip)

  // The Deklaracja is emitted on a V7M file (monthly) and on the MONTH-3 file of a V7K quarter
  // (the quarterly settlement); V7K months 1-2 are evidence-only. The control sums always describe
  // THIS file's Ewidencja rows (the filing month), so compute them from the filing-month rows.
  const isV7K = filing.variant === 'V7K'
  const emitDeclaration = !isV7K || filing.month % 3 === 0
  const filingMonth = computeJpkDeclaration({ variant: filing.variant, sprzedaz, zakup, inputs: declarationInputs })
  const ctrl: JpkCtrlSums = filingMonth.ctrl

  let declaration: JpkDeclaration | undefined
  if (emitDeclaration) {
    if (!isV7K) {
      declaration = filingMonth.declaration
    } else {
      // V7K month 3: the Deklaracja aggregates the WHOLE quarter (this month is month 3 of the
      // quarter → months [m-2, m-1, m]); the Ewidencja above stays month-3-only.
      const quarterSprzedaz: JpkSprzedazRow[] = [...sprzedaz]
      const quarterZakup: JpkZakupRow[] = [...zakup]
      for (const m of [filing.month - 2, filing.month - 1]) {
        const ev = await gatherMonthEvidence(deps, organizationId, tenantId, filing.year, m, contextNip)
        quarterSprzedaz.push(...ev.sprzedaz)
        quarterZakup.push(...ev.zakup)
      }
      declaration = computeJpkDeclaration({
        variant: filing.variant,
        sprzedaz: quarterSprzedaz,
        zakup: quarterZakup,
        inputs: declarationInputs,
      }).declaration
    }
  }

  // --- Podmiot1 (the filing's single taxpayer NIP; falls back to the credential NIP) ------------
  const nip = (filing.contextNip ?? deps.contextNip).replace(/[^0-9]/g, '')
  const podmiot1: JpkPodmiot1 = {
    nip,
    pelnaNazwa: asString(deps.seller?.name) ?? nip,
    email: asString(deps.email) ?? `${nip}@ksef.local`,
  }

  // --- Assemble. DataWytworzeniaJPK clamped to the XSD floor (>= 2026-02-01). --------------------
  const nowIso = new Date().toISOString()
  const dataWytworzenia = Date.parse(nowIso) >= MIN_DATA_WYTWORZENIA ? nowIso : '2026-02-01T00:00:00Z'

  // KodUrzedu (TKodUS, 4 digits) is mandatory + non-empty in the Naglowek. Fail loud at
  // generation rather than emit an empty, XSD-invalid <KodUrzedu/>.
  if (!filing.kodUrzedu || !/^\d{4}$/.test(filing.kodUrzedu)) {
    throw new Error('[internal] JPK generation requires a 4-digit KodUrzedu on the filing')
  }

  const result: BuildJpkXmlInput = {
    variant: filing.variant,
    celZlozenia: (filing.celZlozenia === 2 ? 2 : 1),
    correctionScope: filing.correctionScope,
    naglowek: {
      dataWytworzenia,
      nazwaSystemu: 'Open Mercato',
      kodUrzedu: filing.kodUrzedu,
      rok: filing.year,
      miesiac: filing.month,
    },
    podmiot1,
    // Deklaracja only when emitted; V7K carries the quarter (derived from the month-3 file).
    deklaracja: declaration !== undefined
      ? { ...(isV7K ? { kwartal: filing.quarter ?? Math.ceil(filing.month / 3) } : {}), pozycje: declaration }
      : undefined,
    ewidencja: {
      sprzedaz,
      zakup,
      sprzedazCtrl: ctrl.sprzedazCtrl,
      zakupCtrl: ctrl.zakupCtrl,
    },
  }
  return result
}
