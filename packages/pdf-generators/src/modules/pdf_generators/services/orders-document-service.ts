import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { BaseDocumentService } from './base-document-service'
import { formatDate } from '../utils/formatDate'

/** Template IDs registered by this service — exported for TemplateId type derivation. */
export const ORDERS_TEMPLATE_IDS = ['order-invoice'] as const

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
 * Document service for the Orders module.
 *
 * fetchData loads the full order from the database.
 * normalizeRecord maps it to the flat shape expected by PDF templates.
 */
export class OrdersDocumentService extends BaseDocumentService {
  readonly id = 'orders'
  readonly label = 'Orders'
  readonly module = 'sales'
  readonly resourceKind = 'sales.order'

  constructor() {
    super()

    this.registerTemplate({
      id: 'order-invoice',
      label: 'Order Invoice',
      description: 'Standard invoice for a sales order.',
      documentType: 'invoice',
      tags: ['invoice', 'order', 'sales'],
      note: 'Rendered in the PDF tab on the Order detail page (sales.document.detail.order:tabs).',
      load: () =>
        import('../templates/sales/orders/templates/order-invoice').then(
          (m) => m.OrderInvoiceDocument as unknown as React.ComponentType<{ data: Record<string, unknown> }>
        ),
    })
  }

  /**
   * Loads the full order with line items from the database.
   * The widget only needs to pass { id }.
   *
   * @param record - Widget record containing at minimum { id }
   * @param container - Request-scoped Awilix DI container
   */
  override async fetchData({ data }: { data: unknown }, { container, auth }: { container: AppContainer; auth: AuthContext | null }): Promise<unknown> {
    const { id } = data as { id: string }
    if (!id) return data

    try {
      const em = container.resolve('em') as Parameters<typeof findOneWithDecryption>[0]
      const SalesOrder = container.resolve('SalesOrder')

      const order = await findOneWithDecryption(em, SalesOrder, {
        id,
        ...(auth?.tenantId ? { tenantId: auth.tenantId } : {}),
        ...(auth?.orgId ? { organizationId: auth.orgId } : {}),
      } as any, { populate: ['lines'] } as any) as any
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
        const address = await findOneWithDecryption(em, CustomerAddress, { entity: order.customerEntityId, isPrimary: true } as any) as any
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
      console.error('[OrdersDocumentService] fetchData failed', err)
      return data
    }
  }

  override filename({ data }: { data: Record<string, unknown> }): string {
    const num = (data.document as any)?.number
    return num ? `invoice-${num}.pdf` : 'invoice.pdf'
  }

  toTemplateData({ data }: { data: unknown }): Record<string, unknown> {
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
        number: r.orderNumber,
        date: r.placedAt ? formatDate(r.placedAt.toISOString()) : formatDate(new Date().toISOString()),
        dueDate: r.expectedDeliveryAt ? formatDate(r.expectedDeliveryAt.toISOString()) : undefined,
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
