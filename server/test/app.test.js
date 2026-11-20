// @vitest-environment node
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from '../app.js'

const COMPANY_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_COMPANY_ID = '20000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000001'

const config = {
  appName: 'CK SYS ERP API', appVersion: '3.0.0', appEnv: 'test', production: false,
  maxPageSize: 100, defaultPageSize: 25, corsOrigins: [], secretKey: 'test-service-secret',
}

function profile() {
  return {
    user_id: USER_ID, display_name: 'Test administrator', is_active: true, is_super_admin: true,
    companies: [
      { company_id: COMPANY_ID, code: 'CK', name: 'CK Plastics', is_primary: true, role_codes: ['admin'], permission_codes: ['system.admin'] },
      { company_id: OTHER_COMPANY_ID, code: 'AR', name: 'AR Plastics', is_primary: false, role_codes: ['admin'], permission_codes: ['system.admin'] },
    ],
  }
}

describe('Node API handler', () => {
  let server
  let origin
  let gateway

  beforeEach(async () => {
    gateway = {
      verifyToken: vi.fn(async () => ({ sub: USER_ID, role: 'authenticated' })),
      fetchProfile: vi.fn(async () => profile()),
      dashboard: vi.fn(async (year, options) => ({
        year: year || 2026, company_id: options.companyId, inventory: {}, finance: {}, workforce: {}, operations: {}, generated_at: '2026-01-01T00:00:00Z',
      })),
      execute: vi.fn(async (operation, payload) => ({ ok: true, operation, id: payload.id || null })),
      verifyCatalogCredential: vi.fn(async () => COMPANY_ID),
      publicCatalog: vi.fn(async () => [{
        id: '00000000-0000-4000-8000-000000000003', sku: 'PRD-1', name: 'Frame stand',
        category: 'Frame Stand', image_url: 'https://example.com/frame.webp', selling_price: 1200,
        description: 'A strong display stand.',
      }]),
    }
    server = createServer(createHandler({ config, gateway }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const auth = (extra = {}) => ({ Authorization: 'Bearer test-token', ...extra })

  it('serves liveness without authentication and includes security headers', async () => {
    const response = await fetch(`${origin}/api/v1/health/live`, { headers: { 'X-Request-ID': 'test-request-123' } })
    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe('ok')
    expect(response.headers.get('x-request-id')).toBe('test-request-123')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('selects the requested company and rejects forged company access', async () => {
    const selected = await fetch(`${origin}/api/v1/dashboard`, { headers: auth({ 'X-Company-ID': OTHER_COMPANY_ID }) })
    expect(selected.status).toBe(200)
    expect((await selected.json()).company_id).toBe(OTHER_COMPANY_ID)
    const forged = await fetch(`${origin}/api/v1/dashboard`, { headers: auth({ 'X-Company-ID': '30000000-0000-4000-8000-000000000003' }) })
    expect(forged.status).toBe(403)
    expect((await forged.json()).code).toBe('company_access_denied')
  })

  it('requires an idempotency key and validates mutations before executing', async () => {
    const payload = { name: 'Frame', product_type: 'Photo frame', selling_price: 1250 }
    const missingKey = await fetch(`${origin}/api/v1/products`, {
      method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
    })
    expect(missingKey.status).toBe(400)
    expect((await missingKey.json()).code).toBe('idempotency_key_required')
    const accepted = await fetch(`${origin}/api/v1/products`, {
      method: 'POST', headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': 'product-0001' }), body: JSON.stringify(payload),
    })
    expect(accepted.status).toBe(201)
    expect((await accepted.json()).operation).toBe('product.upsert')
    expect(gateway.execute).toHaveBeenCalledWith('product.upsert', expect.objectContaining({ selling_price: 1250 }), 'product-0001', expect.objectContaining({ companyId: COMPANY_ID }))
  })

  it('scopes edits, reversals, cancellations, and deactivation to the selected record ID', async () => {
    const employeeId = '30000000-0000-4000-8000-000000000003'
    const dailyTargetId = '40000000-0000-4000-8000-000000000004'
    const overtimeId = '50000000-0000-4000-8000-000000000005'
    const payrollId = '60000000-0000-4000-8000-000000000006'
    const quotationId = '70000000-0000-4000-8000-000000000007'
    const mutation = (key, body) => ({
      method: body === undefined ? 'DELETE' : 'PATCH',
      headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': key }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const responses = []
    responses.push(await fetch(`${origin}/api/v1/daily-work/${dailyTargetId}`, mutation('scope-edit-daily', {
        employee_id: employeeId, work_date: '2026-11-20', target_percent: 90, notes: 'Selected row only',
      })))
    responses.push(await fetch(`${origin}/api/v1/overtime/${overtimeId}`, mutation('scope-edit-ot', {
      employee_id: employeeId, work_date: '2026-11-20', hours: 2, target_percent: 80, notes: 'Selected row only',
    })))
    responses.push(await fetch(`${origin}/api/v1/quotations/${quotationId}`, mutation('scope-edit-quotation', {
      quotation_date: '2026-11-20', valid_until: '2026-11-30', customer_name: 'Selected Customer',
      items: [{ manual: true, product_name: 'Selected Product', quantity: 1, unit_price: 1000, discount: 0 }],
    })))
    responses.push(await fetch(`${origin}/api/v1/payroll/${payrollId}`, mutation('scope-correct-payroll', {
      payroll_date: '2026-11-20', salary_month: '2026-11', employee_id: employeeId, status: 'payable',
      earnings: [{ type: 'monthly_salary', amount: 100000 }],
    })))
    responses.push(await fetch(`${origin}/api/v1/employees/${employeeId}`, mutation('scope-edit-employee', {
      name: 'Selected Employee', joined_date: '2026-01-01', pay_model: 'piecework',
    })))
    responses.push(await fetch(`${origin}/api/v1/daily-work/${dailyTargetId}`, {
        method: 'DELETE', headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': 'scope-reverse-daily' }),
        body: JSON.stringify({ reason: 'Selected row only' }),
      }))
    responses.push(await fetch(`${origin}/api/v1/overtime/${overtimeId}`, {
        method: 'DELETE', headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': 'scope-reverse-ot' }),
        body: JSON.stringify({ reason: 'Selected row only' }),
      }))
    responses.push(await fetch(`${origin}/api/v1/payroll/${payrollId}`, {
        method: 'DELETE', headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': 'scope-reverse-payroll' }),
        body: JSON.stringify({ reason: 'Selected row only' }),
      }))
    responses.push(await fetch(`${origin}/api/v1/quotations/${quotationId}`, mutation('scope-cancel-quotation')))
    responses.push(await fetch(`${origin}/api/v1/employees/${employeeId}`, mutation('scope-deactivate-employee')))

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200])
    expect(gateway.execute.mock.calls.map(([operation, payload]) => [operation, payload])).toEqual([
      ['daily_target.upsert', expect.objectContaining({ id: dailyTargetId, employee_id: employeeId })],
      ['overtime.upsert', expect.objectContaining({ id: overtimeId, employee_id: employeeId })],
      ['quotation.upsert', expect.objectContaining({ id: quotationId, customer_name: 'Selected Customer' })],
      ['payroll.replace', expect.objectContaining({
        target: { id: payrollId },
        replacement: expect.objectContaining({ employee_id: employeeId, salary_month: '2026-11' }),
      })],
      ['employee.upsert', expect.objectContaining({ id: employeeId, name: 'Selected Employee' })],
      ['daily_target.reverse', { id: dailyTargetId, reason: 'Selected row only' }],
      ['overtime.reverse', { id: overtimeId, reason: 'Selected row only' }],
      ['payroll.reverse', { id: payrollId, reason: 'Selected row only' }],
      ['quotation.cancel', { id: quotationId }],
      ['employee.delete', { id: employeeId }],
    ])
    for (const call of gateway.execute.mock.calls) {
      expect(call[3]).toEqual(expect.objectContaining({ companyId: COMPANY_ID }))
    }
  })

  it('returns a JSON 404 for unknown API routes', async () => {
    const response = await fetch(`${origin}/api/v1/not-a-route`, { headers: auth() })
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('http_error')
  })

  it('protects the external catalogue with scoped API headers', async () => {
    const missing = await fetch(`${origin}/api/v1/integrations/catalog/products`)
    expect(missing.status).toBe(401)

    const apiId = '40000000-0000-4000-8000-000000000004'
    const apiKey = `ckcat_${'a'.repeat(43)}`
    const accepted = await fetch(`${origin}/api/v1/integrations/catalog/products`, {
      headers: { 'X-Catalog-API-ID': apiId, 'X-Catalog-API-Key': apiKey },
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual(expect.objectContaining({
      api_version: '1.0', catalog_id: apiId,
      items: [expect.objectContaining({ name: 'Frame stand', image_url: 'https://example.com/frame.webp' })],
    }))
    expect(gateway.verifyCatalogCredential).toHaveBeenCalledWith(apiId, apiKey, expect.any(String))
  })

  it('returns a website API key once and stores only its hash', async () => {
    const response = await fetch(`${origin}/api/v1/catalog-api-credential/rotate`, {
      method: 'POST', headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': 'catalog-rotate-0001' }),
      body: '{}',
    })
    expect(response.status).toBe(201)
    const result = await response.json()
    expect(result.api_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.api_key).toMatch(/^ckcat_[A-Za-z0-9_-]{43}$/)
    expect(gateway.execute).toHaveBeenCalledWith(
      'catalog_api_credential.rotate',
      expect.objectContaining({ public_id: result.api_id, secret_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      'catalog-rotate-0001', expect.objectContaining({ companyId: COMPANY_ID }),
    )
    expect(JSON.stringify(gateway.execute.mock.calls.at(-1)?.[1])).not.toContain(result.api_key)
  })
})
