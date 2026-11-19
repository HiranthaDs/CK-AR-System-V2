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
