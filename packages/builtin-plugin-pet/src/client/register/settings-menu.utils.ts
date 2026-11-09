import type { Root } from 'react-dom/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MENU_ITEM_ICON_SELECTOR, MENU_ITEM_LABEL_SELECTOR, MENU_ITEM_SHORTCUT_SELECTOR, PET_MENU_ITEM_ATTRIBUTE, SETTINGS_MENU_LABELS } from '../constants'
import { Ghost, Icon } from '../ui'

const ICON_ROOTS = new WeakMap<HTMLElement, Root>()
function renderIcon(icon: HTMLElement): void {
  ICON_ROOTS.get(icon)?.unmount()
  const root = createRoot(icon)
  root.render(createElement(Icon, { as: Ghost }))
  ICON_ROOTS.set(icon, root)
}
export function isSettingsMenuItem(item: HTMLElement): boolean {
  const label = item.querySelector<HTMLElement>(MENU_ITEM_LABEL_SELECTOR)?.textContent ?? item.textContent ?? ''
  return SETTINGS_MENU_LABELS.includes(label.trim())
}
export function decoratePetMenuItem(source: HTMLButtonElement, label: string): HTMLButtonElement | null {
  const item = source.cloneNode(true) as HTMLButtonElement
  const labelNode = item.querySelector<HTMLElement>(MENU_ITEM_LABEL_SELECTOR)
  if (labelNode === null)
    return null
  labelNode.textContent = label
  const icon = item.querySelector<HTMLElement>(MENU_ITEM_ICON_SELECTOR)
  if (icon !== null)
    renderIcon(icon)
  item.querySelector<HTMLElement>(MENU_ITEM_SHORTCUT_SELECTOR)?.remove()
  item.setAttribute(PET_MENU_ITEM_ATTRIBUTE, '1')
  return item
}
