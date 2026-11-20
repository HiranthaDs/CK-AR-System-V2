import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

export function createStaticHandler(directory) {
  const root = resolve(directory)
  const index = resolve(root, 'index.html')

  return async function staticHandler(request, response) {
    const method = String(request.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' })
      response.end()
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end('Bad request')
      return
    }

    const requested = resolve(root, `.${pathname}`)
    const contained = requested === root || requested.startsWith(`${root}${sep}`)
    const file = contained && await isFile(requested) ? requested : index

    if (!await isFile(file)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end('Not found')
      return
    }

    const headers = {
      'Content-Type': CONTENT_TYPES.get(extname(file).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': file.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    }
    response.writeHead(200, headers)
    if (method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(file).on('error', () => response.destroy()).pipe(response)
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
