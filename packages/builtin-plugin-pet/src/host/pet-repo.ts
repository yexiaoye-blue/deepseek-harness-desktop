import type { PresetPetItem } from '../shared/types'
import type { PetManifest } from './pet-fs'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { parseManifest, safeRelativePath } from './pet-fs'

const PET_MANIFEST_MAX_BYTES = 64 * 1024
const PET_CONFIG_MAX_BYTES = 1024 * 1024
const PET_REPOSITORY_TIMEOUT_MS = 12000
const PET_REPOSITORY_DOWNLOAD_TIMEOUT_MS = 12000
type FetchLike = typeof fetch
function defaultManifest(name: string): PetManifest {
  return {
    id: name,
    kind: 'dsh',
    configPath: 'config.jsonc',
    uriPath: 'webm',
    previewPath: 'preview/preview.gif',
    ext: { default: 'webm', mac: 'webm' },
  }
}
export function parsePetRepository(repository: string): {
  owner: string
  name: string
} {
  const invalid = (): never => {
    throw new Error('PET_REPOSITORY_INVALID: use owner/repo or https://github.com/owner/repo')
  }
  const input = repository.trim()
  let path = input
  if (input.includes('://')) {
    let url: URL
    try {
      url = new URL(input)
    }
    catch {
      return invalid()
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash)
      return invalid()
    path = url.pathname.replace(/^\/+/u, '').replace(/\/+$/u, '')
  }
  const slash = path.indexOf('/')
  if (slash < 0)
    return invalid()
  const owner = path.slice(0, slash)
  let name = path.slice(slash + 1)
  if (name.endsWith('.git'))
    name = name.slice(0, -4)
  if (!owner
    || owner.length > 39
    || owner.startsWith('-')
    || owner.endsWith('-')
    || !/^[\w-]+$/u.test(owner) || ![...owner].every(c => c.charCodeAt(0) < 128)
    || !name
    || name.length > 100
    || name === '.' || name === '..'
    || !/^[\w.-]+$/u.test(name) || ![...name].every(c => c.charCodeAt(0) < 128)) {
    return invalid()
  }
  return { owner, name }
}
export function repositoryAssetUrl(base: string, relative: string): string {
  const normalized = safeRelativePath(relative)
  const url = new URL(base)
  const prefix = url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${prefix}/${normalized}`
}
export function repositorySpec(base: string, name: string, manifestBytes: string | null): PresetPetItem {
  const manifest = manifestBytes === null ? defaultManifest(name) : parseManifest(manifestBytes)
  if (manifest.kind !== 'dsh')
    throw new Error('PET_KIND_FORBIDDEN: repository pets must use kind dsh')
  const config = repositoryAssetUrl(base, manifest.configPath ?? '')
  const image = repositoryAssetUrl(base, manifest.previewPath ?? '')
  const uriDefault = repositoryAssetUrl(base, manifest.uriPath ?? '')
  const uriMac = manifest.macUriPath ? repositoryAssetUrl(base, manifest.macUriPath) : undefined
  return {
    id: manifest.id,
    name: (manifest.displayName ?? '').trim() || manifest.id,
    desc: manifest.description ?? null,
    image,
    kind: 'dsh',
    size: manifest.size ?? null,
    config,
    uri: uriMac ? { default: uriDefault, mac: uriMac } : { default: uriDefault },
    ext: manifest.ext ?? null,
    remote: true,
  }
}
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\')
        out += text[++i] ?? ''
      else if (ch === '"')
        inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    }
    else if (ch === '/' && next === '/') {
      inLine = true
      i++
    }
    else if (ch === '/' && next === '*') {
      inBlock = true
      i++
    }
    else {
      out += ch
    }
  }
  return out.replace(/,(\s*[}\]])/gu, '$1')
}
export function animationNames(config: unknown): string[] {
  const names = new Set<string>()
  function collect(value: unknown): void {
    if (typeof value === 'string') {
      names.add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value)
        collect(item)
      return
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        if (typeof item === 'string' || Array.isArray(item))
          collect(item)
      }
    }
  }
  if (config && typeof config === 'object') {
    const record = config as Record<string, unknown>
    const animations = record.animations as Record<string, unknown> | undefined
    if (animations && typeof animations === 'object') {
      for (const [key, value] of Object.entries(animations)) {
        if (key === 'moves') {
          const moves = value as {
            actions?: Array<{
              name?: unknown
            }>
          } | undefined
          for (const action of moves?.actions ?? []) {
            if (typeof action?.name === 'string')
              names.add(action.name)
          }
        }
        else if (key === 'categories') {
          for (const category of (value as Array<{
            actions?: unknown[]
          }> | undefined) ?? []) {
            for (const name of category.actions ?? [])
              collect(name)
          }
        }
        else if (key === 'events' || key === 'motions') {
          collect(value)
        }
        else {
          collect(value)
        }
      }
    }
  }
  return [...names]
}
function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  const base: Record<string, string> = { 'user-agent': 'dsh-pet-lite', 'accept': 'application/vnd.github+json' }
  return token ? { ...base, authorization: `Bearer ${token}` } : base
}
async function fetchText(fetchImpl: FetchLike, url: string, limit: number, optional: boolean): Promise<string | null> {
  const response = await fetchImpl(url, {
    headers: githubHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(PET_REPOSITORY_DOWNLOAD_TIMEOUT_MS),
  })
  if (optional && response.status === 404)
    return null
  if (!response.ok)
    throw new Error(`PET_REPOSITORY_DOWNLOAD_FAILED: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > limit)
    throw new Error('PET_REPOSITORY_TOO_LARGE: metadata exceeds its byte limit')
  const text = await response.text()
  if (Buffer.byteLength(text) > limit)
    throw new Error('PET_REPOSITORY_TOO_LARGE: metadata exceeds its byte limit')
  return text
}
export async function repositoryHead(fetchImpl: FetchLike, owner: string, name: string): Promise<string> {
  const text = await fetchText(fetchImpl, `https://api.github.com/repos/${owner}/${name}/commits/HEAD`, PET_CONFIG_MAX_BYTES, false)
  const value = JSON.parse(text ?? '{}') as {
    sha?: unknown
  }
  const sha = typeof value.sha === 'string' ? value.sha : ''
  if (!/^[\da-f]{40}$/iu.test(sha))
    throw new Error('PET_REPOSITORY_INVALID: missing commit SHA')
  return sha.toLowerCase()
}
export async function readRepositorySpec(fetchImpl: FetchLike, base: string, name: string, checkMedia: boolean): Promise<PresetPetItem> {
  const manifestBytes = await fetchText(fetchImpl, repositoryAssetUrl(base, 'pet.json'), PET_MANIFEST_MAX_BYTES, true)
  const spec = repositorySpec(base, name, manifestBytes)
  const configText = await fetchText(fetchImpl, spec.config!, PET_CONFIG_MAX_BYTES, false)
  const config = JSON.parse(stripJsonc(configText ?? '{}')) as unknown
  if (checkMedia) {
    const ext = spec.ext ?? { default: 'webm', mac: 'webm' }
    const urls: string[] = [spec.image!]
    const names = animationNames(config)
    for (const [uri, extension] of [[spec.uri!.default, ext.default], [spec.uri!.mac, ext.mac]] as const) {
      if (!uri || !extension)
        continue
      for (const anim of names)
        urls.push(repositoryAssetUrl(`${uri}/`, `${anim}.${extension}`))
    }
    for (const url of urls) {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        headers: githubHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(PET_REPOSITORY_DOWNLOAD_TIMEOUT_MS),
      })
      if (!response.ok)
        throw new Error(`PET_ASSET_INVALID: HTTP ${response.status} for ${url}`)
    }
  }
  return spec
}
export function petRepositoryRevision(spec: PresetPetItem): {
  owner: string
  name: string
  current: string
} {
  const url = new URL(spec.config ?? '')
  const parts = url.pathname.split('/').filter(Boolean)
  const sha = parts[2] ?? ''
  if (url.protocol !== 'https:'
    || url.hostname !== 'raw.githubusercontent.com'
    || url.username || url.password || url.port || url.search || url.hash
    || parts.length < 4
    || !(sha === 'HEAD' || /^[\da-f]{40}$/iu.test(sha))) {
    throw new Error('PET_REPOSITORY_INVALID: pet is not a registered GitHub repository')
  }
  const { owner, name } = parsePetRepository(`${parts[0]}/${parts[1]}`)
  return { owner, name, current: sha }
}
export async function importPetRepository(fetchImpl: FetchLike, repository: string): Promise<PresetPetItem> {
  const { owner, name } = parsePetRepository(repository)
  const run = async (): Promise<PresetPetItem> => {
    const commit = await repositoryHead(fetchImpl, owner, name)
    const base = `https://raw.githubusercontent.com/${owner}/${name}/${commit}/`
    return readRepositorySpec(fetchImpl, base, name, false)
  }
  return withTimeout(run(), PET_REPOSITORY_TIMEOUT_MS, 'PET_REPOSITORY_TIMEOUT: metadata registration exceeded 12 seconds')
}
export async function updatePetRepository(fetchImpl: FetchLike, spec: PresetPetItem): Promise<PresetPetItem> {
  const { owner, name } = petRepositoryRevision(spec)
  const run = async (): Promise<PresetPetItem> => {
    const commit = await repositoryHead(fetchImpl, owner, name)
    const base = `https://raw.githubusercontent.com/${owner}/${name}/${commit}/`
    const next = await readRepositorySpec(fetchImpl, base, name, true)
    return { ...next, id: spec.id }
  }
  return withTimeout(run(), PET_REPOSITORY_TIMEOUT_MS, 'PET_REPOSITORY_TIMEOUT: update exceeded 12 seconds')
}
export async function checkPetUpdates(fetchImpl: FetchLike, specs: readonly PresetPetItem[]): Promise<string[]> {
  const remote = specs.filter(spec => spec.remote)
  const result: string[] = []
  await withTimeout(async () => {
    const checks = remote.map(async (spec) => {
      try {
        const { owner, name, current } = petRepositoryRevision(spec)
        const latest = await repositoryHead(fetchImpl, owner, name)
        if (current.toLowerCase() !== latest)
          result.push(spec.id)
      }
      catch {
      }
    })
    await Promise.all(checks)
  }, PET_REPOSITORY_TIMEOUT_MS, 'PET_REPOSITORY_TIMEOUT: update check exceeded 12 seconds')
  return result
}
async function withTimeout<T>(task: Promise<T> | (() => Promise<T>), ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    const run = typeof task === 'function' ? task() : task
    return await Promise.race([run, timeout])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}
