import type { ClientAdapter, ClientContext } from './sdk'
import { PLUGIN_ID } from '../shared/constants'
import { PetSettings } from './components/pet-settings'
import { locale } from './locales'
import { petSectionFeature } from './register/pet-section'
import { prefillFeature } from './register/prefill'
import { settingsMenuFeature } from './register/settings-menu'
import { loadPetCatalog } from './service/pet'
import { mountPetStore, unmountPetStore } from './store'

export const name = PLUGIN_ID
export const inject = ['slots', 'locale', 'sessions', 'workspaces']
export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return
  mountPetStore()
  const adapter: ClientAdapter = {
    sessions: {
      list: ctx.sessions?.list,
      open: ctx.sessions?.open,
    },
    workspaces: {
      list: ctx.workspaces?.list,
      connectWorkspace: ctx.workspaces?.connectWorkspace,
    },
  }
  ctx.effect(() => locale.attach(ctx.locale), `${PLUGIN_ID}: locale`)
  ctx.effect(() => petSectionFeature(ctx, adapter), `${PLUGIN_ID}: settings section`)
  ctx.effect(() => settingsMenuFeature(ctx, adapter), `${PLUGIN_ID}: settings menu items`)
  ctx.effect(() => prefillFeature(ctx, adapter), `${PLUGIN_ID}: conversation prefill`)
  ctx.effect(() => {
    void loadPetCatalog()
    return () => unmountPetStore()
  }, `${PLUGIN_ID}: catalog bootstrap`)
}
export { PetSettings }
