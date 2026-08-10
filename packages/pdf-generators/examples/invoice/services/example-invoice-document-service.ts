import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { BaseDocumentService, formatDate } from '@open-mercato/pdf-generators'

/** Template IDs registered by this service — exported for TemplateId type derivation. */
export const EXAMPLE_INVOICE_TEMPLATE_IDS = ['example-invoice'] as const

/** Fully loaded order data fetched from the database by fetchData. */
export interface OrderRecord {
  id: string
  orderNumber: string
  currencyCode: string
  placedAt: Date | null
  expectedDeliveryAt: Date | null
  comments: string | null
  grandTotalNetAmount: string
  grandTotalGrossAmount: string
  taxTotalAmount: string
  customerSnapshot: Record<string, unknown> | null
  billingAddressSnapshot: Record<string, unknown> | null
  lines: OrderLineItem[]
}

export interface OrderLineItem {
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
 * Example document service — demonstrates external template registration for sales orders.
 * This is a working copy of OrdersDocumentService adapted for use outside the pdf-generators package.
 *
 * - `readonly module`       top-level module name — used for grouping on the backend page
 * - `readonly resourceKind` matches ctx.resourceKind in the widget (e.g. 'sales.order')
 */
export class ExampleInvoicesDocumentService extends BaseDocumentService {
  readonly id = 'example-invoices'
  readonly label = 'Example Invoices'
  readonly module = 'sales'
  readonly resourceKind = 'sales.order'

  constructor() {
    super()

    this.registerTemplate({
      id: 'example-invoice',
      label: 'Example Invoice',
      description: 'Invoice template for a sales order.',
      documentType: 'invoice',
      tags: ['invoice', 'order', 'sales'],
      note: 'Rendered in the PDF tab on the Order detail page (sales.document.detail.order:tabs).',
      load: () =>
        import('./templates/example-invoice').then(
          (m) => ({
            type: 'react-pdf' as const,
            component: m.ExampleInvoiceDocument as unknown as React.ComponentType<{ data: Record<string, unknown> }>,
          })
        ),
    })
  }

  /**
   * Loads the full order with line items from the database.
   * The widget only needs to pass { id }.
   */
  override async fetchData({ data }: { data: unknown }, { container }: { container: AppContainer }): Promise<unknown> {
    const { id } = data as { id: string }
    if (!id) return data

    try {
      const em = container.resolve('em') as { findOne: (entity: unknown, where: unknown, options?: unknown) => Promise<unknown> }
      const SalesOrder = container.resolve('SalesOrder')

      const order = await em.findOne(SalesOrder, { id }, { populate: ['lines'] }) as any
      if (!order) return data

      const lines: OrderLineItem[] = (order.lines?.getItems?.() ?? []).map((line: any) => ({
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

      let billingAddressSnapshot = order.billingAddressSnapshot ?? null

      // fall back to the customer's primary address when the order has no billing address snapshot
      if (!billingAddressSnapshot && order.customerEntityId) {
        const CustomerAddress = container.resolve('CustomerAddress')
        const address = await em.findOne(CustomerAddress, { entity: order.customerEntityId, isPrimary: true }) as any
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
        id: order.id,
        orderNumber: order.orderNumber,
        currencyCode: order.currencyCode,
        placedAt: order.placedAt ?? null,
        expectedDeliveryAt: order.expectedDeliveryAt ?? null,
        comments: order.comments ?? null,
        grandTotalNetAmount: order.grandTotalNetAmount,
        grandTotalGrossAmount: order.grandTotalGrossAmount,
        taxTotalAmount: order.taxTotalAmount,
        customerSnapshot: order.customerSnapshot ?? null,
        billingAddressSnapshot,
        lines,
      } satisfies OrderRecord
    } catch (err) {
      console.error('[ExampleInvoicesDocumentService] fetchData failed', err)
      return data
    }
  }

  override filename({ data }: { data: Record<string, unknown> }): string {
    const num = (data.document as any)?.number
    return num ? `invoice-${num}.pdf` : 'invoice.pdf'
  }

  override resourceId({ data }: { data: Record<string, unknown> }): string | undefined {
    return (data.document as { id?: string } | undefined)?.id
  }

  override resourceLabel({ data }: { data: Record<string, unknown> }): string | undefined {
    return (data.document as { number?: string } | undefined)?.number
  }

  toTemplateData({ data, locale }: { data: unknown; locale: string }): Record<string, unknown> {
    const r = data as OrderRecord
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
        number: r.orderNumber,
        date: r.placedAt ? formatDate(r.placedAt.toISOString(), locale) : formatDate(new Date().toISOString(), locale),
        dueDate: r.expectedDeliveryAt ? formatDate(r.expectedDeliveryAt.toISOString(), locale) : undefined,
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
