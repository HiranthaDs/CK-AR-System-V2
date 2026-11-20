import { z } from 'zod'
import { validationError } from './errors.js'

const trim = (schema) => z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  schema,
)
const optional = (schema) => schema.nullable().optional()
const text = (maximum = 160, minimum = 1) => trim(z.string().min(minimum).max(maximum))
const uuid = trim(z.string().uuid())
const date = trim(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}, 'Invalid date'))
const number = (minimum = 0, maximum = 1e16) => z.coerce.number().finite().min(minimum).max(maximum)
const positiveMoney = number(Number.EPSILON, 1e16)
const money = number(0, 1e16)
const positiveQuantity = number(Number.EPSILON, 1e16)
const reference = text(80).refine((value) => /^[A-Za-z0-9._/-]+$/.test(value), 'Invalid reference number')
const status = z.enum(['active', 'inactive'])
const paymentMethod = z.enum([
  'cash', 'bank_transfer', 'cheque', 'credit', 'accounts_receivable', 'salary_payable', 'other',
])
const settlementMethod = z.enum(['cash', 'bank_transfer', 'cheque', 'other'])

const payrollComponent = z.object({
  type: text(),
  description: text(300, 0).default(''),
  amount: positiveMoney,
  account_code: text(40, 0).default(''),
}).strict()

const payrollDefaults = z.object({
  earnings: z.array(payrollComponent).max(50).default([]),
  deductions: z.array(payrollComponent).max(50).default([]),
  employer_contributions: z.array(payrollComponent).max(50).default([]),
}).strict()

const emergencyContact = z.object({
  name: text(160, 0).default(''),
  relationship: text(100, 0).default(''),
  phone: text(40, 0).default(''),
}).strict().superRefine((value, ctx) => {
  if ((value.name || value.relationship || value.phone) && !(value.name && value.phone)) {
    ctx.addIssue({ code: 'custom', message: 'emergency contact name and phone are required together' })
  }
})

const employee = z.object({
  id: optional(uuid), employee_no: optional(text(40)), name: text(), nic: optional(text(40, 0)),
  phone: optional(text(40, 0)), email: optional(trim(z.string().email().max(254))),
  date_of_birth: optional(date), address: optional(text(500, 0)), epf_no: optional(text(60, 0)),
  etf_ref: optional(text(60, 0)), joined_date: date, left_date: optional(date),
  job_role: optional(text(100, 0)), department: optional(text(100, 0)),
  employment_type: optional(text(60, 0)), shift: optional(text(60, 0)), tax_no: optional(text(80, 0)),
  emergency_contact: optional(emergencyContact), pay_model: z.enum(['monthly', 'daily', 'hybrid', 'piecework']),
  monthly_rate: optional(money), daily_rate: optional(money), ot_rate: optional(money),
  monthly_incentive: money.default(0), pay_effective_from: optional(date),
  standard_hours_per_day: number(0, 24).default(0), standard_days_per_month: number(0, 31).default(0),
  employee_epf_rate: number(0, 100).default(0), employer_epf_rate: number(0, 100).default(0),
  employer_etf_rate: number(0, 100).default(0), payroll_defaults: payrollDefaults.default({}),
  pay_notes: optional(text(2000, 0)), daily_on_conversion: z.boolean().default(false),
  bank_details: optional(z.record(z.string(), z.unknown())), status: status.default('active'),
}).strict().superRefine((value, ctx) => {
  if (value.date_of_birth && value.date_of_birth >= value.joined_date) ctx.addIssue({ code: 'custom', message: 'date_of_birth must be earlier than joined_date' })
  if (value.left_date && value.left_date < value.joined_date) ctx.addIssue({ code: 'custom', message: 'left_date cannot be earlier than joined_date' })
  if (value.pay_effective_from && value.pay_effective_from < value.joined_date) ctx.addIssue({ code: 'custom', message: 'pay_effective_from cannot be earlier than joined_date' })
  if (value.status === 'inactive' && !value.left_date) ctx.addIssue({ code: 'custom', message: 'left_date is required for an inactive employee' })
  if (['monthly', 'hybrid'].includes(value.pay_model) && !value.monthly_rate) ctx.addIssue({ code: 'custom', message: 'monthly_rate is required for monthly or hybrid pay' })
  if (['daily', 'hybrid'].includes(value.pay_model) && !value.daily_rate) ctx.addIssue({ code: 'custom', message: 'daily_rate is required for daily or hybrid pay' })
})

const conversionType = z.object({
  id: optional(uuid), name: text(), default_chip_name: optional(text()), status: status.default('active'),
  notes: optional(text(1000, 0)),
}).strict()

const pieceworkRate = z.object({
  id: optional(uuid), conversion_type_id: optional(uuid), work_type: optional(text()),
  rate_per_kg: positiveMoney, effective_from: date, effective_to: optional(date),
  status: status.default('active'), notes: optional(text(1000, 0)),
}).strict().superRefine((value, ctx) => {
  if (!value.conversion_type_id && !value.work_type) ctx.addIssue({ code: 'custom', message: 'conversion_type_id or work_type is required' })
  if (value.effective_to && value.effective_to < value.effective_from) ctx.addIssue({ code: 'custom', message: 'effective_to cannot be earlier than effective_from' })
})

const bulkRmRate = z.object({
  id: optional(uuid), material_type: text(160), rate_per_kg: positiveMoney,
  effective_from: date, effective_to: optional(date), status: status.default('active'),
  notes: optional(text(2000, 0)),
}).strict().superRefine((value, ctx) => {
  if (value.effective_to && value.effective_to < value.effective_from) ctx.addIssue({ code: 'custom', message: 'effective_to cannot be earlier than effective_from' })
})

const rmPurchaseItem = z.object({
  bulk_rm_rate_id: uuid,
  quantity_kg: positiveQuantity,
  rate_per_kg: positiveMoney,
  total_cost: optional(positiveMoney),
  notes: optional(text(2000, 0)),
}).strict()

const rmPurchase = z.object({
  id: optional(uuid), reference_no: optional(reference), purchase_date: date,
  supplier_name: optional(text()), supplier_phone: optional(text(40, 0)),
  lorry_no: optional(text(80, 0)), payment_method: z.enum(['cash', 'bank_transfer', 'cheque', 'credit']),
  notes: optional(text(2000, 0)), items: z.array(rmPurchaseItem).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const rateIds = value.items.map((item) => item.bulk_rm_rate_id)
  if (new Set(rateIds).size !== rateIds.length) ctx.addIssue({ code: 'custom', message: 'Each Bulk RM type may appear only once per consignment', path: ['items'] })
})

const companyProfile = z.object({
  address: optional(text(500, 0)), phone: optional(text(40, 0)),
  email: optional(trim(z.string().email().max(254).or(z.literal('')))),
  logo_url: optional(trim(z.string().url().max(1000).startsWith('https://').or(z.literal('')))),
}).strict()

const conversionWorker = z.object({
  employee_id: uuid, rate_id: optional(uuid), task: optional(text()), quantity_kg: positiveQuantity,
  rate_per_kg: optional(positiveMoney), amount: optional(positiveMoney),
}).strict().refine((value) => value.rate_id || (value.task && value.rate_per_kg != null), 'manual worker allocation requires task and rate_per_kg')

const conversion = z.object({
  id: optional(uuid), reference_no: optional(reference), conversion_date: date,
  conversion_type_id: optional(uuid), source_item_id: optional(uuid), source_material_name: optional(text()),
  output_item_id: optional(uuid), chip_name: optional(text()), chip_type: optional(text(100, 0)),
  input_kg: positiveQuantity, output_kg: positiveQuantity, overhead_cost: money.default(0),
  workers: z.array(conversionWorker).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (!value.source_item_id && !value.source_material_name) ctx.addIssue({ code: 'custom', message: 'source_item_id or source_material_name is required' })
  if (!value.output_item_id && !value.chip_name) ctx.addIssue({ code: 'custom', message: 'output_item_id or chip_name is required' })
  if (value.output_kg > value.input_kg * 1.02) ctx.addIssue({ code: 'custom', message: 'output_kg cannot exceed input_kg by more than 2%' })
})

const dailyTarget = z.object({
  id: optional(uuid), employee_id: uuid, work_date: date, target_percent: number(0, 100),
  notes: optional(text(2000, 0)),
}).strict()

const overtime = z.object({
  id: optional(uuid), employee_id: uuid, work_date: date, hours: number(Number.EPSILON, 24),
  rate: optional(positiveMoney), target_percent: number(0, 100).default(0), notes: optional(text(1000, 0)),
}).strict()

const product = z.object({
  id: optional(uuid), sku: optional(text(80, 0)), name: text(), product_type: text(100),
  selling_price: positiveMoney,
  image_url: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    optional(trim(z.string().max(1000).url().startsWith('https://'))),
  ),
  description: optional(text(500, 0)), is_active: z.boolean().default(true),
}).strict()

const publicOrder = z.object({
  customer_name: text(), customer_phone: text(40), customer_email: optional(trim(z.string().email().max(254))),
  customer_address: optional(text(500, 0)), notes: optional(text(2000, 0)),
  items: z.array(z.object({ item_id: uuid, quantity: number(Number.EPSILON, 10_000) }).strict()).min(1).max(50),
  website: text(200, 0).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.website) ctx.addIssue({ code: 'custom', message: 'Order could not be submitted' })
  if (new Set(value.items.map((item) => item.item_id)).size !== value.items.length) ctx.addIssue({ code: 'custom', message: 'Order product IDs must be unique' })
})

const production = z.object({
  id: optional(uuid), reference_no: optional(reference), production_date: date,
  shift: optional(z.enum(['Day', 'Night'])), machine: optional(text(100, 0)), operator_employee_id: uuid,
  chip_item_id: optional(uuid), chip_name: optional(text()), finished_item_id: uuid,
  finished_item_name: optional(text()), product_type: optional(text(100, 0)), input_kg: positiveQuantity,
  output_quantity: positiveQuantity, working_hours: optional(money), overhead_cost: money.default(0),
  selling_price: optional(positiveMoney), notes: optional(text(2000, 0)),
}).strict().superRefine((value, ctx) => {
  if (!value.chip_item_id && !value.chip_name) ctx.addIssue({ code: 'custom', message: 'chip_item_id or chip_name is required' })
})

const saleItem = z.object({
  item_id: optional(uuid), item_name: optional(text()), quantity: positiveQuantity,
  unit_price: positiveMoney, discount: money.default(0),
}).strict().superRefine((value, ctx) => {
  if (!value.item_id && !value.item_name) ctx.addIssue({ code: 'custom', message: 'item_id or item_name is required' })
  if (value.discount >= value.quantity * value.unit_price) ctx.addIssue({ code: 'custom', message: 'discount must be less than the line gross amount' })
})

const sale = z.object({
  id: optional(uuid), reference_no: optional(reference), invoice_no: optional(reference), sale_date: date,
  customer_name: text(), customer_phone: optional(text(40, 0)), payment_method: paymentMethod,
  document_status: z.enum(['issued', 'delivered', 'completed']).default('issued'),
  amount_paid: money.default(0), items: z.array(saleItem).min(1).max(500),
}).strict()

const quotationItem = z.object({
  item_id: optional(uuid), product_name: optional(text(160, 0)), product_type: optional(text(100, 0)),
  manual: z.boolean().optional(),
  quantity: positiveQuantity, unit_price: positiveMoney, discount: money.default(0),
  notes: optional(text(500, 0)),
}).strict().superRefine((value, ctx) => {
  if (!value.item_id && !value.product_name) ctx.addIssue({ code: 'custom', message: 'item_id or product_name is required' })
  if (value.discount >= value.quantity * value.unit_price) ctx.addIssue({ code: 'custom', message: 'discount must be less than the line gross amount' })
})

const quotation = z.object({
  id: optional(uuid), quotation_no: optional(reference), quotation_date: date, valid_until: date,
  customer_name: text(), customer_phone: optional(text(40, 0)), customer_email: optional(text(254, 0)),
  customer_address: optional(text(500, 0)), payment_method: paymentMethod.default('accounts_receivable'),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled']).default('draft'),
  terms: optional(text(4000, 0)), notes: optional(text(4000, 0)), items: z.array(quotationItem).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.valid_until < value.quotation_date) ctx.addIssue({ code: 'custom', message: 'valid_until cannot be before quotation_date' })
  const productIds = value.items.flatMap((item) => item.item_id ? [item.item_id] : [])
  if (new Set(productIds).size !== productIds.length) ctx.addIssue({ code: 'custom', message: 'quotation product IDs must be unique' })
})

const salePayment = z.object({
  id: optional(uuid), reference_no: optional(reference), sale_id: optional(uuid), payment_date: date,
  amount: positiveMoney, method: paymentMethod, notes: optional(text(1000, 0)),
}).strict()

const earning = z.object({
  type: text(), description: optional(text(300, 0)), quantity: optional(money), rate: optional(money),
  amount: positiveMoney, account_code: optional(text(40, 0)),
}).strict()
const deduction = z.object({
  type: text(), description: optional(text(300, 0)), amount: positiveMoney, account_code: optional(text(40, 0)),
}).strict()
const uniqueIds = (maximum) => z.array(uuid).max(maximum).refine((items) => new Set(items).size === items.length, 'claim IDs must be unique').default([])
const payroll = z.object({
  id: optional(uuid), reference_no: optional(reference), payroll_date: date,
  salary_month: trim(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)), employee_id: uuid,
  status: z.enum(['payable', 'paid']), payment_method: optional(paymentMethod),
  earnings: z.array(earning).max(200).default([]), deductions: z.array(deduction).max(200).default([]),
  employer_contributions: z.array(deduction).max(100).default([]), daily_work_ids: uniqueIds(500),
  conversion_worker_ids: uniqueIds(500), manual_piecework_ids: uniqueIds(500), overtime_ids: uniqueIds(500),
  daily_target_ids: uniqueIds(500),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'paid' && !value.payment_method) ctx.addIssue({ code: 'custom', message: 'payment_method is required when payroll status is paid' })
  if (value.status === 'paid' && value.payment_method && !['cash', 'bank_transfer', 'cheque', 'other'].includes(value.payment_method)) ctx.addIssue({ code: 'custom', message: 'paid payroll requires cash, bank_transfer, cheque, or other' })
  if (!value.earnings.length && !['daily_work_ids', 'conversion_worker_ids', 'manual_piecework_ids', 'overtime_ids', 'daily_target_ids'].some((key) => value[key].length)) ctx.addIssue({ code: 'custom', message: 'payroll needs an earning or an open-work claim' })
})

const payrollPayment = z.object({
  id: optional(uuid), reference_no: optional(reference), payroll_id: optional(uuid), payment_date: date,
  amount: positiveMoney, method: settlementMethod, notes: optional(text(1000, 0)),
}).strict()

const adjustment = z.object({
  id: optional(uuid), reference_no: optional(reference), adjustment_date: date, item_id: optional(uuid),
  item_name: optional(text()), direction: z.enum(['positive', 'negative']), quantity: positiveQuantity,
  value: positiveMoney, notes: optional(text(2000, 0)),
}).strict().refine((value) => value.item_id || value.item_name, 'item_id or item_name is required')

const journalLine = z.object({
  account_code: optional(text(40, 0)), account: optional(text(160, 0)), description: optional(text(500, 0)),
  debit: money.default(0), credit: money.default(0),
}).strict().superRefine((value, ctx) => {
  if (!value.account_code && !value.account) ctx.addIssue({ code: 'custom', message: 'account_code or account is required' })
  if ((value.debit > 0) === (value.credit > 0)) ctx.addIssue({ code: 'custom', message: 'exactly one of debit or credit must be greater than zero' })
})
const journal = z.object({
  id: optional(uuid), reference_no: optional(reference), journal_date: date, memo: text(500),
  lines: z.array(journalLine).min(2).max(500),
  allow_control_accounts: z.boolean().default(false),
  control_account_override_acknowledged: z.boolean().default(false),
}).strict().refine((value) => {
  const cents = (amount) => Math.round(amount * 100)
  return value.lines.reduce((total, line) => total + cents(line.debit), 0) === value.lines.reduce((total, line) => total + cents(line.credit), 0)
}, 'journal is not balanced')

const reverse = z.object({ reason: optional(text(1000, 3)) }).strict()
const customerOrderStatus = z.object({ status: z.enum(['pending', 'confirmed', 'in_progress', 'ready', 'completed', 'cancelled']) }).strict()
const purge = z.object({
  confirmation: z.literal('DELETE ALL BUSINESS DATA'), acknowledge_irreversible: z.literal(true),
  delete_conversion_rates: z.literal(true), company_code: z.enum(['CK', 'AR']),
}).strict()
const adminStatus = z.object({ is_active: z.boolean() }).strict()
const adminRemove = z.object({ confirmation_pin: trim(z.string().regex(/^\d{4}$/)) }).strict()
const adminUser = z.object({
  email: trim(z.string().email().min(3).max(320)).transform((value) => value.toLowerCase()),
  display_name: text(200), temporary_password: trim(z.string().min(10).max(72)),
  company_access: z.enum(['CK', 'AR', 'BOTH']),
  role_codes: z.array(z.enum(['admin', 'accountant', 'operations', 'payroll', 'viewer'])),
  is_super_admin: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (!value.is_super_admin && !value.role_codes.length) ctx.addIssue({ code: 'custom', message: 'Select at least one access role' })
  if (!/[a-z]/.test(value.temporary_password)) ctx.addIssue({ code: 'custom', message: 'Password requires a lowercase letter' })
  if (!/[A-Z]/.test(value.temporary_password)) ctx.addIssue({ code: 'custom', message: 'Password requires an uppercase letter' })
  if (!/\d/.test(value.temporary_password)) ctx.addIssue({ code: 'custom', message: 'Password requires a number' })
  if (!/[^A-Za-z0-9]/.test(value.temporary_password)) ctx.addIssue({ code: 'custom', message: 'Password requires a symbol' })
}).transform((value) => value.is_super_admin
  ? { ...value, company_access: 'BOTH', role_codes: ['admin'] }
  : { ...value, role_codes: [...new Set(value.role_codes)] })

export const schemas = {
  employee, conversionType, pieceworkRate, bulkRmRate, rmPurchase, companyProfile, conversion, dailyTarget, overtime,
  product, publicOrder, production, sale, quotation, salePayment, payroll, payrollPayment,
  adjustment, journal, reverse, customerOrderStatus, purge, adminStatus, adminRemove, adminUser,
}

export function parse(schema, value) {
  const result = schema.safeParse(value ?? {})
  if (!result.success) throw validationError(result.error)
  return removeNulls(result.data)
}

function removeNulls(value) {
  if (Array.isArray(value)) return value.map(removeNulls)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => [key, removeNulls(item)]))
}
