import type { PetAsset, PresetPetItem } from '../shared/types'
import presets from './presets.json'
import { readRemotePets, writeRemotePets } from './store'

interface RawPreset {
  id: string
  name: string
  desc?: string
  image?: string
  kind?: string
  size?: number
  config: string
  uri: {
    default: string
    mac?: string
  }
  ext?: {
    default: string
    mac?: string
  }
}
const BUILT_IN: readonly RawPreset[] = presets.pets['built-in']
export function safePresetId(id: string): boolean {
  return (id.length > 0
    && id.length <= 64
    && [...id].every(value => /[\w-]/u.test(value) && value.charCodeAt(0) < 128))
}
function toItem(spec: RawPreset, remote: boolean): PresetPetItem {
  return {
    id: spec.id,
    name: spec.name,
    desc: spec.desc ?? null,
    image: spec.image ?? null,
    kind: (spec.kind === 'codex' ? 'codex' : 'dsh'),
    size: spec.size ?? null,
    config: spec.config,
    uri: spec.uri,
    ext: spec.ext ?? null,
    remote,
  }
}
export function mergeCatalog(remote: readonly PresetPetItem[] = readRemotePets()): PresetPetItem[] {
  const builtInIds = new Set(BUILT_IN.map(spec => spec.id))
  return [
    ...BUILT_IN.map(spec => toItem(spec, false)),
    ...remote.filter(spec => !builtInIds.has(spec.id)).map(spec => spec.remote === false ? { ...spec, remote: true } : spec),
  ]
}
export function builtInCatalog(): PresetPetItem[] {
  return mergeCatalog([])
}
export function fullCatalog(): PresetPetItem[] {
  return mergeCatalog(readRemotePets())
}
export function findPreset(id: string): PresetPetItem | undefined {
  return fullCatalog().find(item => item.id === id)
}
function isRegistered(id: string): boolean {
  return readRemotePets().some(item => item.id === id)
}
export function registerRemotePet(spec: PresetPetItem): PresetPetItem {
  const current = readRemotePets()
  if (BUILT_IN.some(item => item.id === spec.id))
    throw new Error(`PET_ALREADY_EXISTS: preset ${spec.id} is built in`)
  if (current.some(item => item.id === spec.id || item.config === spec.config))
    throw new Error(`PET_ALREADY_EXISTS: preset ${spec.id} is already registered`)
  const next = [...current, { ...spec, remote: true }]
  writeRemotePets(next)
  return { ...spec, remote: true }
}
export function replaceRemotePet(spec: PresetPetItem): PresetPetItem {
  const current = readRemotePets()
  const index = current.findIndex(item => item.id === spec.id)
  if (index < 0)
    throw new Error(`PET_NOT_FOUND: preset ${spec.id} is not registered`)
  const next = current.slice()
  next[index] = { ...spec, remote: true }
  writeRemotePets(next)
  return { ...spec, remote: true }
}
export function unregisterRemotePet(id: string): void {
  if (!isRegistered(id))
    throw new Error(`PET_NOT_FOUND: preset ${id} is not registered`)
  writeRemotePets(readRemotePets().filter(item => item.id !== id))
}
export function presetAsset(item: PresetPetItem): PetAsset {
  if (item.kind === 'codex') {
    return {
      kind: 'codex',
      id: item.id,
      spritesheet: typeof item.uri === 'string' ? item.uri : item.uri.default,
      sprite_version_number: 2,
      columns: 8,
      rows: 11,
    }
  }
  return {
    kind: 'dsh',
    id: item.id,
    config: item.config,
    uri: item.uri,
    ext: item.ext ?? { default: 'webm', mac: 'mov' },
    size: item.size ?? undefined,
  }
}
