import type { Employee, Payroll, PayrollLine } from '../types/api'
import { money, monthLabel, numberValue, shortDate, titleCase } from './format'
import { addBrandLogo } from './brand'

export interface PayrollPaysheetPdfInput {
  payrolls: Payroll[]
  employee?: Partial<Employee> | null
  companyName: string
  salaryMonth: string
}

function safeFilenamePart(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
}

function lineType(line: PayrollLine) {
  return String(line.earning_type ?? line.type ?? line.line_kind ?? 'payroll item')
    .trim()
    .replace(/[\s_-]+/g, ' ')
}

export function payrollPaysheetPdfFilename(input: PayrollPaysheetPdfInput) {
  const first = input.payrolls[0]
  const employee = input.employee ?? first?.employee ?? null
  const employeeNo = employee?.employee_no || first?.employee_no || 'Employee'
  return `${safeFilenamePart(`Paysheet_${employeeNo}_${input.salaryMonth}`)}.pdf`
}

export async function createPayrollPaysheetPdfBlob(input: PayrollPaysheetPdfInput): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const payrolls = input.payrolls.filter((payroll) => payroll.status !== 'reversed')
  const first = payrolls[0]
  const employee = input.employee ?? first?.employee ?? null
  const employeeName = employee?.name || first?.employee_name || 'Employee'
  const employeeNo = employee?.employee_no || first?.employee_no || '—'
  const details = payrolls.flatMap((payroll) => payroll.payroll_details ?? [])
  const earnings = details.filter((line) => ['earning', 'daily_wage', 'conversion_piecework', 'manual_piecework'].includes(String(line.line_kind ?? 'earning')))
  const deductions = details.filter((line) => line.line_kind === 'deduction')
  const contributions = details.filter((line) => line.line_kind === 'employer_contribution')
  const gross = payrolls.reduce((sum, payroll) => sum + numberValue(payroll.gross_pay), 0)
  const deductionTotal = payrolls.reduce((sum, payroll) => sum + numberValue(payroll.deductions_total), 0)
  const net = payrolls.reduce((sum, payroll) => sum + numberValue(payroll.net_pay), 0)
  const paid = payrolls.reduce((sum, payroll) => sum + numberValue(payroll.paid_amount), 0)
  const due = payrolls.reduce((sum, payroll) => sum + numberValue(payroll.balance_due), 0)
  const document = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const pageWidth = document.internal.pageSize.getWidth()
  const pageHeight = document.internal.pageSize.getHeight()
  const margin = 14
  type AutoTableDocument = typeof document & { lastAutoTable?: { finalY: number } }

  document.setProperties({
    title: `${employeeName} paysheet - ${input.salaryMonth}`,
    subject: 'Employee payroll paysheet',
    author: input.companyName,
    creator: 'CK SYS',
  })
  document.setFillColor(23, 32, 51)
  document.rect(0, 0, pageWidth, 34, 'F')
  addBrandLogo(document, { x: margin, y: 7, maxWidth: 32, maxHeight: 20 })
  document.setTextColor(255, 255, 255)
  document.setFont('helvetica', 'bold')
  document.setFontSize(18)
  document.text('MONTHLY PAYSHEET', margin + 38, 16)
  document.setFontSize(10)
  document.text(input.companyName, margin + 38, 24)
  document.setTextColor(23, 32, 51)
  document.setFontSize(12)
  document.text(employeeName, margin, 45)
  document.setFont('helvetica', 'normal')
  document.setFontSize(8.5)
  document.text(`Employee no: ${employeeNo}`, margin, 51)
  document.text(`Salary month: ${monthLabel(input.salaryMonth)}`, pageWidth - margin, 45, { align: 'right' })
  document.text(`Payroll reference: ${payrolls.map((payroll) => payroll.reference_no).join(', ') || '—'}`, pageWidth - margin, 51, { align: 'right' })

  autoTable(document, {
    startY: 58,
    margin: { left: margin, right: margin },
    head: [['Gross earnings', 'Deductions', 'Net pay', 'Paid', 'Balance due']],
    body: [[money(gross), money(deductionTotal), money(net), money(paid), money(due)]],
    theme: 'grid',
    styles: { fontSize: 7.5, cellPadding: 2.4, halign: 'right', lineColor: [218, 223, 231] },
    headStyles: { fillColor: [36, 87, 214], textColor: [255, 255, 255], fontStyle: 'bold' },
  })
  let cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? 75) + 8

  const addLines = (title: string, lines: PayrollLine[]) => {
    if (!lines.length) return
    autoTable(document, {
      startY: cursorY,
      margin: { top: 18, bottom: 20, left: margin, right: margin },
      head: [[title, 'Quantity', 'Rate', 'Amount']],
      body: lines.map((line) => [
        `${titleCase(lineType(line))}${line.description ? ` · ${line.description}` : ''}`,
        line.quantity === null || line.quantity === undefined ? '—' : String(line.quantity),
        line.rate === null || line.rate === undefined ? '—' : money(line.rate),
        money(line.amount),
      ]),
      theme: 'grid',
      rowPageBreak: 'avoid',
      styles: { fontSize: 7.5, cellPadding: 2, lineColor: [218, 223, 231] },
      headStyles: { fillColor: [242, 244, 247], textColor: [29, 41, 57], fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    })
    cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? cursorY) + 7
  }

  addLines('Earnings and allowances', earnings)
  addLines('Deductions', deductions)
  addLines('Employer contributions', contributions)

  const payments = payrolls.flatMap((payroll) => payroll.payroll_payments ?? []).filter((payment) => payment.status !== 'reversed')
  if (payments.length) {
    autoTable(document, {
      startY: cursorY,
      margin: { top: 18, bottom: 20, left: margin, right: margin },
      head: [['Payment date', 'Reference', 'Method', 'Amount']],
      body: payments.map((payment) => [shortDate(payment.payment_date), payment.reference_no, titleCase(payment.method), money(payment.amount)]),
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 2, lineColor: [218, 223, 231] },
      headStyles: { fillColor: [242, 244, 247], textColor: [29, 41, 57], fontStyle: 'bold' },
      columnStyles: { 3: { halign: 'right' } },
    })
  }

  const pages = document.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    document.setPage(page)
    document.setDrawColor(218, 223, 231)
    document.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15)
    document.setFont('helvetica', 'normal')
    document.setFontSize(6.5)
    document.setTextColor(102, 112, 133)
    document.text('Confidential employee payroll · Generated by CK SYS', margin, pageHeight - 10)
    document.text(`Page ${page} of ${pages}`, pageWidth - margin, pageHeight - 10, { align: 'right' })
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

export async function sharePayrollPaysheetPdf(input: PayrollPaysheetPdfInput, text: string) {
  const blob = await createPayrollPaysheetPdfBlob(input)
  const filename = payrollPaysheetPdfFilename(input)
  const file = new File([blob], filename, { type: 'application/pdf' })
  const shareData: ShareData = { title: filename, text, files: [file] }
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    await navigator.share(shareData)
    return 'shared' as const
  }
  downloadBlob(blob, filename)
  return 'downloaded' as const
}
