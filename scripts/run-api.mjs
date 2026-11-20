import { createServer } from 'node:http'
import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'
import { createStaticHandler } from '../server/static.js'

for (const file of ['.env.local', '.env', 'backend/.env']) {
  try {
    loadEnvFile(resolve(file))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const { default: handler } = await import('../server/app.js')
const port = Number.parseInt(process.env.APP_PORT || process.env.PORT || '8000', 10)
const host = process.env.APP_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
const staticHandler = process.env.STATIC_DIR
  ? createStaticHandler(resolve(process.env.STATIC_DIR))
  : null

const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  const requestHandler = pathname.startsWith('/api/') ? handler : staticHandler
  const result = requestHandler
    ? requestHandler(request, response)
    : handler(request, response)

  Promise.resolve(result).catch((error) => {
    console.error('Fatal local API error', error)
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ detail: 'An unexpected error occurred.', code: 'internal_error' }))
  })
})

server.listen(port, host, () => {
  const mode = staticHandler ? 'application' : 'Node API'
  console.log(`CK SYS ${mode} listening on http://${host}:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
