import { randomUUID } from 'node:crypto'
import { getConfig } from './config.js'
import { ApiError, problem } from './errors.js'
import { SupabaseGateway, isUuid } from './gateway.js'
import { authorize, dispatch, matchRoute } from './routes.js'

const BODY_LIMIT = 1_048_576

export function createHandler({ config: suppliedConfig, gateway: suppliedGateway } = {}) {
  return async function handler(request, response) {
    let config
    let requestId = safeRequestId(header(request, 'x-request-id')) || randomUUID()
    let path = '/api/v1'
    try {
      config = suppliedConfig || getConfig()
      const target = requestTarget(request)
      path = target.path
      setSecurityHeaders(response, requestId, config.production)
      setCorsHeaders(request, response, config)

      if (String(request.method || 'GET').toUpperCase() === 'OPTIONS') {
        response.statusCode = 204
        response.end()
        return
      }

      const method = String(request.method || 'GET').toUpperCase()
      const match = matchRoute(method, path)
      if (!match) throw new ApiError(404, 'API route not found', { code: 'http_error' })

      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        ? await readBody(request)
        : {}
      const gateway = suppliedGateway || new SupabaseGateway(config)
      const ctx = {
        request, response, method, path, query: target.query, body, headers: normalizedHeaders(request),
        requestId, config, gateway, params: match.params, principal: null,
      }

      if (!match.route.public) {
        ctx.principal = await authenticate(ctx)
        authorize(ctx.principal, match.route)
      }

      const result = await dispatch(ctx)
      response.statusCode = result?.status || 200
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (result?.headers) {
        for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value)
      }
      response.end(JSON.stringify(result?.body ?? null))
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Unhandled API request failure', error)
      const value = problem(error, { path, requestId })
      setSecurityHeaders(response, requestId, config?.production === true)
      response.statusCode = value.error.status
      response.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
      for (const [name, headerValue] of Object.entries(value.error.headers || {})) response.setHeader(name, headerValue)
      response.end(JSON.stringify(value.body))
    }
  }
}

async function authenticate(ctx) {
  const authorization = header(ctx.request, 'authorization')
  const match = /^Bearer\s+(.+)$/i.exec(authorization || '')
  if (!match) {
    throw new ApiError(401, 'A Supabase user access token is required', {
      code: 'missing_access_token', headers: { 'WWW-Authenticate': 'Bearer' },
    })
  }
  const token = match[1]
  const claims = await ctx.gateway.verifyToken(token)
  const profile = await ctx.gateway.fetchProfile(token, ctx.requestId, claims.sub)
  const company = resolveCompany(profile, header(ctx.request, 'x-company-id'))
  const selectedProfile = {
    ...profile,
    active_company_id: company.company_id,
    active_company_code: company.code,
    active_company_name: company.name,
    role_codes: Array.isArray(company.role_codes) ? company.role_codes : [],
    permission_codes: Array.isArray(company.permission_codes) ? company.permission_codes : [],
  }
  return {
    userId: claims.sub, token, claims, profile: selectedProfile, companyId: company.company_id,
    company, permissions: selectedProfile.permission_codes, roles: selectedProfile.role_codes,
    isSuperAdmin: profile.is_super_admin === true,
  }
}

export function resolveCompany(profile, requestedCompanyId) {
  const companies = Array.isArray(profile.companies) ? profile.companies : []
  if (!companies.length) throw new ApiError(403, 'No active company access is assigned', { code: 'company_access_required' })
  if (requestedCompanyId) {
    if (!isUuid(requestedCompanyId)) throw new ApiError(400, 'X-Company-ID must be a valid UUID', { code: 'invalid_company_id' })
    const company = companies.find((item) => item.company_id === requestedCompanyId)
    if (!company) throw new ApiError(403, 'You do not have active access to the requested company', { code: 'company_access_denied' })
    return company
  }
  return companies.find((company) => company.is_primary) || companies[0]
}

function requestTarget(request) {
  const url = new URL(request.url || '/', 'http://localhost')
  let path = url.pathname
  if (path === '/api/handler' || path === '/api/handler.js' || path === '/api') {
    const forwarded = url.searchParams.get('path') || request.query?.path
    const value = Array.isArray(forwarded) ? forwarded.join('/') : String(forwarded || '')
    path = `/api/v1/${value.replace(/^\/+/, '')}`
    url.searchParams.delete('path')
  }
  if (path.startsWith('/api/v1')) path = path.slice('/api/v1'.length) || '/'
  return { path: `/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/'), query: url.searchParams }
}

async function readBody(request) {
  if (request.body != null && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) return request.body
  if (typeof request.body === 'string') return parseBodyText(request.body)
  if (Buffer.isBuffer(request.body)) return parseBodyText(request.body.toString('utf8'))
  if (!request[Symbol.asyncIterator]) return {}
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    if (length > BODY_LIMIT) throw new ApiError(413, 'Request body exceeds the safe limit', { code: 'payload_too_large' })
    chunks.push(buffer)
  }
  return parseBodyText(Buffer.concat(chunks).toString('utf8'))
}

function parseBodyText(text) {
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value
  } catch {
    throw new ApiError(400, 'Request body must be a valid JSON object', { code: 'invalid_json' })
  }
}

function header(request, name) {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  if (value != null) return String(value)
  if (typeof request.headers?.get === 'function') return request.headers.get(name)
  return null
}

function normalizedHeaders(request) {
  if (!request.headers) return {}
  if (typeof request.headers.entries === 'function') return Object.fromEntries(request.headers.entries())
  return Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]))
}

function setSecurityHeaders(response, requestId, production) {
  if (response.headersSent) return
  response.setHeader('X-Request-ID', requestId)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('Expires', '0')
  response.setHeader('Surrogate-Control', 'no-store')
  if (production) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
}

function setCorsHeaders(request, response, config) {
  const origin = header(request, 'origin')
  if (!origin) return
  const host = header(request, 'host')
  const sameOrigin = host && new URL(origin).host === host
  if (!sameOrigin && !config.corsOrigins.includes(origin)) return
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Credentials', 'true')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Company-ID, X-Request-ID, Cache-Control, Pragma')
  response.setHeader('Access-Control-Expose-Headers', 'X-Request-ID')
  response.setHeader('Access-Control-Max-Age', '600')
}

function safeRequestId(value) {
  return value && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null
}

export default createHandler()
