const TITLES = new Map([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [409, 'Conflict'],
  [413, 'Payload Too Large'],
  [422, 'Validation Error'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
])

export class ApiError extends Error {
  constructor(status, detail, { code = 'api_error', title, headers = {}, errors } = {}) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.code = code
    this.title = title || TITLES.get(status) || 'Request Failed'
    this.headers = headers
    this.errors = errors
  }
}

export function validationError(error) {
  const errors = error?.issues?.map((issue) => ({
    type: issue.code,
    loc: ['body', ...issue.path],
    msg: issue.message,
  }))
  return new ApiError(422, 'The request did not pass validation.', {
    code: 'request_validation_failed',
    errors,
  })
}

export function problem(error, { path, requestId }) {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, 'An unexpected error occurred.', { code: 'internal_error' })
  const body = {
    type: `https://ck-sys.local/problems/${apiError.code}`,
    title: apiError.title,
    status: apiError.status,
    detail: apiError.detail,
    instance: path,
    request_id: requestId,
    code: apiError.code,
  }
  if (apiError.errors?.length) body.errors = apiError.errors
  return { error: apiError, body }
}
