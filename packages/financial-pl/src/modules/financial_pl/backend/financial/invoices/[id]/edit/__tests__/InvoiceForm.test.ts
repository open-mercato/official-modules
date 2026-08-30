import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildInvoiceCrudInitialValues,
  buildInvoicePreviewSnapshot,
  emptyInvoiceFormValue,
  normalizeInvoiceFormValue,
  resolveUntouchedCurrencyDefault,
} from '../InvoiceForm'
import { mapResponseToFormValue } from '../page'

describe('InvoiceForm Packet A regressions', () => {
  it('applies the settings currency only to an untouched header', () => {
    const normalized = normalizeInvoiceFormValue(emptyInvoiceFormValue(), false)
    const baseline = buildInvoiceCrudInitialValues(normalized)

    expect(resolveUntouchedCurrencyDefault('eur', baseline, baseline)).toBe('EUR')

    const edited = { ...baseline, invoiceNumber: 'FV/typed-by-user' }
    expect(resolveUntouchedCurrencyDefault('EUR', edited, baseline)).toBeNull()
    expect(edited).toMatchObject({
      invoiceNumber: 'FV/typed-by-user',
      issueDate: baseline.issueDate,
      dueDate: baseline.dueDate,
      saleDate: baseline.saleDate,
    })
  })

  it('builds the preview from live CrudForm header values', () => {
    const normalized = normalizeInvoiceFormValue(emptyInvoiceFormValue(), false)
    const snapshot = buildInvoicePreviewSnapshot(
      normalized,
      {
        invoiceNumber: 'FV/LIVE/1',
        issueDate: '2026-08-10',
        saleDate: '2026-08-11',
        dueDate: '2026-08-25',
        currencyCode: 'EUR',
        notes: 'Live notes',
        signatureMode: 'authorization',
        issuerSignatory: 'Anna Issuer',
        recipientSignatory: 'Rafał Recipient',
      },
      'FV/PROVISIONAL',
    )

    expect(snapshot).toMatchObject({
      invoiceNumber: 'FV/LIVE/1',
      invoiceNumberProvisional: false,
      header: {
        issueDate: '2026-08-10',
        saleDate: '2026-08-11',
        dueDate: '2026-08-25',
        currencyCode: 'EUR',
      },
      notes: 'Live notes',
      signature: {
        mode: 'authorization',
        issuerSignatory: 'Anna Issuer',
        recipientSignatory: 'Rafał Recipient',
      },
    })
  })

  it('keeps PreviewSync and every body panel mounted while tabs are hidden', () => {
    const source = readFileSync(resolve(__dirname, '../InvoiceForm.tsx'), 'utf8')
    const topRowStart = source.indexOf("id: 'topRow'")
    const nextGroupStart = source.indexOf("id: 'preview'", topRowStart)
    const topRow = source.slice(topRowStart, nextGroupStart)

    expect(topRowStart).toBeGreaterThan(-1)
    expect(topRow).toContain('<PreviewSync values={ctx.values} onValues={setLiveHeader} />')
    expect(source).not.toContain('<TabsContent')
    expect(source).toContain("className={activeTab === 'uwagi' ? 'mt-2 flex max-w-xl flex-col gap-4' : 'hidden'}")
    expect(source).toContain("className={activeTab === 'dodatkowe' ? 'mt-2 max-w-xl' : 'hidden'}")
  })

  it('round-trips stored signature, sale date, payment, contract and transport into CrudForm values', () => {
    const mapped = mapResponseToFormValue({
      invoice: {
        invoiceNumber: 'FV/2026/8/1',
        issueDate: '2026-08-13T09:30:00.000Z',
        dueDate: '2026-08-27T00:00:00.000Z',
        currencyCode: 'EUR',
        orderId: null,
        metadata: {
          saleDate: '2026-08-12T00:00:00.000Z',
          contractNumber: 'UM/42',
          transportTerms: 'DAP Warszawa',
          signature: {
            mode: 'authorization',
            issuerSignatory: 'Anna Issuer',
            recipientSignatory: 'Rafał Recipient',
          },
          payment: {
            method: 'transfer',
            termDays: 14,
            bankAccount: 'PL61109010140000071219812874',
            bankName: 'NBP',
            swift: 'NBPLPLPW',
            paid: true,
            paidDate: '2026-08-13',
          },
        },
      },
      lines: [],
      meta: null,
    })
    const normalized = normalizeInvoiceFormValue(mapped, true)
    const crudValues = buildInvoiceCrudInitialValues(normalized)

    expect(crudValues).toMatchObject({
      saleDate: '2026-08-12',
      signatureMode: 'authorization',
      issuerSignatory: 'Anna Issuer',
      recipientSignatory: 'Rafał Recipient',
      contractNumber: 'UM/42',
      transportTerms: 'DAP Warszawa',
    })
    expect(normalized.payment).toEqual({
      method: 'transfer',
      termDays: 14,
      bankAccount: 'PL61109010140000071219812874',
      bankName: 'NBP',
      swift: 'NBPLPLPW',
      paid: true,
      paidDate: '2026-08-13',
    })
  })
})
