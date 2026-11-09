import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PetAsset, PetCatalog, PetPatch, PetRuntimeStatus, PetSource } from '../shared/types'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG_PATH, DESKTOP_OPEN_URL, ROUTE_PREFIX, SESSION_STREAM_PATH, SETTINGS_PATH, SSE_KEEPALIVE_MS } from '../shared/constants'
import { fullCatalog, presetAsset, registerRemotePet, replaceRemotePet, unregisterRemotePet } from './catalog'
import { findPetDirectory, listPets, parseQualifiedId, petsDir, readSpritesheet, safeRelativePath } from './pet-fs'
import { importPetArchive } from './pet-import'
import { checkPetUpdates, importPetRepository, updatePetRepository } from './pet-repo'
import { sessionStream } from './session-stream'
import { snapshot, update } from './store'

export interface RouteContext {
  desktopSupported: boolean
  desktopOpen: boolean
  setDesktop: (open: boolean) => Promise<void>
  origin: string
}
export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  handle: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext) => Promise<void> | void
}
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit)
      throw new Error('PET_BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readBody(req)) as T
    if (value === null || typeof value !== 'object') {
      sendText(res, 400, 'PET_BAD_REQUEST: body must be an object')
      return undefined
    }
    return value
  }
  catch {
    sendText(res, 400, 'PET_BAD_REQUEST: body must be JSON')
    return undefined
  }
}
function runtimeStatus(ctx: RouteContext): PetRuntimeStatus {
  const openUrl = ctx.desktopOpen || ctx.desktopSupported ? DESKTOP_OPEN_URL : ctx.origin
  return snapshot({ desktopSupported: ctx.desktopSupported, desktopOpen: ctx.desktopOpen, openUrl })
}
async function catalog(ctx: RouteContext): Promise<PetCatalog> {
  const [chatPets, codexPets] = await Promise.all([listPets('chat'), listPets('codex')])
  return {
    presetPets: fullCatalog(),
    chatPets,
    codexPets,
    status: runtimeStatus(ctx),
  }
}
const settingsRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}${SETTINGS_PATH}`,
  handle(_req, res, _url, ctx) {
    sendJson(res, 200, runtimeStatus(ctx))
  },
}
const catalogRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}${CATALOG_PATH}`,
  async handle(_req, res, _url, ctx) {
    sendJson(res, 200, await catalog(ctx))
  },
}
const patchRoute: Route = {
  method: 'PUT',
  path: `${ROUTE_PREFIX}${SETTINGS_PATH}`,
  async handle(req, res, _url, ctx) {
    const patch = await readJson<PetPatch>(req, res)
    if (patch === undefined)
      return
    const next = update({
      active_pet: patch.active_pet,
      enabled: patch.enabled,
      pet_size: patch.pet_size,
      throw_enabled: patch.throw_enabled,
    })
    try {
      await syncDesktop(ctx, next.enabled && next.active_pet !== '')
    }
    catch (error) {
      sendText(res, 502, `PET_DESKTOP_START_FAILED: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    sendJson(res, 200, runtimeStatus(ctx))
  },
}
async function syncDesktop(ctx: RouteContext, shouldOpen: boolean): Promise<void> {
  if (!ctx.desktopSupported)
    return
  if (shouldOpen === ctx.desktopOpen)
    return
  await ctx.setDesktop(shouldOpen)
}
const assetRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/asset`,
  async handle(_req, res, url, ctx) {
    const id = (url.searchParams.get('id') ?? '').trim()
    if (!id) {
      sendText(res, 400, 'PET_ID_INVALID: id is required')
      return
    }
    const preset = fullCatalog().find(entry => entry.id === id)
    if (preset) {
      sendJson(res, 200, presetAsset(preset))
      return
    }
    let qualified: {
      source: PetSource
      manifestId: string
    }
    try {
      qualified = parseQualifiedId(id)
    }
    catch {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    const root = petsDir(qualified.source)
    const found = findPetDirectory(root, qualified.manifestId)
    if (!found) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    try {
      if (found.manifest.kind === 'dsh') {
        const configPath = safeRelativePath(found.manifest.configPath ?? 'config.jsonc')
        const ext = found.manifest.ext ?? { default: 'webm', mac: 'mov' }
        const uriPath = safeRelativePath(found.manifest.uriPath ?? 'webm')
        const asset: PetAsset = {
          kind: 'dsh',
          id,
          config: readFileSync(join(found.directory, configPath), 'utf8'),
          uri: { default: `${ctx.origin}${ROUTE_PREFIX}/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(uriPath)}/{name}.{ext}` },
          ext,
          size: found.manifest.size,
        }
        sendJson(res, 200, asset)
        return
      }
      const { url: spritesheet, grid } = await readSpritesheet(found.directory, found.manifest.spritesheetPath ?? '', found.manifest.spriteVersionNumber)
      const asset: PetAsset = {
        kind: 'codex',
        id,
        spritesheet,
        sprite_version_number: found.manifest.spriteVersionNumber === 1 ? 1 : grid.version,
        columns: grid.columns,
        rows: grid.rows,
      }
      sendJson(res, 200, asset)
    }
    catch (error) {
      sendText(res, 422, `PET_ASSET_INVALID: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}
const fileRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/file`,
  handle(_req, res, url) {
    const id = (url.searchParams.get('id') ?? '').trim()
    const relative = url.searchParams.get('path') ?? ''
    let qualified: {
      source: PetSource
      manifestId: string
    }
    try {
      qualified = parseQualifiedId(id)
    }
    catch {
      sendText(res, 400, 'PET_ID_INVALID: source-qualified id is required')
      return
    }
    const root = petsDir(qualified.source)
    const found = findPetDirectory(root, qualified.manifestId)
    if (!found) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    let target: string
    try {
      target = join(found.directory, safeRelativePath(relative))
    }
    catch {
      sendText(res, 400, 'PET_PATH_INVALID: invalid asset path')
      return
    }
    const base = found.directory
    if (!target.startsWith(base) || !existsSync(target) || !statSync(target).isFile()) {
      sendText(res, 404, 'PET_ASSET_NOT_FOUND')
      return
    }
    const extension = target.slice(target.lastIndexOf('.')).toLowerCase()
    const contentType = extension === '.webm'
      ? 'video/webm'
      : extension === '.mov'
        ? 'video/quicktime'
        : extension === '.mp4'
          ? 'video/mp4'
          : extension === '.png' ? 'image/png' : 'application/octet-stream'
    const bytes = readFileSync(target)
    res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length, 'cache-control': 'public, max-age=3600' })
    res.end(bytes)
  },
}
const configRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/config`,
  async handle(_req, res, url) {
    const id = (url.searchParams.get('id') ?? '').trim()
    const item = fullCatalog().find(entry => entry.id === id)
    if (!item) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    try {
      const response = await fetch(item.config ?? '', { signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        sendText(res, 502, `PET_CONFIG_FETCH_FAILED: ${response.status}`)
        return
      }
      const text = await response.text()
      sendJson(res, 200, { id: item.id, url: item.config, body: text })
    }
    catch (error) {
      sendText(res, 502, `PET_CONFIG_FETCH_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}
const petsRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/pets`,
  async handle(_req, res, url) {
    const source = url.searchParams.get('source') ?? ''
    if (source !== 'chat' && source !== 'codex') {
      sendText(res, 400, 'PET_SOURCE_INVALID: source must be chat or codex')
      return
    }
    try {
      sendJson(res, 200, await listPets(source))
    }
    catch (error) {
      sendText(res, 500, `PET_LIST_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}
const importRoute: Route = {
  method: 'POST',
  path: `${ROUTE_PREFIX}/import`,
  async handle(req, res) {
    const body = await readJson<{
      name?: string
      data?: string
    }>(req, res)
    if (body === undefined)
      return
    if (typeof body.data !== 'string' || body.data.length === 0) {
      sendText(res, 400, 'PET_PACKAGE_DECODE_FAILED: data is required')
      return
    }
    try {
      const item = await importPetArchive(body.data, 'codex')
      sendJson(res, 200, item)
    }
    catch (error) {
      sendText(res, 422, error instanceof Error ? error.message : String(error))
    }
  },
}
const importRepositoryRoute: Route = {
  method: 'POST',
  path: `${ROUTE_PREFIX}/repository`,
  async handle(req, res) {
    const body = await readJson<{
      repository?: string
    }>(req, res)
    if (body === undefined)
      return
    if (typeof body.repository !== 'string') {
      sendText(res, 400, 'PET_REPOSITORY_INVALID: repository is required')
      return
    }
    try {
      const spec = await importPetRepository(fetch, body.repository)
      sendJson(res, 200, registerRemotePet(spec))
    }
    catch (error) {
      sendText(res, 422, error instanceof Error ? error.message : String(error))
    }
  },
}
const updateRepositoryRoute: Route = {
  method: 'PUT',
  path: `${ROUTE_PREFIX}/repository`,
  async handle(req, res) {
    const body = await readJson<{
      id?: string
    }>(req, res)
    if (body === undefined)
      return
    const id = typeof body.id === 'string' ? body.id : ''
    const entry = fullCatalog().find(item => item.id === id && item.remote)
    if (!entry) {
      sendText(res, 404, `PET_NOT_FOUND: preset ${id} is not registered`)
      return
    }
    try {
      const spec = await updatePetRepository(fetch, entry)
      sendJson(res, 200, replaceRemotePet(spec))
    }
    catch (error) {
      sendText(res, 422, error instanceof Error ? error.message : String(error))
    }
  },
}
const deleteRepositoryRoute: Route = {
  method: 'DELETE',
  path: `${ROUTE_PREFIX}/repository`,
  handle(_req, res, url, ctx) {
    const id = (url.searchParams.get('id') ?? '').trim()
    try {
      unregisterRemotePet(id)
      sendJson(res, 200, runtimeStatus(ctx))
    }
    catch (error) {
      sendText(res, 404, error instanceof Error ? error.message : String(error))
    }
  },
}
const updatesRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/updates`,
  async handle(_req, res) {
    try {
      sendJson(res, 200, await checkPetUpdates(fetch, fullCatalog()))
    }
    catch (error) {
      sendText(res, 500, `PET_REPOSITORY_DOWNLOAD_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}
const deletePetRoute: Route = {
  method: 'DELETE',
  path: `${ROUTE_PREFIX}/pet`,
  async handle(_req, res, url, ctx) {
    const id = (url.searchParams.get('id') ?? '').trim()
    try {
      if (id.includes(':')) {
        const { source, manifestId } = parseQualifiedId(id)
        const root = petsDir(source)
        const found = findPetDirectory(root, manifestId)
        if (!found)
          throw new Error(`PET_NOT_FOUND: pet ${id} was not found`)
        rmSync(found.directory, { recursive: true, force: true })
      }
      else {
        unregisterRemotePet(id)
      }
      sendJson(res, 200, runtimeStatus(ctx))
    }
    catch (error) {
      sendText(res, 404, error instanceof Error ? error.message : String(error))
    }
  },
}
const openExternalRoute: Route = {
  method: 'POST',
  path: `${ROUTE_PREFIX}/open-external`,
  async handle(req, res) {
    const body = await readJson<{
      url?: string
    }>(req, res)
    if (body === undefined)
      return
    const value = typeof body.url === 'string' ? body.url : ''
    if (!/^https?:\/\/\S+$/u.test(value)) {
      sendText(res, 400, 'PET_URL_INVALID: only http(s) URLs are allowed')
      return
    }
    sendJson(res, 200, { ok: true, url: value })
  },
}
const streamRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}${SESSION_STREAM_PATH}`,
  handle(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': keepalive\n\n')
    let retrySent = false
    let closed = false
    let keepalive: ReturnType<typeof setInterval> | undefined
    let detach: (() => void) | undefined
    const finish = (): void => {
      if (closed)
        return
      closed = true
      if (keepalive !== undefined) {
        clearInterval(keepalive)
        keepalive = undefined
      }
      detach?.()
      detach = undefined
    }
    const sink = {
      push(frame: string): void {
        if (closed)
          return
        if (retrySent) {
          res.write(`data: ${frame}\n\n`)
          return
        }
        retrySent = true
        res.write(`retry: 1000\ndata: ${frame}\n\n`)
      },
      close(): void {
        finish()
        res.end()
      },
    }
    const { detach: release, stateLost } = sessionStream.start(sink)
    detach = release
    if (stateLost)
      res.write(': state-lost\n\n')
    keepalive = setInterval(() => {
      if (!closed)
        res.write(': keepalive\n\n')
    }, SSE_KEEPALIVE_MS)
    keepalive.unref?.()
    req.on('close', finish)
    res.on('close', finish)
    res.on('error', finish)
  },
}
export const routes: readonly Route[] = [
  settingsRoute,
  catalogRoute,
  patchRoute,
  assetRoute,
  fileRoute,
  configRoute,
  petsRoute,
  importRoute,
  importRepositoryRoute,
  updateRepositoryRoute,
  deleteRepositoryRoute,
  updatesRoute,
  deletePetRoute,
  openExternalRoute,
  streamRoute,
]
export function matchRoute(method: string, pathname: string): Route | undefined {
  return routes.find(route => route.method === method && route.path === pathname)
}
export function notFound(res: ServerResponse, pathname: string): void {
  sendText(res, 404, `PET_NOT_FOUND: ${pathname}`)
}
