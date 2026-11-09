import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let origin = ''
let home = ''
let stop: () => Promise<void>
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-pet-host-'))
  vi.stubEnv('DSH_HOME', home)
  vi.resetModules()
  const disposers: (() => void)[] = []
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('PET_TEST_SERVER_MISSING')
  origin = `http://127.0.0.1:${address.port}`
  stop = async () => {
    for (const dispose of disposers)
      dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  const { apply } = await import('./index')
  apply({
    effect: (setup: () => () => void) => {
      disposers.push(setup())
    },
    webServer: { port: address.port, register: (options: {
      handler: typeof handler
    }) => {
      handler = options.handler
      return () => {
      }
    } },
  } as never)
})
afterEach(async () => {
  await stop()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})
describe('built-in pet host', () => {
  it('rejects foreign origins before mutating pet settings', async () => {
    const response = await fetch(`${origin}/dsh-pet-lite/settings`, {
      method: 'PUT',
      headers: { 'origin': 'https://foreign.example', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('PET_REQUEST_FORBIDDEN')
    const status = await fetch(`${origin}/dsh-pet-lite/settings`).then(response => response.json())
    expect(status.enabled).toBe(false)
  })
  it('stores pet selection without starting an external desktop runtime', async () => {
    const response = await fetch(`${origin}/dsh-pet-lite/settings`, {
      method: 'PUT',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ active_pet: 'dsh-gpt-pet', enabled: true, pet_size: 123 }),
    })
    expect(response.status).toBe(200)
    const status = await fetch(`${origin}/dsh-pet-lite/settings`).then(response => response.json())
    expect(status).toMatchObject({ active_pet: 'dsh-gpt-pet', enabled: true, pet_size: 123, desktop_open: false })
  })
  it('serves the bundled window document and reports missing routes', async () => {
    const response = await fetch(`${origin}/dsh-pet-lite/desktop`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toContain('/dsh-pet-lite/desktop/renderer.js')
    expect((await fetch(`${origin}/dsh-pet-lite/not-a-route`)).status).toBe(404)
  })
})
