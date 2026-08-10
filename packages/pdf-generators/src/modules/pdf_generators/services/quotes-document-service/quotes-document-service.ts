import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { BaseDocumentService } from '../base-document-service'
import { formatDate } from '../../utils/formatDate'
import { quoteDocumentInputSchema } from './validators'

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

type EntityCtor<T extends object> = new (...args: unknown[]) => T

interface SalesQuoteRow {
  id: string
  tenantId: string
  organizationId: string
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
  customerEntityId: string | null
  lines: { getItems(): SalesQuoteLineRow[] }
}

interface SalesQuoteLineRow {
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

interface CustomerAddressRow {
  entity: string
  isPrimary: boolean
  addressLine1: string
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
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
        import('../../templates/sales/quotes/templates/sales-offer').then(
          (m) => ({
            type: 'react-pdf' as const,
            component: m.SalesOfferDocument as unknown as React.ComponentType<{ data: Record<string, unknown> }>,
          })
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
    const { id } = quoteDocumentInputSchema.parse(data)

    if (!auth?.tenantId || !auth?.orgId) throw new Error('[QuotesDocumentService] Missing auth context — tenantId and orgId are required to fetch quote data.')

    const em = container.resolve('em') as Parameters<typeof findOneWithDecryption>[0]
    const SalesQuote = container.resolve('SalesQuote') as unknown as EntityCtor<SalesQuoteRow>

    const quote = await findOneWithDecryption<SalesQuoteRow>(em, SalesQuote, {
      id,
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    }, { populate: ['lines'] })
    if (!quote) throw new Error('[QuotesDocumentService] Quote not found or not accessible')

    const lines: QuoteLineItem[] = (quote.lines?.getItems?.() ?? []).map((line) => ({
      id: line.id,
      name: line.name ?? null,
      description: line.description ?? null,
      quantity: line.quantity ?? '0',
      unitPriceNet: line.unitPriceNet ?? '0',
      unitPriceGross: line.unitPriceGross ?? '0',
      totalNetAmount: line.totalNetAmount ?? '0',
      totalGrossAmount: line.totalGrossAmount ?? '0',
      taxRate: line.taxRate ?? '0',
      currencyCode: line.currencyCode,
    }))

    let billingAddressSnapshot = quote.billingAddressSnapshot ?? null

    // fall back to the customer's primary address when the quote has no billing address snapshot
    if (!billingAddressSnapshot && quote.customerEntityId) {
      const CustomerAddress = container.resolve('CustomerAddress') as unknown as EntityCtor<CustomerAddressRow>
      const address = await findOneWithDecryption<CustomerAddressRow>(em, CustomerAddress, { entity: quote.customerEntityId, isPrimary: true })
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

    return {
      id: quote.id,
      quoteNumber: quote.quoteNumber,
      currencyCode: quote.currencyCode,
      validFrom: quote.validFrom ?? null,
      validUntil: quote.validUntil ?? null,
      comments: quote.comments ?? null,
      grandTotalNetAmount: quote.grandTotalNetAmount,
      grandTotalGrossAmount: quote.grandTotalGrossAmount,
      taxTotalAmount: quote.taxTotalAmount,
      customerSnapshot: quote.customerSnapshot ?? null,
      billingAddressSnapshot,
      lines,
    } satisfies QuoteRecord
  }

  override filename({ data }: { data: Record<string, unknown> }): string {
    const num = (data.document as any)?.number
    return num ? `offer-${num}.pdf` : 'offer.pdf'
  }

  override resourceLabel({ data }: { data: Record<string, unknown> }): string | undefined {
    return (data.document as { number?: string } | undefined)?.number
  }

  override resourceId({ data }: { data: Record<string, unknown> }): string | undefined {
    return (data.document as { id?: string } | undefined)?.id
  }

  toTemplateData({ data, locale }: { data: unknown; locale: string }): Record<string, unknown> {
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
        id: r.id,
        number: r.quoteNumber,
        date: r.validFrom ? formatDate(r.validFrom.toISOString(), locale) : formatDate(new Date().toISOString(), locale),
        validUntil: r.validUntil ? formatDate(r.validUntil.toISOString(), locale) : undefined,
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
