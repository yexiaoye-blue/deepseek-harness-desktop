import { MENU_ITEM_SELECTOR, PET_MENU_ITEM_ATTRIBUTE, PET_MENU_PATCH_ATTRIBUTE } from '../constants'
import { locale } from '../locales'
import { defineRegister } from '../sdk'
import { loadPetStatus, togglePet } from '../service/pet'
import { store } from '../store'
import { decoratePetMenuItem, isSettingsMenuItem } from './settings-menu.utils'

export const settingsMenuFeature = defineRegister((controller) => {
  if (typeof document === 'undefined')
    return
  void loadPetStatus()
  function patchMenu(settingsItem: HTMLButtonElement): void {
    const menu = settingsItem.closest<HTMLElement>('[role="menu"]')
    if (menu === null || menu.hasAttribute(PET_MENU_PATCH_ATTRIBUTE))
      return
    const item = decoratePetMenuItem(settingsItem, enabled() ? locale.text('closePet') : locale.text('enablePet'))
    if (item === null)
      return
    menu.setAttribute(PET_MENU_PATCH_ATTRIBUTE, '1')
    settingsItem.after(item)
  }
  function scan(): void {
    for (const item of document.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)) {
      if (isSettingsMenuItem(item))
        patchMenu(item)
    }
  }
  controller.observe(document.body, scan, { childList: true, subtree: true })
  controller.listen('click', (event) => {
    const origin = event.target
    if (!(origin instanceof Element))
      return
    if (origin.closest(`[${PET_MENU_ITEM_ATTRIBUTE}]`) === null)
      return
    event.preventDefault()
    event.stopImmediatePropagation()
    void togglePet({ enabled: !enabled() })
    const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
    document.dispatchEvent(new PointerEventCtor('pointerdown', { bubbles: true, cancelable: true }))
  }, { capture: true })
})
function enabled(): boolean {
  return store.pet.$state.status?.enabled ?? false
}
