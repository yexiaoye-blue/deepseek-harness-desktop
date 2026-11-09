import type { PetRuntimeStatus, PetStatus, PresetPetItem } from '../shared/types'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PET_DEFAULT_SIZE, PET_SIZE_MAX, PET_SIZE_MIN } from '../shared/constants'
import { builtInCatalog } from './catalog'

export interface PetPersisted {
  active_pet: string
  enabled: boolean
  pet_size: number
  throw_enabled: boolean
}
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (!configured)
    return join(homedir(), '.dsh')
  return configured === '~' ? homedir() : configured
}
export function storeFile(): string {
  return join(dshHome(), 'pet-lite', 'pet.json')
}
function clampSize(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(size))
    return PET_DEFAULT_SIZE
  return Math.round(Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, size)))
}
function normalizeActiveId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id)
    return ''
  return builtInCatalog().some(item => item.id === id) ? id : id
}
export function defaults(): PetPersisted {
  return {
    active_pet: builtInCatalog()[0]?.id ?? '',
    enabled: false,
    pet_size: PET_DEFAULT_SIZE,
    throw_enabled: false,
  }
}
export function readPersisted(): PetPersisted {
  const file = storeFile()
  if (!existsSync(file))
    return defaults()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PetPersisted>
    const fallback = defaults()
    return {
      active_pet: raw.active_pet === undefined ? fallback.active_pet : normalizeActiveId(raw.active_pet),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
      pet_size: clampSize(raw.pet_size),
      throw_enabled: typeof raw.throw_enabled === 'boolean' ? raw.throw_enabled : fallback.throw_enabled,
    }
  }
  catch {
    return defaults()
  }
}
export function writePersisted(value: PetPersisted): boolean {
  const file = storeFile()
  try {
    mkdirSync(join(dshHome(), 'pet-lite'), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  }
  catch {
    return false
  }
}
let current: PetPersisted | undefined
export function state(): PetPersisted {
  if (current === undefined)
    current = readPersisted()
  return current
}
export function update(patch: Partial<PetPersisted>): PetPersisted {
  const base = state()
  const next: PetPersisted = {
    active_pet: patch.active_pet === undefined ? base.active_pet : normalizeActiveId(patch.active_pet),
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    pet_size: patch.pet_size === undefined ? base.pet_size : clampSize(patch.pet_size),
    throw_enabled: patch.throw_enabled === undefined ? base.throw_enabled : patch.throw_enabled,
  }
  current = next
  writePersisted(next)
  return next
}
export function resetCache(): void {
  current = undefined
}
function remoteFile(): string {
  return join(dshHome(), 'pet-lite', 'remote-pets.json')
}
let remoteCache: PresetPetItem[] | undefined
let remoteCacheMtime = -1
export function readRemotePets(): PresetPetItem[] {
  const file = remoteFile()
  const exists = existsSync(file)
  const mtime = exists ? statSync(file).mtimeMs : 0
  if (remoteCache !== undefined && mtime === remoteCacheMtime)
    return remoteCache
  if (!exists) {
    remoteCache = []
    remoteCacheMtime = 0
    return remoteCache
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as PresetPetItem[]
    remoteCache = Array.isArray(raw) ? raw : []
  }
  catch {
    remoteCache = []
  }
  remoteCacheMtime = mtime
  return remoteCache
}
export function writeRemotePets(list: PresetPetItem[]): void {
  const file = remoteFile()
  remoteCache = list
  try {
    mkdirSync(join(dshHome(), 'pet-lite'), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    renameSync(tmp, file)
    remoteCacheMtime = statSync(file).mtimeMs
  }
  catch {
  }
}
export function resetRemoteCache(): void {
  remoteCache = undefined
  remoteCacheMtime = -1
}
export function snapshot(input: {
  desktopSupported: boolean
  desktopOpen: boolean
  openUrl?: string
}): PetRuntimeStatus {
  const value = state()
  const status: PetStatus = {
    active_pet: value.active_pet,
    enabled: value.enabled,
    pet_size: value.pet_size,
    throw_enabled: value.throw_enabled,
    visible: value.enabled && value.active_pet !== '',
  }
  return {
    ...status,
    desktop_supported: input.desktopSupported,
    desktop_open: input.desktopOpen,
    open_url: input.openUrl ?? '',
  }
}
