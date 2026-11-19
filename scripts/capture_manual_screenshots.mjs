import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'docs', 'screenshots', 'user-manual')
const baseUrl = process.env.MANUAL_BASE_URL || 'http://127.0.0.1:5173'
const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'

const pagePayload = (items = []) => ({
  items, total: items.length, page: 1, page_size: 100, pages: items.length ? 1 : 0,
  pagination_mode: 'offset', next_cursor: null, has_more: false, total_is_estimate: false,
})

const me = {
  user_id: userId, email: 'manual.demo@example.com', display_name: 'Manual Demo', is_active: true,
  active_company_id: companyId, active_company_code: 'CK', active_company_name: 'CK Plastics',
  is_super_admin: true, role_codes: ['admin'], permission_codes: ['system.admin'],
  companies: [{
    company_id: companyId, code: 'CK', name: 'CK Plastics', is_primary: true,
    role_codes: ['admin'], permission_codes: ['system.admin'],
  }],
}

const dashboard = {
  year: 2026,
  inventory: {
    bulk: [{ quantity_on_hand: 2450, inventory_value: 1_715_000, item_count: 3 }],
    chip: [{ quantity_on_hand: 920, inventory_value: 828_000, item_count: 4 }],
    finished: [{ quantity_on_hand: 12_480, inventory_value: 2_184_000, item_count: 8 }],
  },
  finance: { revenue: 8_460_000, cogs: 5_170_000, expenses: 1_120_000, receivables: 684_500, payables: 392_000, cash_bank: 1_936_400 },
  workforce: { active_employees: 24, open_daily_wages: 86_500, open_piecework: 42_750 },
  operations: { purchases: 34, conversions: 48, production: 126, sales: 204, payroll: 22 },
  generated_at: '2026-10-24T12:30:00Z',
}

const productionSummary = {
  as_of: '2026-10-24', month: '2026-10', today_runs: 6, today_input_kg: 210,
  today_output_quantity: 3250, month_runs: 126, month_input_kg: 4120,
  month_output_quantity: 64_300, bulk_item_count: 3, chip_item_count: 4,
  bulk_value: 1_715_000, chip_value: 828_000,
  recent_daily: [
    ['2026-10-20', 4, 180, 2800, 462000], ['2026-10-21', 5, 195, 3020, 498000],
    ['2026-10-22', 5, 205, 3180, 520000], ['2026-10-23', 6, 215, 3310, 541000],
    ['2026-10-24', 6, 210, 3250, 533000],
  ].map(([production_date, run_count, input_kg, output_quantity, total_cost]) => ({ production_date, run_count, input_kg, output_quantity, total_cost })),
}

const inventory = [
  { item_id: '33333333-3333-4333-8333-333333333331', id: '33333333-3333-4333-8333-333333333331', sku: 'FP-001', item_name: '5 Litre Utility Bucket', name: '5 Litre Utility Bucket', stage: 'finished', unit: 'piece', quantity_on_hand: 6480, shared_quantity_on_hand: 9250, inventory_value: 1_134_000, average_unit_cost: 175, selling_price: 295, product_type: 'Utility', last_movement_at: '2026-10-24T08:15:00Z', is_active: true },
  { item_id: '33333333-3333-4333-8333-333333333332', id: '33333333-3333-4333-8333-333333333332', sku: 'FP-002', item_name: '10 Litre Storage Container', name: '10 Litre Storage Container', stage: 'finished', unit: 'piece', quantity_on_hand: 6000, shared_quantity_on_hand: 8100, inventory_value: 1_050_000, average_unit_cost: 175, selling_price: 340, product_type: 'Storage', last_movement_at: '2026-10-24T09:05:00Z', is_active: true },
]

const inventorySummary = {
  bulk: { item_count: 3, total_quantity: 2450, shared_total_quantity: 3100, total_value: 1_715_000 },
  chips: { item_count: 4, total_quantity: 920, shared_total_quantity: 1380, total_value: 828_000 },
  finished: { item_count: 8, total_quantity: 12_480, shared_total_quantity: 17_350, total_value: 2_184_000 },
  total_quantity: 15_850, shared_total_quantity: 21_830, total_value: 4_727_000,
}

const accounts = [
  ['CASH', 'Cash on hand', 'asset', 1_150_000], ['BANK', 'Bank current account', 'asset', 786_400],
  ['AR', 'Trade receivables', 'asset', 684_500], ['AP', 'Trade payables', 'liability', 392_000],
  ['CAPITAL', 'Owner capital', 'equity', 543_900], ['SALES', 'Sales revenue', 'revenue', 8_460_000],
  ['COGS', 'Cost of goods sold', 'expense', 5_170_000], ['UTIL', 'Utilities expense', 'expense', 1_120_000],
].map(([account_code, account_name, category, balance], index) => ({ account_id: index + 1, account_code, account_name, category, debit_total: category === 'asset' || category === 'expense' ? balance : 0, credit_total: category === 'asset' || category === 'expense' ? 0 : balance, balance }))

const audit = [
  { id: 101, occurred_at: '2026-10-24T09:42:00Z', actor_user_id: userId, actor_display_name: 'Manual Demo', actor_email: 'manual.demo@example.com', operation: 'post_sales_invoice', entity_table: 'sales', entity_id: 'INV-2026-0204', action: 'insert', before_data: null, after_data: { invoice_no: 'INV-2026-0204', total_amount: 144250 }, request_id: 'req-demo-001', company_id: companyId },
  { id: 100, occurred_at: '2026-10-24T08:18:00Z', actor_user_id: userId, actor_display_name: 'Manual Demo', actor_email: 'manual.demo@example.com', operation: 'post_production_run', entity_table: 'production_runs', entity_id: 'PR-2026-0126', action: 'insert', before_data: null, after_data: { output_quantity: 3250 }, request_id: 'req-demo-002', company_id: companyId },
]

const adminUsers = [
  { company_id: companyId, company_code: 'CK', company_name: 'CK Plastics', user_id: userId, display_name: 'Manual Demo', email: 'manual.demo@example.com', profile_active: true, is_super_admin: true, membership_active: true, is_primary: true, role_codes: ['admin'] },
  { company_id: companyId, company_code: 'CK', company_name: 'CK Plastics', user_id: '22222222-2222-4222-8222-222222222223', display_name: 'Production Operator', email: 'operator@example.com', profile_active: true, is_super_admin: false, membership_active: true, is_primary: true, role_codes: ['operations'] },
]

function apiResponse(path) {
  if (path === '/api/v1/me') return me
  if (path === '/api/v1/dashboard') return dashboard
  if (path === '/api/v1/production/summary') return productionSummary
  if (path === '/api/v1/inventory/summary') return inventorySummary
  if (path.startsWith('/api/v1/inventory/finished') || path.startsWith('/api/v1/inventory/position') || path.startsWith('/api/v1/reports/inventory') || path.startsWith('/api/v1/products')) return pagePayload(inventory)
  if (path === '/api/v1/account-balances') return pagePayload(accounts)
  if (path === '/api/v1/reports/audit-log') return pagePayload(audit)
  if (path === '/api/v1/admin/users') return pagePayload(adminUsers)
  if (path === '/api/v1/conversion-types') return pagePayload([
    { id: '44444444-4444-4444-8444-444444444441', name: 'Clear PP', default_chip_name: 'Clear PP Chip', notes: 'Standard clear material', status: 'active' },
    { id: '44444444-4444-4444-8444-444444444442', name: 'Colour Mix', default_chip_name: 'Mixed Colour Chip', notes: 'Sorted colour material', status: 'active' },
  ])
  if (path === '/api/v1/piecework-rates') return pagePayload([
    { id: '55555555-5555-4555-8555-555555555551', conversion_type_id: '44444444-4444-4444-8444-444444444441', work_type: 'Sorting and grinding', rate_per_kg: 18.5, effective_from: '2026-01-01', effective_to: null, status: 'active' },
    { id: '55555555-5555-4555-8555-555555555552', conversion_type_id: '44444444-4444-4444-8444-444444444442', work_type: 'Washing and grinding', rate_per_kg: 22, effective_from: '2026-01-01', effective_to: null, status: 'active' },
  ])
  if (path === '/api/v1/reports/financial-summary') return { generated_at: '2026-10-24T12:30:00Z', filters: { year: 2026 }, totals: { revenue: 8_460_000, cogs: 5_170_000, expenses: 1_120_000, net_result: 2_170_000, assets: 4_727_000, liabilities: 392_000, equity: 4_335_000 }, items: [] }
  return pagePayload()
}

function jwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ aud: 'authenticated', exp: now + 86_400, iat: now, iss: 'https://khtmogtjyjpekftzkfcr.supabase.co/auth/v1', role: 'authenticated', sub: userId, email: 'manual.demo@example.com' })}.documentation`
}

async function save(page, filename) {
  await page.locator('main#main-content').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(output, filename), fullPage: true })
}

async function openPage(page, path, filename) {
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' })
  await save(page, filename)
}

async function selectTab(page, label, filename) {
  await page.getByRole('tab', { name: label, exact: true }).click()
  await page.waitForTimeout(500)
  await save(page, filename)
}

mkdirSync(output, { recursive: true })
const executablePath = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync)
if (!executablePath) throw new Error('Microsoft Edge or Google Chrome is required for screenshots.')

const browser = await chromium.launch({ headless: true, executablePath })
try {
  const publicContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 })
  const publicPage = await publicContext.newPage()
  await publicPage.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' })
  await publicPage.screenshot({ path: resolve(output, '01-company-portal-selection.png'), fullPage: true })
  await publicPage.goto(`${baseUrl}/ck/login`, { waitUntil: 'networkidle' })
  await publicPage.screenshot({ path: resolve(output, '02-ck-sign-in.png'), fullPage: true })
  await publicPage.getByRole('button', { name: 'Forgot your password?' }).click()
  await publicPage.screenshot({ path: resolve(output, '03-password-recovery.png'), fullPage: true })
  await publicContext.close()

  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 })
  await context.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiResponse(path)) })
  })
  await context.route('**/auth/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  const token = jwt()
  const session = {
    access_token: token, refresh_token: 'documentation-refresh-token', expires_at: Math.floor(Date.now() / 1000) + 86_400,
    expires_in: 86_400, token_type: 'bearer',
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'manual.demo@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Manual Demo' }, created_at: '2026-01-01T00:00:00Z' },
  }
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: 'ck-sys-v3-auth', value: session })
  const page = await context.newPage()

  await openPage(page, '/ck/dashboard', '04-dashboard.png')
  await openPage(page, '/ck/production', '05-production-dashboard.png')
  await selectTab(page, 'Bulk RM', '06-production-bulk-rm.png')
  await page.getByRole('button', { name: 'New purchase' }).click()
  await page.screenshot({ path: resolve(output, '07-post-purchase-dialog.png'), fullPage: true })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await selectTab(page, 'Conversions', '08-production-conversions.png')
  await selectTab(page, 'Production runs', '09-production-runs.png')
  await openPage(page, '/ck/inventory', '10-inventory-finished.png')
  await selectTab(page, 'Read-only report', '11-inventory-report.png')
  await openPage(page, '/ck/sales', '12-sales-invoices.png')
  await page.getByRole('button', { name: 'New invoice' }).first().click()
  await page.screenshot({ path: resolve(output, '13-new-invoice-dialog.png'), fullPage: true })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await selectTab(page, 'Outstanding', '14-sales-outstanding.png')
  await openPage(page, '/ck/employees', '15-staff-employees.png')
  await selectTab(page, 'Daily work', '16-staff-daily-work.png')
  await selectTab(page, 'OT hours', '17-staff-overtime.png')
  await selectTab(page, 'Open earnings', '18-staff-open-earnings.png')
  await selectTab(page, 'Payroll', '19-staff-payroll.png')
  await selectTab(page, 'Payroll report', '20-staff-payroll-report.png')
  await openPage(page, '/ck/accounting', '21-accounting-overview.png')
  await selectTab(page, 'Quick entry', '22-accounting-quick-entry.png')
  await selectTab(page, 'Journals', '23-accounting-journals.png')
  await selectTab(page, 'Master ledger', '24-accounting-ledger.png')
  await selectTab(page, 'Statements', '25-accounting-statements.png')
  await openPage(page, '/ck/activity', '26-activity-audit.png')
  await openPage(page, '/ck/account', '27-account-security.png')
  await openPage(page, '/ck/settings', '28-settings.png')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.screenshot({ path: resolve(output, '29-create-account-dialog.png'), fullPage: true })
  await context.close()
} finally {
  await browser.close()
}

console.log(`Captured ${readdirSync(output).filter((file) => file.endsWith('.png')).length} screenshots in ${output}`)
