import type { CompanyProfile, RawMaterialPurchase, RawMaterialPurchaseItem } from '../types/api'
import { money, numberValue, quantity, shortDate, titleCase } from './format'
import {
  downloadInvoiceBlob,
  drawInvoiceFooters,
  drawInvoiceHeader,
  invoiceCompany,
  openInvoicePdf,
} from './invoiceBrand'
import { BRAND_LOGO_URL } from './brand'

export interface RawMaterialPurchaseInvoiceInput {
  purchase: RawMaterialPurchase
  company: CompanyProfile
}

function lineName(line: RawMaterialPurchaseItem) {
  return line.inventory_items?.name || line.material_name || line.item_name || 'Raw material'
}

function ratePerKg(line: RawMaterialPurchaseItem) {
  const savedRate = numberValue(line.rate_per_kg)
  return savedRate > 0 ? savedRate : numberValue(line.total_cost) / Math.max(numberValue(line.quantity_kg), 1)
}

function purchaseLines(purchase: RawMaterialPurchase) {
  return [...purchase.purchase_items].sort(
    (left, right) => (left.line_no ?? Number.MAX_SAFE_INTEGER) - (right.line_no ?? Number.MAX_SAFE_INTEGER),
  )
}

function safeFilenamePart(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
}

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function rawMaterialPurchaseInvoiceFilename({ purchase }: RawMaterialPurchaseInvoiceInput) {
  return `${safeFilenamePart(`Raw_Material_Purchase_${purchase.invoice_no}`)}.pdf`
}

export function rawMaterialPurchaseWhatsAppMessage(purchase: RawMaterialPurchase) {
  const supplier = purchase.supplier_name || 'Supplier'
  return [
    `Hello ${supplier},`,
    '',
    `Please find raw-material purchase invoice ${purchase.invoice_no} for ${shortDate(purchase.purchase_date)}.`,
    `Grand total: ${money(purchase.grand_total)}`,
    purchase.lorry_no ? `Bill / lorry no: ${purchase.lorry_no}` : null,
    '',
    'Thank you.',
  ].filter((line): line is string => line !== null).join('\n')
}

export async function createRawMaterialPurchaseInvoicePdf(input: RawMaterialPurchaseInvoiceInput): Promise<Blob> {
  const company = invoiceCompany(input.company)
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const { purchase } = input
  const document = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const width = document.internal.pageSize.getWidth()
  const height = document.internal.pageSize.getHeight()
  const margin = 14
  type AutoTableDocument = typeof document & { lastAutoTable?: { finalY: number } }

  document.setProperties({
    title: `Raw Material Purchase Invoice ${purchase.invoice_no}`,
    subject: `Payment details for ${purchase.supplier_name || 'supplier'}`,
    author: company.name,
    creator: 'CK SYS',
  })
  drawInvoiceHeader(document, { company, title: 'BULK RM INVOICE', number: purchase.invoice_no })

  document.setTextColor(23, 32, 51)
  document.setFontSize(8)
  document.setFont('helvetica', 'bold')
  document.text('SUPPLIER', margin, 54)
  document.text('PURCHASE DETAILS', width - 82, 54)
  document.setFont('helvetica', 'normal')
  document.setFontSize(10)
  document.text(purchase.supplier_name || 'Not provided', margin, 61)
  document.setFontSize(8)
  document.text(purchase.supplier_phone || 'No supplier phone', margin, 67)
  document.text(`Date: ${shortDate(purchase.purchase_date)}`, width - 82, 61)
  document.text(`Bill / lorry: ${purchase.lorry_no || 'Not provided'}`, width - 82, 67)
  document.text(`Reference: ${purchase.reference_no}`, width - 82, 73)

  autoTable(document, {
    startY: 82,
    margin: { left: margin, right: margin, bottom: 48 },
    head: [['No.', 'Bulk RM type', 'Qty (kg)', 'Rate / kg', 'Total']],
    body: purchaseLines(purchase).map((line, index) => [
      String(index + 1),
      lineName(line),
      quantity(line.quantity_kg, 3),
      money(ratePerKg(line)),
      money(line.total_cost),
    ]),
    theme: 'grid',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8.5, cellPadding: 3, lineColor: [220, 226, 235], textColor: [23, 32, 51] },
    headStyles: { fillColor: [36, 87, 214], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 13, halign: 'center' },
      2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' },
    },
  })

  let cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? 100) + 8
  if (cursorY > height - 72) { document.addPage(); cursorY = 22 }
  document.setFont('helvetica', 'bold')
  document.setFontSize(13)
  document.text('GRAND TOTAL', width - 85, cursorY)
  document.text(money(purchase.grand_total), width - margin, cursorY, { align: 'right' })
  cursorY += 12
  document.setFontSize(8)
  document.text('PAYMENT METHOD', margin, cursorY)
  document.setFont('helvetica', 'normal')
  document.text(titleCase(purchase.payment_method), margin, cursorY + 6)
  const notes = [
    purchase.notes,
    ...purchaseLines(purchase).map((line) => line.notes ? `${lineName(line)}: ${line.notes}` : null),
  ].filter(Boolean) as string[]
  document.setFont('helvetica', 'bold')
  document.text('NOTES', margin, cursorY + 15)
  document.setFont('helvetica', 'normal')
  const noteLines = document.splitTextToSize(notes.join('\n') || 'No notes', width - margin * 2) as string[]
  document.text(noteLines, margin, cursorY + 21)

  const signatureY = Math.min(height - 34, Math.max(cursorY + 39, height - 45))
  document.setDrawColor(145, 154, 171)
  document.line(width - 78, signatureY, width - margin, signatureY)
  document.setFontSize(7.5)
  document.setTextColor(93, 104, 123)
  document.text('Authorized signature / stamp', width - 78, signatureY + 5)

  drawInvoiceFooters(document, purchase.invoice_no)
  return document.output('blob')
}

export async function downloadRawMaterialPurchaseInvoicePdf(input: RawMaterialPurchaseInvoiceInput) {
  downloadInvoiceBlob(await createRawMaterialPurchaseInvoicePdf(input), rawMaterialPurchaseInvoiceFilename(input))
}

export async function shareRawMaterialPurchaseInvoice(input: RawMaterialPurchaseInvoiceInput) {
  const blob = await createRawMaterialPurchaseInvoicePdf(input)
  const filename = rawMaterialPurchaseInvoiceFilename(input)
  const file = new File([blob], filename, { type: 'application/pdf' })
  const shareData: ShareData = {
    title: input.purchase.invoice_no,
    text: rawMaterialPurchaseWhatsAppMessage(input.purchase),
    files: [file],
  }
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    await navigator.share(shareData)
    return 'shared' as const
  }
  downloadInvoiceBlob(blob, filename)
  return 'downloaded' as const
}

export async function printRawMaterialPurchaseInvoice(input: RawMaterialPurchaseInvoiceInput) {
  try {
    return await openInvoicePdf(() => createRawMaterialPurchaseInvoicePdf(input))
  } catch {
    return printRawMaterialPurchaseInvoiceHtml(input)
  }
}

function printRawMaterialPurchaseInvoiceHtml(input: RawMaterialPurchaseInvoiceInput) {
  const { purchase, company } = input
  const lines = purchaseLines(purchase)
  const rows = lines.map((line, index) => `<tr>
    <td>${index + 1}</td><td>${escapeHtml(lineName(line))}</td>
    <td class="number">${escapeHtml(quantity(line.quantity_kg, 3))}</td>
    <td class="number">${escapeHtml(money(ratePerKg(line)))}</td>
    <td class="number"><strong>${escapeHtml(money(line.total_cost))}</strong></td>
  </tr>`).join('')
  const notes = [purchase.notes, ...lines.map((line) => line.notes ? `${lineName(line)}: ${line.notes}` : null)].filter(Boolean).join(' · ')
  const popup = window.open('', '_blank', 'width=980,height=760')
  if (!popup) return false
  popup.opener = null
  popup.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(purchase.invoice_no)}</title><style>
    *{box-sizing:border-box}body{margin:0;background:#eef2f7;color:#172033;font:14px Arial,sans-serif}.sheet{width:210mm;min-height:297mm;margin:0 auto;padding:15mm;background:#fff}.head{display:flex;justify-content:space-between;gap:24px;padding-bottom:18px;border-bottom:3px solid #2457d6}.brand{display:flex;gap:14px}.logo{width:84px;height:auto;align-self:flex-start;object-fit:contain}.head h1{margin:0;color:#112a5c;font-size:23px}.head h2{margin:0 0 8px;color:#2457d6;font-size:18px}.muted{color:#657089}.meta{text-align:right}.supplier{display:flex;justify-content:space-between;gap:24px;margin:24px 0}.supplier p{margin:4px 0}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #dbe2ed;text-align:left}th{background:#2457d6;color:#fff}.number{text-align:right}.grand{display:flex;justify-content:flex-end;gap:32px;margin:18px 0;font-size:20px}.footer{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:30px}.signature{margin-top:50px;padding-top:8px;border-top:1px solid #657089;text-align:center}@media print{body{background:#fff}.sheet{margin:0;padding:12mm;box-shadow:none}@page{size:A4;margin:0}}
  </style></head><body><main class="sheet"><header class="head"><div class="brand"><img class="logo" src="${BRAND_LOGO_URL}" alt="CK Plastic"><div><h1>${escapeHtml(company.name)}</h1><p class="muted">${escapeHtml(company.address || '')}<br>${escapeHtml(company.phone || '')}<br>${escapeHtml(company.email || '')}</p></div></div><div class="meta"><h2>RAW MATERIAL<br>PURCHASE INVOICE</h2><strong>${escapeHtml(purchase.invoice_no)}</strong><p>${escapeHtml(shortDate(purchase.purchase_date))}</p></div></header><section class="supplier"><div><strong>Supplier</strong><p>${escapeHtml(purchase.supplier_name || 'Not provided')}</p><p>${escapeHtml(purchase.supplier_phone || 'No supplier phone')}</p></div><div class="meta"><strong>Bill / Lorry No.</strong><p>${escapeHtml(purchase.lorry_no || 'Not provided')}</p><p class="muted">${escapeHtml(purchase.reference_no)}</p></div></section><table><thead><tr><th>No.</th><th>Bulk RM Type</th><th class="number">Qty (kg)</th><th class="number">Rate/kg</th><th class="number">Total</th></tr></thead><tbody>${rows}</tbody></table><section class="grand"><span>Grand Total</span><strong>${escapeHtml(money(purchase.grand_total))}</strong></section><section class="footer"><div><strong>Payment Method</strong><p>${escapeHtml(titleCase(purchase.payment_method))}</p><strong>Notes</strong><p>${escapeHtml(notes || 'No notes')}</p><p><strong>Thank you for your business.</strong></p></div><div class="signature">Authorized signature / stamp</div></section></main></body></html>`)
  popup.document.close()
  window.setTimeout(() => popup.print(), 250)
  return true
}
