import type { CompanyProfile, Quotation } from '../types/api'
import { money, quantity, shortDate, titleCase } from './format'
import {
  downloadInvoiceBlob,
  drawInvoiceFooters,
  drawInvoiceHeader,
  invoiceCompany,
  openInvoicePdf,
} from './invoiceBrand'

export interface QuotationPdfInput {
  quotation: Quotation
  company?: CompanyProfile
  companyName?: string
}

function safeFilenamePart(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
}

export function quotationPdfFilename({ quotation }: QuotationPdfInput) {
  return `${safeFilenamePart(`Quotation_${quotation.quotation_no}_${quotation.customer_name}`)}.pdf`
}

export function quotationWhatsAppMessage(quotation: Quotation) {
  return [
    `Hello ${quotation.customer_name},`,
    '',
    `Please find quotation ${quotation.quotation_no} attached as a PDF.`,
    `Quotation total: ${money(quotation.total_amount)}`,
    `Valid until: ${shortDate(quotation.valid_until)}`,
    '',
    'Thank you.',
  ].join('\n')
}

export async function createQuotationPdfBlob(input: QuotationPdfInput): Promise<Blob> {
  const company = invoiceCompany(input.company ?? (input.companyName ? { name: input.companyName } : null))
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const { quotation } = input
  const document = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const width = document.internal.pageSize.getWidth()
  const height = document.internal.pageSize.getHeight()
  const margin = 14
  type AutoTableDocument = typeof document & { lastAutoTable?: { finalY: number } }

  document.setProperties({ title: `Quotation ${quotation.quotation_no}`, subject: `Quotation for ${quotation.customer_name}`, author: company.name, creator: 'CK SYS' })
  drawInvoiceHeader(document, { company, title: 'QUOTATION', number: quotation.quotation_no })

  document.setTextColor(23, 32, 51)
  document.setFont('helvetica', 'bold')
  document.setFontSize(8)
  document.text('PREPARED FOR', margin, 55)
  document.text('QUOTATION DETAILS', width - 82, 55)
  document.setFontSize(11)
  document.text(quotation.customer_name, margin, 62)
  document.setFont('helvetica', 'normal')
  document.setFontSize(8)
  const customerLines = [quotation.customer_phone, quotation.customer_email, quotation.customer_address].filter(Boolean) as string[]
  document.text(customerLines.length ? customerLines : ['No additional customer details'], margin, 68, { maxWidth: 100 })
  document.text(`Date: ${shortDate(quotation.quotation_date)}`, width - 82, 62)
  document.text(`Valid until: ${shortDate(quotation.valid_until)}`, width - 82, 68)
  document.text(`Payment: ${titleCase(quotation.payment_method || 'accounts_receivable')}`, width - 82, 74)
  document.text(`Status: ${titleCase(quotation.status)}`, width - 82, 80)

  autoTable(document, {
    startY: 87,
    margin: { left: margin, right: margin, bottom: 35 },
    head: [['Product', 'Type', 'Qty', 'Unit price', 'Discount', 'Amount']],
    body: (quotation.quotation_items ?? []).map((line) => [
      `${line.product_name}${line.item?.sku ? `\n${line.item.sku}` : ''}`,
      line.product_type || line.item?.product_type || 'Manual item',
      quantity(line.quantity, 3),
      money(line.unit_price),
      money(line.discount),
      money(line.line_total),
    ]),
    theme: 'grid',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8, cellPadding: 2.5, lineColor: [220, 226, 235], textColor: [23, 32, 51] },
    headStyles: { fillColor: [36, 87, 214], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' } },
  })

  let cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? 95) + 7
  if (cursorY > height - 78) { document.addPage(); cursorY = 22 }
  const totalsX = width - 82
  document.setFontSize(9)
  document.setFont('helvetica', 'normal')
  document.text('Subtotal', totalsX, cursorY)
  document.text(money(quotation.subtotal), width - margin, cursorY, { align: 'right' })
  cursorY += 7
  document.text('Discount', totalsX, cursorY)
  document.text(money(quotation.discount_total), width - margin, cursorY, { align: 'right' })
  cursorY += 8
  document.setDrawColor(23, 32, 51)
  document.line(totalsX, cursorY - 4, width - margin, cursorY - 4)
  document.setFont('helvetica', 'bold')
  document.setFontSize(13)
  document.text('TOTAL', totalsX, cursorY + 2)
  document.text(money(quotation.total_amount), width - margin, cursorY + 2, { align: 'right' })

  let detailY = cursorY + 16
  const detailBlocks = [
    quotation.terms ? ['TERMS & CONDITIONS', quotation.terms] : null,
    quotation.notes ? ['NOTES', quotation.notes] : null,
  ].filter(Boolean) as [string, string][]
  for (const [heading, value] of detailBlocks) {
    if (detailY > height - 52) { document.addPage(); detailY = 22 }
    document.setFont('helvetica', 'bold')
    document.setFontSize(8.5)
    document.text(heading, margin, detailY)
    document.setFont('helvetica', 'normal')
    document.setFontSize(8)
    const lines = document.splitTextToSize(value, width - margin * 2) as string[]
    document.text(lines, margin, detailY + 6)
    detailY += Math.max(14, lines.length * 4 + 9)
  }

  if (detailY < height - 42) {
    document.setDrawColor(145, 154, 171)
    document.line(margin, height - 42, 83, height - 42)
    document.line(width - 83, height - 42, width - margin, height - 42)
    document.setFontSize(7.5)
    document.setTextColor(93, 104, 123)
    document.text('Customer acceptance / date', margin, height - 37)
    document.text('Authorized signature', width - 83, height - 37)
  }
  drawInvoiceFooters(document, quotation.quotation_no)
  return document.output('blob')
}

export async function downloadQuotationPdf(input: QuotationPdfInput) {
  downloadInvoiceBlob(await createQuotationPdfBlob(input), quotationPdfFilename(input))
}

export async function printQuotationPdf(input: QuotationPdfInput) {
  return openInvoicePdf(() => createQuotationPdfBlob(input))
}

export async function shareQuotationPdf(input: QuotationPdfInput) {
  const blob = await createQuotationPdfBlob(input)
  const filename = quotationPdfFilename(input)
  const file = new File([blob], filename, { type: 'application/pdf' })
  const shareData: ShareData = { title: `Quotation ${input.quotation.quotation_no}`, text: quotationWhatsAppMessage(input.quotation), files: [file] }
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    await navigator.share(shareData)
    return 'shared' as const
  }
  downloadInvoiceBlob(blob, filename)
  return 'downloaded' as const
}
