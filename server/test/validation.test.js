// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parse, schemas } from '../validation.js'

const ids = {
  employee: '00000000-0000-4000-8000-000000000001',
  item: '00000000-0000-4000-8000-000000000002',
  product: '00000000-0000-4000-8000-000000000003',
}

describe('Node request validation', () => {
  it('enforces employee compensation and lifecycle rules', () => {
    expectValidation(() => parse(schemas.employee, {
      name: 'Nimali Perera', joined_date: '2025-01-15', pay_model: 'daily', daily_rate: 0,
    }), /daily_rate is required/)
    expectValidation(() => parse(schemas.employee, {
      name: 'Nimali Perera', joined_date: '2025-01-15', pay_model: 'monthly', monthly_rate: 85000,
      status: 'inactive',
    }), /left_date is required/)
  })

  it('accepts a saved conversion rate and rejects unsafe output yield', () => {
    const value = parse(schemas.conversion, {
      conversion_date: '2026-09-21', source_item_id: ids.item, chip_name: 'PP chips',
      input_kg: 100, output_kg: 95,
      workers: [{ employee_id: ids.employee, rate_id: ids.product, quantity_kg: 95 }],
    })
    expect(value.workers[0].rate_id).toBe(ids.product)
    expectValidation(() => parse(schemas.conversion, { ...value, output_kg: 103 }), /more than 2%/)
  })

  it('accepts a multi-material lorry purchase and rejects duplicate material rates', () => {
    const anotherRate = '00000000-0000-4000-8000-000000000004'
    const purchase = {
      purchase_date: '2026-11-19', payment_method: 'credit', supplier_name: 'Polymer Supplier',
      lorry_no: 'WP AB-1234',
      items: [
        { bulk_rm_rate_id: ids.item, quantity_kg: 500, rate_per_kg: 320 },
        { bulk_rm_rate_id: anotherRate, quantity_kg: 250, rate_per_kg: 280 },
      ],
    }
    expect(parse(schemas.rmPurchase, purchase).items).toHaveLength(2)
    expectValidation(() => parse(schemas.rmPurchase, {
      ...purchase, items: [purchase.items[0], purchase.items[0]],
    }), /only once/)
  })

  it('validates effective Bulk RM rates and HTTPS company invoice branding', () => {
    expect(parse(schemas.bulkRmRate, {
      material_type: 'ABS', rate_per_kg: 310.5, effective_from: '2026-11-01', status: 'active',
    }).material_type).toBe('ABS')
    expectValidation(() => parse(schemas.bulkRmRate, {
      material_type: 'ABS', rate_per_kg: 310.5, effective_from: '2026-11-20', effective_to: '2026-11-01', status: 'active',
    }), /cannot be earlier/)
    expectValidation(() => parse(schemas.companyProfile, { logo_url: 'http://example.com/logo.png' }), /Invalid URL|must start with/)
  })

  it('rejects duplicate public order products and honeypot submissions', () => {
    const item = { item_id: ids.product, quantity: 1 }
    expectValidation(() => parse(schemas.publicOrder, {
      customer_name: 'Customer', customer_phone: '+94 77 123 4567', items: [item, item],
    }), /unique/)
    expectValidation(() => parse(schemas.publicOrder, {
      customer_name: 'Customer', customer_phone: '+94 77 123 4567', items: [item], website: 'spam',
    }), /could not be submitted/)
  })

  it('requires balanced journals and settlement-safe payroll methods', () => {
    expectValidation(() => parse(schemas.journal, {
      journal_date: '2026-09-30', memo: 'Unbalanced',
      lines: [
        { account_code: 'CASH', debit: 100, credit: 0 },
        { account_code: 'SALES', debit: 0, credit: 99 },
      ],
    }), /not balanced/)
    expectValidation(() => parse(schemas.payroll, {
      payroll_date: '2026-09-30', salary_month: '2026-09', employee_id: ids.employee,
      status: 'paid', payment_method: 'salary_payable', earnings: [{ type: 'salary', amount: 1000 }],
    }), /paid payroll requires/)
  })
})

function expectValidation(callback, message) {
  try {
    callback()
    throw new Error('Expected validation to fail')
  } catch (error) {
    expect(error.errors?.map((issue) => issue.msg).join(' ')).toMatch(message)
  }
}
