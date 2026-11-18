import type { Quotation } from '../types/api'
import { money, quantity, shortDate, titleCase } from './format'

export interface QuotationPdfInput {
  quotation: Quotation
  companyName: string
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
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const { quotation, companyName } = input
  const document = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const width = document.internal.pageSize.getWidth()
  const height = document.internal.pageSize.getHeight()
  const margin = 14
  type AutoTableDocument = typeof document & { lastAutoTable?: { finalY: number } }

  document.setProperties({ title: `Quotation ${quotation.quotation_no}`, subject: `Quotation for ${quotation.customer_name}`, author: companyName, creator: 'CK SYS' })
  document.setFillColor(17, 42, 92)
  document.rect(0, 0, width, 38, 'F')
  document.setTextColor(255, 255, 255)
  document.setFont('helvetica', 'bold')
  document.setFontSize(20)
  document.text(companyName, margin, 16)
  document.setFontSize(9)
  document.setFont('helvetica', 'normal')
  document.text('Prepared with CK SYS', margin, 24)
  document.setFont('helvetica', 'bold')
  document.setFontSize(22)
  document.text('QUOTATION', width - margin, 17, { align: 'right' })
  document.setFontSize(10)
  document.text(quotation.quotation_no, width - margin, 25, { align: 'right' })

  document.setTextColor(23, 32, 51)
  document.setFontSize(10)
  document.text('PREPARED FOR', margin, 49)
  document.setFontSize(13)
  document.text(quotation.customer_name, margin, 57)
  document.setFont('helvetica', 'normal')
  document.setFontSize(8.5)
  const customerLines = [quotation.customer_phone, quotation.customer_email, quotation.customer_address].filter(Boolean) as string[]
  document.text(customerLines.length ? customerLines : ['No additional customer details'], margin, 63, { maxWidth: 100 })
  document.setFont('helvetica', 'bold')
  document.text('Quotation date', width - 72, 49)
  document.text('Valid until', width - 72, 56)
  document.text('Status', width - 72, 63)
  document.setFont('helvetica', 'normal')
  document.text(shortDate(quotation.quotation_date), width - margin, 49, { align: 'right' })
  document.text(shortDate(quotation.valid_until), width - margin, 56, { align: 'right' })
  document.text(titleCase(quotation.status), width - margin, 63, { align: 'right' })

  autoTable(document, {
    startY: 76,
    margin: { left: margin, right: margin, bottom: 24 },
    head: [['Product', 'Type', 'Qty', 'Unit price', 'Discount', 'Amount']],
    body: (quotation.quotation_items ?? []).map((line) => [
      `${line.product_name}${line.item?.sku ? `\n${line.item.sku}` : ''}`,
      line.product_type || line.item?.product_type || '—',
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

  if (detailY < height - 38) {
    document.setDrawColor(145, 154, 171)
    document.line(margin, height - 38, 83, height - 38)
    document.line(width - 83, height - 38, width - margin, height - 38)
    document.setFontSize(7.5)
    document.setTextColor(93, 104, 123)
    document.text('Customer acceptance / date', margin, height - 33)
    document.text('Authorized signature', width - 83, height - 33)
  }

  const pages = document.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    document.setPage(page)
    document.setDrawColor(220, 226, 235)
    document.line(margin, height - 17, width - margin, height - 17)
    document.setFont('helvetica', 'normal')
    document.setFontSize(6.5)
    document.setTextColor(102, 112, 133)
    document.text(`Quotation ${quotation.quotation_no} · Generated by CK SYS`, margin, height - 11)
    document.text(`Page ${page} of ${pages}`, width - margin, height - 11, { align: 'right' })
  }
  return document.output('blob')
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function downloadQuotationPdf(input: QuotationPdfInput) {
  const blob = await createQuotationPdfBlob(input)
  downloadBlob(blob, quotationPdfFilename(input))
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
  downloadBlob(blob, filename)
  return 'downloaded' as const
}
