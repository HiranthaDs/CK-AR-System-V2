import { ApiError } from './errors.js'

function integer(value, fallback, minimum, maximum) {
  const parsed = value == null || value === '' ? fallback : Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback
  return parsed
}

function list(value, fallback = []) {
  if (!value?.trim()) return fallback
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.map(String) : fallback
    } catch {
      return fallback
    }
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean)
}

export function getConfig(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim().replace(/\/$/, '')
  const publishableKey = (env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim()
  const secretKey = (env.SUPABASE_SECRET_KEY || '').trim() || null

  if (!/^https?:\/\/[^/?#]+$/i.test(supabaseUrl)) {
    throw new ApiError(503, 'SUPABASE_URL is missing or invalid.', {
      code: 'server_configuration_error',
    })
  }
  if (!publishableKey.startsWith('sb_publishable_')) {
    throw new ApiError(503, 'SUPABASE_PUBLISHABLE_KEY must be an sb_publishable_ key.', {
      code: 'server_configuration_error',
    })
  }
  if (secretKey && !secretKey.startsWith('sb_secret_')) {
    throw new ApiError(503, 'SUPABASE_SECRET_KEY must be an sb_secret_ server key.', {
      code: 'server_configuration_error',
    })
  }

  const defaultPageSize = integer(env.DEFAULT_PAGE_SIZE, 25, 1, 100)
  const maxPageSize = integer(env.MAX_PAGE_SIZE, 100, 1, 500)
  return {
    appName: env.APP_NAME || 'CK SYS ERP API',
    appVersion: env.APP_VERSION || '3.0.0',
    appEnv: env.APP_ENV || env.VERCEL_ENV || 'development',
    supabaseUrl,
    restUrl: `${supabaseUrl}/rest/v1`,
    authUrl: `${supabaseUrl}/auth/v1`,
    publishableKey,
    secretKey,
    schema: env.SUPABASE_SCHEMA || 'public',
    defaultPageSize: Math.min(defaultPageSize, maxPageSize),
    maxPageSize,
    paginationCount: ['exact', 'planned', 'estimated'].includes(env.PAGINATION_COUNT)
      ? env.PAGINATION_COUNT
      : 'estimated',
    inventorySummaryMaxRows: integer(env.INVENTORY_SUMMARY_MAX_ROWS, 10_000, 100, 100_000),
    timeoutMs: integer(env.HTTP_TIMEOUT_MS, 10_000, 1_000, 60_000),
    retryAttempts: integer(env.HTTP_RETRY_ATTEMPTS, 3, 1, 5),
    corsOrigins: list(env.CORS_ORIGINS, ['http://localhost:5173', 'http://127.0.0.1:5173']),
    production: (env.APP_ENV || env.VERCEL_ENV || '').toLowerCase() === 'production',
  }
}
