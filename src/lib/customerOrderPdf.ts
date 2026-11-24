import type { CompanyProfile, CustomerOrder } from '../types/api'
import { money, quantity, shortDate, titleCase } from './format'
import {
  downloadInvoiceBlob,
  drawInvoiceFooters,
  drawInvoiceHeader,
  invoiceCompany,
  openInvoicePdf,
} from './invoiceBrand'

export interface CustomerOrderPdfInput {
  order: CustomerOrder
  company?: CompanyProfile
}

function safeFilenamePart(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
}

export function customerOrderPdfFilename({ order }: CustomerOrderPdfInput) {
  return `${safeFilenamePart(`Shipping_Order_${order.order_no}_${order.customer_name}`)}.pdf`
}

export async function createCustomerOrderPdfBlob(input: CustomerOrderPdfInput): Promise<Blob> {
  const company = invoiceCompany(input.company)
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const { order } = input
  const document = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const width = document.internal.pageSize.getWidth()
  const height = document.internal.pageSize.getHeight()
  const margin = 14
  type AutoTableDocument = typeof document & { lastAutoTable?: { finalY: number } }

  document.setProperties({
    title: `Shipping order ${order.order_no}`,
    subject: `Customer order and shipping details for ${order.customer_name}`,
    author: company.name,
    creator: 'CK SYS',
  })
  drawInvoiceHeader(document, { company, title: 'SHIPPING ORDER', number: order.order_no })

  document.setTextColor(23, 32, 51)
  document.setFont('helvetica', 'bold')
  document.setFontSize(8)
  document.text('SHIP TO', margin, 55)
  document.text('ORDER DETAILS', width - 82, 55)
  document.setFontSize(11)
  document.text(order.customer_name, margin, 62)
  document.setFont('helvetica', 'normal')
  document.setFontSize(8)
  const customerLines = [order.customer_address, order.customer_phone, order.customer_email].filter(Boolean) as string[]
  document.text(customerLines.length ? customerLines : ['No delivery details provided'], margin, 68, { maxWidth: 104 })
  document.text(`Received: ${shortDate(order.created_at)}`, width - 82, 62)
  document.text(`Status: ${titleCase(order.status)}`, width - 82, 68)
  document.text(`Source: ${titleCase(order.source)}`, width - 82, 74)
  document.text(`Lines: ${(order.customer_order_items ?? []).length}`, width - 82, 80)

  autoTable(document, {
    startY: 88,
    margin: { left: margin, right: margin, bottom: 54 },
    head: [['Product', 'Category', 'Quantity', 'Unit price', 'Amount']],
    body: (order.customer_order_items ?? []).map((line) => [
      `${line.product_name}${line.product_description ? `\n${line.product_description}` : ''}`,
      line.product_category,
      quantity(line.quantity, 3),
      money(line.unit_price),
      money(line.line_total),
    ]),
    theme: 'grid',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8, cellPadding: 2.7, lineColor: [220, 226, 235], textColor: [23, 32, 51] },
    headStyles: { fillColor: [36, 87, 214], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right', fontStyle: 'bold' },
    },
  })

  let cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? 96) + 8
  if (cursorY > height - 82) { document.addPage(); cursorY = 24 }
  const totalsX = width - 82
  document.setFont('helvetica', 'bold')
  document.setFontSize(13)
  document.text('ORDER TOTAL', totalsX, cursorY)
  document.text(money(order.total_amount), width - margin, cursorY, { align: 'right' })

  if (order.notes) {
    cursorY += 14
    if (cursorY > height - 64) { document.addPage(); cursorY = 24 }
    document.setFont('helvetica', 'bold')
    document.setFontSize(8.5)
    document.text('CUSTOMER / DELIVERY NOTES', margin, cursorY)
    document.setFont('helvetica', 'normal')
    document.setFontSize(8)
    const noteLines = document.splitTextToSize(order.notes, width - margin * 2) as string[]
    document.text(noteLines, margin, cursorY + 6)
  }

  const signatureY = height - 39
  document.setDrawColor(145, 154, 171)
  document.line(margin, signatureY, 70, signatureY)
  document.line(78, signatureY, 134, signatureY)
  document.line(142, signatureY, width - margin, signatureY)
  document.setFontSize(7.5)
  document.setTextColor(93, 104, 123)
  document.text('Packed by / date', margin, signatureY + 5)
  document.text('Dispatched by / date', 78, signatureY + 5)
  document.text('Customer receipt / date', 142, signatureY + 5)
  drawInvoiceFooters(document, order.order_no)
  return document.output('blob')
}

export async function downloadCustomerOrderPdf(input: CustomerOrderPdfInput) {
  downloadInvoiceBlob(await createCustomerOrderPdfBlob(input), customerOrderPdfFilename(input))
}

export async function printCustomerOrderPdf(input: CustomerOrderPdfInput) {
  return openInvoicePdf(() => createCustomerOrderPdfBlob(input))
}
