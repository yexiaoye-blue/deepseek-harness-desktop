import type { MotionInput } from 'dsh-pet-component'
import type { PointerEvent } from 'react'
import type { PetAsset, PetRuntimeStatus, PetSessionPayload, PetWorkStatus } from '../shared/types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Pet } from 'dsh-pet-component'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { alphaRectangles } from './alpha-mask'

interface NativeState {
  overlay_supported: boolean
  dragging: boolean
}
const motions: Record<PetWorkStatus, MotionInput> = {
  thinking: { type: 'thinking', loop: true },
  working: { type: 'working', loop: true },
  result: { type: 'result', loop: true },
  waiting: { type: 'waiting', loop: true },
  success: 'success',
  error: 'failed',
}
const overlay = (globalThis as {
  __DSH_PET_OVERLAY__?: boolean
}).__DSH_PET_OVERLAY__ === true
const nativeDrag = (globalThis as {
  __DSH_PET_NATIVE_DRAG__?: boolean
}).__DSH_PET_NATIVE_DRAG__ === true
function native(request: Record<string, unknown>): Promise<NativeState> {
  const bridge = (globalThis as {
    __DSH_PET_X11__?: { command: (request: Record<string, unknown>) => Promise<NativeState> }
  }).__DSH_PET_X11__
  if (bridge)
    return bridge.command(request)
  return invoke('pet_native', { request })
}
function openMenu() {
  void native({ kind: 'menu' }).catch(failure)
}
if (nativeDrag && typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = 'html,body,#root,#root *{-webkit-app-region:drag;-webkit-user-select:none;user-select:none}'
  document.head.appendChild(style)
  ;(globalThis as { __DSH_PET_MENU__?: () => void }).__DSH_PET_MENU__ = openMenu
  ;(globalThis as { __DSH_PET_CLICK__?: (x: number, y: number) => void }).__DSH_PET_CLICK__ = (x, y) => {
    const hit = document.querySelector('.dsh-pet__hitbox')
    if (!(hit instanceof HTMLElement)) return
    const rect = hit.getBoundingClientRect()
    if (x < rect.left || y < rect.top || x > rect.right || y > rect.bottom) return
    const base = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    hit.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }))
    hit.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  }
}
function failure(error: unknown) {
  const target = document.getElementById('error')
  if (target) {
    target.textContent = String(error)
    target.style.display = 'block'
  }
  void native({ kind: 'ready' }).catch(error => console.warn('PET_ERROR_WINDOW_FAILED', error))
}
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/dsh-pet-lite/${path}`, { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`PET_REQUEST_FAILED: ${response.status}`)
  return response.json() as Promise<T>
}
const sprites = new Map<string, HTMLImageElement>()
function mask() {
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(innerWidth)
  canvas.height = Math.ceil(innerHeight)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context)
    return []
  let drawn = false
  for (const media of document.querySelectorAll<HTMLVideoElement | HTMLCanvasElement>('video,canvas')) {
    if (media instanceof HTMLVideoElement && (media.readyState < 2))
      continue
    const bounds = media.getBoundingClientRect()
    if (!bounds.width || !bounds.height || Number(getComputedStyle(media).opacity) < 0.05)
      continue
    context.drawImage(media, bounds.x, bounds.y, bounds.width, bounds.height)
    drawn = true
  }
  for (const element of document.querySelectorAll<HTMLElement>('.dsh-pet__sprite')) {
    const style = getComputedStyle(element)
    const match = /^url\(["']?(.*?)["']?\)$/.exec(style.backgroundImage)
    if (!match)
      continue
    const url = match[1]!
    let image = sprites.get(url)
    if (!image) {
      image = new Image()
      image.crossOrigin = 'anonymous'
      image.src = url
      if (sprites.size >= 4)
        sprites.clear()
      sprites.set(url, image)
    }
    if (!image.complete || !image.naturalWidth)
      continue
    const bounds = element.getBoundingClientRect()
    const [scaleX, scaleY] = style.backgroundSize.split(' ').map(value => Number.parseFloat(value) / 100)
    const columns = scaleX || 8
    const rows = scaleY || 11
    const sx = Number.parseFloat(style.backgroundPositionX) / 100 * (image.naturalWidth - image.naturalWidth / columns)
    const sy = Number.parseFloat(style.backgroundPositionY) / 100 * (image.naturalHeight - image.naturalHeight / rows)
    context.save()
    if (style.transform.startsWith('matrix(-1')) {
      context.translate(bounds.x * 2 + bounds.width, 0)
      context.scale(-1, 1)
    }
    context.drawImage(image, sx, sy, image.naturalWidth / columns, image.naturalHeight / rows, bounds.x, bounds.y, bounds.width, bounds.height)
    context.restore()
    drawn = true
  }
  if (!drawn)
    return []
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  return alphaRectangles(data, canvas.width, canvas.height)
}
function App() {
  const [status, setStatus] = useState<PetRuntimeStatus | null>(null)
  const [asset, setAsset] = useState<PetAsset | null>(null)
  const [motion, setMotion] = useState<MotionInput>('idle')
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(Promise.resolve())
  const pressPoint = useRef<{ x: number, y: number } | null>(null)
  // keep:effect 订阅宿主窗口刷新事件并注销未完成的请求。
  useEffect(() => {
    let disposed = false
    async function refresh() {
      try {
        const next = await read<PetRuntimeStatus>('settings')
        const selected = await read<PetAsset>(`asset?id=${encodeURIComponent(next.active_pet)}`)
        if (!disposed) {
          setStatus(next)
          setAsset(selected)
        }
      }
      catch (error) {
        if (!disposed)
          failure(error)
      }
    }
    void refresh()
    const onRefresh = () => { void refresh() }
    window.addEventListener('dsh-pet-refresh', onRefresh)
    const unlisten = (globalThis as { __DSH_PET_X11__?: unknown }).__DSH_PET_X11__
      ? Promise.resolve(() => {})
      : listen('dsh-pet-refresh', onRefresh)
    return () => {
      disposed = true
      window.removeEventListener('dsh-pet-refresh', onRefresh)
      void unlisten.then(dispose => dispose())
    }
  }, [])
  // keep:effect 消费会话活动流，窗口卸载时关闭连接。
  useEffect(() => {
    const source = new EventSource('/dsh-pet-lite/session/stream')
    source.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data) as {
          payload?: PetSessionPayload
        }
        const state = value.payload?.workStatus
        if (state && state in motions)
          setMotion(motions[state])
      }
      catch (error) {
        console.warn('PET_SESSION_FRAME_INVALID', error)
      }
    }
    return () => source.close()
  }, [])
  const width = (asset?.kind === 'dsh' ? (asset.size ?? 200) : 200) * (status?.pet_size ?? 100) / 100
  const height = width * (asset?.kind === 'codex' ? 208 / 192 : 9 / 16)
  // keep:effect 资源或尺寸改变后同步原生窗口尺寸，不写窗口位置。
  useEffect(() => {
    if (asset)
      void native({ kind: 'resize', width: Math.ceil(width + 96), height: Math.ceil(height + 96) }).catch(failure)
  }, [width, height, asset])
  // keep:effect 为视频声明跨域读取，并在卸载时移除新媒体节点监听。
  useEffect(() => {
    function prepare() {
      for (const video of document.querySelectorAll('video')) {
        if (video.crossOrigin === 'anonymous')
          continue
        video.crossOrigin = 'anonymous'
        if (video.currentSrc || video.getAttribute('src'))
          video.load()
      }
    }
    const observer = new MutationObserver(prepare)
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
    prepare()
    return () => observer.disconnect()
  }, [])
  // keep:effect 只在动画帧轮廓改变时更新原生输入区域。
  useEffect(() => {
    if (!asset || !overlay)
      return
    let disposed = false
    let frame = 0
    let pending = false
    let previous = ''
    let last = 0
    let sequence = 0
    function sample(at: number) {
      if (disposed)
        return
      frame = requestAnimationFrame(sample)
      if (pending || at - last < 32)
        return
      last = at
      try {
        const rectangles = mask()
        const signature = JSON.stringify(rectangles)
        if (signature === previous)
          return
        previous = signature
        pending = true
        void native({ kind: 'frame', frame: ++sequence, rectangles }).catch(failure).finally(() => {
          pending = false
        })
      }
      catch (error) {
        failure(error)
        disposed = true
      }
    }
    frame = requestAnimationFrame(sample)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
    }
  }, [asset])
  function pointer(action: string, event: PointerEvent<HTMLDivElement>) {
    if (nativeDrag) {
      if (action === 'press' && event.button === 0)
        void native({ kind: 'pointer', action: 'press' }).catch(failure)
      return
    }
    if (!overlay || (action === 'press' && event.button !== 0))
      return
    event.preventDefault()
    if (action === 'press') {
      pressPoint.current = { x: event.clientX, y: event.clientY }
      setDragging(false)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    if (action === 'release' || action === 'cancel') {
      pressPoint.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId)
      setDragging(false)
    }
    inputRef.current = inputRef.current.then(async () => {
      await native({ kind: 'pointer', action })
    }).catch(failure)
  }
  function follow(event: PointerEvent<HTMLDivElement>) {
    const start = pressPoint.current
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (dx * dx + dy * dy >= 25) setDragging(true)
  }
  if (!asset || !status)
    return null
  const config = asset.kind === 'dsh'
    ? asset.config
    : {
        kind: 'codex' as const,
        spriteVersionNumber: asset.sprite_version_number === 2 ? 2 as const : 1 as const,
        columns: asset.columns,
        rows: asset.rows,
      }
  const uri = asset.kind === 'dsh' ? asset.uri : asset.spritesheet
  return (
    <div
      style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', cursor: overlay || nativeDrag ? 'grab' : 'default' }}
      onPointerDown={event => pointer('press', event)}
      onPointerMove={event => follow(event)}
      onPointerUp={event => pointer('release', event)}
      onPointerCancel={event => pointer('cancel', event)}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu()
      }}
    >
      <Pet
        kind={asset.kind}
        config={config}
        uri={uri}
        ext={asset.kind === 'dsh' ? asset.ext : undefined}
        size={width}
        motion={motion}
        dragging={dragging}
        cache={true}
        style={{ cursor: overlay || nativeDrag ? 'grab' : 'default' }}
        onReady={() => {
          void native({ kind: 'ready' }).catch(failure)
        }}
        onError={failure}
      />
    </div>
  )
}
const root = document.getElementById('root')
if (!root)
  throw new Error('PET_RENDERER_ROOT_MISSING')
createRoot(root).render(<App />)
