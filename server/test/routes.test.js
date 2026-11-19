// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { routeManifest } from '../routes.js'

const expected = `
GET /health/live
GET /health/ready
GET /public/catalog
POST /public/orders
GET /me
GET /company-profile
PATCH /company-profile
GET /dashboard
GET /employees
GET /employees/:employee_id
GET /employees/:employee_id/compensation-history
POST /employees
PATCH /employees/:employee_id
DELETE /employees/:employee_id
GET /conversion-types
POST /conversion-types
PATCH /conversion-types/:conversion_type_id
DELETE /conversion-types/:conversion_type_id
GET /piecework-rates
POST /piecework-rates
PATCH /piecework-rates/:rate_id
DELETE /piecework-rates/:rate_id
GET /bulk-rm-rates
POST /bulk-rm-rates
PATCH /bulk-rm-rates/:rate_id
DELETE /bulk-rm-rates/:rate_id
GET /daily-work
POST /daily-work
PATCH /daily-work/:work_id
DELETE /daily-work/:work_id
GET /overtime
POST /overtime
PATCH /overtime/:overtime_id
DELETE /overtime/:overtime_id
GET /open-earnings
GET /inventory/summary
GET /inventory/bulk
GET /inventory/chips
GET /inventory/finished
GET /inventory/position
GET /inventory/items
GET /products
POST /products
PATCH /products/:product_id
DELETE /products/:product_id
GET /rm-purchases
GET /rm-purchases/:purchase_id
POST /rm-purchases
PATCH /rm-purchases/:purchase_id
DELETE /rm-purchases/:purchase_id
GET /conversions
GET /conversions/:conversion_id
POST /conversions
PATCH /conversions/:conversion_id
DELETE /conversions/:conversion_id
GET /production
GET /production/summary
GET /production/:production_id
POST /production
PATCH /production/:production_id
DELETE /production/:production_id
GET /customer-orders
PATCH /customer-orders/:order_id/status
GET /quotations
GET /quotations/:quotation_id
POST /quotations
PATCH /quotations/:quotation_id
DELETE /quotations/:quotation_id
GET /sales-outstanding
GET /sales
GET /sales/:sale_id
POST /sales
PATCH /sales/:sale_id
DELETE /sales/:sale_id
GET /sales/:sale_id/payments
POST /sales/:sale_id/payments
DELETE /sales/:sale_id/payments/:payment_id
GET /payroll-outstanding
GET /payroll
GET /payroll/:payroll_id
POST /payroll
PATCH /payroll/:payroll_id
DELETE /payroll/:payroll_id
GET /payroll/:payroll_id/payments
POST /payroll/:payroll_id/payments
DELETE /payroll/:payroll_id/payments/:payment_id
GET /adjustments
POST /adjustments
PATCH /adjustments/:adjustment_id
DELETE /adjustments/:adjustment_id
GET /journals
GET /journals/:journal_id
POST /journals
PATCH /journals/:journal_id
DELETE /journals/:journal_id
GET /ledger
GET /account-balances
GET /reports/inventory
GET /reports/sales
GET /reports/payroll
GET /reports/ledger
GET /reports/financial-summary
GET /reports/audit-log
GET /admin/users
POST /admin/users
PATCH /admin/users/:target_user_id/status
DELETE /admin/users/:target_user_id
POST /admin/purge-business-data
`.trim().split('\n').sort()

describe('Node API route parity', () => {
  it('contains every original API method and path exactly once', () => {
    const actual = routeManifest().map((route) => `${route.method} ${route.path}`)
    expect(actual).toHaveLength(108)
    expect(new Set(actual).size).toBe(actual.length)
    expect(actual.sort()).toEqual(expected)
  })
})
