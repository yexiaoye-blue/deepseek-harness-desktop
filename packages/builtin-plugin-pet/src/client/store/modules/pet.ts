import type { BakedActions, StoreInstance } from '@deepseek-ai/dsh-client-store'
import type { PetListItem, PetStatus, PresetPetItem } from '../../service/pet.types'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { useSyncExternalStore } from 'react'

export interface PetState {
  status: PetStatus | null
  fetchRevision: number
  catalogLoaded: boolean
  presetPets: PresetPetItem[]
  petUpdates: string[]
  chatPets: PetListItem[]
  codexPets: PetListItem[]
  prefills: Record<string, string>
  overlaySupported: boolean | null
  forceXwayland: boolean | null
}
const actions = {
  bumpRevision(draft: PetState): void {
    draft.fetchRevision += 1
  },
  writeStatus(draft: PetState, status: PetStatus | null): void {
    draft.status = status
  },
  clearStatus(draft: PetState): void {
    draft.fetchRevision += 1
    draft.status = null
  },
  writeCatalog(draft: PetState, input: {
    presets: PresetPetItem[]
    chat: PetListItem[]
    codex: PetListItem[]
  }): void {
    draft.presetPets = input.presets
    draft.chatPets = input.chat
    draft.codexPets = input.codex
    draft.catalogLoaded = true
  },
  writePresetPets(draft: PetState, list: PresetPetItem[]): void {
    draft.presetPets = list
  },
  writeChatPets(draft: PetState, list: PetListItem[]): void {
    draft.chatPets = list
  },
  writeCodexPets(draft: PetState, list: PetListItem[]): void {
    draft.codexPets = list
  },
  writePetUpdates(draft: PetState, ids: string[]): void {
    draft.petUpdates = ids
  },
  replacePresetPet(draft: PetState, item: PresetPetItem): void {
    draft.presetPets = draft.presetPets.map(pet => (pet.id === item.id ? item : pet))
    draft.petUpdates = draft.petUpdates.filter(id => id !== item.id)
  },
  removePet(draft: PetState, id: string): void {
    draft.presetPets = draft.presetPets.filter(item => item.id !== id)
    draft.petUpdates = draft.petUpdates.filter(item => item !== id)
    draft.chatPets = draft.chatPets.filter(item => item.id !== id)
    draft.codexPets = draft.codexPets.filter(item => item.id !== id)
  },
  writeOverlaySupported(draft: PetState, supported: boolean): void {
    draft.overlaySupported = supported
  },
  writeForceXwayland(draft: PetState, enabled: boolean): void {
    draft.forceXwayland = enabled
  },
  writePrefill(draft: PetState, sessionId: string, text: string): void {
    draft.prefills[sessionId] = text
  },
  dropPrefill(draft: PetState, sessionId: string): void {
    delete draft.prefills[sessionId]
  },
  clearPrefills(draft: PetState): void {
    draft.prefills = {}
  },
}
export function createPetStoreHandle(): ReturnType<typeof defineStore<PetState, typeof actions>> {
  return defineStore<PetState, typeof actions>({
    init: (): PetState => ({
      status: null,
      fetchRevision: 0,
      catalogLoaded: false,
      presetPets: [],
      petUpdates: [],
      chatPets: [],
      codexPets: [],
      prefills: {},
      overlaySupported: null,
      forceXwayland: null,
    }),
    actions,
  })
}
type PetInstance = StoreInstance<PetState, typeof actions>
export interface PetStoreFacade {
  readonly $state: PetState
  readonly instance: PetInstance
  useStore: () => PetState
  beginFetch: () => number
  commitFetch: (revision: number, status: PetStatus) => boolean
  setStatus: (status: PetStatus | null) => void
  setCatalog: (input: {
    presets: PresetPetItem[]
    chat: PetListItem[]
    codex: PetListItem[]
  }) => void
  setOverlaySupported: (supported: boolean) => void
  setForceXwayland: (enabled: boolean) => void
  setPresetPets: (list: PresetPetItem[]) => void
  setPetUpdates: (ids: string[]) => void
  replacePresetPet: (item: PresetPetItem) => void
  setChatPets: (list: PetListItem[]) => void
  setCodexPets: (list: PetListItem[]) => void
  removePet: (id: string) => void
  setPrefill: (sessionId: string, draft: string) => void
  takePrefill: (sessionId: string) => string | undefined
  clearPrefills: () => void
}
export function createPetStoreFacade(instance: PetInstance): PetStoreFacade {
  const a: BakedActions<PetState, typeof actions> = instance.actions
  const facade: PetStoreFacade = {
    get $state() {
      return instance.getSnapshot()
    },
    instance,
    useStore(): PetState {
      return useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
    },
    beginFetch(): number {
      a.bumpRevision()
      return instance.getSnapshot().fetchRevision
    },
    commitFetch(revision, status): boolean {
      if (revision !== instance.getSnapshot().fetchRevision)
        return false
      a.writeStatus(status)
      return true
    },
    setStatus(status): void {
      a.bumpRevision()
      a.writeStatus(status)
    },
    setCatalog(input): void {
      a.writeCatalog(input)
    },
    setOverlaySupported(supported): void {
      a.writeOverlaySupported(supported)
    },
    setForceXwayland(enabled): void {
      a.writeForceXwayland(enabled)
    },
    setPresetPets(list): void {
      a.writePresetPets(list)
    },
    setPetUpdates(ids): void {
      a.writePetUpdates(ids)
    },
    replacePresetPet(item): void {
      a.replacePresetPet(item)
    },
    setChatPets(list): void {
      a.writeChatPets(list)
    },
    setCodexPets(list): void {
      a.writeCodexPets(list)
    },
    removePet(id): void {
      a.removePet(id)
    },
    setPrefill(sessionId, text): void {
      a.writePrefill(sessionId, text)
    },
    takePrefill(sessionId): string | undefined {
      const value = instance.getSnapshot().prefills[sessionId]
      if (value === undefined)
        return undefined
      a.dropPrefill(sessionId)
      return value
    },
    clearPrefills(): void {
      a.clearPrefills()
    },
  }
  return facade
}
