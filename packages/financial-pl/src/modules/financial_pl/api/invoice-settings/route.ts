import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { InvoiceSettings, type InvoiceBankAccount } from '../../data/entities'
import { invoiceSettingsPutSchema } from '../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
  PUT: { requireAuth: true, requireFeatures: ['financial_pl.manage'] },
}

const EMPTY_SETTINGS = {
  logoDataUrl: null as string | null,
  footerNote: null as string | null,
  defaultPaymentMethod: null as string | null,
  defaultTermDays: null as number | null,
  defaultTaxRate: null as string | null,
  defaultCurrencyCode: null as string | null,
  defaultPriceMode: null as string | null,
  bankAccounts: [] as InvoiceBankAccount[],
}

function toDto(row: InvoiceSettings | null) {
  if (!row) return EMPTY_SETTINGS
  return {
    logoDataUrl: row.logoDataUrl ?? null,
    footerNote: row.footerNote ?? null,
    defaultPaymentMethod: row.defaultPaymentMethod ?? null,
    defaultTermDays: row.defaultTermDays ?? null,
    defaultTaxRate: row.defaultTaxRate ?? null,
    defaultCurrencyCode: row.defaultCurrencyCode ?? null,
    defaultPriceMode: row.defaultPriceMode ?? null,
    bankAccounts: row.bankAccounts ?? [],
  }
}

/**
 * Resolve the single organization these settings belong to. Settings are per-organization, so a
 * multi-org scope has to pick one — the selected organization, falling back to the user's own.
 */
function requireOrganizationId(scope: { selectedId?: string | null } | null, fallback?: string | null): string {
  const organizationId = scope?.selectedId ?? fallback ?? null
  if (!organizationId) {
    throw new CrudHttpError(400, { error: 'Select an organization before editing invoice settings.' })
  }
  return organizationId
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = requireOrganizationId(scope, auth.orgId)
    const em = (container.resolve('em') as EntityManager).fork()
    const row = await em.findOne(InvoiceSettings, { organizationId, tenantId: auth.tenantId, deletedAt: null })
    return NextResponse.json({ settings: toDto(row) })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    console.error('[internal] financial_pl.invoice-settings GET failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = requireOrganizationId(scope, auth.orgId)
    const body = await readJsonSafe<Record<string, unknown>>(req, {})
    const parsed = invoiceSettingsPutSchema.parse(body)

    const em = (container.resolve('em') as EntityManager).fork()
    let row = await em.findOne(InvoiceSettings, { organizationId, tenantId: auth.tenantId, deletedAt: null })
    if (!row) {
      // `createdAt` carries a property default, but MikroORM's `RequiredEntityData` still demands
      // it at the call site, so it is passed explicitly rather than silently cast away.
      row = em.create(InvoiceSettings, { organizationId, tenantId: auth.tenantId, createdAt: new Date() })
      em.persist(row)
    }
    // `undefined` leaves a field untouched; an explicit `null` clears it.
    if (parsed.logoDataUrl !== undefined) row.logoDataUrl = parsed.logoDataUrl
    if (parsed.footerNote !== undefined) row.footerNote = parsed.footerNote
    if (parsed.defaultPaymentMethod !== undefined) row.defaultPaymentMethod = parsed.defaultPaymentMethod
    if (parsed.defaultTermDays !== undefined) row.defaultTermDays = parsed.defaultTermDays
    if (parsed.defaultTaxRate !== undefined) row.defaultTaxRate = parsed.defaultTaxRate
    if (parsed.defaultCurrencyCode !== undefined) row.defaultCurrencyCode = parsed.defaultCurrencyCode
    if (parsed.defaultPriceMode !== undefined) row.defaultPriceMode = parsed.defaultPriceMode
    if (parsed.bankAccounts !== undefined) {
      const accounts = parsed.bankAccounts ?? []
      // Exactly one default, decided server-side: two defaults (or none, with accounts present)
      // would leave the create form guessing which account to prefill.
      const firstDefault = accounts.findIndex((account) => account.isDefault)
      const defaultIndex = firstDefault >= 0 ? firstDefault : accounts.length > 0 ? 0 : -1
      row.bankAccounts = accounts.map((account, index) => ({
        ...account,
        accountNumber: account.accountNumber.trim(),
        isDefault: index === defaultIndex,
      }))
    }
    await em.flush()
    return NextResponse.json({ ok: true, settings: toDto(row) })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[internal] financial_pl.invoice-settings PUT failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const settingsSchema = z.object({
  logoDataUrl: z.string().nullable(),
  footerNote: z.string().nullable(),
  defaultPaymentMethod: z.string().nullable(),
  defaultTermDays: z.number().nullable(),
  defaultTaxRate: z.string().nullable(),
  defaultCurrencyCode: z.string().nullable(),
  defaultPriceMode: z.string().nullable(),
  bankAccounts: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable().optional(),
      accountNumber: z.string(),
      bankName: z.string().nullable().optional(),
      swift: z.string().nullable().optional(),
      isDefault: z.boolean().optional(),
    }),
  ),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Invoice issuing settings',
  methods: {
    GET: {
      summary: 'Read invoice issuing settings',
      description:
        'Per-organization presentation (logo, footer note) and new-invoice defaults. Returns empty values when nothing has been configured yet.',
      responses: [{ status: 200, description: 'Settings', schema: z.object({ settings: settingsSchema }) }],
    },
    PUT: {
      summary: 'Update invoice issuing settings',
      description:
        'Upserts the settings row for the selected organization. Omitted fields keep their value; an explicit null clears one.',
      requestBody: { contentType: 'application/json', schema: invoiceSettingsPutSchema },
      responses: [
        { status: 200, description: 'Updated', schema: z.object({ ok: z.boolean(), settings: settingsSchema }) },
      ],
      errors: [{ status: 400, description: 'Validation failed', schema: z.object({ error: z.string() }) }],
    },
  },
}
