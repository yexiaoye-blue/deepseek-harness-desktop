export type PetActionResult = {
  ok: true
} | {
  ok: false
  error: string
}
export interface PetStatus {
  active_pet: string
  enabled: boolean
  pet_size?: number | null
  throw_enabled: boolean
  visible: boolean
  desktop_supported?: boolean
  desktop_open?: boolean
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
  desc?: string | null
  id: string
  image?: string | null
  kind?: 'dsh' | 'codex' | null
  name: string
  remote?: boolean
  size?: number | null
  config?: string
  uri?: {
    default: string
    mac?: string
  }
  ext?: {
    default: string
    mac?: string
  } | null
}
