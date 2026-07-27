'use client'

import * as React from 'react'
import { Eye } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@open-mercato/ui/primitives/drawer'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  InvoiceForm,
  emptyInvoiceFormValue,
  type InvoicePreviewSnapshot,
} from '../[id]/edit/InvoiceForm'
import { InvoiceDocumentPreview } from '../../../../components/InvoiceDocumentPreview'
import { PAYMENT_METHODS } from '../../../../components/PaymentFields'
import { useInvoiceSettings } from '../../../../components/useInvoiceSettings'

/**
 * Create-invoice page (SPEC-013). Renders the shared {@link InvoiceForm} in create mode, with the
 * live document preview behind a drawer.
 *
 * On submit the form POSTs the base invoice to core `/api/sales/invoices` (persisting lines), reads
 * the new id, PUTs the PL-VAT metadata to `/api/financial_pl/ksef/invoice-meta`, then navigates to
 * the new invoice's edit page — switching to edit/PUT mode so a failed meta step is retried in place
 * (never re-POSTing, which would duplicate-create).
 */
export default function CreateInvoicePage() {
  const t = useT()
  // Built once per mount so the starter line/header defaults are stable.
  const initialValue = React.useMemo(() => emptyInvoiceFormValue(), [])
  const [snapshot, setSnapshot] = React.useState<InvoicePreviewSnapshot | null>(null)
  // The preview used to hold a permanent 40% column beside the form. That column starved the line
  // editor: its seven-column table had ~64px per numeric cell, and every field added (GTU, CN/PKWiU)
  // made it worse. The document is something you check before filing rather than watch continuously,
  // so it moved into a drawer — the form gets the full width, and the preview gets more room than
  // the sidebar ever gave it.
  const [previewOpen, setPreviewOpen] = React.useState(false)
  // The logo and footer live in invoice settings and print on the document, so the preview has to
  // read them too — otherwise the settings screen promises something the preview never shows.
  const invoiceSettings = useInvoiceSettings()

  const paymentMethodLabel = React.useMemo(() => {
    const method = snapshot?.payment?.method
    if (!method) return null
    const known = (PAYMENT_METHODS as readonly string[]).includes(method)
    const label = t(`financial_pl.invoices.form.payment.methods.${method}`, method)
    return known && method === 'other' && snapshot?.payment?.methodOther
      ? `${label} (${snapshot.payment.methodOther})`
      : label
  }, [snapshot?.payment, t])

  return (
    <Page>
      <PageBody>
        <InvoiceForm
          initialValue={initialValue}
          onPreviewChange={setSnapshot}
          headerActions={
            <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
              <Eye className="mr-1 size-4" />
              {t('financial_pl.invoices.create.showPreview', 'Show preview')}
            </Button>
          }
        />
        <Drawer open={previewOpen} onOpenChange={setPreviewOpen}>
          {/* Wider than the DS default `max-w-md`: this is a document, and 448px would render it
              narrower than the sidebar column it replaces. */}
          <DrawerContent className="max-w-3xl">
            <DrawerHeader>
              <DrawerTitle>
                {t('financial_pl.invoices.create.previewTitle', 'Invoice preview')}
              </DrawerTitle>
              <DrawerDescription>
                {t(
                  'financial_pl.invoices.create.previewHint',
                  'Draft — reflects the form as filled in right now.',
                )}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody className="pb-6">
              <InvoiceDocumentPreview
                logoDataUrl={invoiceSettings?.logoDataUrl ?? null}
                footerNote={invoiceSettings?.footerNote ?? null}
                invoiceNumber={snapshot?.invoiceNumber ?? null}
                invoiceNumberProvisional={snapshot?.invoiceNumberProvisional}
                seller={null}
                buyer={{
                  name: snapshot?.buyer?.companyName ?? null,
                  nip: snapshot?.buyer?.nip ?? null,
                  addressLine1: snapshot?.buyer?.addressLine1 ?? null,
                  addressLine2: snapshot?.buyer?.addressLine2 ?? null,
                  postalCode: snapshot?.buyer?.postalCode ?? null,
                  city: snapshot?.buyer?.city ?? null,
                  countryCode: snapshot?.buyer?.countryCode ?? null,
                }}
                issueDate={snapshot?.header.issueDate || null}
                saleDate={snapshot?.header.saleDate || null}
                dueDate={snapshot?.header.dueDate || null}
                currency={snapshot?.header.currencyCode || 'PLN'}
                lines={(snapshot?.lines ?? []).map((line) => ({
                  name: line.name,
                  quantity: line.quantity,
                  quantityUnit: line.quantityUnit,
                  unitPriceNet: line.unitPriceNet,
                  taxRate: line.taxRate,
                  discountPercent: line.discountPercent,
                  discountAmount: line.discountAmount,
                  totalNetAmount: line.totalNetAmount,
                  taxAmount: line.taxAmount,
                  totalGrossAmount: line.totalGrossAmount,
                  currencyCode: line.currencyCode,
                }))}
                totalNet={sumLines(snapshot, 'totalNetAmount')}
                taxTotal={sumLines(snapshot, 'taxAmount')}
                totalGross={sumLines(snapshot, 'totalGrossAmount')}
                exchangeRate={snapshot?.meta?.exchangeRate ?? null}
                exchangeRateDate={snapshot?.meta?.exchangeRateDate ?? null}
                note={snapshot?.notes ?? null}
                signature={snapshot?.signature ?? null}
                payment={
                  snapshot?.payment
                    ? {
                        methodLabel: paymentMethodLabel,
                        bankAccount: snapshot.payment.bankAccount ?? null,
                        bankName: snapshot.payment.bankName ?? null,
                        swift: snapshot.payment.swift ?? null,
                        paid: snapshot.payment.paid,
                        paidDate: snapshot.payment.paidDate ?? null,
                      }
                    : null
                }
              />
            </DrawerBody>
          </DrawerContent>
        </Drawer>
      </PageBody>
    </Page>
  )
}

/** Totals are not persisted yet while creating, so the preview sums the line values itself. */
function sumLines(
  snapshot: InvoicePreviewSnapshot | null,
  key: 'totalNetAmount' | 'taxAmount' | 'totalGrossAmount',
): string | null {
  if (!snapshot?.lines?.length) return null
  const total = snapshot.lines.reduce((sum, line) => {
    const value = Number(line[key])
    return Number.isFinite(value) ? sum + value : sum
  }, 0)
  return total.toFixed(2)
}
