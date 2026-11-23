import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { ApiError } from './errors.js'

export const READABLE_SOURCES = new Set([
  'current_user_access',
  'admin_user_access',
  'roles',
  'employees',
  'employee_compensation_history',
  'companies',
  'conversion_types',
  'piecework_rates',
  'bulk_rm_rates',
  'inventory_items',
  'raw_material_purchase_consignments',
  'raw_material_purchases',
  'conversions',
  'conversion_workers',
  'daily_work',
  'daily_work_piecework',
  'daily_target_work_view',
  'overtime_work_view',
  'production_runs',
  'quotations',
  'quotation_items',
  'customer_orders',
  'customer_order_items',
  'sales',
  'sale_items',
  'sale_payments',
  'payrolls',
  'payroll_details',
  'payroll_payments',
  'stock_adjustments',
  'journal_entries',
  'journal_lines',
  'stock_movements',
  'inventory_position',
  'inventory_stage_summary',
  'company_inventory_position',
  'company_inventory_stage_summary',
  'production_daily_summary',
  'account_balances',
  'account_balances_by_year',
  'ledger_view',
  'employee_open_earnings',
  'sales_outstanding',
  'payroll_outstanding',
  'audit_log',
  'catalog_api_credentials',
  'company_shift_settings',
  'employee_salary_advance_view',
])

const TIEBREAKERS = {
  current_user_access: 'user_id',
  admin_user_access: 'user_id',
  roles: 'id',
  employees: 'id',
  employee_compensation_history: 'id',
  companies: 'id',
  conversion_types: 'id',
  piecework_rates: 'id',
  bulk_rm_rates: 'id',
  inventory_items: 'id',
  raw_material_purchase_consignments: 'id',
  raw_material_purchases: 'id',
  conversions: 'id',
  conversion_workers: 'id',
  daily_work: 'id',
  daily_work_piecework: 'id',
  daily_target_work_view: 'id',
  overtime_work_view: 'id',
  production_runs: 'id',
  quotations: 'id',
  quotation_items: 'id',
  customer_orders: 'id',
  customer_order_items: 'id',
  sales: 'id',
  sale_items: 'id',
  sale_payments: 'id',
  payrolls: 'id',
  payroll_details: 'id',
  payroll_payments: 'id',
  stock_adjustments: 'id',
  journal_entries: 'id',
  journal_lines: 'id',
  stock_movements: 'id',
  inventory_position: 'item_id',
  inventory_stage_summary: 'stage',
  company_inventory_position: 'item_id',
  company_inventory_stage_summary: 'stage',
  production_daily_summary: 'production_date',
  account_balances: 'account_code',
  account_balances_by_year: 'account_code',
  ledger_view: 'id',
  employee_open_earnings: 'source_id',
  sales_outstanding: 'id',
  payroll_outstanding: 'id',
  audit_log: 'id',
  catalog_api_credentials: 'id',
  company_shift_settings: 'company_id',
  employee_salary_advance_view: 'id',
}

const UNSCOPED = new Set([
  'current_user_access',
  'roles',
  'companies',
  'conversion_types',
  'piecework_rates',
  'inventory_items',
  'inventory_position',
  'inventory_stage_summary',
])
const COMPANY_SCOPED = new Set([...READABLE_SOURCES].filter((source) => !UNSCOPED.has(source)))
const RETRYABLE = new Set([408, 425, 429, 502, 503, 504])
const ORDER = /^(?<column>[a-z_][a-z0-9_]*)\.(?<direction>asc|desc)$/

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function unwrap(data) {
  return Array.isArray(data) && data.length === 1 ? data[0] : data
}

export class SupabaseGateway {
  constructor(config, { fetchImpl = globalThis.fetch, authClient } = {}) {
    this.config = config
    this.fetch = fetchImpl
    this.authClient =
      authClient ||
      createClient(config.supabaseUrl, config.publishableKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      })
  }

  async verifyToken(token) {
    if (!token || token.length > 16_384) throw unauthorized()
    const { data, error } = await this.authClient.auth.getClaims(token)
    const claims = data?.claims
    const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]
    if (
      error ||
      !claims ||
      claims.iss !== this.config.authUrl ||
      !audience.includes('authenticated') ||
      claims.role !== 'authenticated' ||
      claims.is_anonymous === true ||
      !isUuid(claims.sub) ||
      !Number.isFinite(claims.iat) ||
      !Number.isFinite(claims.exp) ||
      claims.iat > claims.exp
    ) {
      throw unauthorized()
    }
    return claims
  }

  async authHealth() {
    const response = await this.send('GET', `${this.config.authUrl}/health`, {
      headers: this.publicHeaders(),
      retrySafe: true,
    })
    if (!response.ok)
      throw new ApiError(503, 'Supabase Auth is unavailable', {
        code: 'supabase_unavailable',
      })
    return response.json().catch(() => ({ status: 'ok' }))
  }

  async jwksHealth() {
    const response = await this.send('GET', `${this.config.authUrl}/.well-known/jwks.json`, {
      headers: this.publicHeaders(),
      retrySafe: true,
    })
    if (!response.ok)
      throw new ApiError(503, 'Authentication keys are temporarily unavailable', { code: 'jwks_unavailable' })
    const body = await response.json().catch(() => null)
    if (!body || !Array.isArray(body.keys))
      throw new ApiError(503, 'Authentication keys are temporarily unavailable', { code: 'jwks_unavailable' })
    return body
  }

  async schemaHealth() {
    const url = new URL(`${this.config.restUrl}/current_user_access`)
    url.searchParams.set('select', 'user_id')
    url.searchParams.set('limit', '0')
    const response = await this.send('GET', url, {
      headers: this.publicHeaders(),
      retrySafe: true,
    })
    const body = await response
      .clone()
      .json()
      .catch(() => ({}))
    const code = String(body?.code || '')
    if (response.ok) return { status: 'ok' }
    if ([401, 403].includes(response.status) && code === '42501') return { status: 'protected' }
    if (['PGRST202', 'PGRST204', 'PGRST205'].includes(code)) {
      throw new ApiError(503, 'The Supabase ERP schema is not deployed. Apply all database migrations.', {
        code: 'supabase_schema_unavailable',
      })
    }
    throw new ApiError(503, 'Supabase Data API readiness check failed', {
      code: 'supabase_unavailable',
    })
  }

  async fetchProfile(token, requestId, expectedUserId) {
    const data = await this.request('GET', 'current_user_access', {
      token,
      requestId,
      retrySafe: true,
      params: [
        ['select', 'user_id,display_name,email,is_active,is_super_admin,companies'],
        ['user_id', `eq.${expectedUserId}`],
        ['limit', '1'],
      ],
    })
    if (!Array.isArray(data) || !data.length)
      throw new ApiError(403, 'No active ERP profile is assigned', {
        code: 'profile_not_authorized',
      })
    const profile = data[0]
    if (profile.user_id !== expectedUserId)
      throw new ApiError(403, 'Profile identity mismatch', {
        code: 'profile_not_authorized',
      })
    if (!profile.is_active)
      throw new ApiError(403, 'The ERP profile is inactive', {
        code: 'profile_inactive',
      })
    if (!Array.isArray(profile.companies)) profile.companies = []
    return profile
  }

  async selectPage(
    source,
    {
      token,
      requestId,
      page,
      pageSize,
      select = '*',
      order,
      filters = [],
      paginationMode = 'offset',
      cursor = null,
      companyId,
    },
  ) {
    this.assertSource(source)
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
      throw new ApiError(422, 'Invalid pagination bounds', {
        code: 'invalid_pagination',
      })
    }
    if (pageSize > this.config.maxPageSize && paginationMode === 'offset') {
      throw new ApiError(422, 'Page size exceeds the configured limit', {
        code: 'invalid_pagination',
      })
    }
    const { stable, column, direction, tie } = this.stableOrder(source, order)
    const queryFilters = this.scopeFilters(source, companyId, filters)
    const fingerprint = queryFingerprint(queryFilters, select)
    const params = [
      ['select', select],
      ['limit', String(paginationMode === 'cursor' ? pageSize + 1 : pageSize)],
      ['order', stable],
    ]
    let cursorState = null
    if (paginationMode === 'offset') {
      if (cursor)
        throw new ApiError(422, 'Cursor is not valid for offset pagination', {
          code: 'invalid_cursor',
        })
      params.push(['offset', String((page - 1) * pageSize)])
    } else {
      if (page !== 1)
        throw new ApiError(422, 'Page cannot be combined with cursor pagination', { code: 'invalid_pagination' })
      if (cursor) {
        cursorState = decodeCursor(cursor, {
          source,
          column,
          direction,
          tie,
          fingerprint,
        })
        params.push(['or', cursorPredicate(column, direction, tie, cursorState)])
      }
    }
    for (const filter of queryFilters) params.push([filter.column, filterValue(filter)])
    const countRequested = paginationMode === 'offset' || !cursorState
    const { data, headers } = await this.requestWithHeaders('GET', source, {
      token,
      requestId,
      params,
      retrySafe: true,
      extraHeaders: countRequested ? { Prefer: `count=${this.config.paginationCount}` } : {},
    })
    if (!Array.isArray(data) || data.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new ApiError(502, 'Supabase returned an invalid collection', {
        code: 'invalid_upstream',
      })
    }
    if (paginationMode === 'cursor') {
      const responsePage = cursorState?.page || 1
      const total = cursorState?.total ?? parseTotal(headers.get('content-range'), data.length)
      const hasMore = data.length > pageSize
      const items = data.slice(0, pageSize)
      const nextCursor =
        hasMore && items.length
          ? encodeCursor({
              source,
              column,
              direction,
              tie,
              fingerprint,
              item: items.at(-1),
              page: responsePage + 1,
              total,
            })
          : null
      return pageResponse(items, total, responsePage, pageSize, {
        pagination_mode: 'cursor',
        next_cursor: nextCursor,
        has_more: hasMore,
        total_is_estimate: this.config.paginationCount !== 'exact',
      })
    }
    const total = parseTotal(headers.get('content-range'), data.length)
    return pageResponse(data, total, page, pageSize, {
      pagination_mode: 'offset',
      has_more: page * pageSize < total,
      total_is_estimate: this.config.paginationCount !== 'exact',
    })
  }

  async selectOne(source, recordId, { token, requestId, select = '*', companyId }) {
    this.assertSource(source)
    const params = [
      ['select', select],
      ['id', `eq.${recordId}`],
      ['limit', '1'],
    ]
    for (const filter of this.scopeFilters(source, companyId, [])) params.push([filter.column, filterValue(filter)])
    const data = await this.request('GET', source, {
      token,
      requestId,
      params,
      retrySafe: true,
    })
    if (!Array.isArray(data) || !data.length) throw new ApiError(404, 'Record not found', { code: 'record_not_found' })
    if (!data[0] || typeof data[0] !== 'object')
      throw new ApiError(502, 'Supabase returned an invalid record', {
        code: 'invalid_upstream',
      })
    return data[0]
  }

  async selectAll(source, options) {
    const maximum = options.maxRows ?? 10_000
    const pageSize = Math.min(this.config.maxPageSize, maximum)
    const rows = []
    let cursor = null
    for (;;) {
      const result = await this.selectPage(source, {
        ...options,
        page: 1,
        pageSize,
        paginationMode: 'cursor',
        cursor,
      })
      if (rows.length + result.items.length > maximum)
        throw new ApiError(413, 'Result exceeds the safe row limit', {
          code: 'result_too_large',
        })
      rows.push(...result.items)
      if (!result.has_more) return rows
      if (!result.next_cursor || rows.length >= maximum)
        throw new ApiError(413, 'Result exceeds the safe row limit', {
          code: 'result_too_large',
        })
      cursor = result.next_cursor
    }
  }

  async execute(operation, payload, idempotencyKey, { token, requestId, companyId }) {
    const data = await this.request('POST', 'rpc/erp_execute', {
      token,
      requestId,
      retrySafe: true,
      body: {
        p_operation: operation,
        p_payload: { ...payload, company_id: String(companyId) },
        p_idempotency_key: idempotencyKey,
      },
      extraHeaders: {
        Prefer: 'return=representation',
        'Idempotency-Key': idempotencyKey,
      },
    })
    const value = unwrap(data)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ApiError(502, 'ERP transaction returned an invalid result', {
        code: 'invalid_upstream',
      })
    return value
  }

  async publicCatalog(requestId) {
    const data = await this.serviceRpc('erp_public_catalog', {}, { requestId, retrySafe: true })
    if (!Array.isArray(data))
      throw new ApiError(502, 'Catalogue returned an invalid result', {
        code: 'invalid_upstream',
      })
    return data
  }

  async verifyCatalogCredential(publicId, apiKey, requestId) {
    const secretHash = createHash('sha256').update(apiKey, 'utf8').digest('hex')
    const data = await this.serviceRpc(
      'erp_verify_catalog_api_credential',
      {
        p_public_id: publicId,
        p_secret_hash: secretHash,
      },
      { requestId, retrySafe: true },
    )
    const companyId = unwrap(data)
    if (!isUuid(companyId))
      throw new ApiError(401, 'Invalid catalogue API credentials', {
        code: 'invalid_catalog_api_credentials',
        headers: { 'WWW-Authenticate': 'CatalogKey' },
      })
    return companyId
  }

  async submitPublicOrder(payload, idempotencyKey, requestId) {
    const data = await this.serviceRpc(
      'erp_submit_public_order',
      {
        p_payload: payload,
        p_request_key: idempotencyKey,
      },
      { requestId, retrySafe: true, idempotencyKey },
    )
    const value = unwrap(data)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ApiError(502, 'Order submission returned an invalid result', {
        code: 'invalid_upstream',
      })
    return value
  }

  async serviceRpc(functionName, payload, { requestId, retrySafe, idempotencyKey }) {
    const secret = this.config.secretKey
    if (!secret)
      throw new ApiError(503, 'The public catalogue service is not configured.', {
        code: 'service_access_not_configured',
      })
    const headers = this.serviceHeaders(requestId)
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const response = await this.send('POST', `${this.config.restUrl}/rpc/${functionName}`, {
      headers,
      body: payload,
      retrySafe,
    })
    if (!response.ok) throw await this.mapError(response)
    return response.status === 204
      ? null
      : response.json().catch(() => {
          throw new ApiError(502, 'Supabase returned invalid JSON', {
            code: 'invalid_upstream',
          })
        })
  }

  async createAuthUser({ email, password, displayName, requestId }) {
    const secret = this.config.secretKey
    if (!secret)
      throw new ApiError(
        503,
        'Account creation is not configured on the API server. Add a rotated SUPABASE_SECRET_KEY (sb_secret_...) to the server environment.',
        { code: 'auth_admin_not_configured' },
      )
    const response = await this.send('POST', `${this.config.authUrl}/admin/users`, {
      headers: {
        apikey: secret,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
        'Cache-Control': 'no-store, no-cache',
      },
      body: {
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: displayName },
      },
      retrySafe: false,
    })
    if (!response.ok) throw await this.mapAuthAdminError(response)
    const body = await response.json().catch(() => null)
    if (!isUuid(body?.id))
      throw new ApiError(502, 'Supabase Auth returned an invalid user', {
        code: 'invalid_upstream',
      })
    return body.id
  }

  async deleteAuthUser(userId, requestId) {
    if (!this.config.secretKey) return
    await this.send('DELETE', `${this.config.authUrl}/admin/users/${userId}`, {
      headers: {
        apikey: this.config.secretKey,
        Accept: 'application/json',
        'X-Request-ID': requestId,
        'Cache-Control': 'no-store, no-cache',
      },
      retrySafe: false,
    }).catch(() => undefined)
  }

  async provisionUserAccess({ targetUserId, displayName, companyCodes, roleCodes, isSuperAdmin, token, requestId }) {
    return this.rpcObject(
      'provision_user_access',
      {
        p_target_user_id: targetUserId,
        p_display_name: displayName,
        p_company_codes: companyCodes,
        p_role_codes: roleCodes,
        p_is_super_admin: isSuperAdmin,
      },
      { token, requestId },
      'Access provisioning returned an invalid result',
    )
  }

  async setUserAccountStatus({ targetUserId, isActive, token, requestId, idempotencyKey }) {
    return this.rpcObject(
      'set_user_account_status',
      {
        p_target_user_id: targetUserId,
        p_is_active: isActive,
        p_request_id: requestId,
        p_idempotency_key: idempotencyKey,
      },
      { token, requestId },
      'Account status returned an invalid result',
    )
  }

  async removeUserAccount({ targetUserId, confirmationPin, token, requestId, idempotencyKey }) {
    return this.rpcObject(
      'remove_user_account',
      {
        p_target_user_id: targetUserId,
        p_confirmation_pin: confirmationPin,
        p_request_id: requestId,
        p_idempotency_key: idempotencyKey,
      },
      { token, requestId },
      'Account removal returned an invalid result',
    )
  }

  async dashboard(year, { token, requestId, companyId }) {
    return this.rpcObject(
      'erp_company_dashboard',
      { p_company_id: companyId, p_year: year ?? null },
      { token, requestId, retrySafe: true },
      'Dashboard returned an invalid result',
    )
  }

  async rpcObject(name, body, { token, requestId, retrySafe = false }, message) {
    const value = unwrap(
      await this.request('POST', `rpc/${name}`, {
        token,
        requestId,
        body,
        retrySafe,
      }),
    )
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ApiError(502, message, { code: 'invalid_upstream' })
    return value
  }

  async request(method, path, options) {
    return (await this.requestWithHeaders(method, path, options)).data
  }

  async requestWithHeaders(
    method,
    path,
    { token, requestId, params = [], body, extraHeaders = {}, retrySafe = false },
  ) {
    const url = new URL(`${this.config.restUrl}/${String(path).replace(/^\//, '')}`)
    for (const [key, value] of params) url.searchParams.append(key, String(value))
    const response = await this.send(method, url, {
      headers: { ...this.userHeaders(token, requestId), ...extraHeaders },
      body,
      retrySafe,
    })
    if (!response.ok) throw await this.mapError(response)
    if (response.status === 204) return { data: null, headers: response.headers }
    const data = await response.json().catch(() => {
      throw new ApiError(502, 'Supabase returned invalid JSON', {
        code: 'invalid_upstream',
      })
    })
    return { data, headers: response.headers }
  }

  async send(method, url, { headers = {}, body, retrySafe = false }) {
    const attempts = retrySafe ? this.config.retryAttempts : 1
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs),
          redirect: 'manual',
        })
        if (!RETRYABLE.has(response.status) || attempt + 1 >= attempts) return response
        const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10)
        await response.body?.cancel().catch(() => undefined)
        await sleep(
          Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 2000) : Math.min(150 * 2 ** attempt, 2000),
        )
      } catch (error) {
        lastError = error
        if (attempt + 1 >= attempts) break
        await sleep(Math.min(150 * 2 ** attempt, 2000))
      }
    }
    if (lastError?.name === 'TimeoutError')
      throw new ApiError(503, 'Supabase request timed out', {
        code: 'supabase_timeout',
      })
    throw new ApiError(503, 'Supabase is unavailable', {
      code: 'supabase_unavailable',
    })
  }

  publicHeaders() {
    return {
      apikey: this.config.publishableKey,
      Accept: 'application/json',
      'Accept-Profile': this.config.schema,
      'Cache-Control': 'no-store, no-cache',
    }
  }

  userHeaders(token, requestId) {
    return {
      ...this.publicHeaders(),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Profile': this.config.schema,
      'X-Request-ID': requestId,
    }
  }

  serviceHeaders(requestId) {
    return {
      apikey: this.config.secretKey,
      Authorization: `Bearer ${this.config.secretKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Profile': this.config.schema,
      'Content-Profile': this.config.schema,
      'X-Request-ID': requestId,
      'Cache-Control': 'no-store, no-cache',
    }
  }

  async mapError(response) {
    const body = await response
      .clone()
      .json()
      .catch(() => ({}))
    const pgCode = String(body?.code || '').slice(0, 32)
    const message = String(body?.message || body?.details || '').trim()
    const upstreamDetails = [body?.details, body?.hint]
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && value !== message && values.indexOf(value) === index)
      .slice(0, 2)
      .map((value) => ({
        type: 'database_detail',
        loc: ['database'],
        msg: value.slice(0, 500),
      }))
    let status = response.status
    let code = 'supabase_error'
    let detail = 'The database request was rejected'
    if (/^Unsupported ERP operation:/i.test(message)) {
      status = 503
      code = 'supabase_schema_unavailable'
      detail = `${message}. The database operation dispatcher is out of date; apply all pending migrations.`
    } else if (['PGRST200', 'PGRST202', 'PGRST204', 'PGRST205', '42703', '42P01'].includes(pgCode)) {
      status = 503
      code = 'supabase_schema_unavailable'
      detail =
        'The Supabase ERP schema update is not deployed. Apply all database migrations and reload the Data API schema.'
    } else if (status === 401) {
      code = 'supabase_auth_failed'
      detail = 'The Supabase session was rejected'
    } else if (status === 403 || pgCode === '42501') {
      status = 403
      code = 'insufficient_database_permission'
      detail = 'You do not have permission to perform this database operation'
    } else if (status === 404 || pgCode === 'PGRST116') {
      status = 404
      code = 'record_not_found'
      detail = 'Record not found'
    } else if (status === 409 || ['23503', '23505'].includes(pgCode)) {
      status = 409
      code = 'data_conflict'
      detail = message.slice(0, 500) || 'The operation conflicts with existing data'
    } else if (['22003', '22007', '22023', '22P02', '23502', '23514', 'P0001'].includes(pgCode)) {
      status = 422
      code = 'business_rule_violation'
      detail = message.slice(0, 500) || 'The operation violates a business rule'
    } else if (status === 429) {
      code = 'supabase_rate_limited'
      detail = 'Supabase is temporarily rate limited'
    } else if (status >= 500) {
      status = 502
      code = 'supabase_bad_gateway'
      detail = 'The database is temporarily unavailable'
    }
    const retryAfter = response.headers.get('retry-after')
    return new ApiError(status, detail, {
      code,
      errors: upstreamDetails,
      headers: retryAfter ? { 'Retry-After': retryAfter.slice(0, 100) } : {},
    })
  }

  async mapAuthAdminError(response) {
    const body = await response
      .clone()
      .json()
      .catch(() => ({}))
    const authCode = String(body?.code || body?.error_code || '').slice(0, 64)
    const message = String(body?.message || body?.msg || body?.error_description || '').trim()
    let status = response.status
    let code = 'supabase_auth_admin_error'
    let detail = 'Supabase Auth rejected the new account'
    if (['email_exists', 'user_already_exists'].includes(authCode)) {
      status = 409
      code = 'account_email_exists'
      detail = 'A login account already exists for this email address'
    } else if (authCode === 'email_address_invalid') {
      status = 422
      code = 'invalid_account_email'
      detail = 'Supabase Auth rejected this email address'
    } else if (authCode === 'weak_password') {
      status = 422
      code = 'weak_account_password'
      detail = message.slice(0, 500) || 'The temporary password does not meet the Auth password policy'
    } else if (['validation_failed', 'bad_json'].includes(authCode)) {
      status = 422
      code = 'invalid_account_details'
      detail = message.slice(0, 500) || 'Supabase Auth rejected the account details'
    } else if (authCode === 'over_request_rate_limit' || status === 429) {
      status = 429
      code = 'supabase_auth_rate_limited'
      detail = 'Too many account-creation requests. Wait a few minutes and try again'
    } else if (['not_admin', 'no_authorization', 'bad_jwt'].includes(authCode) || [401, 403].includes(status)) {
      status = 503
      code = 'auth_admin_key_invalid'
      detail = "The API server's Supabase secret key is missing, invalid, or belongs to another project"
    } else if (status >= 500 || authCode === 'unexpected_failure') {
      status = 502
      code = 'supabase_auth_unavailable'
      detail = 'Supabase Auth could not create the account'
    } else if (message) detail = message.slice(0, 500)
    return new ApiError(status, detail, { code })
  }

  stableOrder(source, order) {
    const first = order?.split(',', 1)[0]
    const match = ORDER.exec(first || '')
    if (!match)
      throw new ApiError(500, 'The collection has an invalid order', {
        code: 'invalid_collection_configuration',
      })
    const column = match.groups.column
    const direction = match.groups.direction
    const tie = TIEBREAKERS[source]
    return {
      stable: tie === column ? first : `${first},${tie}.${direction}`,
      column,
      direction,
      tie,
    }
  }

  scopeFilters(source, companyId, filters) {
    const scoped = [...filters]
    if (!COMPANY_SCOPED.has(source)) return scoped
    if (!companyId)
      throw new ApiError(500, 'A company context is required for this data source', { code: 'company_context_missing' })
    const expected = String(companyId)
    const supplied = scoped.filter((item) => item.column === 'company_id')
    if (supplied.some((item) => item.operator !== 'eq' || String(item.value) !== expected)) {
      throw new ApiError(403, 'A data query cannot override the selected company', { code: 'company_scope_mismatch' })
    }
    if (!supplied.length) scoped.push({ column: 'company_id', operator: 'eq', value: expected })
    return scoped
  }

  assertSource(source) {
    if (!READABLE_SOURCES.has(source)) throw new Error(`Unapproved PostgREST source: ${source}`)
  }
}

export function pageResponse(items, total, page, pageSize, extra = {}) {
  return {
    items,
    total,
    page,
    page_size: pageSize,
    pages: total ? Math.ceil(total / pageSize) : 0,
    pagination_mode: 'offset',
    next_cursor: null,
    has_more: false,
    total_is_estimate: false,
    ...extra,
  }
}

function unauthorized(detail = 'Invalid or expired access token') {
  return new ApiError(401, detail, {
    code: 'invalid_access_token',
    headers: { 'WWW-Authenticate': 'Bearer' },
  })
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function parseTotal(contentRange, fallback) {
  const value = contentRange?.split('/').at(-1)
  return /^\d+$/.test(value || '') ? Number(value) : fallback
}

function filterValue(filter) {
  if (filter.operator === 'in') return `in.(${filter.value})`
  return `${filter.operator}.${typeof filter.value === 'boolean' ? String(filter.value).toLowerCase() : filter.value}`
}

function queryFingerprint(filters, select) {
  const ordered = [...filters].sort((a, b) =>
    `${a.column}:${a.operator}:${a.value}`.localeCompare(`${b.column}:${b.operator}:${b.value}`),
  )
  return createHash('sha256')
    .update(
      JSON.stringify({
        select,
        filters: ordered.map((item) => [item.column, item.operator, item.value]),
      }),
    )
    .digest('hex')
    .slice(0, 24)
}

function encodeCursor({ source, column, direction, tie, fingerprint, item, page, total }) {
  const position = item[column]
  const tieValue = item[tie]
  if (!cursorScalar(position) || !cursorScalar(tieValue))
    throw new ApiError(502, 'Supabase omitted a pagination key', {
      code: 'invalid_upstream',
    })
  return Buffer.from(
    JSON.stringify({
      v: 1,
      s: source,
      o: column,
      d: direction,
      k: tie,
      f: fingerprint,
      p: page,
      t: total,
      x: position,
      y: tieValue,
    }),
  ).toString('base64url')
}

function decodeCursor(cursor, expected) {
  let value
  try {
    if (cursor.length > 4096) throw new Error('large')
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new ApiError(422, 'Cursor is invalid or expired', {
      code: 'invalid_cursor',
    })
  }
  if (
    !value ||
    value.v !== 1 ||
    value.s !== expected.source ||
    value.o !== expected.column ||
    value.d !== expected.direction ||
    value.k !== expected.tie ||
    value.f !== expected.fingerprint ||
    !cursorScalar(value.x) ||
    !cursorScalar(value.y) ||
    !Number.isInteger(value.p) ||
    value.p < 2 ||
    !Number.isInteger(value.t) ||
    value.t < 0
  ) {
    throw new ApiError(422, 'Cursor does not match this query', {
      code: 'invalid_cursor',
    })
  }
  return {
    position: value.x,
    tieValue: value.y,
    page: value.p,
    total: value.t,
  }
}

function cursorPredicate(column, direction, tie, state) {
  const operator = direction === 'desc' ? 'lt' : 'gt'
  const position = logicLiteral(state.position)
  if (tie === column) return `(${column}.${operator}.${position})`
  return `(${column}.${operator}.${position},and(${column}.eq.${position},${tie}.${operator}.${logicLiteral(state.tieValue)}))`
}

function cursorScalar(value) {
  return typeof value === 'boolean' || Number.isFinite(value) || (typeof value === 'string' && value.length <= 1024)
}

function logicLiteral(value) {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export { isUuid }
