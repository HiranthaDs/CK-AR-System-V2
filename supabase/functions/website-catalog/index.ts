import { withSupabase } from 'npm:@supabase/server@1.9.2'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const responseHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (request, context) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json(
        { code: 'method_not_allowed', message: 'Use GET to read the catalogue.' },
        { status: 405, headers: { ...responseHeaders, Allow: 'GET, HEAD, OPTIONS' } },
      )
    }

    const catalogId = new URL(request.url).searchParams.get('catalog_id')?.trim() ?? ''
    if (!UUID_PATTERN.test(catalogId)) {
      return Response.json(
        { code: 'invalid_catalog_id', message: 'A valid catalog_id is required.' },
        { status: 400, headers: responseHeaders },
      )
    }

    const { data, error } = await context.supabaseAdmin.rpc('erp_public_website_catalog', {
      p_catalog_id: catalogId,
    })

    if (error) {
      console.error('website-catalog database request failed', {
        code: error.code,
        request_id: request.headers.get('x-request-id'),
      })
      return Response.json(
        { code: 'catalog_unavailable', message: 'The catalogue is temporarily unavailable.' },
        { status: 503, headers: responseHeaders },
      )
    }

    if (!data) {
      return Response.json(
        { code: 'catalog_not_found', message: 'This catalogue link is inactive or invalid.' },
        { status: 404, headers: responseHeaders },
      )
    }

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: responseHeaders })
    }
    return Response.json(data, { status: 200, headers: responseHeaders })
  }),
}
