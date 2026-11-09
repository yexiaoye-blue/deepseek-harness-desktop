import type { PetListItem, PetSource } from '../shared/types'
import type { PetManifest } from './pet-fs'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { unzipSync } from 'fflate'
import { manifestToListItem, parseManifest, petsDir, readSpritesheet, safeRelativePath, validateManifestId } from './pet-fs'

const PET_PACKAGE_MAX_BYTES = 32 * 1024 * 1024
const PET_PACKAGE_MAX_ENTRIES = 512
const PET_PACKAGE_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
function ignoredArchiveEntry(name: string): boolean {
  return name.split('/').some(segment => segment === '__MACOSX'
    || segment === '.DS_Store'
    || segment === 'Thumbs.db'
    || segment === 'desktop.ini'
    || segment === '.staging'
    || segment.startsWith('._'))
}
interface Entry {
  name: string
  data: Uint8Array
  isDir: boolean
}
function archiveRootPrefix(entries: readonly Entry[]): string {
  const manifests = entries.filter(entry => !entry.isDir && entry.name.split('/').pop() === 'pet.json')
  if (manifests.length !== 1)
    throw new Error('PET_ARCHIVE_LAYOUT_INVALID: archive must contain exactly one pet.json')
  const manifestPath = manifests[0]!.name
  const slash = manifestPath.lastIndexOf('/')
  const prefix = slash < 0 ? '' : manifestPath.slice(0, slash + 1)
  if (prefix === '')
    return ''
  for (const entry of entries) {
    if (entry.name.startsWith(prefix))
      continue
    if (entry.isDir && prefix.startsWith(`${entry.name}/`))
      continue
    throw new Error('PET_ARCHIVE_LAYOUT_INVALID: archive must have exactly one supported root')
  }
  return prefix
}
function uniqueStagingPath(root: string): string {
  const nonce = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  return join(root, '.staging', `import-${nonce}`)
}
export async function importPetArchive(base64: string, source: PetSource = 'codex'): Promise<PetListItem> {
  const encodedLimit = Math.ceil(PET_PACKAGE_MAX_BYTES / 3) * 4
  if (base64.length > encodedLimit)
    throw new Error(`PET_PACKAGE_TOO_LARGE: pet package must not exceed ${PET_PACKAGE_MAX_BYTES} compressed bytes`)
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > PET_PACKAGE_MAX_BYTES)
    throw new Error(`PET_PACKAGE_TOO_LARGE: pet package must not exceed ${PET_PACKAGE_MAX_BYTES} compressed bytes`)
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(new Uint8Array(bytes))
  }
  catch (error) {
    throw new Error(`PET_ARCHIVE_INVALID: failed to open zip: ${error instanceof Error ? error.message : String(error)}`)
  }
  const entries: Entry[] = []
  let total = 0
  const names = Object.keys(raw)
  if (names.length === 0 || names.length > PET_PACKAGE_MAX_ENTRIES)
    throw new Error(`PET_ARCHIVE_ENTRY_LIMIT: archive must contain 1..=${PET_PACKAGE_MAX_ENTRIES} entries`)
  for (const name of names) {
    const isDir = name.endsWith('/')
    if (ignoredArchiveEntry(name))
      continue
    safeRelativePath(name.replace(/\/+$/u, ''))
    const data = raw[name]!
    if (!isDir) {
      total += data.length
      if (total > PET_PACKAGE_MAX_UNCOMPRESSED_BYTES)
        throw new Error(`PET_ARCHIVE_TOO_LARGE: uncompressed files must not exceed ${PET_PACKAGE_MAX_UNCOMPRESSED_BYTES} bytes`)
    }
    entries.push({ name, data, isDir })
  }
  const prefix = archiveRootPrefix(entries)
  const root = petsDir(source)
  const staging = uniqueStagingPath(root)
  mkdirSync(staging, { recursive: true })
  let committed = false
  try {
    const outputs = new Set<string>()
    for (const entry of entries) {
      const relative = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : ''
      if (relative === '' || relative.endsWith('/'))
        continue
      const normalized = safeRelativePath(relative)
      if (outputs.has(normalized))
        throw new Error('PET_ARCHIVE_DUPLICATE_ENTRY: duplicate output path')
      outputs.add(normalized)
      const target = join(staging, normalized)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, entry.data)
    }
    const manifest: PetManifest = parseManifest(readFileSync(join(staging, 'pet.json'), 'utf8'))
    validateManifestId(manifest.id)
    if (manifest.kind === 'dsh')
      throw new Error('PET_KIND_FORBIDDEN: Codex pets must use spritesheets')
    await readSpritesheet(staging, manifest.spritesheetPath ?? '', manifest.spriteVersionNumber)
    const target = join(root, manifest.id)
    if (existsSync(target))
      throw new Error(`PET_ALREADY_IMPORTED: Codex pet target ${manifest.id} already exists`)
    mkdirSync(root, { recursive: true })
    renameSync(staging, target)
    committed = true
    return await manifestToListItem(source, target, manifest)
  }
  finally {
    if (!committed)
      rmSync(staging, { recursive: true, force: true })
  }
}
