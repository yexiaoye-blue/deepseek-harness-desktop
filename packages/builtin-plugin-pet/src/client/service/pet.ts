import type { ClientAdapter } from '../sdk'
import type { PetActionResult, PetListItem, PetStatus, PresetPetItem } from './pet.types'
import { CMD_CHECK_PET_UPDATES, CMD_DELETE_PET, CMD_GET_PET_STATUS, CMD_IMPORT_PET, CMD_IMPORT_PET_REPOSITORY, CMD_LIST_PETS, CMD_LIST_PRESET_PETS, CMD_OPEN_EXTERNAL_URL, CMD_SET_ACTIVE_PET, CMD_SET_PET_ENABLED, CMD_SET_PET_SIZE, CMD_SET_PET_THROW_ENABLED, CMD_UPDATE_PET_REPOSITORY, PET_COMMUNITY_URL, PET_HATCH_PROMPT } from '../constants'
import { invoke } from '../sdk'
import { store } from '../store'
import { chooseWorkspace, messageOf } from './pet.utils'

async function guard(label: string, action: () => Promise<PetActionResult>): Promise<PetActionResult> {
  try {
    return await action()
  }
  catch (error) {
    console.error(`[dsh-pet-lite] ${label} failed:`, error)
    return { ok: false, error: messageOf(error) }
  }
}
export async function loadPetStatus(): Promise<PetStatus | null> {
  const revision = store.pet.beginFetch()
  try {
    const status = await invoke<PetStatus>(CMD_GET_PET_STATUS)
    store.pet.commitFetch(revision, status)
    return status
  }
  catch (error) {
    console.error('[dsh-pet-lite] load pet status failed:', error)
    return null
  }
}
export async function loadPetCatalog(): Promise<PetActionResult> {
  const revision = store.pet.beginFetch()
  return guard('load pet catalog', async () => {
    const catalog = await invoke<{
      presetPets: PresetPetItem[]
      chatPets: PetListItem[]
      codexPets: PetListItem[]
      status: PetStatus
    }>(CMD_LIST_PRESET_PETS)
    store.pet.setCatalog({
      presets: catalog.presetPets,
      chat: catalog.chatPets,
      codex: catalog.codexPets,
    })
    store.pet.commitFetch(revision, catalog.status)
    return { ok: true }
  })
}
export async function choosePet(input: {
  id: string
}): Promise<PetActionResult> {
  return guard('choose pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: input.id }))
    return { ok: true }
  })
}
export async function enablePet(input: {
  id: string
}): Promise<PetActionResult> {
  return guard('enable pet', async () => {
    let status = await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: input.id })
    if (!status.enabled)
      status = await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: true })
    store.pet.setStatus(status)
    return { ok: true }
  })
}
export async function clearPetSelection(): Promise<PetActionResult> {
  const status = store.pet.$state.status
  try {
    if (status?.enabled)
      store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: false }))
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: '' }))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-pet-lite] clear pet selection failed:', error)
    await loadPetStatus()
    return { ok: false, error: messageOf(error) }
  }
}
export async function togglePet(input: {
  enabled: boolean
}): Promise<PetActionResult> {
  return guard('toggle pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: input.enabled }))
    return { ok: true }
  })
}
export async function resizePet(input: {
  size: number
}): Promise<PetActionResult> {
  return guard('resize pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_SIZE, { size: input.size }))
    return { ok: true }
  })
}
export async function togglePetThrow(input: {
  enabled: boolean
}): Promise<PetActionResult> {
  return guard('toggle pet throw', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_THROW_ENABLED, { enabled: input.enabled }))
    return { ok: true }
  })
}
export async function openCommunityShare(): Promise<PetActionResult> {
  return guard('open community share', async () => {
    await invoke(CMD_OPEN_EXTERNAL_URL, { url: PET_COMMUNITY_URL })
    return { ok: true }
  })
}
export async function createPetSession(input: {
  adapter: ClientAdapter
  close?: () => void
}): Promise<PetActionResult> {
  const { adapter, close } = input
  const workspaceId = chooseWorkspace(adapter)
  const connectWorkspace = adapter.workspaces.connectWorkspace
  const open = adapter.sessions.open
  if (workspaceId === undefined || connectWorkspace === undefined)
    return { ok: false, error: 'PET_WORKSPACE_UNAVAILABLE: no workspace can create a pet session' }
  if (open === undefined)
    return { ok: false, error: 'PET_SESSION_UNAVAILABLE: session opener is unavailable' }
  return guard('create pet session', async () => {
    const sessionId = await connectWorkspace(workspaceId)
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return { ok: false, error: 'PET_SESSION_UNAVAILABLE: workspace did not return a session id' }
    store.pet.setPrefill(sessionId, PET_HATCH_PROMPT)
    close?.()
    open(sessionId)
    return { ok: true }
  })
}
export async function deletePet(input: {
  id: string
}): Promise<PetActionResult> {
  return guard('delete pet', async () => {
    store.pet.setStatus(await invoke(CMD_DELETE_PET, { id: input.id }))
    store.pet.removePet(input.id)
    await loadPetCatalog()
    return { ok: true }
  })
}
export async function importPetArchive(input: {
  name: string
  data: string
}): Promise<PetActionResult> {
  return guard('import pet', async () => {
    await invoke(CMD_IMPORT_PET, { name: input.name, data: input.data })
    const codexPets = await invoke<PetListItem[]>(CMD_LIST_PETS, { source: 'codex' })
    store.pet.setCodexPets(codexPets)
    return { ok: true }
  })
}
export async function importPetRepository(input: {
  repository: string
}): Promise<PetActionResult> {
  const match = /^(?:https:\/\/github\.com\/)?([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([\w.-]{1,100})\/?$/i.exec(input.repository.trim())
  if (!match || match[2] === '.' || match[2] === '..')
    return { ok: false, error: 'PET_REPOSITORY_INVALID' }
  return guard('import pet repository', async () => {
    await invoke(CMD_IMPORT_PET_REPOSITORY, { repository: `${match[1]}/${match[2]}` })
    store.pet.setPresetPets(await invoke<PresetPetItem[]>(CMD_LIST_PRESET_PETS))
    return { ok: true }
  })
}
export async function updatePetRepository(input: {
  id: string
}): Promise<PetActionResult> {
  return guard('update pet repository', async () => {
    const item = await invoke<PresetPetItem>(CMD_UPDATE_PET_REPOSITORY, { id: input.id })
    store.pet.replacePresetPet({ ...item, remote: true })
    return { ok: true }
  })
}
export async function loadPetList(source: 'chat' | 'codex'): Promise<PetListItem[]> {
  const items = await invoke<PetListItem[]>(CMD_LIST_PETS, { source })
  if (source === 'chat')
    store.pet.setChatPets(items)
  else
    store.pet.setCodexPets(items)
  return items
}
export async function loadPetUpdates(): Promise<PetActionResult> {
  return guard('check pet updates', async () => {
    const ids = await invoke<string[]>(CMD_CHECK_PET_UPDATES)
    store.pet.setPetUpdates(ids)
    return { ok: true }
  })
}
export async function loadPetOverlaySupported(): Promise<boolean | null> {
  try {
    store.pet.setOverlaySupported(true)
    return true
  }
  catch (error) {
    console.error('[dsh-pet-lite] load pet overlay support failed:', error)
    return null
  }
}
export async function loadForceXwayland(): Promise<boolean | null> {
  try {
    store.pet.setForceXwayland(false)
    return false
  }
  catch (error) {
    console.error('[dsh-pet-lite] load force xwayland failed:', error)
    return null
  }
}
export async function toggleForceXwayland(_input: {
  enabled: boolean
}): Promise<PetActionResult> {
  return { ok: false, error: 'PET_UNSUPPORTED_COMMAND: force xwayland is not configurable' }
}
