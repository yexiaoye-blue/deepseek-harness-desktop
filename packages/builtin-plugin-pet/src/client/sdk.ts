import { isTauri as nativeAvailable, invoke as nativeInvoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import { PLUGIN_ID, ROUTE_PREFIX } from '../shared/constants'

export { useSyncExternalStore }
interface InvokeSpec {
  path: string
  method: 'GET' | 'PUT' | 'POST' | 'DELETE'
}
const INVOKE: Record<string, InvokeSpec> = {
  get_pet_status: { path: '/settings', method: 'GET' },
  list_pet_catalog: { path: '/catalog', method: 'GET' },
  list_preset_pets: { path: '/catalog', method: 'GET' },
  set_pet_enabled: { path: '/settings', method: 'PUT' },
  set_active_pet: { path: '/settings', method: 'PUT' },
  set_pet_size: { path: '/settings', method: 'PUT' },
  set_pet_throw_enabled: { path: '/settings', method: 'PUT' },
  get_pet_asset: { path: '/asset', method: 'GET' },
  list_pets: { path: '/pets', method: 'GET' },
  import_pet: { path: '/import', method: 'POST' },
  delete_pet: { path: '/pet', method: 'DELETE' },
  import_pet_repository: { path: '/repository', method: 'POST' },
  update_pet_repository: { path: '/repository', method: 'PUT' },
  delete_pet_repository: { path: '/repository', method: 'DELETE' },
  check_pet_updates: { path: '/updates', method: 'GET' },
  open_external_url: { path: '/open-external', method: 'POST' },
  get_pet_overlay_supported: { path: '/unsupported', method: 'GET' },
  get_force_xwayland: { path: '/unsupported', method: 'GET' },
  set_force_xwayland: { path: '/unsupported', method: 'GET' },
}
function bodyFor(command: string, args: Record<string, unknown> | undefined): unknown {
  if (!args)
    return {}
  switch (command) {
    case 'set_pet_enabled':
      return { enabled: args.enabled }
    case 'set_active_pet':
      return { active_pet: args.id }
    case 'set_pet_size':
      return { pet_size: args.size }
    case 'set_pet_throw_enabled':
      return { throw_enabled: args.enabled }
    case 'import_pet':
      return { name: args.name, data: args.data }
    case 'import_pet_repository':
      return { repository: args.repository }
    case 'update_pet_repository':
      return { id: args.id }
    case 'open_external_url':
      return { url: args.url }
    default:
      return {}
  }
}
function queryFor(command: string, args: Record<string, unknown> | undefined): string {
  if (!args)
    return ''
  const id = typeof args.id === 'string' ? String(args.id) : undefined
  switch (command) {
    case 'get_pet_asset':
      return id ? `?id=${encodeURIComponent(id)}` : ''
    case 'list_pets':
      return typeof args.source === 'string' ? `?source=${encodeURIComponent(String(args.source))}` : ''
    case 'delete_pet':
      return id ? `?id=${encodeURIComponent(id)}` : ''
    case 'delete_pet_repository':
      return id ? `?id=${encodeURIComponent(id)}` : ''
    default:
      return ''
  }
}
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command === 'get_force_xwayland' || command === 'set_force_xwayland')
    return nativeInvoke<T>(command, args)
  if (command === 'get_pet_overlay_supported') {
    const state = await nativeInvoke<{ overlay_supported: boolean }>('pet_native', { request: { kind: 'state' } })
    return state.overlay_supported as T
  }

  const spec = INVOKE[command]
  if (!spec)
    throw new Error(`PET_UNSUPPORTED_COMMAND: ${command}`)
  if (spec.path === '/unsupported')
    throw new Error(`PET_UNSUPPORTED_COMMAND: ${command}`)
  const hasBody = spec.method === 'PUT' || spec.method === 'POST'
  const url = `${ROUTE_PREFIX}${spec.path}${spec.method === 'GET' || spec.method === 'DELETE' ? queryFor(command, args) : ''}`
  const response = await fetch(url, {
    method: spec.method,
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(bodyFor(command, args)) : undefined,
    cache: 'no-store',
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text.trim() || `PET_REQUEST_FAILED: ${command} (${response.status})`)
  }
  if (command === 'open_external_url' && args && typeof args.url === 'string') {
    try {
      window.open(args.url, '_blank', 'noopener,noreferrer')
    }
    catch {
    }
  }
  if (response.status === 204)
    return undefined as T
  const value = await response.json() as Record<string, unknown>
  const status = (value.status ?? value) as Record<string, unknown>
  if (typeof status.active_pet === 'string' && typeof status.enabled === 'boolean') {
    if (nativeAvailable()) {
      const state = await nativeInvoke<Record<string, unknown>>('pet_native', { request: {
        kind: 'sync',
        enabled: status.enabled && status.active_pet !== '',
        throw_enabled: status.throw_enabled === true,
      } })
      Object.assign(status, state)
    }
    else {
      Object.assign(status, { desktop_supported: false, desktop_open: false, overlay_supported: false })
    }
  }
  return value as T
}
export function isTauri(): boolean {
  return nativeAvailable()
}
export function cn(...values: Array<string | false | null | undefined | Array<string | false | null | undefined>>): string {
  const out: string[] = []
  for (const value of values) {
    if (!value)
      continue
    if (Array.isArray(value))
      out.push(cn(...value))
    else
      out.push(value)
  }
  return out.filter(Boolean).join(' ')
}
export interface LocaleRuntimeLike {
  register: (namespace: string, locale: string, dict: Record<string, string>) => () => void
  getLocale: () => {
    active: string
  }
  subscribe: (onChange: () => void) => () => void
}
export interface LocaleHandle<K extends string> {
  text: (key: K) => string
  useLocale: () => void
}
export function defineLocale<K extends string>(namespace: string, dicts: {
  zh: Record<K, string>
  en: Record<K, string>
}): LocaleFeature<K> {
  let active = 'en'
  const listeners = new Set<() => void>()
  const text = (key: K): string => (active === 'zh' ? dicts.zh[key] : dicts.en[key]) ?? String(key)
  function useLocale(): void {
    useSyncExternalStore((onChange: () => void) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    }, () => active, () => active)
  }
  const handle: LocaleFeature<K> = {
    text,
    useLocale,
    attach(locale: LocaleRuntimeLike | undefined): () => void {
      const target = locale
      if (!target)
        return () => { }
      const disposers = [
        target.register(namespace, 'zh', dicts.zh as Record<string, string>),
        target.register(namespace, 'en', dicts.en as Record<string, string>),
      ]
      active = target.getLocale().active
      const unsubscribe = target.subscribe(() => {
        active = target.getLocale().active
        for (const listener of listeners)
          listener()
      })
      return () => {
        unsubscribe()
        for (const disposer of disposers)
          disposer()
      }
    },
  }
  return handle
}
export type LocaleFeature<K extends string> = LocaleHandle<K> & {
  attach: (locale: LocaleRuntimeLike | undefined) => () => void
}
export function useStore<F extends {
  useStore: () => unknown
}>(facade: F): ReturnType<F['useStore']> {
  return facade.useStore() as ReturnType<F['useStore']>
}
export interface RegisterController {
  add: (disposer: (() => void) | void) => void
  listen: <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions) => void
  observe: (target: Node, handler: () => void, options?: MutationObserverInit) => void
}
export interface ClientAdapter {
  sessions: {
    list?: {
      getSnapshot: () => unknown
    }
    open?: (id: string) => void
  }
  workspaces: {
    list?: {
      getSnapshot: () => unknown
    }
    connectWorkspace?: (id: string) => Promise<string>
  }
}
export interface ClientContext {
  slots: {
    inject: (name: string, factory: () => (() => void) | void) => (() => void) | void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  locale?: LocaleRuntimeLike
  sessions?: ClientAdapter['sessions']
  workspaces?: ClientAdapter['workspaces']
  effect: (execute: () => () => void, label?: string) => unknown
}
export function defineRegister(setup: (controller: RegisterController, ctx: ClientContext, adapter: ClientAdapter) => void): (ctx: ClientContext, adapter: ClientAdapter) => () => void {
  return (ctx, adapter) => {
    const disposers: Array<() => void> = []
    const controller: RegisterController = {
      add: (disposer) => {
        if (typeof disposer === 'function')
          disposers.push(disposer)
      },
      listen: (type, handler, options) => {
        window.addEventListener(type, handler as EventListener, options)
        disposers.push(() => window.removeEventListener(type, handler as EventListener, options))
      },
      observe: (target, handler, options) => {
        const observer = new MutationObserver(handler)
        observer.observe(target, options)
        disposers.push(() => observer.disconnect())
      },
    }
    setup(controller, ctx, adapter)
    return () => {
      for (const disposer of disposers.splice(0))
        disposer()
    }
  }
}
export const PLUGIN_NAME = PLUGIN_ID
