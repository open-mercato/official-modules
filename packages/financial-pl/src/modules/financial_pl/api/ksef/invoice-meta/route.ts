import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { KsefSubmission, SalesInvoicePlMeta } from '../../../data/entities'
import type { JpkTypDokumentuColumn } from '../../../data/entities'
import { JPK_PROCEDURE_MARKINGS, type JpkProcedureMarking } from '../../../lib/jpk-markings-codes'
import { invoiceMetaPutSchema } from '../../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  // SPEC-013 composed gating: the PUT writes statutory metadata tied to a core sales
  // invoice, so it requires BOTH the PL-meta manage feature and core invoice-manage.
  PUT: { requireAuth: true, requireFeatures: ['financial_pl.manage', 'sales.invoices.manage'] },
}

// SPEC-013 — KSeF-immutability statuses (mirrors api/interceptors.ts). An invoice with a
// submission in either state must not be edited.
const KSEF_LOCKED_STATUSES = ['accepted', 'processing'] as const
const KSEF_LOCKED_MESSAGE_DEFAULT =
  'This invoice is locked: it has an accepted or in-progress KSeF submission. Issue a correction (KOR) instead of editing it.'

async function resolveInvoiceLockedMessage(): Promise<string> {
  try {
    const { translate } = await resolveTranslations()
    return translate('financial_pl.errors.invoice_locked_ksef', KSEF_LOCKED_MESSAGE_DEFAULT)
  } catch {
    return KSEF_LOCKED_MESSAGE_DEFAULT
  }
}

// Pure-JPK procedure marking code → SalesInvoicePlMeta boolean column. The marking
// object is the API/widget shape; the entity stores one boolean per code (matching the
// existing `mppRequired` style and keeping the future JPK export column-filterable).
const PROCEDURE_MARKING_FIELDS = {
  WSTO_EE: 'wstoEe',
  IED: 'ied',
  TP: 'tp',
  TT_WNT: 'ttWnt',
  TT_D: 'ttD',
  MR_T: 'mrT',
  MR_UZ: 'mrUz',
  I_42: 'i42',
  I_63: 'i63',
  B_SPV: 'bSpv',
  B_SPV_DOSTAWA: 'bSpvDostawa',
  B_MPV_PROWIZJA: 'bMpvProwizja',
} as const satisfies Record<JpkProcedureMarking, keyof SalesInvoicePlMeta>

type ProcedureMarkings = Partial<Record<JpkProcedureMarking, boolean>>

/** Project the PL-meta row to the wire shape shared by GET and the PUT response. */
function projectMeta(record: SalesInvoicePlMeta) {
  const procedureMarkings: Record<JpkProcedureMarking, boolean> = {} as Record<JpkProcedureMarking, boolean>
  for (const code of JPK_PROCEDURE_MARKINGS) {
    procedureMarkings[code] = Boolean(record[PROCEDURE_MARKING_FIELDS[code]])
  }
  return {
    id: record.id,
    salesInvoiceId: record.salesInvoiceId,
    contextNip: record.contextNip ?? null,
    mppRequired: record.mppRequired,
    issuedOutsideKsef: record.issuedOutsideKsef,
    vatExemptionBasis: record.vatExemptionBasis ?? null,
    // SPEC-009 additive fields:
    invoiceKind: record.invoiceKind,
    selfBilling: record.selfBilling,
    reverseCharge: record.reverseCharge,
    ossProcedure: record.ossProcedure,
    consumptionCountryCode: record.consumptionCountryCode ?? null,
    exchangeRate: record.exchangeRate ?? null,
    exchangeRateDate: record.exchangeRateDate ?? null,
    advancePayments: record.advancePayments ?? [],
    advanceRefs: record.advanceRefs ?? [],
    orderSnapshot: record.orderSnapshot ?? null,
    gtuCodes: record.gtuCodes ?? [],
    procedureMarkings,
    typDokumentu: record.docType ?? null,
    marginScheme: record.marginScheme ?? null,
    marginPurchaseCost: record.marginPurchaseCost ?? null,
    marginVatRate: record.marginVatRate != null ? Number(record.marginVatRate) : null,
    badDebtReliefPeriod: record.badDebtReliefPeriod ?? null,
    badDebtTerminPlatnosci: record.badDebtTerminPlatnosci ?? null,
    ksefStatus: record.ksefStatus,
    ksefNumber: record.ksefNumber ?? null,
    updatedAt: record.updatedAt ?? null,
  }
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const url = new URL(req.url)
    const salesInvoiceId = url.searchParams.get('salesInvoiceId')
    if (!salesInvoiceId) throw new CrudHttpError(400, { error: '[internal] salesInvoiceId is required' })

    const filter: Record<string, unknown> = {
      tenantId: auth.tenantId,
      salesInvoiceId,
      deletedAt: null,
    }
    // Org-scope contract (mirror upo/route.ts): filterIds===null ⇒ super-admin (all orgs in the
    // tenant); filterIds===[] ⇒ no accessible orgs ⇒ no record visible — NEVER an unscoped findOne,
    // which could read another org's invoice meta when the salesInvoiceId is known.
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      return NextResponse.json({ item: null })
    }
    if (Array.isArray(orgIds) && orgIds.length > 0) filter.organizationId = { $in: orgIds }

    const em = (container.resolve('em') as EntityManager).fork()
    const record = await findOneWithDecryption(
      em,
      SalesInvoicePlMeta,
      filter,
      undefined,
      { tenantId: auth.tenantId, organizationId: Array.isArray(orgIds) && orgIds.length === 1 ? orgIds[0] : null },
    )
    return NextResponse.json({ item: record ? projectMeta(record) : null })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.invoice_meta read failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) throw new CrudHttpError(400, { error: '[internal] Organization scope is required' })

    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const parsed = invoiceMetaPutSchema.parse(body)

    // SPEC-013 — KSeF-immutability guard. This is a hand-written route, so the module's
    // `before` interceptor (api/interceptors.ts) never runs for it; enforce the same rule
    // here, BEFORE any write. A KSeF-accepted invoice is legally immutable (corrections only);
    // an in-flight ('processing') submission must not race a concurrent edit. Org/tenant-scoped,
    // document_kind='invoice' so an accepted correction never locks the corrected original.
    const lockEm = (container.resolve('em') as EntityManager).fork()
    const lockedCount = await lockEm.count(KsefSubmission, {
      salesInvoiceId: parsed.salesInvoiceId,
      documentKind: 'invoice',
      status: { $in: KSEF_LOCKED_STATUSES },
      organizationId,
      tenantId: auth.tenantId,
      deletedAt: null,
    })
    if (lockedCount > 0) {
      throw new CrudHttpError(409, { error: await resolveInvoiceLockedMessage(), code: 'invoice_locked_ksef' })
    }

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId,
      userId: auth.sub ?? null,
      resourceKind: 'financial_pl.invoice_meta',
      resourceId: parsed.salesInvoiceId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const em = (container.resolve('em') as EntityManager).fork()
    const existing = await findOneWithDecryption(
      em,
      SalesInvoicePlMeta,
      {
        organizationId,
        tenantId: auth.tenantId,
        salesInvoiceId: parsed.salesInvoiceId,
        deletedAt: null,
      },
      undefined,
      { organizationId, tenantId: auth.tenantId },
    )

    // Optimistic lock on the existing meta row (additive — a request without the
    // header is a no-op; a stale edit gets the structured 409). Skipped on first
    // create when no row exists yet.
    if (existing) {
      enforceCommandOptimisticLock({
        resourceKind: 'financial_pl.invoice_meta',
        resourceId: parsed.salesInvoiceId,
        current: existing.updatedAt ?? null,
        request: req,
      })
    }

    const now = new Date()
    const record =
      existing ??
      em.create(SalesInvoicePlMeta, {
        organizationId,
        tenantId: auth.tenantId,
        salesInvoiceId: parsed.salesInvoiceId,
        ksefStatus: 'not_applicable',
        mppRequired: false,
        issuedOutsideKsef: false,
        // SPEC-009 defaulted columns (also set by the entity field initializers at runtime;
        // passed here so em.create's RequiredEntityData type is satisfied — same pattern as the
        // existing defaulted columns above).
        invoiceKind: 'vat',
        selfBilling: false,
        reverseCharge: false,
        ossProcedure: false,
        advancePayments: [],
        advanceRefs: [],
        gtuCodes: [],
        wstoEe: false,
        ied: false,
        tp: false,
        ttWnt: false,
        ttD: false,
        mrT: false,
        mrUz: false,
        i42: false,
        i63: false,
        bSpv: false,
        bSpvDostawa: false,
        bMpvProwizja: false,
        createdAt: now,
        updatedAt: now,
      })
    if (parsed.contextNip !== undefined) record.contextNip = parsed.contextNip ?? null
    if (parsed.mppRequired !== undefined) record.mppRequired = parsed.mppRequired
    if (parsed.vatExemptionBasis !== undefined) record.vatExemptionBasis = parsed.vatExemptionBasis ?? null
    if (parsed.issuedOutsideKsef !== undefined) record.issuedOutsideKsef = parsed.issuedOutsideKsef
    // SPEC-009 additive fields — each applied only when present (the `mppRequired` pattern).
    if (parsed.invoiceKind !== undefined) record.invoiceKind = parsed.invoiceKind
    if (parsed.selfBilling !== undefined) record.selfBilling = parsed.selfBilling
    if (parsed.reverseCharge !== undefined) record.reverseCharge = parsed.reverseCharge
    if (parsed.ossProcedure !== undefined) record.ossProcedure = parsed.ossProcedure
    if (parsed.consumptionCountryCode !== undefined) record.consumptionCountryCode = parsed.consumptionCountryCode ?? null
    if (parsed.exchangeRate !== undefined) record.exchangeRate = parsed.exchangeRate ?? null
    if (parsed.exchangeRateDate !== undefined)
      record.exchangeRateDate = parsed.exchangeRateDate ? new Date(parsed.exchangeRateDate) : null
    if (parsed.advancePayments !== undefined) record.advancePayments = parsed.advancePayments
    if (parsed.advanceRefs !== undefined) record.advanceRefs = parsed.advanceRefs
    if (parsed.orderSnapshot !== undefined) record.orderSnapshot = parsed.orderSnapshot ?? null
    if (parsed.gtuCodes !== undefined) record.gtuCodes = Array.from(new Set(parsed.gtuCodes))
    if (parsed.procedureMarkings !== undefined) {
      const markings: ProcedureMarkings = parsed.procedureMarkings
      // The mapped columns are all booleans; write through a boolean-only view so the
      // dynamic key assignment stays type-safe (no `any`).
      const booleanColumns = record as unknown as Record<(typeof PROCEDURE_MARKING_FIELDS)[JpkProcedureMarking], boolean>
      for (const code of JPK_PROCEDURE_MARKINGS) {
        const next = markings[code]
        if (next !== undefined) booleanColumns[PROCEDURE_MARKING_FIELDS[code]] = next
      }
    }
    if (parsed.typDokumentu !== undefined) record.docType = (parsed.typDokumentu ?? null) as JpkTypDokumentuColumn | null
    if (parsed.marginScheme !== undefined) record.marginScheme = parsed.marginScheme ?? null
    if (parsed.marginPurchaseCost !== undefined) record.marginPurchaseCost = parsed.marginPurchaseCost ?? null
    if (parsed.marginVatRate !== undefined)
      record.marginVatRate = parsed.marginVatRate == null ? null : String(parsed.marginVatRate)
    if (parsed.badDebtReliefPeriod !== undefined) record.badDebtReliefPeriod = parsed.badDebtReliefPeriod ?? null
    if (parsed.badDebtTerminPlatnosci !== undefined)
      record.badDebtTerminPlatnosci = parsed.badDebtTerminPlatnosci ? new Date(parsed.badDebtTerminPlatnosci) : null
    record.updatedAt = now
    if (!existing) em.persist(record)
    await em.flush()

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId,
        userId: auth.sub ?? null,
        resourceKind: 'financial_pl.invoice_meta',
        resourceId: parsed.salesInvoiceId,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ ok: true, item: projectMeta(record) })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.invoice_meta upsert failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const okResponseSchema = z.object({ ok: z.boolean(), item: z.object({}).loose() })
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Upsert Polish invoice metadata',
  methods: {
    GET: {
      summary: 'Read Polish statutory metadata for a sales invoice',
      description: 'Returns the SalesInvoicePlMeta row for ?salesInvoiceId=, or null when none exists yet.',
      responses: [{ status: 200, description: 'Metadata (or null)', schema: z.object({ item: z.object({}).loose().nullable() }) }],
    },
    PUT: {
      summary: 'Upsert Polish statutory metadata for a sales invoice',
      description:
        'Creates or updates the SalesInvoicePlMeta row for a sales invoice (context NIP, MPP flag, VAT exemption basis, and the SPEC-009 FA(3) doc-kind / self-billing / reverse-charge / OSS / FX / advance snapshots / GTU + JPK procedure markings + TypDokumentu fields). Org/tenant-scoped, optimistic-locked; each field is applied only when supplied.',
      requestBody: { contentType: 'application/json', schema: invoiceMetaPutSchema },
      responses: [{ status: 200, description: 'Metadata saved', schema: okResponseSchema }],
      errors: [{ status: 400, description: 'Validation failed', schema: errorSchema }],
    },
  },
}
