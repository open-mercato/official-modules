import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { BaseDocumentService } from './base-document-service'
import { formatDate } from '../utils/formatDate'

/** Template IDs registered by this service — exported for TemplateId type derivation. */
export const QUOTES_TEMPLATE_IDS = ['sales-offer'] as const

/** Fully loaded quote data fetched from the database by fetchData. */
export interface QuoteRecord {
  id: string
  quoteNumber: string
  currencyCode: string
  validFrom: Date | null
  validUntil: Date | null
  comments: string | null
  grandTotalNetAmount: string
  grandTotalGrossAmount: string
  taxTotalAmount: string
  customerSnapshot: Record<string, unknown> | null
  billingAddressSnapshot: Record<string, unknown> | null
  lines: QuoteLineItem[]
}

export interface QuoteLineItem {
  id: string
  name: string | null
  description: string | null
  quantity: string
  unitPriceNet: string
  unitPriceGross: string
  totalNetAmount: string
  totalGrossAmount: string
  taxRate: string
  currencyCode: string
}

/**
 * Document service for the Quotes module.
 *
 * fetchData loads the full quote from the database.
 * normalizeRecord maps it to the flat shape expected by PDF templates.
 */
export class QuotesDocumentService extends BaseDocumentService {
  readonly id = 'quotes'
  readonly label = 'Quotes'
  readonly module = 'sales'
  readonly resourceKind = 'sales.quote'

  constructor() {
    super()

    this.registerTemplate({
      id: 'sales-offer',
      label: 'Sales Offer',
      description: 'Professional sales offer.',
      documentType: 'offer',
      tags: ['offer', 'sales'],
      note: 'Rendered in the PDF tab on the Quote detail page (sales.document.detail.quote:tabs).',
      load: () =>
        import('../templates/sales/quotes/templates/sales-offer').then(
          (m) => m.SalesOfferDocument as unknown as React.ComponentType<{ data: Record<string, unknown> }>
        ),
    })
  }

  /**
   * Loads the full quote with line items from the database.
   * The widget only needs to pass { id }.
   *
   * @param input - Widget record containing at minimum { id }
   * @param ctx - Request-scoped Awilix DI container
   */
  override async fetchData({ data }: { data: unknown }, { container, auth }: { container: AppContainer; auth: AuthContext | null }): Promise<unknown> {
    const { id } = data as { id: string }
    if (!id) return data

    try {
      // SalesQuote is not in DI — use raw SQL, but skip encrypted columns (customerSnapshot, billingAddressSnapshot)
      // and resolve customer data separately via CustomerEntity which is in DI
      const em = container.resolve('em') as Parameters<typeof findOneWithDecryption>[0]
      const conn = (em as any).getConnection() as { execute: (sql: string, params?: unknown[]) => Promise<any[]> }

      const tenantId = auth?.tenantId ?? null
      const organizationId = auth?.orgId ?? null

      const [quote] = await conn.execute(
        `SELECT id, quote_number, currency_code, valid_from, valid_until, comments,
                grand_total_net_amount, grand_total_gross_amount, tax_total_amount,
                customer_entity_id, billing_address_snapshot
         FROM sales_quotes
         WHERE id = ?
           AND (tenant_id = ? OR ? IS NULL)
           AND (organization_id = ? OR ? IS NULL)
         LIMIT 1`,
        [id, tenantId, tenantId, organizationId, organizationId]
      )
      if (!quote) return data

      const rows = await conn.execute(
        `SELECT id, name, description, quantity, unit_price_net, unit_price_gross,
                total_net_amount, total_gross_amount, tax_rate, currency_code
         FROM sales_quote_lines WHERE quote_id = ? ORDER BY line_number ASC`,
        [quote.id]
      )

      const lines: QuoteLineItem[] = rows.map((row) => ({
        id: row.id,
        name: row.name ?? null,
        description: row.description ?? null,
        quantity: row.quantity ?? '0',
        unitPriceNet: row.unit_price_net ?? '0',
        unitPriceGross: row.unit_price_gross ?? '0',
        totalNetAmount: row.total_net_amount ?? '0',
        totalGrossAmount: row.total_gross_amount ?? '0',
        taxRate: row.tax_rate ?? '0',
        currencyCode: row.currency_code,
      }))

      // resolve customer via DI entity (avoids encrypted customerSnapshot from raw SQL)
      let customerSnapshot: Record<string, unknown> | null = null
      let billingAddressSnapshot: Record<string, unknown> | null = null

      if (quote.customer_entity_id) {
        const CustomerEntity = container.resolve('CustomerEntity')
        const CustomerAddress = container.resolve('CustomerAddress')

        const customer = await findOneWithDecryption(em, CustomerEntity, { id: quote.customer_entity_id } as any, { populate: ['personProfile', 'companyProfile'] } as any) as any
        if (customer) {
          customerSnapshot = {
            customer: {
              id: customer.id,
              kind: customer.kind,
              displayName: customer.displayName,
              primaryEmail: customer.primaryEmail ?? null,
              personProfile: customer.personProfile
                ? { firstName: customer.personProfile.firstName ?? null, lastName: customer.personProfile.lastName ?? null }
                : null,
              companyProfile: customer.companyProfile
                ? { legalName: customer.companyProfile.legalName ?? null, brandName: customer.companyProfile.brandName ?? null }
                : null,
            },
            contact: null,
          }

          const address = await findOneWithDecryption(em, CustomerAddress, { entity: customer.id, isPrimary: true } as any) as any
          if (address) {
            billingAddressSnapshot = {
              addressLine1: address.addressLine1,
              addressLine2: address.addressLine2 ?? null,
              city: address.city ?? null,
              region: address.region ?? null,
              postalCode: address.postalCode ?? null,
              country: address.country ?? null,
            }
          }
        }
      }

      return {
        id: quote.id,
        quoteNumber: quote.quote_number,
        currencyCode: quote.currency_code,
        validFrom: quote.valid_from ? new Date(quote.valid_from) : null,
        validUntil: quote.valid_until ? new Date(quote.valid_until) : null,
        comments: quote.comments ?? null,
        grandTotalNetAmount: quote.grand_total_net_amount,
        grandTotalGrossAmount: quote.grand_total_gross_amount,
        taxTotalAmount: quote.tax_total_amount,
        customerSnapshot,
        billingAddressSnapshot,
        lines,
      } satisfies QuoteRecord
    } catch (err) {
      console.error('[QuotesDocumentService] fetchData failed', err)
      return data
    }
  }

  override filename({ data }: { data: Record<string, unknown> }): string {
    const num = (data.document as any)?.number
    return num ? `offer-${num}.pdf` : 'offer.pdf'
  }

  toTemplateData({ data }: { data: unknown }): Record<string, unknown> {
    const r = data as QuoteRecord
    const customer = typeof r.customerSnapshot === 'string' ? JSON.parse(r.customerSnapshot) : r.customerSnapshot as any
    const billing = typeof r.billingAddressSnapshot === 'string' ? JSON.parse(r.billingAddressSnapshot) : r.billingAddressSnapshot as any

    const addressParts = [
      billing?.addressLine1,
      billing?.addressLine2,
      [billing?.postalCode, billing?.city].filter(Boolean).join(' '),
      billing?.region,
      billing?.country,
    ].filter(Boolean)

    const lines = (r.lines ?? []).map((line) => ({
      title: line.name ?? '',
      description: line.description ?? undefined,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPriceNet),
      total: Number(line.totalNetAmount),
      currency: line.currencyCode,
    }))

    return {
      document: {
        number: r.quoteNumber,
        date: r.validFrom ? formatDate(r.validFrom.toISOString()) : formatDate(new Date().toISOString()),
        validUntil: r.validUntil ? formatDate(r.validUntil.toISOString()) : undefined,
      },
      client: {
        name: customer?.contact
          ? `${customer.contact.firstName} ${customer.contact.lastName}`
          : (customer?.customer?.personProfile
            ? `${customer.customer.personProfile.firstName} ${customer.customer.personProfile.lastName}`
            : (customer?.customer?.displayName ?? '')),
        company: customer?.customer?.companyProfile?.legalName ?? customer?.customer?.companyProfile?.brandName ?? undefined,
        email: customer?.customer?.primaryEmail ?? undefined,
        address: addressParts.length > 0 ? addressParts.join(', ') : undefined,
      },
      seller: {
        name: '',
        company: '',
        email: '',
      },
      lines,
      totals: {
        subtotal: Number(r.grandTotalNetAmount ?? 0),
        tax: Number(r.taxTotalAmount ?? 0),
        total: Number(r.grandTotalGrossAmount ?? 0),
        currency: r.currencyCode,
      },
      notes: r.comments ?? undefined,
    }
  }
}
