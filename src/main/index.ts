import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type BrowserWindow as BrowserWindowType,
  type IpcMainInvokeEvent,
  type UtilityProcess
} from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type ElectronStore from 'electron-store'
import type {
  AgentSnapshot,
  BrowserCapabilityResponse,
  BrowserCommand,
  HostCommand,
  HostEvent,
  HostRequest,
  HostResult,
  SnapshotHostCommand,
  WorkbenchEvent
} from '../shared/contracts'
import {
  BUILTIN_BROWSER_VIEW_ID,
  WORKBENCH_CHANNEL,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_PANEL_CHANNEL
} from '../shared/workbench-contracts'
import {
  browserCapabilityCancelSchema,
  browserCapabilityRequestSchema,
  browserCommandSchema,
  hostCommandSchema
} from '../shared/schemas'
import { workbenchCommandSchema } from '../shared/workbench-schemas'
import { BrowserManager } from './browser-manager'
import { HostResponseBroker } from './host-response-broker'
import { assertE2EModeAllowed, canonicalExistingTempDirectory } from './e2e-temp-directory'
import { loadElectronStoreConstructor } from './electron-store-interop'
import { ProjectOpenCoordinator } from './project-open-coordinator'
import { pathToPersistAfterOpen, resolveExistingProjectPath } from './recent-project'
import {
  createWorkbenchHost,
  createWorkbenchPanelStateAdapter,
  type WorkbenchHost
} from './workbench-host'
import type { WorkbenchStateStore } from './workbench-host-state'
import { createWorkbenchPanelIpcRouter } from './workbench-panel-ipc'
import icon from '../../resources/icon.png?asset'

const E2E_MODE = process.env['PI_DESKTOP_E2E'] === '1'
assertE2EModeAllowed(E2E_MODE, app.isPackaged)

function requiredE2ETempPath(
  name: 'PI_DESKTOP_E2E_USER_DATA' | 'PI_DESKTOP_E2E_AGENT_DIR'
): string {
  return canonicalExistingTempDirectory(process.env[name], name)
}

const e2eAgentDir = E2E_MODE ? requiredE2ETempPath('PI_DESKTOP_E2E_AGENT_DIR') : null
if (E2E_MODE) app.setPath('userData', requiredE2ETempPath('PI_DESKTOP_E2E_USER_DATA'))

let agentHost: UtilityProcess | null = null
let hostSpawned = false
let hostReady: Promise<void> | null = null
let resolveHostReady: (() => void) | null = null
let rejectHostReady: ((error: Error) => void) | null = null
let preferences: ElectronStore<Preferences> | null = null
let browserManager: BrowserManager | null = null
let browserOwner: BrowserWindowType | null = null
let workbenchHost: WorkbenchHost | null = null
let activeHostIdentity: Pick<AgentSnapshot, 'sessionId' | 'generation'> = {
  sessionId: null,
  generation: 0
}
let activeProjectPath: string | null = null
const AUTH_EXTERNAL_HOSTS = new Set(['auth.openai.com'])
const responseBroker = new HostResponseBroker({
  onInvalid: (message) => console.warn('忽略无效 Agent Host 消息', message)
})
const projectOpenCoordinator = new ProjectOpenCoordinator<AgentSnapshot>()
const workbenchPanelIpc = createWorkbenchPanelIpcRouter({
  createAdapter: createWorkbenchPanelStateAdapter
})

type Preferences = {
  lastProjectPath?: string
  workbenchDesktopEnabled?: Record<string, boolean>
  workbenchPanelState?: Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function updateWorkbenchContext(): void {
  const host = workbenchHost
  if (!host) return
  try {
    host.setContext({
      projectPath: activeProjectPath,
      sessionId: activeHostIdentity.sessionId,
      generation: activeHostIdentity.generation
    })
  } catch (error) {
    console.warn('忽略过期的 Workbench 上下文', errorMessage(error))
  }
}

function forwardEvent(event: HostEvent): void {
  if (event.event === 'snapshot' || event.event === 'patch') {
    activeHostIdentity = {
      sessionId: event.data.sessionId,
      generation: event.data.generation
    }
    if (event.event === 'snapshot') {
      activeProjectPath = event.data.project?.path ?? null
      browserManager?.setProject(activeProjectPath)
    }
    if (event.event === 'patch' && 'project' in event.data.meta) {
      activeProjectPath = event.data.meta.project?.path ?? null
      browserManager?.setProject(activeProjectPath)
    }
    updateWorkbenchContext()
  }
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
  const capabilityRequest = browserCapabilityRequestSchema.safeParse(message)
  if (capabilityRequest.success) {
    const request = capabilityRequest.data
    if (
      request.generation !== activeHostIdentity.generation ||
      request.sessionId !== activeHostIdentity.sessionId
    ) {
      agentHost?.postMessage({
        type: 'capability-response',
        capability: 'browser',
        requestId: request.requestId,
        ok: false,
        error: '会话已切换，浏览器操作已取消'
      } satisfies BrowserCapabilityResponse)
      return
    }
    const manager = browserManager
    if (!manager) {
      agentHost?.postMessage({
        type: 'capability-response',
        capability: 'browser',
        requestId: request.requestId,
        ok: false,
        error: '浏览器工作台尚未就绪'
      } satisfies BrowserCapabilityResponse)
      return
    }
    browserOwner?.webContents.send(WORKBENCH_EVENT_CHANNEL, {
      type: 'reveal',
      viewId: BUILTIN_BROWSER_VIEW_ID
    } satisfies WorkbenchEvent)
    void manager
      .executeAgent(request.operation, request.requestId)
      .then((data) => {
        agentHost?.postMessage({
          type: 'capability-response',
          capability: 'browser',
          requestId: request.requestId,
          ok: true,
          data
        } satisfies BrowserCapabilityResponse)
      })
      .catch((error) => {
        agentHost?.postMessage({
          type: 'capability-response',
          capability: 'browser',
          requestId: request.requestId,
          ok: false,
          error: errorMessage(error)
        } satisfies BrowserCapabilityResponse)
      })
    return
  }
  const capabilityCancel = browserCapabilityCancelSchema.safeParse(message)
  if (capabilityCancel.success) {
    browserManager?.abortAgent(capabilityCancel.data.requestId)
    return
  }
  const event = responseBroker.accept(message)
  if (event) forwardEvent(event)
}

async function callHost(command: HostCommand): Promise<HostResult> {
  if (!hostSpawned) {
    if (!hostReady) throw new Error('Agent Host 尚未启动')
    await hostReady
  }
  if (!agentHost) throw new Error('Agent Host 尚未就绪')

  return responseBroker.request(command, (request) => {
    if (!agentHost) throw new Error('Agent Host 尚未就绪')
    agentHost.postMessage(request)
  })
}

async function callHostSnapshot(command: SnapshotHostCommand): Promise<AgentSnapshot> {
  const result = await callHost(command)
  if (result.kind !== 'snapshot') {
    throw new Error(`Agent Host 未返回状态快照：${command.type}`)
  }
  activeHostIdentity = {
    sessionId: result.snapshot.sessionId,
    generation: result.snapshot.generation
  }
  activeProjectPath = result.snapshot.project?.path ?? null
  browserManager?.setProject(activeProjectPath)
  updateWorkbenchContext()
  return result.snapshot
}

function preferenceStore(): ElectronStore<Preferences> {
  if (!preferences) throw new Error('偏好存储尚未就绪')
  return preferences
}

async function openCanonicalProject(canonicalPath: string): Promise<AgentSnapshot> {
  const snapshot = await callHostSnapshot({ type: 'project:open', cwd: canonicalPath })
  const persistedPath = pathToPersistAfterOpen(canonicalPath, snapshot)
  if (!persistedPath) throw new Error('Agent Host 未确认所选工作区')
  preferenceStore().set('lastProjectPath', persistedPath)
  return snapshot
}

async function openUserProject(candidatePath: unknown): Promise<AgentSnapshot> {
  const canonicalPath = await resolveExistingProjectPath(candidatePath)
  if (!canonicalPath) throw new Error('所选工作区不存在或不是文件夹')
  return projectOpenCoordinator.runUserOpen(() => openCanonicalProject(canonicalPath))
}

async function attemptRecentProjectRestore(): Promise<AgentSnapshot | null> {
  const store = preferenceStore()
  const storedPath = store.get('lastProjectPath')
  if (storedPath === undefined) return null

  const canonicalPath = await resolveExistingProjectPath(storedPath)
  if (!canonicalPath) {
    store.delete('lastProjectPath')
    return null
  }

  try {
    return await openCanonicalProject(canonicalPath)
  } catch (error) {
    store.delete('lastProjectPath')
    console.warn('无法恢复最近工作区', errorMessage(error))
    return null
  }
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
    stdio: 'pipe',
    ...(e2eAgentDir
      ? {
          env: {
            ...process.env,
            PI_DESKTOP_E2E: '1',
            PI_DESKTOP_E2E_AGENT_DIR: e2eAgentDir
          }
        }
      : {})
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
  agentHost.on('error', (error) => {
    console.error('Agent Host 进程错误', errorMessage(error))
  })
  agentHost.on('message', handleHostMessage)
  agentHost.on('exit', (code) => {
    hostSpawned = false
    agentHost = null
    browserManager?.abortAgent()
    const failure = new Error(`Agent Host 已退出（code ${code}）`)
    if (code !== 0) console.error(failure.message)
    rejectHostReady?.(failure)
    resolveHostReady = null
    rejectHostReady = null
    hostReady = null
    responseBroker.rejectAll(failure)
  })
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('拒绝非主窗口 IPC 请求')
  }
  const source = new URL(event.senderFrame.url)
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && rendererUrl) {
    if (source.origin !== new URL(rendererUrl).origin) {
      throw new Error('拒绝非本地开发页面 IPC 请求')
    }
  } else if (source.href !== pathToFileURL(join(__dirname, '../renderer/index.html')).href) {
    throw new Error('拒绝非应用页面 IPC 请求')
  }
}

function registerIpc(): void {
  ipcMain.handle('pi:state', async (event) => {
    assertTrustedRenderer(event)
    return projectOpenCoordinator.restoreThenRead(attemptRecentProjectRestore, () =>
      callHostSnapshot({ type: 'state:get' })
    )
  })
  ipcMain.handle('pi:command', async (event, command: HostCommand) => {
    assertTrustedRenderer(event)
    const parsed = hostCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的 Pi Desktop IPC 请求')
    if (parsed.data.type === 'project:open') {
      const snapshot = await openUserProject(parsed.data.cwd)
      return { kind: 'snapshot', snapshot } satisfies HostResult
    }
    if (parsed.data.type === 'browser:e2e' && !E2E_MODE) {
      throw new Error('该 Agent Browser 测试命令只在 E2E 模式可用')
    }
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
    return openUserProject(cwd)
  })
  ipcMain.handle('pi:browser', async (event, command: BrowserCommand) => {
    assertTrustedRenderer(event)
    const parsed = browserCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的浏览器 IPC 请求')
    const manager = browserManager
    if (!manager) throw new Error('浏览器工作台尚未就绪')
    switch (parsed.data.type) {
      case 'state:get':
        return { state: manager.getState() }
      case 'operate': {
        const result = await manager.executeUser(parsed.data.operation)
        return { state: manager.getState(), result }
      }
      case 'agent:stop':
        manager.abortAgent()
        return { state: manager.getState() }
      case 'e2e:agent': {
        if (!E2E_MODE) throw new Error('该浏览器测试命令只在 E2E 模式可用')
        const result = await manager.executeAgent(parsed.data.operation, randomUUID())
        return { state: manager.getState(), result }
      }
    }
  })
  ipcMain.handle(WORKBENCH_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = workbenchCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的 Workbench IPC 请求')
    const host = workbenchHost
    if (!host) throw new Error('Workbench 尚未就绪')
    return host.dispatch(parsed.data)
  })
  ipcMain.handle(WORKBENCH_PANEL_CHANNEL, (event, command: unknown) =>
    workbenchPanelIpc.handle(event, command)
  )
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

  browserOwner = mainWindow
  browserManager = new BrowserManager(mainWindow, (state) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pi:browser:event', { type: 'state', data: state })
    }
  })
  const workbenchStore: WorkbenchStateStore = {
    get: (key) => preferenceStore().get(key as keyof Preferences),
    set: (key, value) => {
      preferenceStore().set(key as keyof Preferences, value)
    }
  }
  workbenchHost = createWorkbenchHost({
    appVersion: app.getVersion(),
    agentDir: e2eAgentDir ?? join(homedir(), '.pi', 'agent'),
    preloadPath: join(__dirname, '../preload/plugin.js'),
    store: workbenchStore,
    window: mainWindow,
    browser: browserManager,
    panelSenderBinding: workbenchPanelIpc,
    onState: (state) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(WORKBENCH_EVENT_CHANNEL, {
          type: 'state',
          data: state
        } satisfies WorkbenchEvent)
      }
    }
  })
  updateWorkbenchContext()
  void workbenchHost.reload().catch((error) => {
    console.error('无法加载 Workbench 插件', errorMessage(error))
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
  mainWindow.on('closed', () => {
    if (browserOwner !== mainWindow) return
    workbenchHost?.dispose()
    workbenchHost = null
    browserManager?.dispose()
    browserManager = null
    browserOwner = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('works.pi.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const Store = await loadElectronStoreConstructor()
  preferences = new Store<Preferences>({
    name: 'pi-desktop-preferences',
    schema: {
      lastProjectPath: { type: 'string' },
      workbenchDesktopEnabled: {
        type: 'object',
        additionalProperties: { type: 'boolean' }
      },
      workbenchPanelState: { type: 'object' }
    }
  })

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
  workbenchHost?.dispose()
  workbenchHost = null
  browserManager?.dispose()
  browserManager = null
  agentHost?.kill()
  agentHost = null
})
