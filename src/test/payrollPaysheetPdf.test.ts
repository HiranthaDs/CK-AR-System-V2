import { describe, expect, it } from 'vitest'

import { createPayrollPaysheetPdfBlob, payrollPaysheetPdfFilename } from '../lib/payrollPaysheetPdf'
import type { Payroll } from '../types/api'

const payroll: Payroll = {
  id: '00000000-0000-0000-0000-000000000001',
  reference_no: 'PAY-001',
  payroll_date: '2026-11-30',
  salary_month: '2026-11',
  employee_id: '00000000-0000-0000-0000-000000000002',
  employee: { name: 'Sandeep Perera', employee_no: 'CKP 001' },
  gross_pay: 85_680,
  deductions_total: 6_800,
  net_pay: 78_880,
  paid_amount: 78_880,
  balance_due: 0,
  status: 'posted',
  payroll_details: [
    {
      id: '00000000-0000-0000-0000-000000000003',
      line_kind: 'earning',
      earning_type: 'daily_target_incentive',
      description: 'Daily Target DT-001',
      quantity: 100,
      rate: 680,
      amount: 680,
    },
  ],
  payroll_payments: [],
}

describe('payroll paysheet PDF', () => {
  it('uses the employee number and salary month in a safe PDF filename', () => {
    expect(payrollPaysheetPdfFilename({
      payrolls: [payroll],
      companyName: 'CK Products',
      salaryMonth: '2026-11',
    })).toBe('Paysheet_CKP_001_2026-11.pdf')
  })

  it('creates a non-empty PDF document', async () => {
    const blob = await createPayrollPaysheetPdfBlob({
      payrolls: [payroll],
      companyName: 'CK Products',
      salaryMonth: '2026-11',
    })

    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(1_000)
  })
})
