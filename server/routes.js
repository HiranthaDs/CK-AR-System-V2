import { createHash, createHmac } from 'node:crypto'
import { ApiError } from './errors.js'
import { isUuid } from './gateway.js'
import { parse, schemas } from './validation.js'

const PAYROLL_SELECT =
  '*,payroll_details(*),payroll_payments(*),employee:employees!payrolls_employee_id_fkey(id,employee_no,name,nic,phone,address,epf_no,etf_ref,joined_date,job_role,employment_type,shift,pay_model,monthly_rate,daily_rate,ot_rate,monthly_incentive,bank_details,status)'
const SALE_SELECT =
  '*,sale_items(*,item:inventory_items!sale_items_item_id_fkey(id,name,sku,unit,product_type)),sale_payments(*)'
const SALE_LEGACY_SELECT =
  '*,sale_items(*,item:inventory_items!sale_items_item_id_fkey(id,name,sku,unit)),sale_payments(*)'
const PRODUCTION_SELECT =
  '*,chip_item:inventory_items!production_runs_chip_item_id_fkey(name,sku),finished_item:inventory_items!production_runs_finished_item_id_fkey(name,sku,selling_price,product_type),operator:employees!production_runs_operator_employee_id_fkey(name,employee_no)'
const PRODUCTION_LEGACY_SELECT =
  '*,chip_item:inventory_items!production_runs_chip_item_id_fkey(name,sku),finished_item:inventory_items!production_runs_finished_item_id_fkey(name,sku,selling_price),operator:employees!production_runs_operator_employee_id_fkey(name,employee_no)'
const QUOTATION_SELECT =
  '*,quotation_items(*,item:inventory_items!quotation_items_item_id_fkey(id,name,sku,unit,product_type,selling_price))'
const CUSTOMER_ORDER_SELECT = '*,customer_order_items(*)'
const PIECEWORK_SELECT =
  '*,conversion_type:conversion_types!piecework_rates_conversion_type_id_fkey(id,name,default_chip_name,status)'
const CONVERSION_SELECT =
  '*,conversion_workers(*),conversion_type:conversion_types(id,name,default_chip_name,status),source_item:inventory_items!conversions_source_item_id_fkey(name,sku),output_item:inventory_items!conversions_output_item_id_fkey(name,sku)'
const CONVERSION_LEGACY_SELECT =
  '*,conversion_workers(*),source_item:inventory_items!conversions_source_item_id_fkey(name,sku),output_item:inventory_items!conversions_output_item_id_fkey(name,sku)'
const RM_PURCHASE_SELECT =
  '*,purchase_items:raw_material_purchases!raw_material_purchases_consignment_id_fkey(*,inventory_items(name,sku))'

const routes = []

function add(method, path, options, handler) {
  routes.push({ method, path, ...compile(path), ...options, handler })
}

function compile(path) {
  const names = []
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1))
        return '([^/]+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
  return {
    regex: new RegExp(`^/${parts.join('/')}/?$`),
    names,
    score: parts.filter((part) => !part.includes('(')).length,
  }
}

function f(column, operator, value) {
  return { column, operator, value }
}

function requireUuid(value, name = 'id') {
  if (!isUuid(value))
    throw new ApiError(422, `${name} must be a valid UUID`, {
      code: 'request_validation_failed',
    })
  return value
}

function numberQuery(query, key, { minimum, maximum, optional = true } = {}) {
  const raw = query.get(key)
  if (raw == null || raw === '') {
    if (optional) return null
    throw new ApiError(422, `${key} is required`, {
      code: 'request_validation_failed',
    })
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new ApiError(422, `${key} is invalid`, {
      code: 'request_validation_failed',
    })
  return value
}

function booleanQuery(query, key, fallback) {
  const raw = query.get(key)
  if (raw == null) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new ApiError(422, `${key} must be true or false`, {
    code: 'request_validation_failed',
  })
}

function pagination(query, config) {
  const page = numberQuery(query, 'page', { minimum: 1, maximum: 1_000_000_000 }) ?? 1
  const pageSize =
    numberQuery(query, 'page_size', {
      minimum: 1,
      maximum: config.maxPageSize,
    }) ?? config.defaultPageSize
  const mode = query.get('pagination_mode') || 'offset'
  const cursor = query.get('cursor') || null
  if (!['offset', 'cursor'].includes(mode))
    throw new ApiError(422, 'pagination_mode must be offset or cursor', {
      code: 'invalid_pagination',
    })
  if (cursor && mode !== 'cursor')
    throw new ApiError(422, 'cursor requires pagination_mode=cursor', {
      code: 'invalid_pagination',
    })
  if (mode === 'cursor' && page !== 1)
    throw new ApiError(422, 'page cannot be combined with cursor pagination', {
      code: 'invalid_pagination',
    })
  return { page, pageSize, paginationMode: mode, cursor }
}

function collection(query) {
  const q = query.get('q')?.trim() || null
  const status = query.get('status')?.trim() || null
  const fromDate = query.get('from_date') || null
  const toDate = query.get('to_date') || null
  const sort = query.get('sort') || null
  if (q && q.length > 100)
    throw new ApiError(422, 'q is too long', {
      code: 'request_validation_failed',
    })
  if (status && !/^[a-z_]+$/.test(status))
    throw new ApiError(422, 'status is invalid', {
      code: 'request_validation_failed',
    })
  if (fromDate && !validDate(fromDate))
    throw new ApiError(422, 'from_date is invalid', {
      code: 'request_validation_failed',
    })
  if (toDate && !validDate(toDate))
    throw new ApiError(422, 'to_date is invalid', {
      code: 'request_validation_failed',
    })
  if (fromDate && toDate && fromDate > toDate)
    throw new ApiError(422, 'from_date cannot be later than to_date', {
      code: 'invalid_date_range',
    })
  if (sort && !/^[a-z_][a-z0-9_]*$/.test(sort))
    throw new ApiError(422, 'sort is invalid', {
      code: 'request_validation_failed',
    })
  return {
    q,
    status,
    fromDate,
    toDate,
    sort,
    descending: booleanQuery(query, 'descending', true),
  }
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

function plusDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function filters(values, { dateColumn, searchColumn, includeStatus = true, dateIsTimestamp = false, extra = [] }) {
  const result = [...extra]
  if (includeStatus && values.status) result.push(f('status', 'eq', values.status))
  if (values.q && searchColumn) {
    const term = values.q.replace(/[*%]/g, '')
    if (term) result.push(f(searchColumn, 'ilike', `*${term}*`))
  }
  if (dateColumn && values.fromDate) result.push(f(dateColumn, 'gte', values.fromDate))
  if (dateColumn && values.toDate)
    result.push(
      f(dateColumn, dateIsTimestamp ? 'lt' : 'lte', dateIsTimestamp ? plusDays(values.toDate, 1) : values.toDate),
    )
  return result
}

function order(values, allowed, fallback) {
  const column = values.sort || fallback
  if (!allowed.includes(column))
    throw new ApiError(422, `sort must be one of: ${[...allowed].sort().join(', ')}`, { code: 'invalid_sort' })
  return `${column}.${values.descending ? 'desc' : 'asc'}`
}

function idempotency(ctx) {
  const value = String(ctx.headers['idempotency-key'] || '')
  if (!value)
    throw new ApiError(400, 'Idempotency-Key header is required for every mutation', {
      code: 'idempotency_key_required',
    })
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value))
    throw new ApiError(422, 'Idempotency-Key is invalid', {
      code: 'request_validation_failed',
    })
  return value
}

function body(ctx, schema) {
  return parse(schema, ctx.body)
}

function uuidFromDigest(digest) {
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function catalogCredential(ctx, requestKey) {
  if (!ctx.config.secretKey) {
    throw new ApiError(503, 'Catalogue API key generation is not configured on the server.', {
      code: 'service_access_not_configured',
    })
  }
  const seed = `${ctx.principal.companyId}:${requestKey}`
  const keyBytes = createHmac('sha256', ctx.config.secretKey).update(`catalog-key:${seed}`).digest()
  const idBytes = createHmac('sha256', ctx.config.secretKey).update(`catalog-id:${seed}`).digest()
  const apiKey = `ckcat_${keyBytes.toString('base64url')}`
  return {
    apiId: uuidFromDigest(idBytes),
    apiKey,
    secretHash: createHash('sha256').update(apiKey, 'utf8').digest('hex'),
    keyPrefix: `${apiKey.slice(0, 14)}...`,
  }
}

function catalogPayload(items, catalogId) {
  return {
    api_version: '1.0',
    catalog_id: catalogId,
    generated_at: new Date().toISOString(),
    items,
  }
}

function reversePayload(id, value) {
  const result = { id }
  if (value.reason) result.reason = value.reason
  return result
}

function normalize(source, row) {
  if (!row || typeof row !== 'object') return row
  const item = { ...row }
  if (source === 'raw_material_purchases' && !item.material_name) item.material_name = item.inventory_items?.name
  if (source === 'conversions') {
    if (!item.source_item_name) item.source_item_name = item.source_item?.name
    if (!item.output_item_name) item.output_item_name = item.output_item?.name
  }
  if (source === 'production_runs') {
    if (!item.chip_name) item.chip_name = item.chip_item?.name
    if (!item.finished_item_name) item.finished_item_name = item.finished_item?.name
    if (!item.operator_name) item.operator_name = item.operator?.name
  }
  return item
}

async function listHandler(ctx, spec) {
  const page = pagination(ctx.query, ctx.config)
  const values = collection(ctx.query)
  const source = typeof spec.source === 'function' ? spec.source(ctx) : spec.source
  const extras = spec.extra ? spec.extra(ctx) : []
  const options = {
    token: ctx.principal.token,
    requestId: ctx.requestId,
    companyId: ctx.principal.companyId,
    ...page,
    select: spec.select || '*',
    order: order(values, spec.allowed, spec.defaultOrder),
    filters: filters(values, {
      dateColumn: spec.dateColumn,
      searchColumn: spec.searchColumn,
      includeStatus: spec.includeStatus !== false,
      dateIsTimestamp: spec.dateIsTimestamp,
      extra: extras,
    }),
  }
  let response
  try {
    response = await ctx.gateway.selectPage(source, options)
  } catch (error) {
    const canFallback =
      error.code === 'supabase_schema_unavailable' &&
      spec.fallbackSelect &&
      (!spec.fallbackWhen || spec.fallbackWhen(ctx))
    if (!canFallback) throw error
    response = await ctx.gateway.selectPage(source, {
      ...options,
      select: spec.fallbackSelect,
    })
  }
  return {
    body: {
      ...response,
      items: response.items.map((item) => normalize(source, item)),
    },
  }
}

async function detailHandler(ctx, spec) {
  const id = requireUuid(ctx.params[spec.param], spec.param)
  const options = {
    token: ctx.principal.token,
    requestId: ctx.requestId,
    companyId: ctx.principal.companyId,
    select: spec.select || '*',
  }
  let record
  try {
    record = await ctx.gateway.selectOne(spec.source, id, options)
  } catch (error) {
    if (error.code !== 'supabase_schema_unavailable' || !spec.fallbackSelect) throw error
    record = await ctx.gateway.selectOne(spec.source, id, {
      ...options,
      select: spec.fallbackSelect,
    })
  }
  return { body: normalize(spec.source, record) }
}

async function execute(ctx, operation, payload) {
  return ctx.gateway.execute(operation, payload, idempotency(ctx), {
    token: ctx.principal.token,
    requestId: ctx.requestId,
    companyId: ctx.principal.companyId,
  })
}

// Public health and ordering routes are registered before dynamic routes.
add('GET', '/health/live', { public: true }, async (ctx) => ({
  body: {
    status: 'ok',
    service: ctx.config.appName,
    version: ctx.config.appVersion,
    environment: ctx.config.appEnv,
  },
}))

add('GET', '/health/ready', { public: true }, async (ctx) => {
  await Promise.all([ctx.gateway.authHealth(), ctx.gateway.schemaHealth(), ctx.gateway.jwksHealth()])
  return {
    body: {
      status: 'ready',
      service: ctx.config.appName,
      version: ctx.config.appVersion,
      environment: ctx.config.appEnv,
      checks: {
        supabase_auth: 'ok',
        supabase_jwks: 'ok',
        supabase_schema: 'ok',
      },
    },
  }
})

add('GET', '/public/catalog', { public: true }, async (ctx) => ({
  body: catalogPayload(await ctx.gateway.publicCatalog(ctx.requestId), 'public'),
}))
add('POST', '/public/orders', { public: true }, async (ctx) => {
  const payload = body(ctx, schemas.publicOrder)
  delete payload.website
  return {
    status: 201,
    body: await ctx.gateway.submitPublicOrder(payload, idempotency(ctx), ctx.requestId),
  }
})

add('GET', '/integrations/catalog/products', { public: true }, async (ctx) => {
  const apiId = String(ctx.headers['x-catalog-api-id'] || '')
  const apiKey = String(ctx.headers['x-catalog-api-key'] || '')
  if (!isUuid(apiId) || !/^ckcat_[A-Za-z0-9_-]{43}$/.test(apiKey)) {
    throw new ApiError(401, 'Invalid catalogue API credentials', {
      code: 'invalid_catalog_api_credentials',
      headers: { 'WWW-Authenticate': 'CatalogKey' },
    })
  }
  await ctx.gateway.verifyCatalogCredential(apiId, apiKey, ctx.requestId)
  return {
    body: catalogPayload(await ctx.gateway.publicCatalog(ctx.requestId), apiId),
  }
})

add('GET', '/me', {}, async (ctx) => ({ body: ctx.principal.profile }))
add(
  'GET',
  '/company-profile',
  {
    permissions: ['dashboard.read', 'inventory.read', 'production.read', 'sales.read'],
    anyPermission: true,
  },
  async (ctx) => ({
    body: await ctx.gateway.selectOne('companies', ctx.principal.companyId, {
      token: ctx.principal.token,
      requestId: ctx.requestId,
      select: 'id,code,name,address,phone,email,logo_url,is_active,updated_at',
    }),
  }),
)
add('GET', '/catalog-api-credential', { permissions: ['system.admin'] }, async (ctx) => {
  const response = await ctx.gateway.selectPage('catalog_api_credentials', {
    token: ctx.principal.token,
    requestId: ctx.requestId,
    companyId: ctx.principal.companyId,
    page: 1,
    pageSize: 1,
    select: 'id,public_id,key_prefix,status,last_used_at,created_at,updated_at,rotated_at',
    order: 'rotated_at.desc',
    filters: [],
  })
  return {
    body: {
      credential: response.items[0] || null,
      endpoint: '/api/v1/integrations/catalog/products',
    },
  }
})
add('POST', '/catalog-api-credential/rotate', { permissions: ['system.admin'] }, async (ctx) => {
  const requestKey = idempotency(ctx)
  const credential = catalogCredential(ctx, requestKey)
  const result = await ctx.gateway.execute(
    'catalog_api_credential.rotate',
    {
      public_id: credential.apiId,
      secret_hash: credential.secretHash,
      key_prefix: credential.keyPrefix,
    },
    requestKey,
    {
      token: ctx.principal.token,
      requestId: ctx.requestId,
      companyId: ctx.principal.companyId,
    },
  )
  return {
    status: 201,
    body: { ...result, api_id: credential.apiId, api_key: credential.apiKey },
  }
})
add('DELETE', '/catalog-api-credential', { permissions: ['system.admin'] }, async (ctx) => ({
  body: await execute(ctx, 'catalog_api_credential.revoke', {}),
}))
add('GET', '/dashboard', { permissions: ['dashboard.read'] }, async (ctx) => {
  const year = numberQuery(ctx.query, 'year', { minimum: 2000, maximum: 2200 })
  return {
    body: await ctx.gateway.dashboard(year, {
      token: ctx.principal.token,
      requestId: ctx.requestId,
      companyId: ctx.principal.companyId,
    }),
  }
})
add('GET', '/reports/financial-summary', { permissions: ['reports.read'] }, async (ctx) => {
  const year = numberQuery(ctx.query, 'year', {
    minimum: 2000,
    maximum: 2200,
  })
  return {
    body: await ctx.gateway.dashboard(year, {
      token: ctx.principal.token,
      requestId: ctx.requestId,
      companyId: ctx.principal.companyId,
    }),
  }
})

add('GET', '/inventory/summary', { permissions: ['inventory.read'] }, async (ctx) => {
  const rows = await ctx.gateway.selectAll('company_inventory_stage_summary', {
    token: ctx.principal.token,
    requestId: ctx.requestId,
    order: 'stage.asc',
    maxRows: 3,
    companyId: ctx.principal.companyId,
  })
  const empty = {
    item_count: 0,
    total_quantity: 0,
    shared_total_quantity: 0,
    total_value: 0,
  }
  const byStage = Object.fromEntries(
    rows.filter((row) => ['bulk', 'chip', 'finished'].includes(row.stage)).map((row) => [row.stage, row]),
  )
  const bulk = { ...empty, ...byStage.bulk }
  const chips = { ...empty, ...byStage.chip }
  const finished = { ...empty, ...byStage.finished }
  return {
    body: {
      bulk,
      chips,
      finished,
      total_quantity: num(bulk.total_quantity) + num(chips.total_quantity) + num(finished.total_quantity),
      shared_total_quantity:
        num(bulk.shared_total_quantity) + num(chips.shared_total_quantity) + num(finished.shared_total_quantity),
      total_value: num(bulk.total_value) + num(chips.total_value) + num(finished.total_value),
    },
  }
})

add('GET', '/production/summary', { permissions: ['production.read'] }, async (ctx) => {
  const anchor = ctx.query.get('as_of') || new Date().toISOString().slice(0, 10)
  if (!validDate(anchor))
    throw new ApiError(422, 'as_of is invalid', {
      code: 'request_validation_failed',
    })
  const monthStart = `${anchor.slice(0, 7)}-01`
  const recentStart = plusDays(anchor, -6)
  const rangeStart = monthStart < recentStart ? monthStart : recentStart
  const common = {
    token: ctx.principal.token,
    requestId: ctx.requestId,
    companyId: ctx.principal.companyId,
  }
  const [daily, inventory] = await Promise.all([
    ctx.gateway.selectAll('production_daily_summary', {
      ...common,
      order: 'production_date.asc',
      filters: [f('production_date', 'gte', rangeStart), f('production_date', 'lte', anchor)],
      maxRows: 38,
    }),
    ctx.gateway.selectAll('company_inventory_stage_summary', {
      ...common,
      order: 'stage.asc',
      maxRows: 3,
    }),
  ])
  const today = daily.find((row) => row.production_date === anchor)
  const monthRows = daily.filter((row) => row.production_date >= monthStart)
  const stages = Object.fromEntries(inventory.map((row) => [row.stage, row]))
  return {
    body: {
      as_of: anchor,
      month: anchor.slice(0, 7),
      today_runs: num(today?.run_count),
      today_input_kg: num(today?.input_kg),
      today_output_quantity: num(today?.output_quantity),
      month_runs: sum(monthRows, 'run_count'),
      month_input_kg: sum(monthRows, 'input_kg'),
      month_output_quantity: sum(monthRows, 'output_quantity'),
      bulk_item_count: num(stages.bulk?.item_count),
      chip_item_count: num(stages.chip?.item_count),
      bulk_value: num(stages.bulk?.total_value),
      chip_value: num(stages.chip?.total_value),
      recent_daily: daily.filter((row) => row.production_date >= recentStart),
    },
  }
})

const listSpecs = [
  [
    'GET',
    '/employees',
    ['employees.read'],
    {
      source: 'employees',
      allowed: ['employee_no', 'name', 'joined_date', 'created_at'],
      defaultOrder: 'name',
      dateColumn: 'joined_date',
      searchColumn: 'name',
    },
  ],
  [
    'GET',
    '/employees/:employee_id/compensation-history',
    ['payroll.read'],
    {
      source: 'employee_compensation_history',
      allowed: ['effective_from', 'changed_at'],
      defaultOrder: 'effective_from',
      dateColumn: 'effective_from',
      searchColumn: null,
      includeStatus: false,
      extra: (ctx) => [f('employee_id', 'eq', requireUuid(ctx.params.employee_id, 'employee_id'))],
    },
  ],
  [
    'GET',
    '/conversion-types',
    ['inventory.read', 'production.read', 'employees.read'],
    {
      any: true,
      source: 'conversion_types',
      allowed: ['name', 'created_at'],
      defaultOrder: 'name',
      dateColumn: null,
      searchColumn: 'name',
    },
  ],
  [
    'GET',
    '/piecework-rates',
    ['employees.read', 'inventory.read', 'production.read'],
    {
      any: true,
      source: 'piecework_rates',
      select: PIECEWORK_SELECT,
      fallbackSelect: '*',
      fallbackWhen: (ctx) => !ctx.query.get('conversion_type_id'),
      allowed: ['work_type', 'effective_from', 'created_at'],
      defaultOrder: 'effective_from',
      dateColumn: 'effective_from',
      searchColumn: 'work_type',
      extra: (ctx) =>
        ctx.query.get('conversion_type_id')
          ? [f('conversion_type_id', 'eq', requireUuid(ctx.query.get('conversion_type_id'), 'conversion_type_id'))]
          : [],
    },
  ],
  [
    'GET',
    '/bulk-rm-rates',
    ['inventory.read', 'production.read'],
    {
      any: true,
      source: 'bulk_rm_rates',
      allowed: ['material_type', 'effective_from', 'created_at'],
      defaultOrder: 'effective_from',
      dateColumn: 'effective_from',
      searchColumn: 'material_type',
    },
  ],
  [
    'GET',
    '/daily-work',
    ['employees.read'],
    {
      source: 'daily_target_work_view',
      allowed: ['work_date', 'created_at'],
      defaultOrder: 'work_date',
      dateColumn: 'work_date',
      searchColumn: null,
      extra: employeeExtra,
    },
  ],
  [
    'GET',
    '/overtime',
    ['employees.read', 'payroll.read', 'reports.read'],
    {
      any: true,
      source: 'overtime_work_view',
      allowed: ['work_date', 'employee_name', 'amount', 'created_at'],
      defaultOrder: 'work_date',
      dateColumn: 'work_date',
      searchColumn: 'employee_name',
      extra: employeeExtra,
    },
  ],
  [
    'GET',
    '/salary-advances',
    ['employees.read', 'payroll.read'],
    {
      any: true,
      source: 'employee_salary_advance_view',
      allowed: ['advance_date', 'employee_name', 'amount', 'created_at'],
      defaultOrder: 'advance_date',
      dateColumn: 'advance_date',
      searchColumn: 'employee_name',
      extra: employeeExtra,
    },
  ],
  [
    'GET',
    '/shift-settings',
    ['employees.read', 'payroll.read'],
    {
      any: true,
      source: 'company_shift_settings',
      allowed: ['updated_at'],
      defaultOrder: 'updated_at',
      dateColumn: null,
      searchColumn: null,
      includeStatus: false,
    },
  ],
  [
    'GET',
    '/open-earnings',
    ['payroll.read'],
    {
      source: 'employee_open_earnings',
      allowed: ['work_date', 'employee_name', 'amount'],
      defaultOrder: 'work_date',
      dateColumn: 'work_date',
      searchColumn: 'employee_name',
      includeStatus: false,
      extra: (ctx) => [
        ...employeeExtra(ctx),
        ...(ctx.query.get('source_type')
          ? [f('source_type', 'eq', safePattern(ctx.query.get('source_type'), /^[a-z_]+$/, 'source_type'))]
          : []),
      ],
    },
  ],
  ['GET', '/inventory/bulk', ['inventory.read'], inventoryStageSpec('bulk')],
  ['GET', '/inventory/chips', ['inventory.read'], inventoryStageSpec('chip')],
  ['GET', '/inventory/finished', ['inventory.read', 'sales.read'], { ...inventoryStageSpec('finished'), any: true }],
  [
    'GET',
    '/inventory/position',
    ['inventory.read'],
    {
      source: 'company_inventory_position',
      allowed: ['item_name', 'stage', 'quantity_on_hand', 'inventory_value'],
      defaultOrder: 'item_name',
      dateColumn: null,
      searchColumn: 'item_name',
      includeStatus: false,
      extra: stageExtra,
    },
  ],
  [
    'GET',
    '/inventory/items',
    ['inventory.read'],
    {
      source: 'inventory_items',
      allowed: ['name', 'sku', 'stage', 'created_at'],
      defaultOrder: 'name',
      dateColumn: null,
      searchColumn: 'name',
      includeStatus: false,
      extra: stageExtra,
    },
  ],
  [
    'GET',
    '/products',
    ['production.read', 'inventory.read', 'sales.read'],
    {
      any: true,
      source: 'inventory_items',
      allowed: ['name', 'product_type', 'selling_price', 'created_at'],
      defaultOrder: 'name',
      dateColumn: null,
      searchColumn: 'name',
      includeStatus: false,
      extra: (ctx) => [
        f('stage', 'eq', 'finished'),
        ...(booleanQuery(ctx.query, 'active_only', false) ? [f('is_active', 'eq', true)] : []),
      ],
    },
  ],
  [
    'GET',
    '/rm-purchases',
    ['inventory.read'],
    {
      source: 'raw_material_purchase_consignments',
      select: RM_PURCHASE_SELECT,
      allowed: ['purchase_date', 'invoice_no', 'reference_no', 'created_at'],
      defaultOrder: 'purchase_date',
      dateColumn: 'purchase_date',
      searchColumn: 'invoice_no',
    },
  ],
  [
    'GET',
    '/conversions',
    ['inventory.read'],
    {
      source: 'conversions',
      select: CONVERSION_SELECT,
      fallbackSelect: CONVERSION_LEGACY_SELECT,
      allowed: ['conversion_date', 'reference_no', 'created_at'],
      defaultOrder: 'conversion_date',
      dateColumn: 'conversion_date',
      searchColumn: 'reference_no',
    },
  ],
  [
    'GET',
    '/production',
    ['production.read'],
    {
      source: 'production_runs',
      select: PRODUCTION_SELECT,
      fallbackSelect: PRODUCTION_LEGACY_SELECT,
      allowed: ['production_date', 'reference_no', 'created_at'],
      defaultOrder: 'production_date',
      dateColumn: 'production_date',
      searchColumn: 'reference_no',
    },
  ],
  [
    'GET',
    '/customer-orders',
    ['sales.read'],
    {
      source: 'customer_orders',
      select: CUSTOMER_ORDER_SELECT,
      allowed: ['created_at', 'order_no', 'customer_name', 'total_amount', 'status'],
      defaultOrder: 'created_at',
      dateColumn: 'created_at',
      dateIsTimestamp: true,
      searchColumn: 'customer_name',
    },
  ],
  [
    'GET',
    '/quotations',
    ['sales.read'],
    {
      source: 'quotations',
      select: QUOTATION_SELECT,
      allowed: ['quotation_date', 'quotation_no', 'valid_until', 'total_amount', 'created_at'],
      defaultOrder: 'quotation_date',
      dateColumn: 'quotation_date',
      searchColumn: 'quotation_no',
    },
  ],
  [
    'GET',
    '/sales-outstanding',
    ['sales.read'],
    {
      source: 'sales_outstanding',
      allowed: ['sale_date', 'invoice_no', 'balance_due'],
      defaultOrder: 'sale_date',
      dateColumn: 'sale_date',
      searchColumn: 'invoice_no',
      includeStatus: false,
    },
  ],
  [
    'GET',
    '/sales',
    ['sales.read'],
    {
      source: 'sales',
      select: SALE_SELECT,
      fallbackSelect: SALE_LEGACY_SELECT,
      allowed: ['sale_date', 'invoice_no', 'reference_no', 'created_at'],
      defaultOrder: 'sale_date',
      dateColumn: 'sale_date',
      searchColumn: 'invoice_no',
    },
  ],
  [
    'GET',
    '/sales/:sale_id/payments',
    ['sales.read'],
    {
      source: 'sale_payments',
      allowed: ['payment_date', 'reference_no', 'created_at'],
      defaultOrder: 'payment_date',
      dateColumn: 'payment_date',
      searchColumn: 'reference_no',
      extra: (ctx) => [f('sale_id', 'eq', requireUuid(ctx.params.sale_id, 'sale_id'))],
    },
  ],
  [
    'GET',
    '/payroll-outstanding',
    ['payroll.read'],
    {
      source: 'payroll_outstanding',
      allowed: ['payroll_date', 'salary_month', 'balance_due'],
      defaultOrder: 'payroll_date',
      dateColumn: 'payroll_date',
      searchColumn: 'reference_no',
      includeStatus: false,
    },
  ],
  [
    'GET',
    '/payroll',
    ['payroll.read'],
    {
      source: 'payrolls',
      select: PAYROLL_SELECT,
      allowed: ['payroll_date', 'salary_month', 'reference_no', 'created_at'],
      defaultOrder: 'payroll_date',
      dateColumn: 'payroll_date',
      searchColumn: 'reference_no',
      extra: employeeExtra,
    },
  ],
  [
    'GET',
    '/payroll/:payroll_id/payments',
    ['payroll.read'],
    {
      source: 'payroll_payments',
      allowed: ['payment_date', 'reference_no', 'created_at'],
      defaultOrder: 'payment_date',
      dateColumn: 'payment_date',
      searchColumn: 'reference_no',
      extra: (ctx) => [f('payroll_id', 'eq', requireUuid(ctx.params.payroll_id, 'payroll_id'))],
    },
  ],
  [
    'GET',
    '/adjustments',
    ['inventory.read'],
    {
      source: 'stock_adjustments',
      allowed: ['adjustment_date', 'reference_no', 'created_at'],
      defaultOrder: 'adjustment_date',
      dateColumn: 'adjustment_date',
      searchColumn: 'reference_no',
    },
  ],
  [
    'GET',
    '/journals',
    ['finance.read'],
    {
      source: 'journal_entries',
      select: '*,journal_lines(*)',
      allowed: ['journal_date', 'reference_no', 'created_at'],
      defaultOrder: 'journal_date',
      dateColumn: 'journal_date',
      searchColumn: 'reference_no',
    },
  ],
  [
    'GET',
    '/reports/inventory',
    ['reports.read'],
    {
      source: 'company_inventory_position',
      allowed: ['item_name', 'stage', 'quantity_on_hand', 'inventory_value'],
      defaultOrder: 'item_name',
      dateColumn: null,
      searchColumn: 'item_name',
      includeStatus: false,
      extra: stageExtra,
    },
  ],
  [
    'GET',
    '/reports/sales',
    ['reports.read'],
    {
      source: 'sales',
      select: SALE_SELECT,
      fallbackSelect: SALE_LEGACY_SELECT,
      allowed: ['sale_date', 'invoice_no', 'total_amount'],
      defaultOrder: 'sale_date',
      dateColumn: 'sale_date',
      searchColumn: 'invoice_no',
    },
  ],
  [
    'GET',
    '/reports/payroll',
    ['reports.read'],
    {
      source: 'payrolls',
      select: PAYROLL_SELECT,
      allowed: ['payroll_date', 'salary_month', 'net_pay'],
      defaultOrder: 'payroll_date',
      dateColumn: 'payroll_date',
      searchColumn: 'reference_no',
      extra: (ctx) =>
        ctx.query.get('salary_month')
          ? [
              f(
                'salary_month',
                'eq',
                safePattern(ctx.query.get('salary_month'), /^\d{4}-(0[1-9]|1[0-2])$/, 'salary_month'),
              ),
            ]
          : [],
    },
  ],
  [
    'GET',
    '/reports/ledger',
    ['reports.read'],
    {
      source: 'journal_lines',
      select: '*,journal_entries(*),accounts(*)',
      allowed: ['created_at', 'line_no', 'debit', 'credit'],
      defaultOrder: 'created_at',
      dateColumn: null,
      searchColumn: 'description',
      includeStatus: false,
    },
  ],
]

for (const [method, path, permissions, spec] of listSpecs) {
  add(method, path, { permissions, anyPermission: spec.any }, (ctx) => listHandler(ctx, spec))
}

add('GET', '/ledger', { permissions: ['finance.read'] }, (ctx) =>
  listHandler(ctx, {
    source: 'ledger_view',
    allowed: ['entry_date', 'created_at', 'line_no', 'debit', 'credit'],
    defaultOrder: 'entry_date',
    dateColumn: 'entry_date',
    searchColumn: 'search_text',
    includeStatus: false,
    extra: ledgerExtra,
  }),
)

add('GET', '/account-balances', { permissions: ['finance.read'] }, (ctx) =>
  listHandler(ctx, {
    source: () => (ctx.query.get('year') ? 'account_balances_by_year' : 'account_balances'),
    allowed: ['account_code', 'account_name', 'category', 'balance'],
    defaultOrder: 'account_code',
    dateColumn: null,
    searchColumn: 'account_name',
    includeStatus: false,
    extra: (inner) =>
      inner.query.get('year')
        ? [
            f(
              'fiscal_year',
              'eq',
              numberQuery(inner.query, 'year', {
                minimum: 2000,
                maximum: 2200,
              }),
            ),
          ]
        : [],
  }),
)

add('GET', '/reports/audit-log', { permissions: ['audit.read'] }, (ctx) =>
  listHandler(ctx, {
    source: 'audit_log',
    allowed: ['occurred_at', 'operation', 'action', 'actor_display_name'],
    defaultOrder: 'occurred_at',
    dateColumn: 'occurred_at',
    dateIsTimestamp: true,
    searchColumn: 'operation',
    includeStatus: false,
    extra: auditExtra,
  }),
)

const detailSpecs = [
  ['/employees/:employee_id', ['employees.read'], { source: 'employees', param: 'employee_id' }],
  [
    '/rm-purchases/:purchase_id',
    ['inventory.read'],
    {
      source: 'raw_material_purchase_consignments',
      param: 'purchase_id',
      select: RM_PURCHASE_SELECT,
    },
  ],
  [
    '/conversions/:conversion_id',
    ['inventory.read'],
    {
      source: 'conversions',
      param: 'conversion_id',
      select: CONVERSION_SELECT,
      fallbackSelect: CONVERSION_LEGACY_SELECT,
    },
  ],
  [
    '/production/:production_id',
    ['production.read'],
    {
      source: 'production_runs',
      param: 'production_id',
      select: PRODUCTION_SELECT,
      fallbackSelect: PRODUCTION_LEGACY_SELECT,
    },
  ],
  [
    '/quotations/:quotation_id',
    ['sales.read'],
    { source: 'quotations', param: 'quotation_id', select: QUOTATION_SELECT },
  ],
  [
    '/sales/:sale_id',
    ['sales.read'],
    {
      source: 'sales',
      param: 'sale_id',
      select: SALE_SELECT,
      fallbackSelect: SALE_LEGACY_SELECT,
    },
  ],
  ['/payroll/:payroll_id', ['payroll.read'], { source: 'payrolls', param: 'payroll_id', select: PAYROLL_SELECT }],
  [
    '/journals/:journal_id',
    ['finance.read'],
    {
      source: 'journal_entries',
      param: 'journal_id',
      select: '*,journal_lines(*)',
    },
  ],
]
for (const [path, permissions, spec] of detailSpecs)
  add('GET', path, { permissions }, (ctx) => detailHandler(ctx, spec))

const mutations = [
  ['POST', '/employees', ['employees.write'], schemas.employee, 'employee.upsert', 'body', 201],
  ['PATCH', '/employees/:employee_id', ['employees.write'], schemas.employee, 'employee.upsert', 'upsert', 200],
  ['DELETE', '/employees/:employee_id', ['employees.write'], null, 'employee.delete', 'delete', 200],
  [
    'POST',
    '/conversion-types',
    ['inventory.write', 'production.write', 'employees.write'],
    schemas.conversionType,
    'conversion_type.upsert',
    'body',
    201,
    true,
  ],
  [
    'PATCH',
    '/conversion-types/:conversion_type_id',
    ['inventory.write', 'production.write', 'employees.write'],
    schemas.conversionType,
    'conversion_type.upsert',
    'upsert',
    200,
    true,
  ],
  [
    'DELETE',
    '/conversion-types/:conversion_type_id',
    ['inventory.write', 'production.write', 'employees.write'],
    null,
    'conversion_type.delete',
    'delete',
    200,
    true,
  ],
  [
    'POST',
    '/piecework-rates',
    ['employees.write', 'inventory.write', 'production.write'],
    schemas.pieceworkRate,
    'piecework_rate.upsert',
    'body',
    201,
    true,
  ],
  [
    'PATCH',
    '/piecework-rates/:rate_id',
    ['employees.write', 'inventory.write', 'production.write'],
    schemas.pieceworkRate,
    'piecework_rate.upsert',
    'upsert',
    200,
    true,
  ],
  [
    'DELETE',
    '/piecework-rates/:rate_id',
    ['employees.write', 'inventory.write', 'production.write'],
    null,
    'piecework_rate.delete',
    'delete',
    200,
    true,
  ],
  ['POST', '/bulk-rm-rates', ['inventory.write'], schemas.bulkRmRate, 'bulk_rm_rate.upsert', 'body', 201],
  ['PATCH', '/bulk-rm-rates/:rate_id', ['inventory.write'], schemas.bulkRmRate, 'bulk_rm_rate.upsert', 'upsert'],
  ['DELETE', '/bulk-rm-rates/:rate_id', ['inventory.write'], null, 'bulk_rm_rate.deactivate', 'delete'],
  ['POST', '/daily-work', ['employees.write'], schemas.dailyTarget, 'daily_target.upsert', 'body', 201],
  ['PATCH', '/daily-work/:work_id', ['employees.write'], schemas.dailyTarget, 'daily_target.upsert', 'upsert'],
  ['DELETE', '/daily-work/:work_id', ['employees.write'], schemas.reverse, 'daily_target.reverse', 'reverse'],
  ['POST', '/overtime', ['employees.write'], schemas.overtime, 'overtime.upsert', 'body', 201],
  ['PATCH', '/overtime/:overtime_id', ['employees.write'], schemas.overtime, 'overtime.upsert', 'upsert'],
  ['DELETE', '/overtime/:overtime_id', ['employees.write'], schemas.reverse, 'overtime.reverse', 'reverse'],
  ['POST', '/salary-advances', ['payroll.write'], schemas.salaryAdvance, 'salary_advance.upsert', 'body', 201],
  ['DELETE', '/salary-advances/:advance_id', ['payroll.write'], schemas.reverse, 'salary_advance.reverse', 'reverse'],
  ['POST', '/shift-settings', ['employees.write'], schemas.shiftSettings, 'shift_settings.upsert', 'body', 200],
  ['POST', '/products', ['production.write'], schemas.product, 'product.upsert', 'body', 201],
  ['PATCH', '/products/:product_id', ['production.write'], schemas.product, 'product.upsert', 'upsert'],
  ['DELETE', '/products/:product_id', ['production.write'], null, 'product.reverse', 'delete'],
  ['POST', '/rm-purchases', ['inventory.write'], schemas.rmPurchase, 'rm_purchase.post', 'body', 201],
  ['PATCH', '/rm-purchases/:purchase_id', ['inventory.write'], schemas.rmPurchase, 'rm_purchase.replace', 'replace'],
  ['DELETE', '/rm-purchases/:purchase_id', ['inventory.write'], schemas.reverse, 'rm_purchase.reverse', 'reverse'],
  ['POST', '/conversions', ['inventory.write'], schemas.conversion, 'conversion.post', 'body', 201],
  ['PATCH', '/conversions/:conversion_id', ['inventory.write'], schemas.conversion, 'conversion.replace', 'replace'],
  ['DELETE', '/conversions/:conversion_id', ['inventory.write'], schemas.reverse, 'conversion.reverse', 'reverse'],
  ['POST', '/production', ['production.write'], schemas.production, 'production.post', 'body', 201],
  ['PATCH', '/production/:production_id', ['production.write'], schemas.production, 'production.replace', 'replace'],
  ['DELETE', '/production/:production_id', ['production.write'], schemas.reverse, 'production.reverse', 'reverse'],
  [
    'PATCH',
    '/customer-orders/:order_id/status',
    ['sales.write'],
    schemas.customerOrderStatus,
    'customer_order.status',
    'status',
  ],
  ['POST', '/quotations', ['sales.write'], schemas.quotation, 'quotation.upsert', 'body', 201],
  ['PATCH', '/quotations/:quotation_id', ['sales.write'], schemas.quotation, 'quotation.upsert', 'upsert'],
  ['DELETE', '/quotations/:quotation_id', ['sales.write'], null, 'quotation.cancel', 'delete'],
  ['POST', '/sales', ['sales.write'], schemas.sale, 'sale.post', 'body', 201],
  ['PATCH', '/sales/:sale_id', ['sales.write'], schemas.sale, 'sale.replace', 'replace'],
  ['DELETE', '/sales/:sale_id', ['sales.write'], schemas.reverse, 'sale.reverse', 'reverse'],
  ['POST', '/sales/:sale_id/payments', ['sales.write'], schemas.salePayment, 'sale_payment.post', 'child', 201],
  [
    'DELETE',
    '/sales/:sale_id/payments/:payment_id',
    ['sales.write'],
    schemas.reverse,
    'sale_payment.reverse',
    'reverseChild',
  ],
  ['POST', '/payroll', ['payroll.write'], schemas.payroll, 'payroll.post', 'body', 201],
  ['PATCH', '/payroll/:payroll_id', ['payroll.write'], schemas.payroll, 'payroll.replace', 'replace'],
  ['DELETE', '/payroll/:payroll_id', ['payroll.write'], schemas.reverse, 'payroll.reverse', 'reverse'],
  [
    'POST',
    '/payroll/:payroll_id/payments',
    ['payroll.write'],
    schemas.payrollPayment,
    'payroll_payment.post',
    'child',
    201,
  ],
  [
    'DELETE',
    '/payroll/:payroll_id/payments/:payment_id',
    ['payroll.write'],
    schemas.reverse,
    'payroll_payment.reverse',
    'reverseChild',
  ],
  ['POST', '/adjustments', ['inventory.write'], schemas.adjustment, 'adjustment.post', 'body', 201],
  ['PATCH', '/adjustments/:adjustment_id', ['inventory.write'], schemas.adjustment, 'adjustment.replace', 'replace'],
  ['DELETE', '/adjustments/:adjustment_id', ['inventory.write'], schemas.reverse, 'adjustment.reverse', 'reverse'],
  ['POST', '/journals', ['finance.write'], schemas.journal, 'journal.post', 'body', 201],
  ['PATCH', '/journals/:journal_id', ['finance.write'], schemas.journal, 'journal.replace', 'replace'],
  ['DELETE', '/journals/:journal_id', ['finance.write'], schemas.reverse, 'journal.reverse', 'reverse'],
  ['PATCH', '/company-profile', ['system.admin'], schemas.companyProfile, 'company_profile.update', 'body'],
]

for (const [
  method,
  path,
  permissions,
  schema,
  operation,
  mode,
  responseStatus = 200,
  anyPermission = false,
] of mutations) {
  add(method, path, { permissions, anyPermission }, async (ctx) => {
    const parsed = schema ? body(ctx, schema) : {}
    const idName =
      Object.keys(ctx.params).find((key) => !['sale_id', 'payroll_id'].includes(key)) || Object.keys(ctx.params)[0]
    const recordId = idName ? requireUuid(ctx.params[idName], idName) : null
    let payload = parsed
    if (mode === 'upsert') payload = { ...parsed, id: recordId }
    if (mode === 'delete') payload = { id: recordId }
    if (mode === 'replace') payload = { target: { id: recordId }, replacement: parsed }
    if (mode === 'reverse') payload = reversePayload(recordId, parsed)
    if (mode === 'status')
      payload = {
        id: requireUuid(ctx.params.order_id, 'order_id'),
        status: parsed.status,
      }
    if (mode === 'child') {
      const parentKey = ctx.params.sale_id ? 'sale_id' : 'payroll_id'
      const parentId = requireUuid(ctx.params[parentKey], parentKey)
      if (parsed[parentKey] && parsed[parentKey] !== parentId)
        throw new ApiError(422, `${parentKey} does not match the URL`, {
          code: 'parent_id_mismatch',
        })
      payload = { ...parsed, [parentKey]: parentId }
    }
    if (mode === 'reverseChild') payload = reversePayload(requireUuid(ctx.params.payment_id, 'payment_id'), parsed)
    return {
      status: responseStatus,
      body: await execute(ctx, operation, payload),
    }
  })
}

add('GET', '/admin/users', { permissions: ['access.manage'] }, async (ctx) => {
  const page = pagination(ctx.query, ctx.config)
  return {
    body: await ctx.gateway.selectPage('admin_user_access', {
      token: ctx.principal.token,
      requestId: ctx.requestId,
      companyId: ctx.principal.companyId,
      ...page,
      select: '*',
      order: 'display_name.asc',
      filters: [],
    }),
  }
})

add('POST', '/admin/users', { permissions: ['access.manage'] }, async (ctx) => {
  idempotency(ctx)
  requireSuperAdmin(ctx, 'create login accounts')
  const value = body(ctx, schemas.adminUser)
  const companyCodes = value.company_access === 'BOTH' ? ['CK', 'AR'] : [value.company_access]
  const userId = await ctx.gateway.createAuthUser({
    email: value.email,
    password: value.temporary_password,
    displayName: value.display_name,
    requestId: ctx.requestId,
  })
  try {
    const result = await ctx.gateway.provisionUserAccess({
      targetUserId: userId,
      displayName: value.display_name,
      companyCodes,
      roleCodes: value.role_codes,
      isSuperAdmin: value.is_super_admin,
      token: ctx.principal.token,
      requestId: ctx.requestId,
    })
    return { status: 201, body: result }
  } catch (error) {
    await ctx.gateway.deleteAuthUser(userId, ctx.requestId)
    throw error
  }
})

add('PATCH', '/admin/users/:target_user_id/status', { permissions: ['access.manage'] }, async (ctx) => {
  requireSuperAdmin(ctx, 'change login status')
  const value = body(ctx, schemas.adminStatus)
  return {
    body: await ctx.gateway.setUserAccountStatus({
      targetUserId: requireUuid(ctx.params.target_user_id, 'target_user_id'),
      isActive: value.is_active,
      token: ctx.principal.token,
      requestId: ctx.requestId,
      idempotencyKey: idempotency(ctx),
    }),
  }
})

add('DELETE', '/admin/users/:target_user_id', { permissions: ['access.manage'] }, async (ctx) => {
  requireSuperAdmin(ctx, 'remove login accounts')
  const value = body(ctx, schemas.adminRemove)
  return {
    body: await ctx.gateway.removeUserAccount({
      targetUserId: requireUuid(ctx.params.target_user_id, 'target_user_id'),
      confirmationPin: value.confirmation_pin,
      token: ctx.principal.token,
      requestId: ctx.requestId,
      idempotencyKey: idempotency(ctx),
    }),
  }
})

add('POST', '/admin/purge-business-data', { permissions: ['system.admin'] }, async (ctx) => {
  const value = body(ctx, schemas.purge)
  if (value.company_code !== ctx.principal.company.code)
    throw new ApiError(422, 'The purge company does not match the selected portal', {
      code: 'company_confirmation_mismatch',
    })
  return { body: await execute(ctx, 'system.purge_business_data', value) }
})

function employeeExtra(ctx) {
  return ctx.query.get('employee_id')
    ? [f('employee_id', 'eq', requireUuid(ctx.query.get('employee_id'), 'employee_id'))]
    : []
}

function stageExtra(ctx) {
  const stage = ctx.query.get('stage')
  return stage ? [f('stage', 'eq', safePattern(stage, /^(bulk|chip|finished)$/, 'stage'))] : []
}

function inventoryStageSpec(stage) {
  return {
    source: 'company_inventory_position',
    allowed: ['item_name', 'quantity_on_hand', 'inventory_value', 'last_movement_at'],
    defaultOrder: 'item_name',
    dateColumn: null,
    searchColumn: 'item_name',
    includeStatus: false,
    extra: (ctx) => [
      f('stage', 'eq', stage),
      ...(booleanQuery(ctx.query, 'produced_only', false) ? [f('last_movement_at', 'not.is', 'null')] : []),
      ...(booleanQuery(ctx.query, 'available_only', false) ? [f('quantity_on_hand', 'gt', 0)] : []),
    ],
  }
}

function ledgerExtra(ctx) {
  const result = []
  if (ctx.query.get('journal_entry_id'))
    result.push(f('journal_entry_id', 'eq', requireUuid(ctx.query.get('journal_entry_id'), 'journal_entry_id')))
  if (ctx.query.get('source_type'))
    result.push(f('source_type', 'eq', safePattern(ctx.query.get('source_type'), /^[a-z_.]+$/, 'source_type')))
  if (ctx.query.get('category'))
    result.push(
      f(
        'category',
        'eq',
        safePattern(ctx.query.get('category'), /^(asset|liability|equity|revenue|expense)$/, 'category'),
      ),
    )
  const month = ctx.query.get('month')
  if (month) {
    safePattern(month, /^\d{4}-(0[1-9]|1[0-2])$/, 'month')
    const start = `${month}-01`
    const next = new Date(`${start}T00:00:00Z`)
    next.setUTCMonth(next.getUTCMonth() + 1)
    result.push(f('entry_date', 'gte', start), f('entry_date', 'lt', next.toISOString().slice(0, 10)))
  } else if (ctx.query.get('year')) {
    const year = numberQuery(ctx.query, 'year', {
      minimum: 2000,
      maximum: 2200,
    })
    result.push(f('entry_date', 'gte', `${year}-01-01`), f('entry_date', 'lte', `${year}-12-31`))
  }
  return result
}

function auditExtra(ctx) {
  const result = []
  const action = ctx.query.get('action')
  const actor = ctx.query.get('actor')
  const entity = ctx.query.get('entity')
  if (action) result.push(f('action', 'eq', safePattern(action, /^(insert|update|delete|reverse|execute)$/, 'action')))
  if (actor) result.push(f('actor_display_name', 'ilike', `*${actor.replace(/[*%]/g, '').slice(0, 200)}*`))
  if (entity)
    result.push(
      f(
        'entity_table',
        'ilike',
        `*${safePattern(entity, /^[A-Za-z0-9_. -]+$/, 'entity')
          .replace(/[*%]/g, '')
          .slice(0, 100)}*`,
      ),
    )
  return result
}

function safePattern(value, pattern, name) {
  if (!pattern.test(value))
    throw new ApiError(422, `${name} is invalid`, {
      code: 'request_validation_failed',
    })
  return value
}

function requireSuperAdmin(ctx, action) {
  if (!ctx.principal.isSuperAdmin)
    throw new ApiError(403, `Only a group super administrator can ${action}`, {
      code: 'super_admin_required',
    })
}

function num(value) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + num(row[key]), 0)
}

export function matchRoute(method, path) {
  const candidates = routes
    .filter((route) => route.method === method)
    .sort((a, b) => b.score - a.score || b.path.length - a.path.length)
  for (const route of candidates) {
    const match = route.regex.exec(path)
    if (!match) continue
    const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]))
    return { route, params }
  }
  return null
}

export function authorize(principal, route) {
  const permissions = route.permissions || []
  if (!permissions.length) return
  const granted = new Set(principal.permissions)
  if (granted.has('system.admin')) return
  const allowed = route.anyPermission
    ? permissions.some((permission) => granted.has(permission))
    : permissions.every((permission) => granted.has(permission))
  if (!allowed) {
    const message = route.anyPermission
      ? `One of these permissions is required: ${[...permissions].sort().join(', ')}`
      : `Permission required: ${permissions[0]}`
    throw new ApiError(403, message, { code: 'permission_denied' })
  }
}

export async function dispatch(ctx) {
  const match = matchRoute(ctx.method, ctx.path)
  if (!match) throw new ApiError(404, 'API route not found', { code: 'http_error' })
  ctx.params = match.params
  if (!match.route.public) {
    authorize(ctx.principal, match.route)
  }
  return match.route.handler(ctx)
}

export function routeManifest() {
  return routes.map(({ method, path }) => ({ method, path }))
}
