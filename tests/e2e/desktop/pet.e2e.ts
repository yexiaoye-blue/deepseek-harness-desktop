import type { ShellApp } from '../setup/shell'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invoke, startShellApp, WINDOW_TIMEOUT_MS } from '../setup/shell'

let app: ShellApp
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><head><title>Pet native fixture</title><style>html,body{margin:0;background:transparent}</style></head><body></body></html>')
})

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(1420, 'localhost', resolve)
  })
  app = await startShellApp({ electronArgs: ['--ozone-platform=x11'] })
})
afterAll(async () => {
  await app?.stop()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

interface PetState { desktop_open: boolean, overlay_supported: boolean, dragging: boolean, position: [number, number] }

describe('pet native window ownership', () => {
  it('keeps one pet window in the main runtime while the main window is hidden', async () => {
    const main = app.window.page
    await main.goto('http://localhost:1420/')
    const sync = () => invoke<PetState>(main, 'pet_native', { request: { kind: 'sync', enabled: true, throw_enabled: false } })
    const first = await sync()
    expect(first.desktop_open, '宿主必须创建宠物原生窗口').toBe(true)
    expect(first.overlay_supported, 'X11 后端必须提供定位与置顶能力').toBe(true)
    await sync()
    await expect.poll(async () => (await app.windows()).map(window => window.label).filter(label => label === 'pet'), { timeout: WINDOW_TIMEOUT_MS, message: '重复同步不得创建第二个宠物窗口' }).toEqual(['pet'])
    const pet = (await app.windows()).find(window => window.label === 'pet')!
    await expect.poll(() => new URL(pet.page.url()).pathname, { timeout: WINDOW_TIMEOUT_MS, message: '宠物必须加载独立的渲染文档' }).toBe('/dsh-pet-lite/desktop')
    await invoke(pet.page, 'pet_native', { request: { kind: 'ready' } })
    expect(await invoke(main, 'plugin:window|is_visible', { label: 'pet' }), '宠物就绪后必须显示').toBe(true)
    expect(await invoke(main, 'plugin:window|is_resizable', { label: 'pet' }), '宠物不允许缩放窗口边框').toBe(false)
    expect(await invoke(main, 'plugin:window|is_decorated', { label: 'pet' }), '宠物必须无边框').toBe(false)
    expect(await invoke(main, 'plugin:window|is_always_on_top', { label: 'pet' }), '宠物必须保持置顶').toBe(true)
    await invoke(main, 'plugin:window|minimize', { label: 'main' })
    expect(await invoke(main, 'plugin:window|is_visible', { label: 'pet' }), '最小化主窗口不得隐藏宠物').toBe(true)
    await invoke(main, 'plugin:window|unminimize', { label: 'main' })
    await invoke(main, 'plugin:window|hide', { label: 'main' })
    expect(await invoke(main, 'plugin:window|is_visible', { label: 'pet' }), '隐藏主窗口不得隐藏宠物').toBe(true)
    const state = await invoke<PetState>(main, 'pet_native', { request: { kind: 'state' } })
    expect(state.position, '隐藏主窗口不得重排宠物位置').toEqual(first.position)
    await expect(invoke(pet.page, 'pet_native', { request: { kind: 'sync', enabled: false, throw_enabled: false } }), '宠物页面不得修改主程序设置').rejects.toThrow('PET_COMMAND_DENIED')
    await invoke(main, 'pet_native', { request: { kind: 'sync', enabled: false, throw_enabled: false } })
    await expect.poll(async () => (await app.windows()).map(window => window.label), { timeout: WINDOW_TIMEOUT_MS, message: '关闭宠物必须销毁其原生窗口' }).toEqual(['main'])
    await invoke(main, 'plugin:window|show', { label: 'main' })
  })
})
