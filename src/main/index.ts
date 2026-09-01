import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess
} from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type {
  AgentSnapshot,
  HostCommand,
  HostEvent,
  HostMessage,
  HostRequest,
  HostResponse
} from '../shared/contracts'
import { hostCommandSchema, hostMessageSchema } from '../shared/schemas'
import icon from '../../resources/icon.png?asset'

type PendingRequest = {
  resolve: (snapshot: AgentSnapshot) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let agentHost: UtilityProcess | null = null
let hostSpawned = false
let hostReady: Promise<void> | null = null
let resolveHostReady: (() => void) | null = null
let rejectHostReady: ((error: Error) => void) | null = null
const pendingRequests = new Map<string, PendingRequest>()
const AUTH_EXTERNAL_HOSTS = new Set(['auth.openai.com'])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function forwardEvent(event: HostEvent): void {
  if (event.event === 'open-external') {
    try {
      const target = new URL(event.data.url)
      if (target.protocol === 'https:' && AUTH_EXTERNAL_HOSTS.has(target.hostname)) {
        void shell.openExternal(target.toString())
      }
    } catch {
      // Ignore malformed provider URLs rather than handing them to the OS.
    }
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:event', event)
  }
}

function handleHostMessage(message: unknown): void {
  const parsed = hostMessageSchema.safeParse(message)
  if (!parsed.success) {
    console.warn('忽略无效 Agent Host 消息', parsed.error.message)
    return
  }
  const value = parsed.data as HostMessage
  if (value?.type === 'event') {
    forwardEvent(value)
    return
  }

  if (value?.type !== 'response') return
  const response = value as HostResponse
  const pending = pendingRequests.get(response.requestId)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingRequests.delete(response.requestId)
  if (response.ok && response.data) {
    pending.resolve(response.data as AgentSnapshot)
  } else {
    pending.reject(new Error(response.error ?? 'Agent Host 请求失败'))
  }
}

async function callHost(command: HostCommand): Promise<AgentSnapshot> {
  if (!hostSpawned) {
    if (!hostReady) throw new Error('Agent Host 尚未启动')
    await hostReady
  }
  if (!agentHost) throw new Error('Agent Host 尚未就绪')

  const requestId = randomUUID()
  const request: HostRequest = { ...command, requestId }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error(`Agent Host 请求超时：${command.type}`))
    }, 30_000)
    pendingRequests.set(requestId, { resolve, reject, timer })
    agentHost?.postMessage(request)
  })
}

function startAgentHost(): void {
  hostReady = new Promise((resolve, reject) => {
    resolveHostReady = resolve
    rejectHostReady = reject
  })
  void hostReady.catch(() => undefined)
  const script = join(__dirname, 'agent-host.js')
  agentHost = utilityProcess.fork(script, [], {
    serviceName: 'Pi Agent Host',
    stdio: 'pipe'
  })

  agentHost.stdout?.on('data', (chunk) => {
    if (is.dev) process.stdout.write(`[agent-host] ${String(chunk)}`)
  })
  agentHost.stderr?.on('data', (chunk) => {
    process.stderr.write(`[agent-host] ${String(chunk)}`)
  })
  agentHost.on('spawn', () => {
    hostSpawned = true
    resolveHostReady?.()
    resolveHostReady = null
    rejectHostReady = null
    agentHost?.postMessage({ type: 'bootstrap', requestId: randomUUID() } satisfies HostRequest)
  })
  agentHost.on('message', handleHostMessage)
  agentHost.on('exit', (code) => {
    hostSpawned = false
    agentHost = null
    const failure = new Error(`Agent Host 已退出（code ${code}）`)
    rejectHostReady?.(failure)
    resolveHostReady = null
    rejectHostReady = null
    hostReady = null
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(failure)
    }
    pendingRequests.clear()
  })
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('拒绝非主窗口 IPC 请求')
  }
  const source = new URL(event.senderFrame.url)
  if (is.dev) {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (!rendererUrl || source.origin !== new URL(rendererUrl).origin) {
      throw new Error('拒绝非本地开发页面 IPC 请求')
    }
  } else if (source.protocol !== 'file:') {
    throw new Error('拒绝非应用页面 IPC 请求')
  }
}

function registerIpc(): void {
  ipcMain.handle('pi:state', (event) => {
    assertTrustedRenderer(event)
    return callHost({ type: 'state:get' })
  })
  ipcMain.handle('pi:command', (event, command: HostCommand) => {
    assertTrustedRenderer(event)
    const parsed = hostCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的 Pi Desktop IPC 请求')
    return callHost(parsed.data)
  })
  ipcMain.handle('pi:select-project', async (event) => {
    assertTrustedRenderer(event)
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '选择 Pi 工作区',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择 Pi 工作区',
          properties: ['openDirectory', 'createDirectory']
        })

    const cwd = result.filePaths[0]
    if (result.canceled || !cwd) return null
    return callHost({ type: 'project:open', cwd })
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Pi Desktop',
    backgroundColor: '#0A0A0A',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        void shell.openExternal(target.toString())
      }
    } catch (error) {
      console.warn('拒绝打开无效链接', errorMessage(error))
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow.webContents.getURL()
    if (current && url === current) return
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('works.pi.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  registerIpc()
  startAgentHost()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  agentHost?.kill()
  agentHost = null
})
