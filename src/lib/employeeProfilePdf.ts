import type { Employee } from '../types/api'
import { addBrandLogo } from './brand'
import { money, shortDate, titleCase } from './format'

function safeName(value: string) {
  const withoutControls = Array.from(value, (character) =>
    (character.codePointAt(0) ?? 0) < 32 ? '-' : character,
  ).join('')
  return withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '_')
}

export function employeeProfilePdfFilename(employee: Employee) {
  return `${safeName(`Employee_Profile_${employee.employee_no || employee.name}`)}.pdf`
}

async function imageDataUrl(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('The employee photograph could not be downloaded.')
  const blob = await response.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('The employee photograph could not be converted.'))
    }
    reader.onerror = () => reject(new Error('The employee photograph could not be read.'))
    reader.readAsDataURL(blob)
  })
}

export async function downloadEmployeeProfilePdf(employee: Employee, companyName: string, photoUrl?: string | null) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const document = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const width = document.internal.pageSize.getWidth()
  const margin = 15
  document.setProperties({
    title: `${employee.name} employee profile`,
    subject: 'Employee master profile',
    author: companyName,
    creator: 'CK SYS',
  })
  document.setFillColor(22, 34, 55)
  document.rect(0, 0, width, 38, 'F')
  addBrandLogo(document, { x: margin, y: 7, maxWidth: 35, maxHeight: 22 })
  document.setTextColor(255, 255, 255)
  document.setFont('helvetica', 'bold')
  document.setFontSize(17)
  document.text('EMPLOYEE PROFILE', margin + 42, 17)
  document.setFontSize(9)
  document.text(companyName, margin + 42, 25)

  let photoBottom = 52
  if (photoUrl) {
    try {
      const photo = await imageDataUrl(photoUrl)
      document.addImage(photo, 'JPEG', width - margin - 30, 43, 30, 36, undefined, 'FAST')
      photoBottom = 82
    } catch {
      // The profile is still useful if a private image link expired mid-export.
    }
  }
  document.setTextColor(23, 32, 51)
  document.setFontSize(15)
  document.text(employee.name, margin, 50)
  document.setFont('helvetica', 'normal')
  document.setFontSize(9)
  document.text(
    `${employee.employee_no || 'No employee number'} · ${employee.job_role || 'No designation'}`,
    margin,
    57,
  )

  const details = [
    ['Personal information', 'NIC', employee.nic || '—'],
    ['', 'Date of birth', shortDate(employee.date_of_birth)],
    ['Contact information', 'Phone', employee.phone || '—'],
    ['', 'Email', employee.email || '—'],
    ['', 'Address', employee.address || '—'],
    ['Employment information', 'Department', employee.department || '—'],
    ['', 'Employment type', employee.employment_type || '—'],
    ['', 'Shift', employee.shift || '—'],
    ['', 'Joined date', shortDate(employee.joined_date)],
    ['', 'Status', titleCase(employee.status)],
    ['Payroll information', 'Pay model', titleCase(employee.pay_model)],
    ['', 'Monthly rate', money(employee.monthly_rate)],
    ['', 'Daily rate', money(employee.daily_rate)],
    ['', 'OT rate', money(employee.ot_rate)],
    ['', 'EPF number', employee.epf_no || '—'],
    ['', 'ETF reference', employee.etf_ref || '—'],
    ['', 'Tax number', employee.tax_no || '—'],
  ]
  autoTable(document, {
    startY: Math.max(66, photoBottom),
    margin: { left: margin, right: margin },
    head: [['Section', 'Field', 'Information']],
    body: details,
    theme: 'grid',
    styles: {
      fontSize: 8,
      cellPadding: 2.3,
      lineColor: [220, 226, 234],
      overflow: 'linebreak',
    },
    headStyles: { fillColor: [37, 87, 214], textColor: 255 },
    columnStyles: {
      0: { cellWidth: 40, fontStyle: 'bold' },
      1: { cellWidth: 36 },
    },
  })
  type PdfWithTable = typeof document & { lastAutoTable?: { finalY: number } }
  let y = ((document as PdfWithTable).lastAutoTable?.finalY ?? 160) + 8
  for (const [heading, body] of [
    ['Education qualifications', employee.education_qualifications],
    ['Other qualifications', employee.other_qualifications],
    ['Additional information', employee.profile_notes],
  ] as const) {
    if (y > 260) {
      document.addPage()
      y = 20
    }
    document.setFont('helvetica', 'bold')
    document.setFontSize(10)
    document.text(heading, margin, y)
    document.setFont('helvetica', 'normal')
    document.setFontSize(8.5)
    const splitResult: unknown = document.splitTextToSize(body?.trim() || '—', width - margin * 2)
    const lines = Array.isArray(splitResult)
      ? splitResult.filter((line): line is string => typeof line === 'string')
      : [body?.trim() || '—']
    document.text(lines, margin, y + 5)
    y += 10 + lines.length * 4
  }
  const pages = document.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    document.setPage(page)
    document.setFontSize(7)
    document.setTextColor(100, 116, 139)
    document.text(`Confidential employee record · Page ${page} of ${pages}`, width - margin, 289, { align: 'right' })
  }
  document.save(employeeProfilePdfFilename(employee))
}
