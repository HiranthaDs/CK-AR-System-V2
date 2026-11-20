import { afterEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue({
    data: { session: { access_token: 'test-access-token' } },
    error: null,
  }),
  refreshSession: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: { auth: authMocks },
}))

import { api, ApiError, getActiveCompanyId, setActiveCompanyId } from '../lib/api'

afterEach(() => {
  setActiveCompanyId(null)
  vi.restoreAllMocks()
})

describe('company-aware API requests', () => {
  it('adds the selected company header to authenticated requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    setActiveCompanyId('22222222-2222-4222-8222-222222222222')
    await api.get<{ ok: boolean }>('/me')

    const request = fetchMock.mock.calls[0]
    const headers = new Headers(request?.[1]?.headers)
    expect(getActiveCompanyId()).toBe('22222222-2222-4222-8222-222222222222')
    expect(headers.get('X-Company-ID')).toBe('22222222-2222-4222-8222-222222222222')
    expect(headers.get('Authorization')).toBe('Bearer test-access-token')
  })

  it('omits the company header until a company context is known', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    await api.get<{ ok: boolean }>('/me')

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.has('X-Company-ID')).toBe(false)
  })

  it('shows validation details and a request reference from failed saves', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 422,
      detail: 'The request did not pass validation.',
      code: 'request_validation_failed',
      request_id: 'request-accounting-42',
      errors: [
        { loc: ['body', 'lines', 1, 'credit'], msg: 'Enter either a debit or a credit.' },
      ],
    }), { status: 422, headers: { 'Content-Type': 'application/problem+json' } }))

    const error = await api.post('/journals', {}).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe(
      'The request did not pass validation. • lines › line 2 › credit: Enter either a debit or a credit. • Request reference: request-accounting-42',
    )
  })
})
