import type { CompanyProfile, Sale } from '../types/api'
import { money, numberValue, quantity, shortDate, titleCase } from './format'
import { saleLineName } from './salesInvoice'
import {
  downloadInvoiceBlob,
  drawInvoiceFooters,
  drawInvoiceHeader,
  invoiceCompany,
  invoiceLogoDataUrl,
  openInvoicePdf,
} from './invoiceBrand'

export interface SalesInvoicePdfInput {
  sale: Sale
  company: CompanyProfile
}

function safeFilenamePart(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
}

export function salesInvoicePdfFilename({ sale }: SalesInvoicePdfInput) {
  return `${safeFilenamePart(`Invoice_${sale.invoice_no}_${sale.customer_name}`)}.pdf`
}

export async function createSalesInvoicePdfBlob(input: SalesInvoicePdfInput): Promise<Blob> {
  const company = invoiceCompany(input.company)
  const [{ jsPDF }, { autoTable }, logo] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    invoiceLogoDataUrl(company.logo_url),
  ])
  const { sale } = input
  const document = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const width = document.internal.pageSize.getWidth()
  const height = document.internal.pageSize.getHeight()
  const margin = 14
  type AutoTableDocument = typeof document & { lastAutoTable?: { finalY: number } }

  document.setProperties({
    title: `Invoice ${sale.invoice_no}`,
    subject: `Sales invoice for ${sale.customer_name}`,
    author: company.name,
    creator: 'CK SYS',
  })
  drawInvoiceHeader(document, { company, logo, title: 'SALES INVOICE', number: sale.invoice_no })

  document.setTextColor(23, 32, 51)
  document.setFont('helvetica', 'bold')
  document.setFontSize(8)
  document.text('BILL TO', margin, 55)
  document.text('INVOICE DETAILS', width - 82, 55)
  document.setFontSize(11)
  document.text(sale.customer_name, margin, 62)
  document.setFont('helvetica', 'normal')
  document.setFontSize(8)
  document.text(sale.customer_phone || 'No customer phone', margin, 68)
  document.text(`Date: ${shortDate(sale.sale_date)}`, width - 82, 62)
  document.text(`Payment: ${titleCase(sale.payment_method || 'accounts_receivable')}`, width - 82, 68)
  document.text(`Status: ${titleCase(sale.status === 'reversed' ? 'reversed' : sale.document_status || 'issued')}`, width - 82, 74)

  autoTable(document, {
    startY: 83,
    margin: { left: margin, right: margin, bottom: 35 },
    head: [['Product', 'Qty', 'Unit price', 'Discount', 'Amount']],
    body: (sale.sale_items ?? []).map((line) => [
      `${saleLineName(line)}${line.item?.sku ? `\n${line.item.sku}` : ''}`,
      quantity(line.quantity, 3),
      money(line.unit_price),
      money(line.discount),
      money(line.line_total ?? numberValue(line.quantity) * numberValue(line.unit_price) - numberValue(line.discount)),
    ]),
    theme: 'grid',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8.5, cellPadding: 3, lineColor: [220, 226, 235], textColor: [23, 32, 51] },
    headStyles: { fillColor: [36, 87, 214], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' },
    },
  })

  let cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? 100) + 8
  if (cursorY > height - 68) { document.addPage(); cursorY = 24 }
  const totalsX = width - 88
  document.setFont('helvetica', 'normal')
  document.setFontSize(9)
  document.text('Paid', totalsX, cursorY)
  document.text(money(sale.paid_amount), width - margin, cursorY, { align: 'right' })
  cursorY += 7
  document.text('Balance due', totalsX, cursorY)
  document.text(money(sale.balance_due), width - margin, cursorY, { align: 'right' })
  cursorY += 9
  document.setDrawColor(23, 32, 51)
  document.line(totalsX, cursorY - 5, width - margin, cursorY - 5)
  document.setFont('helvetica', 'bold')
  document.setFontSize(13)
  document.text('TOTAL', totalsX, cursorY + 1)
  document.text(money(sale.total_amount), width - margin, cursorY + 1, { align: 'right' })
  drawInvoiceFooters(document, sale.invoice_no)
  return document.output('blob')
}

export async function downloadSalesInvoicePdf(input: SalesInvoicePdfInput) {
  downloadInvoiceBlob(await createSalesInvoicePdfBlob(input), salesInvoicePdfFilename(input))
}

export async function printSalesInvoicePdf(input: SalesInvoicePdfInput) {
  return openInvoicePdf(() => createSalesInvoicePdfBlob(input))
}

export async function shareSalesInvoicePdf(input: SalesInvoicePdfInput, message: string) {
  const blob = await createSalesInvoicePdfBlob(input)
  const filename = salesInvoicePdfFilename(input)
  const file = new File([blob], filename, { type: 'application/pdf' })
  const shareData: ShareData = { title: `Invoice ${input.sale.invoice_no}`, text: message, files: [file] }
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    await navigator.share(shareData)
    return 'shared' as const
  }
  downloadInvoiceBlob(blob, filename)
  return 'downloaded' as const
}
