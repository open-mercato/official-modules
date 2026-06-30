/**
 * Invoice PDF visualization renderer (pure: pdf-lib + a caller-supplied Unicode
 * font + optional KOD I QR PNG + an optional KOD II cert-signed QR PNG for
 * offline-issued invoices). Produces an A4 Polish "Faktura VAT" layout from an
 * InvoicePdfModel. No DB/DI/network — unit-testable on bytes.
 *
 * A Unicode TTF (LiberationSans, bundled) MUST be supplied: the standard PDF fonts
 * cannot render Polish diacritics. Fontkit is registered to embed it.
 */
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { InvoicePdfModel } from './invoice-pdf-model'

// Polish fiscal-document labels (a PL invoice is Polish-language by law — these are
// document constants, not UI strings).
const L = {
  seller: 'Sprzedawca',
  buyer: 'Nabywca',
  nip: 'NIP',
  issueDate: 'Data wystawienia',
  saleDate: 'Data sprzedaży',
  lp: 'Lp.',
  name: 'Nazwa',
  qty: 'Ilość',
  unit: 'j.m.',
  unitNet: 'Cena netto',
  net: 'Wartość netto',
  vatRate: 'VAT',
  vatAmount: 'Kwota VAT',
  gross: 'Wartość brutto',
  summary: 'Podsumowanie VAT',
  rate: 'Stawka',
  totalNet: 'Razem netto',
  totalVat: 'Razem VAT',
  totalGross: 'Razem brutto',
  toPay: 'Do zapłaty',
  ksefNumber: 'Numer KSeF',
  correctionReason: 'Przyczyna korekty',
} as const

const A4 = { w: 595.28, h: 841.89 }
const M = 40
const DARK = rgb(0.1, 0.1, 0.1)
const GREY = rgb(0.45, 0.45, 0.45)
const LINE = rgb(0.8, 0.8, 0.8)

// Line-table columns (x offsets from left margin; the name column flexes).
const COL = { lp: 0, name: 26, qty: 250, unit: 300, unitNet: 330, net: 395, vat: 455, vatAmt: 480, gross: 535 }
const TABLE_RIGHT = A4.w - M - M // content width
const ROW_HEIGHT = 13
const TABLE_HEADER_HEIGHT = 18
const SINGLE_PAGE_LINE_LIMIT = 40
const MULTI_PAGE_BOTTOM_Y = M + 20
const FINAL_BLOCK_BOTTOM_Y = M + 40 + 90 + 12

function clip(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxWidth) t = t.slice(0, -1)
  return t + '…'
}

export async function renderInvoicePdf(
  model: InvoicePdfModel,
  deps: { fontBytes: Uint8Array; qrPng?: Uint8Array; qrIiPng?: Uint8Array },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  // Make the output deterministic: pdf-lib otherwise stamps the document Info
  // dictionary with the current wall-clock CreationDate/ModDate, so two renders of
  // the same model produce byte-different PDFs (the timestamps drift across a second
  // boundary). Pin both to a fixed epoch so identical inputs yield byte-identical
  // bytes — the documented byte-stable invariant for the visualization renderer.
  const FIXED_PDF_DATE = new Date(0)
  doc.setCreationDate(FIXED_PDF_DATE)
  doc.setModificationDate(FIXED_PDF_DATE)
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(deps.fontBytes, { subset: true })

  if (model.lines.length <= SINGLE_PAGE_LINE_LIMIT) {
    const page = doc.addPage([A4.w, A4.h])

    let y = A4.h - M
    const text = (s: string, x: number, yy: number, size = 9, color = DARK) => page.drawText(s, { x, y: yy, size, font, color })
    const right = (s: string, xRight: number, yy: number, size = 9, color = DARK) =>
      page.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y: yy, size, font, color })

    // Header
    text(model.title, M, y, 18)
    text(`${L.ksefNumber}: ${model.ksef.label}`, M, y - 22, 9, model.ksef.number ? DARK : GREY)
    right(`Nr ${model.invoiceNumber}`, A4.w - M, y, 12)
    right(`${L.issueDate}: ${model.issueDate}`, A4.w - M, y - 16, 9, GREY)
    if (model.saleDate) right(`${L.saleDate}: ${model.saleDate}`, A4.w - M, y - 28, 9, GREY)
    y -= 56

    // Parties (two columns)
    const colW = (TABLE_RIGHT - 20) / 2
    const drawParty = (title: string, x: number, p: InvoicePdfModel['seller']) => {
      let yy = y
      text(title, x, yy, 10, GREY); yy -= 14
      text(clip(font, p.name, 10, colW), x, yy, 10); yy -= 13
      if (p.nip) { text(`${L.nip}: ${p.nip}`, x, yy, 9); yy -= 12 }
      text(clip(font, p.addressLine1, 9, colW), x, yy, 9); yy -= 12
      if (p.addressLine2) { text(clip(font, p.addressLine2, 9, colW), x, yy, 9); yy -= 12 }
      return yy
    }
    const yLeft = drawParty(L.seller, M, model.seller)
    const yRight = drawParty(L.buyer, M + colW + 20, model.buyer)
    y = Math.min(yLeft, yRight) - 14

    // Line table header
    const x0 = M
    const hSize = 7.5
    page.drawLine({ start: { x: x0, y: y + 10 }, end: { x: A4.w - M, y: y + 10 }, thickness: 0.5, color: LINE })
    text(L.lp, x0 + COL.lp, y, hSize, GREY)
    text(L.name, x0 + COL.name, y, hSize, GREY)
    right(L.qty, x0 + COL.unit - 4, y, hSize, GREY)
    text(L.unit, x0 + COL.unit, y, hSize, GREY)
    right(L.unitNet, x0 + COL.net - 4, y, hSize, GREY)
    right(L.net, x0 + COL.vat - 4, y, hSize, GREY)
    text(L.vatRate, x0 + COL.vat, y, hSize, GREY)
    right(L.vatAmount, x0 + COL.gross - 4, y, hSize, GREY)
    right(L.gross, x0 + COL.gross + 40, y, hSize, GREY)
    y -= 6
    page.drawLine({ start: { x: x0, y }, end: { x: A4.w - M, y }, thickness: 0.5, color: LINE })
    y -= 12

    // Line rows
    const rSize = 8
    for (const ln of model.lines) {
      text(String(ln.lp), x0 + COL.lp, y, rSize)
      text(clip(font, ln.name, rSize, COL.qty - COL.name - 6), x0 + COL.name, y, rSize)
      right(ln.quantity, x0 + COL.unit - 4, y, rSize)
      text(clip(font, ln.unit, rSize, 26), x0 + COL.unit, y, rSize)
      right(ln.unitNet, x0 + COL.net - 4, y, rSize)
      right(ln.net, x0 + COL.vat - 4, y, rSize)
      text(ln.vatRateLabel, x0 + COL.vat, y, rSize)
      right(ln.vat, x0 + COL.gross - 4, y, rSize)
      right(ln.gross, x0 + COL.gross + 40, y, rSize)
      y -= 13
    }
    y -= 4
    page.drawLine({ start: { x: x0, y: y + 8 }, end: { x: A4.w - M, y: y + 8 }, thickness: 0.5, color: LINE })
    y -= 10

    // VAT summary + totals (right-aligned block)
    text(L.summary, x0, y, 9, GREY)
    for (const r of model.vatSummary) {
      text(`${L.rate} ${r.vatRateLabel}`, x0, y - 12, 8)
      right(`${r.net}`, x0 + 320, y - 12, 8)
      right(`${r.vat}`, x0 + 400, y - 12, 8)
      right(`${r.gross}`, x0 + 480, y - 12, 8)
      y -= 12
    }
    y -= 8
    right(`${L.totalNet}: ${model.totalNet} ${model.currencyCode}`, A4.w - M, y, 9)
    right(`${L.totalVat}: ${model.totalVat} ${model.currencyCode}`, A4.w - M, y - 13, 9)
    right(`${L.toPay}: ${model.totalGross} ${model.currencyCode}`, A4.w - M, y - 28, 12)
    y -= 44

    if (model.correctionReason) {
      text(clip(font, `${L.correctionReason}: ${model.correctionReason}`, 8, TABLE_RIGHT), x0, y, 8, GREY)
      y -= 16
    }

    // KSeF block + KOD I QR (bottom-left)
    const qrY = M + 40
    const qrSize = 90
    if (deps.qrPng) {
      const png = await doc.embedPng(deps.qrPng)
      page.drawImage(png, { x: M, y: qrY, width: qrSize, height: qrSize })
      text(model.ksef.label, M, qrY - 12, 8, model.ksef.number ? DARK : GREY)
    }
    // KOD II cert-signed QR (offline-issued only): rendered to the right of KOD I,
    // labelled "CERTYFIKAT" (model.ksefCert.label). Present only when both the model
    // carries a ksefCert block AND the caller supplies the KOD II PNG — otherwise the
    // single-QR (KOD I only) byte layout above is unchanged.
    if (deps.qrIiPng && model.ksefCert) {
      const pngIi = await doc.embedPng(deps.qrIiPng)
      const xIi = M + qrSize + 24
      page.drawImage(pngIi, { x: xIi, y: qrY, width: qrSize, height: qrSize })
      text(model.ksefCert.label, xIi, qrY - 12, 8, GREY)
    }

    // Footer notice (visualization disclaimer)
    text(clip(font, model.notice, 7.5, TABLE_RIGHT), M, M - 4, 7.5, GREY)

    return doc.save()
  }

  const x0 = M
  const hSize = 7.5
  const rSize = 8
  const qrY = M + 40
  const qrSize = 90
  const colW = (TABLE_RIGHT - 20) / 2
  const firstTableY = (() => {
    const partyTopY = A4.h - M - 56
    const partyBottomY = (p: InvoicePdfModel['seller']) => {
      let yy = partyTopY
      yy -= 14
      yy -= 13
      if (p.nip) yy -= 12
      yy -= 12
      if (p.addressLine2) yy -= 12
      return yy
    }
    return Math.min(partyBottomY(model.seller), partyBottomY(model.buyer)) - 14
  })()
  const firstRowsStartY = firstTableY - TABLE_HEADER_HEIGHT
  const continuationRowsStartY = A4.h - M - TABLE_HEADER_HEIGHT
  const firstPageCapacity = Math.max(1, Math.floor((firstRowsStartY - MULTI_PAGE_BOTTOM_Y) / ROW_HEIGHT))
  const continuationCapacity = Math.max(1, Math.floor((continuationRowsStartY - MULTI_PAGE_BOTTOM_Y) / ROW_HEIGHT))
  const finalBlockHeight = 12 * model.vatSummary.length + 52 + (model.correctionReason ? 16 : 0)
  const finalPageCapacity = Math.max(0, Math.floor((continuationRowsStartY - 14 - finalBlockHeight - FINAL_BLOCK_BOTTOM_Y) / ROW_HEIGHT))
  const finalPageMinimumRows = finalPageCapacity > 0 ? 1 : 0

  let totalPages = 2
  while (
    model.lines.length >
    firstPageCapacity + Math.max(0, totalPages - 2) * continuationCapacity + finalPageCapacity
  ) {
    totalPages += 1
  }

  const lineChunks: InvoicePdfModel['lines'][] = []
  let remainingLineIndex = 0
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const remainingLines = model.lines.length - remainingLineIndex
    if (pageIndex === totalPages - 1) {
      lineChunks.push(model.lines.slice(remainingLineIndex))
      break
    }
    const capacity = pageIndex === 0 ? firstPageCapacity : continuationCapacity
    const pagesAfterThis = totalPages - pageIndex - 1
    const minimumRowsAfterThis = Math.max(0, pagesAfterThis - 1) + finalPageMinimumRows
    const take = Math.max(1, Math.min(capacity, remainingLines - minimumRowsAfterThis))
    lineChunks.push(model.lines.slice(remainingLineIndex, remainingLineIndex + take))
    remainingLineIndex += take
  }

  const png = deps.qrPng ? await doc.embedPng(deps.qrPng) : undefined
  const pngIi = deps.qrIiPng && model.ksefCert ? await doc.embedPng(deps.qrIiPng) : undefined
  let page = doc.addPage([A4.w, A4.h])
  const text = (s: string, x: number, yy: number, size = 9, color = DARK) => page.drawText(s, { x, y: yy, size, font, color })
  const right = (s: string, xRight: number, yy: number, size = 9, color = DARK) =>
    page.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y: yy, size, font, color })
  const drawTableHeader = (yy: number): number => {
    page.drawLine({ start: { x: x0, y: yy + 10 }, end: { x: A4.w - M, y: yy + 10 }, thickness: 0.5, color: LINE })
    text(L.lp, x0 + COL.lp, yy, hSize, GREY)
    text(L.name, x0 + COL.name, yy, hSize, GREY)
    right(L.qty, x0 + COL.unit - 4, yy, hSize, GREY)
    text(L.unit, x0 + COL.unit, yy, hSize, GREY)
    right(L.unitNet, x0 + COL.net - 4, yy, hSize, GREY)
    right(L.net, x0 + COL.vat - 4, yy, hSize, GREY)
    text(L.vatRate, x0 + COL.vat, yy, hSize, GREY)
    right(L.vatAmount, x0 + COL.gross - 4, yy, hSize, GREY)
    right(L.gross, x0 + COL.gross + 40, yy, hSize, GREY)
    yy -= 6
    page.drawLine({ start: { x: x0, y: yy }, end: { x: A4.w - M, y: yy }, thickness: 0.5, color: LINE })
    return yy - 12
  }
  const drawLineRows = (yy: number, lines: InvoicePdfModel['lines']): number => {
    for (const ln of lines) {
      text(String(ln.lp), x0 + COL.lp, yy, rSize)
      text(clip(font, ln.name, rSize, COL.qty - COL.name - 6), x0 + COL.name, yy, rSize)
      right(ln.quantity, x0 + COL.unit - 4, yy, rSize)
      text(clip(font, ln.unit, rSize, 26), x0 + COL.unit, yy, rSize)
      right(ln.unitNet, x0 + COL.net - 4, yy, rSize)
      right(ln.net, x0 + COL.vat - 4, yy, rSize)
      text(ln.vatRateLabel, x0 + COL.vat, yy, rSize)
      right(ln.vat, x0 + COL.gross - 4, yy, rSize)
      right(ln.gross, x0 + COL.gross + 40, yy, rSize)
      yy -= ROW_HEIGHT
    }
    return yy
  }
  const drawFooter = (pageNumber: number) => {
    text(clip(font, model.notice, 7.5, TABLE_RIGHT), M, M - 4, 7.5, GREY)
    right(`Strona ${pageNumber} / ${totalPages}`, A4.w - M, M - 4, 7.5, GREY)
  }

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    if (pageIndex > 0) page = doc.addPage([A4.w, A4.h])
    let y = A4.h - M
    if (pageIndex === 0) {
      text(model.title, M, y, 18)
      text(`${L.ksefNumber}: ${model.ksef.label}`, M, y - 22, 9, model.ksef.number ? DARK : GREY)
      right(`Nr ${model.invoiceNumber}`, A4.w - M, y, 12)
      right(`${L.issueDate}: ${model.issueDate}`, A4.w - M, y - 16, 9, GREY)
      if (model.saleDate) right(`${L.saleDate}: ${model.saleDate}`, A4.w - M, y - 28, 9, GREY)
      y -= 56

      const drawParty = (title: string, x: number, p: InvoicePdfModel['seller']) => {
        let yy = y
        text(title, x, yy, 10, GREY); yy -= 14
        text(clip(font, p.name, 10, colW), x, yy, 10); yy -= 13
        if (p.nip) { text(`${L.nip}: ${p.nip}`, x, yy, 9); yy -= 12 }
        text(clip(font, p.addressLine1, 9, colW), x, yy, 9); yy -= 12
        if (p.addressLine2) { text(clip(font, p.addressLine2, 9, colW), x, yy, 9); yy -= 12 }
        return yy
      }
      const yLeft = drawParty(L.seller, M, model.seller)
      const yRight = drawParty(L.buyer, M + colW + 20, model.buyer)
      y = Math.min(yLeft, yRight) - 14
    }

    y = drawTableHeader(y)
    y = drawLineRows(y, lineChunks[pageIndex] ?? [])

    if (pageIndex === totalPages - 1) {
      y -= 4
      page.drawLine({ start: { x: x0, y: y + 8 }, end: { x: A4.w - M, y: y + 8 }, thickness: 0.5, color: LINE })
      y -= 10

      text(L.summary, x0, y, 9, GREY)
      for (const r of model.vatSummary) {
        text(`${L.rate} ${r.vatRateLabel}`, x0, y - 12, 8)
        right(`${r.net}`, x0 + 320, y - 12, 8)
        right(`${r.vat}`, x0 + 400, y - 12, 8)
        right(`${r.gross}`, x0 + 480, y - 12, 8)
        y -= 12
      }
      y -= 8
      right(`${L.totalNet}: ${model.totalNet} ${model.currencyCode}`, A4.w - M, y, 9)
      right(`${L.totalVat}: ${model.totalVat} ${model.currencyCode}`, A4.w - M, y - 13, 9)
      right(`${L.toPay}: ${model.totalGross} ${model.currencyCode}`, A4.w - M, y - 28, 12)
      y -= 44

      if (model.correctionReason) {
        text(clip(font, `${L.correctionReason}: ${model.correctionReason}`, 8, TABLE_RIGHT), x0, y, 8, GREY)
      }

      if (png) {
        page.drawImage(png, { x: M, y: qrY, width: qrSize, height: qrSize })
        text(model.ksef.label, M, qrY - 12, 8, model.ksef.number ? DARK : GREY)
      }
      if (pngIi && model.ksefCert) {
        const xIi = M + qrSize + 24
        page.drawImage(pngIi, { x: xIi, y: qrY, width: qrSize, height: qrSize })
        text(model.ksefCert.label, xIi, qrY - 12, 8, GREY)
      }
    }

    drawFooter(pageIndex + 1)
  }

  return doc.save()
}
