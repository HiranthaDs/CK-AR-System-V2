import { createServer } from 'node:http'
import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'

for (const file of ['.env.local', '.env', 'backend/.env']) {
  try {
    loadEnvFile(resolve(file))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const { default: handler } = await import('../server/app.js')
const port = Number.parseInt(process.env.APP_PORT || process.env.PORT || '8000', 10)
const host = process.env.APP_HOST || '127.0.0.1'

const server = createServer((request, response) => {
  Promise.resolve(handler(request, response)).catch((error) => {
    console.error('Fatal local API error', error)
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ detail: 'An unexpected error occurred.', code: 'internal_error' }))
  })
})

server.listen(port, host, () => {
  console.log(`CK SYS Node API listening on http://${host}:${port}/api/v1`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
