export interface PetStatus {
  active_pet: string
  enabled: boolean
  pet_size?: number | null
  throw_enabled: boolean
  visible: boolean
}
export interface PetRuntimeStatus extends PetStatus {
  desktop_supported: boolean
  desktop_open: boolean
  open_url: string
}
export type PetSource = 'chat' | 'codex'
export interface PetListItem {
  description?: string
  id: string
  name: string
  source: PetSource
  kind?: 'dsh' | 'codex'
  thumbnail?: string
  thumbnail_type?: 'gif' | 'spritesheet'
}
export interface PresetPetItem {
  config: string
  desc?: string | null
  ext?: {
    default: string
    mac?: string
  } | null
  id: string
  image?: string | null
  kind?: 'dsh' | 'codex' | null
  name: string
  remote?: boolean
  size?: number | null
  uri: {
    default: string
    mac?: string
  }
}
export type PetAsset = {
  kind: 'codex'
  id: string
  spritesheet: string
  sprite_version_number: number
  columns: number
  rows: number
} | {
  kind: 'dsh'
  id: string
  config: string
  uri: {
    default: string
    mac?: string
  }
  ext?: {
    default: string
    mac?: string
  }
  size?: number
}
export interface PetCatalog {
  presetPets: PresetPetItem[]
  chatPets: PetListItem[]
  codexPets: PetListItem[]
  status: PetRuntimeStatus
}
export type PetActionResult = {
  ok: true
} | {
  ok: false
  error: string
}
export interface PetPatch {
  active_pet?: string
  enabled?: boolean
  pet_size?: number
  throw_enabled?: boolean
}
export interface PetSessionPayload {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  name?: string
  description?: string
  message?: string
  status?: string
  activity?: string
  phase?: string
  running?: boolean
  pendingInteraction?: unknown
  pending?: readonly unknown[]
  lastAgentError?: string
  workStatus?: PetWorkStatus
  task?: string
  toolActivity?: PetToolActivity
  liveActivity?: {
    kind: string
    text?: string
    name?: string
    command?: string
    path?: string
    args?: string
  }
}
export type PetWorkStatus = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error'
export type PetToolActivity = 'searching' | 'editing' | 'testing' | 'commanding' | 'using-tool'
export interface SessionStreamSink {
  push: (frame: string) => void
  close: () => void
}
