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
  notes: 'Uwagi',
  correctionReason: 'Przyczyna korekty',
  payment: 'Płatność',
  paymentMethod: 'Sposób płatności',
  paymentTerm: 'Termin płatności',
  paymentPaid: 'Zapłacono',
  paymentAccount: 'Nr konta',
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
const SINGLE_PAGE_LINE_LIMIT = 45
const MULTI_PAGE_BOTTOM_Y = M + 20
const FINAL_BLOCK_BOTTOM_Y = M + 40 + 90 + 12
const NOTE_FONT_SIZE = 8
const NOTE_LINE_HEIGHT = 10
const NOTE_LABEL_GAP = 13
const NOTE_AFTER_GAP = 4
const PAYMENT_LINE_HEIGHT = 11
const PAYMENT_LABEL_GAP = 13
const PAYMENT_AFTER_GAP = 8

function clip(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxWidth) t = t.slice(0, -1)
  return t + '…'
}

function splitLongWord(font: PDFFont, word: string, size: number, maxWidth: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word]
  const chunks: string[] = []
  let current = ''
  for (const ch of word) {
    const next = current + ch
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      chunks.push(current)
      current = ch
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function wrapText(font: PDFFont, value: string, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of value.replace(/\r\n?/g, '\n').split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      if (lines.length > 0) lines.push('')
      continue
    }
    let current = ''
    for (const word of words) {
      for (const part of splitLongWord(font, word, size, maxWidth)) {
        const next = current ? `${current} ${part}` : part
        if (!current || font.widthOfTextAtSize(next, size) <= maxWidth) {
          current = next
        } else {
          lines.push(current)
          current = part
        }
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

function noteBlockHeight(lineCount: number): number {
  return lineCount > 0 ? NOTE_LABEL_GAP + lineCount * NOTE_LINE_HEIGHT + NOTE_AFTER_GAP : 0
}

function noteLineCapacity(topY: number, bottomY: number): number {
  return Math.max(0, Math.floor((topY - bottomY - NOTE_LABEL_GAP - NOTE_AFTER_GAP) / NOTE_LINE_HEIGHT))
}

function paymentBlockLines(payment: NonNullable<InvoicePdfModel['payment']>): string[] {
  const lines = [`${L.paymentMethod}: ${payment.methodLabel}`]
  if (payment.term) lines.push(`${L.paymentTerm}: ${payment.term}`)
  if (payment.paid) lines.push(L.paymentPaid)
  if (payment.account) {
    lines.push(`${L.paymentAccount}: ${payment.account}${payment.bankName ? ` (${payment.bankName})` : ''}`)
  }
  return lines
}

function paymentBlockHeight(model: InvoicePdfModel): number {
  return model.payment ? PAYMENT_LABEL_GAP + paymentBlockLines(model.payment).length * PAYMENT_LINE_HEIGHT + PAYMENT_AFTER_GAP : 0
}

function partyBottomY(p: InvoicePdfModel['seller'], partyTopY: number): number {
  let yy = partyTopY
  yy -= 14
  yy -= 13
  if (p.nip) yy -= 12
  yy -= 12
  if (p.addressLine2) yy -= 12
  return yy
}

function firstTableY(model: InvoicePdfModel): number {
  const partyTopY = A4.h - M - 56
  return Math.min(partyBottomY(model.seller, partyTopY), partyBottomY(model.buyer, partyTopY)) - 14 - paymentBlockHeight(model)
}

function estimateSinglePageYBeforeNotes(model: InvoicePdfModel): number {
  let y = firstTableY(model)
  y -= TABLE_HEADER_HEIGHT
  y -= model.lines.length * ROW_HEIGHT
  y -= 4
  y -= 10
  y -= 12 * model.vatSummary.length
  y -= 8
  y -= 44
  if (model.correctionReason) y -= 16
  return y
}

function estimateContinuationFinalYBeforeNotes(model: InvoicePdfModel, finalLineCount: number): number {
  let y = A4.h - M - TABLE_HEADER_HEIGHT
  y -= finalLineCount * ROW_HEIGHT
  y -= 4
  y -= 10
  y -= 12 * model.vatSummary.length
  y -= 8
  y -= 44
  if (model.correctionReason) y -= 16
  return y
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
  const noteLines = model.notes ? wrapText(font, model.notes, NOTE_FONT_SIZE, TABLE_RIGHT) : []

  if (
    model.lines.length <= SINGLE_PAGE_LINE_LIMIT &&
    (noteLines.length === 0 ||
      estimateSinglePageYBeforeNotes(model) - noteBlockHeight(noteLines.length) >= FINAL_BLOCK_BOTTOM_Y)
  ) {
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
    const drawPaymentBlock = (yy: number): number => {
      if (!model.payment) return yy
      text(L.payment, M, yy, 9, GREY)
      yy -= PAYMENT_LABEL_GAP
      for (const line of paymentBlockLines(model.payment)) {
        text(clip(font, line, 8, TABLE_RIGHT), M, yy, 8, DARK)
        yy -= PAYMENT_LINE_HEIGHT
      }
      return yy - PAYMENT_AFTER_GAP
    }
    const yLeft = drawParty(L.seller, M, model.seller)
    const yRight = drawParty(L.buyer, M + colW + 20, model.buyer)
    y = Math.min(yLeft, yRight) - 14
    if (model.payment) y = drawPaymentBlock(y)

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

    if (noteLines.length > 0) {
      text(L.notes, x0, y, 9, GREY)
      y -= NOTE_LABEL_GAP
      for (const line of noteLines) {
        if (line) text(line, x0, y, NOTE_FONT_SIZE, DARK)
        y -= NOTE_LINE_HEIGHT
      }
      y -= NOTE_AFTER_GAP
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
  const firstTableTopY = firstTableY(model)
  const firstRowsStartY = firstTableTopY - TABLE_HEADER_HEIGHT
  const continuationRowsStartY = A4.h - M - TABLE_HEADER_HEIGHT
  const firstPageCapacity = Math.max(1, Math.floor((firstRowsStartY - MULTI_PAGE_BOTTOM_Y) / ROW_HEIGHT))
  const continuationCapacity = Math.max(1, Math.floor((continuationRowsStartY - MULTI_PAGE_BOTTOM_Y) / ROW_HEIGHT))
  const finalBlockHeight = 12 * model.vatSummary.length + 52 + (model.correctionReason ? 16 : 0)
  const finalPageCapacity = Math.max(0, Math.floor((continuationRowsStartY - 14 - finalBlockHeight - FINAL_BLOCK_BOTTOM_Y) / ROW_HEIGHT))
  const finalPageMinimumRows = finalPageCapacity > 0 ? 1 : 0

  let linePageCount = 2
  while (
    model.lines.length >
    firstPageCapacity + Math.max(0, linePageCount - 2) * continuationCapacity + finalPageCapacity
  ) {
    linePageCount += 1
  }

  const lineChunks: InvoicePdfModel['lines'][] = []
  let remainingLineIndex = 0
  for (let pageIndex = 0; pageIndex < linePageCount; pageIndex += 1) {
    const remainingLines = model.lines.length - remainingLineIndex
    if (pageIndex === linePageCount - 1) {
      lineChunks.push(model.lines.slice(remainingLineIndex))
      break
    }
    const capacity = pageIndex === 0 ? firstPageCapacity : continuationCapacity
    const pagesAfterThis = linePageCount - pageIndex - 1
    const minimumRowsAfterThis = Math.max(0, pagesAfterThis - 1) + finalPageMinimumRows
    const take = Math.max(1, Math.min(capacity, remainingLines - minimumRowsAfterThis))
    lineChunks.push(model.lines.slice(remainingLineIndex, remainingLineIndex + take))
    remainingLineIndex += take
  }

  const finalPageNoteCapacity = noteLines.length
    ? Math.min(
        noteLines.length,
        noteLineCapacity(
          estimateContinuationFinalYBeforeNotes(model, lineChunks[lineChunks.length - 1]?.length ?? 0),
          FINAL_BLOCK_BOTTOM_Y,
        ),
      )
    : 0
  const remainingNoteLinesAfterFinalPage = Math.max(0, noteLines.length - finalPageNoteCapacity)
  const continuationNoteCapacity = Math.max(1, noteLineCapacity(A4.h - M, MULTI_PAGE_BOTTOM_Y))
  const noteContinuationPages =
    remainingNoteLinesAfterFinalPage > 0
      ? Math.ceil(remainingNoteLinesAfterFinalPage / continuationNoteCapacity)
      : 0
  const totalPageCount = linePageCount + noteContinuationPages

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
    right(`Strona ${pageNumber} / ${totalPageCount}`, A4.w - M, M - 4, 7.5, GREY)
  }
  const drawNotesBlock = (yy: number, startIndex: number, maxLines: number): { y: number; nextIndex: number } => {
    if (maxLines <= 0 || startIndex >= noteLines.length) return { y: yy, nextIndex: startIndex }
    text(L.notes, x0, yy, 9, GREY)
    yy -= NOTE_LABEL_GAP
    const endIndex = Math.min(noteLines.length, startIndex + maxLines)
    for (let i = startIndex; i < endIndex; i += 1) {
      const line = noteLines[i]
      if (line) text(line, x0, yy, NOTE_FONT_SIZE, DARK)
      yy -= NOTE_LINE_HEIGHT
    }
    yy -= NOTE_AFTER_GAP
    return { y: yy, nextIndex: endIndex }
  }
  const drawPaymentBlock = (yy: number): number => {
    if (!model.payment) return yy
    text(L.payment, x0, yy, 9, GREY)
    yy -= PAYMENT_LABEL_GAP
    for (const line of paymentBlockLines(model.payment)) {
      text(clip(font, line, 8, TABLE_RIGHT), x0, yy, 8, DARK)
      yy -= PAYMENT_LINE_HEIGHT
    }
    return yy - PAYMENT_AFTER_GAP
  }

  let noteIndex = 0
  for (let pageIndex = 0; pageIndex < linePageCount; pageIndex += 1) {
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
      if (model.payment) y = drawPaymentBlock(y)
    }

    y = drawTableHeader(y)
    y = drawLineRows(y, lineChunks[pageIndex] ?? [])

    if (pageIndex === linePageCount - 1) {
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
        y -= 16
      }

      if (finalPageNoteCapacity > 0) {
        const notes = drawNotesBlock(y, noteIndex, finalPageNoteCapacity)
        y = notes.y
        noteIndex = notes.nextIndex
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

  for (let pageIndex = linePageCount; noteIndex < noteLines.length; pageIndex += 1) {
    page = doc.addPage([A4.w, A4.h])
    const notes = drawNotesBlock(A4.h - M, noteIndex, continuationNoteCapacity)
    noteIndex = notes.nextIndex
    drawFooter(pageIndex + 1)
  }

  return doc.save()
}
