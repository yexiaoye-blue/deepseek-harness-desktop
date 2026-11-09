import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { matchRoute, notFound } from './host/routes'
import { resetRuntime } from './host/runtime'
import { attachHost } from './host/session-stream'
import { PLUGIN_ID, ROUTE_PREFIX } from './shared/constants'

export const inject = ['webServer', 'sessions', 'workspaceRegistry']
export const name = PLUGIN_ID

export function apply(ctx: Context): void {
  attachHost(ctx as never)
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const origin = `http://127.0.0.1:${ctx.webServer.port}`
        const url = new URL(req.url ?? '/', origin)
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
        const host = req.headers.host
        if (!local || ![new URL(origin).host, `localhost:${ctx.webServer.port}`].includes(host ?? '')
          || (req.headers.origin !== undefined && ![origin, `http://localhost:${ctx.webServer.port}`].includes(req.headers.origin))) {
          res.writeHead(403)
          res.end('PET_REQUEST_FORBIDDEN')
          return
        }
        const staticFile = url.pathname === `${ROUTE_PREFIX}/desktop`
          ? ['../assets/desktop.html', 'text/html; charset=utf-8']
          : url.pathname === `${ROUTE_PREFIX}/desktop/renderer.js`
            ? ['./desktop/renderer.js', 'text/javascript; charset=utf-8']
            : undefined
        if (staticFile && req.method === 'GET') {
          try {
            const body = readFileSync(fileURLToPath(new URL(staticFile[0]!, import.meta.url)))
            res.writeHead(200, { 'content-type': staticFile[1]!, 'cache-control': 'no-store' })
            res.end(body)
          }
          catch {
            res.writeHead(503)
            res.end('PET_RENDERER_UNAVAILABLE: bundled renderer is missing')
          }
          return
        }
        const route = matchRoute(req.method ?? 'GET', url.pathname)
        if (!route) {
          notFound(res, url.pathname)
          return
        }
        try {
          await route.handle(req, res, url, {
            desktopSupported: false,
            desktopOpen: false,
            setDesktop: async () => {},
            origin,
          })
        }
        catch (error) {
          if (!res.headersSent)
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`PET_ROUTE_FAILED: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    return () => {
      dispose()
      resetRuntime()
      attachHost(undefined)
    }
  }, `${PLUGIN_ID}: routes`)
}
