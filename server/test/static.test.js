import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStaticHandler } from '../static.js'

describe('production static handler', () => {
  let directory
  let server
  let origin

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ck-sys-static-'))
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'index.html'), '<main>CK SYS</main>')
    await writeFile(join(directory, 'assets', 'app.js'), 'console.log("ready")')
    server = createServer(createStaticHandler(directory))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })

  it('serves built assets with immutable caching', async () => {
    const response = await fetch(`${origin}/assets/app.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(await response.text()).toContain('ready')
  })

  it('falls back to the SPA entry point for client routes', async () => {
    const response = await fetch(`${origin}/ck/dashboard`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.text()).toBe('<main>CK SYS</main>')
  })

  it('does not resolve paths outside the static directory', async () => {
    const response = await fetch(`${origin}/..%2F..%2Fpackage.json`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<main>CK SYS</main>')
  })
})
