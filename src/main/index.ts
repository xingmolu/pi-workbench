import { ProcessCpuSampler } from './process-cpu-sampler'
import { NAVIGATION_LIBRARY_CHANNEL, projectIsHidden } from '../shared/navigation-library'
import { NavigationLibrary } from './navigation-library'
import { DESKTOP_SETTINGS_CHANNEL } from '../shared/desktop-settings'
import { DESKTOP_CONTROL_CHANNEL } from '../shared/desktop-control'
import { SessionWorkerSupervisor } from './session-worker-supervisor'
import { UtilityProcessAgentRuntime } from './utility-session-worker'
import { AgentRuntimeProviderRegistry } from './agent-runtime'
import { ForegroundCapabilityRouter } from './foreground-capability-router'
import { WorkerMutationCapabilities } from './worker-mutation-capabilities'
import { PluginAgentBridge } from './plugin-agent-bridge'
import { desktopCommandOriginSchema, type DesktopCommandOrigin, type SelectedSessionScope } from '../shared/session-runtime'
import { piPackageRootsMessageSchema } from '../shared/workbench-host-schemas'
import { applyStatePatch } from '../shared/state-patch'
import { GlobalConfigurationGate } from './global-configuration-gate'
import { handleDesktopSettings } from './desktop-settings'
import { DesktopControlService } from './desktop-control-service'
import { NativePaletteFocus } from './native-palette-focus'
import { NATIVE_PALETTE_FOCUS_CHANNEL, nativePaletteFocusSchema } from '../shared/native-palette-focus'
import {
  app,
  BrowserWindow,
  WebContentsView,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeTheme,
  powerSaveBlocker,
  screen,
  clipboard,
  shell,
  systemPreferences,
  utilityProcess,
  type BrowserWindow as BrowserWindowType,
  type IpcMainInvokeEvent,
  type UtilityProcess
} from 'electron'
import { randomUUID } from 'node:crypto'
import { MarkdownTableExporter } from './markdown-table-export'
import { MARKDOWN_TABLE_EXPORT_CHANNEL } from '../shared/markdown-table-export'
import { TextAttachments } from './text-attachments'
import { AttachmentSubmissions } from './attachment-submissions'
import {
  TEXT_ATTACHMENT_CHANNEL,
  attachmentCommandSchema,
  formatTextContext
} from '../shared/text-attachments'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type ElectronStore from 'electron-store'
import type {
  AgentSnapshot,
  BrowserCommand,
  HostCommand,
  DesktopEvent,
  HostRequest,
  HostResult,
  PermissionMode,
  SnapshotHostCommand,
  WorkbenchEvent
} from '../shared/contracts'
import {
  BROWSER_PLUGIN_ID,
  BROWSER_VIEW_ID,
  TERMINAL_PLUGIN_ID,
  WORKBENCH_CHANNEL,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_PANEL_CHANNEL
} from '../shared/workbench-contracts'
import {
  browserCommandSchema,
  hostCommandSchema
} from '../shared/schemas'
import { workbenchCommandSchema } from '../shared/workbench-schemas'
import { WORKSPACE_FILES_CHANNEL, workspaceFilesCommandSchema } from '../shared/workspace-files'
import { WorkspaceFiles } from './workspace-files'
import { GIT_REVIEW_CHANNEL, gitReviewCommandSchema } from '../shared/git-review'
import { GitReview } from './git-review'
import { GitReviewProcess } from './git-review-process'
import {
  createUserGitPushRunner,
  PluginFileService,
  PluginGitService
} from './plugin-services'
import { TerminalManager } from './terminal-manager'
import { TERMINAL_CHANNEL, TERMINAL_EVENT_CHANNEL } from '../shared/terminal'
import { resolveShell, terminalEnvironment } from '../shared/terminal-shell'
import { BrowserManager } from './browser-manager'
import { RemoteBrowser } from './remote-browser'
import { RemoteTerminals } from './remote-terminals'
import { createRemoteViewsBridge } from './remote-views-bridge'
import type { RemoteViewAccess } from '../shared/remote-views'
import { ComputerUseService } from './computer-use-service'
import { HostResponseBroker } from './host-response-broker'
import { assertE2EModeAllowed, canonicalExistingTempDirectory } from './e2e-temp-directory'
import { loadElectronStoreConstructor } from './electron-store-interop'
import { ProjectOpenCoordinator } from './project-open-coordinator'
import { pathToPersistAfterOpen, resolveExistingProjectPath } from './recent-project'
import { mergeRecentProjects } from './recent-projects'
import {
  createWorkbenchHost,
  createWorkbenchPanelStateAdapter,
  type WorkbenchHost
} from './workbench-host'
import type { WorkbenchStateStore } from './workbench-host-state'
import { createWorkbenchPanelIpcRouter } from './workbench-panel-ipc'
import { createPiPackageRootsLifecycle } from './workbench-package-roots'
import { MOBILE_GATEWAY_CHANNEL, type MobileConversationSnapshot, type PairedDeviceRecord } from '../shared/mobile-gateway'
import { MobileGatewayService } from './mobile-gateway-service'
import {
  liveToMobile,
  toMobileSnapshot,
  type MobileSessionBridge
} from './mobile-session-bridge'
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
let lobbySnapshot: AgentSnapshot | null = null
let hostReady: Promise<void> | null = null
let resolveHostReady: (() => void) | null = null
let rejectHostReady: ((error: Error) => void) | null = null
let preferences: ElectronStore<Preferences> | null = null
let browserManager: BrowserManager | null = null
/** Phones watching the desktop browser; created with the main window. */
let remoteBrowser: RemoteBrowser | null = null
let browserOwner: BrowserWindowType | null = null
let desktopControl: DesktopControlService | null = null
let computerUse: ComputerUseService | null = null
let lobbyOwnerId: string | null = null
const browserScopeOwners = new Map<string, object>()
/** Whether a bundled package is enabled. Before the registry exists, assume on. */
function bundledPluginEnabled(owner: string): boolean {
  const snapshot = workbenchHost?.snapshot()
  if (!snapshot) return true
  return snapshot.plugins.some(
    ({ pluginId, desktopEnabled }) => pluginId === owner && desktopEnabled
  )
}

/** The terminal ships as the bundled `works.pi.terminal` package; off means no new shells. */
function terminalPluginEnabled(): boolean {
  return bundledPluginEnabled(TERMINAL_PLUGIN_ID)
}

/** The browser ships as the bundled `works.pi.browser` package; off means no view and no tool. */
function browserPluginEnabled(): boolean {
  return bundledPluginEnabled(BROWSER_PLUGIN_ID)
}

const foregroundCapabilities = new ForegroundCapabilityRouter({
  authority: owner => ({
    selected: !browserOwner || quitInProgress ? null : sessionWorkers.selectedScope ?? (lobbyOwnerId
      ? { workerId: lobbyOwnerId, selectionEpoch: sessionWorkers.selectionEpoch } : null),
    identity: owner === lobbyOwnerId ? lobbySnapshot : sessionWorkers.tryGetSnapshot(owner)
  }),
  execute: async (request, ownerId, executionId, signal) => {
    switch (request.capability) {
      case 'browser': {
        const manager = browserManager
        if (!manager) throw new Error('浏览器工作台尚未就绪')
        if (!browserPluginEnabled())
          throw new Error('浏览器插件已关闭。在「设置 › Desktop 插件」中打开「浏览器」后，Pi 才能使用浏览器。')
        browserOwner?.webContents.send(WORKBENCH_EVENT_CHANNEL, { type: 'reveal', viewId: BROWSER_VIEW_ID } satisfies WorkbenchEvent)
        const owner = browserScopeOwners.get(ownerId) ?? {}
        browserScopeOwners.set(ownerId, owner)
        const scope = { owner, projectPath: activeProjectPath ?? '', sessionId: request.sessionId, generation: request.generation }
        return manager.executePrepared(scope, manager.prepare(scope, request.operation), executionId)
      }
      case 'computer-use':
        if (!computerUse) throw new Error('Computer Use 尚未就绪')
        return computerUse.execute(request.operation, { ownerId, sessionId: request.sessionId, generation: request.generation }, signal)
    }
  },
  abortBrowser: executionId => browserManager?.abortAgent(executionId),
  releaseOwner: owner => {
    computerUse?.releaseOwner(owner)
    const browserScopeOwner = browserScopeOwners.get(owner)
    if (browserScopeOwner) browserManager?.invalidateAgentScope(browserScopeOwner)
    browserScopeOwners.delete(owner)
  }
})

const nativePaletteFocus = new NativePaletteFocus()
const paletteSourceIdentity = (): string => JSON.stringify([activeProjectPath, activeHostIdentity.sessionId, activeHostIdentity.generation])
let workbenchHost: WorkbenchHost | null = null
let activeHostIdentity: Pick<AgentSnapshot, 'sessionId' | 'generation'> = {
  sessionId: null,
  generation: 0
}
let activeProjectPath: string | null = null
const workspaceFiles = new WorkspaceFiles()
const textAttachments = new TextAttachments()
const attachmentSubmissions = new AttachmentSubmissions({ retainUncertain: true })
let gitReview: GitReview | null = null
let mobileGateway: MobileGatewayService | null = null
const terminalManager = new TerminalManager({
  canonicalProject: resolveExistingProjectPath,
  startHost: async (handlers) => {
    let account: { homedir: string; username: string; shell: string | null }
    try {
      account = userInfo()
    } catch {
      account = { homedir: homedir(), username: 'user', shell: '/bin/zsh' }
    }
    const terminalHome = E2E_MODE
      ? canonicalExistingTempDirectory(
          await mkdtemp(join(e2eAgentDir!, 'terminal-home-')),
          'Terminal fixture HOME'
        )
      : account.homedir
    const executable = (path: string): boolean => {
      try {
        accessSync(path, fsConstants.X_OK)
        return true
      } catch {
        return false
      }
    }
    // The isolated fixture keeps a fixed, minimal environment; real use inherits the user's.
    const shell = resolveShell(E2E_MODE ? [] : [account.shell, process.env.SHELL], executable)
    const terminalEnv = E2E_MODE
      ? {
          HOME: terminalHome,
          USER: 'terminal-fixture',
          LOGNAME: 'terminal-fixture',
          SHELL: shell,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          TMPDIR: app.getPath('temp'),
          LANG: 'en_US.UTF-8',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'PiDesktop',
          ZDOTDIR: terminalHome
        }
      : terminalEnvironment(process.env, {
          shell,
          home: terminalHome,
          version: app.getVersion()
        })
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(
        join(__dirname, 'terminal-host.js'),
        E2E_MODE ? ['--isolated-terminal-fixture'] : [],
        {
          serviceName: 'Pi User Terminal Host',
          stdio: 'pipe',
          env: terminalEnv
        }
      )
      // Deliberately drain without logging terminal data or native exception payloads.
      child.stdout?.resume()
      child.stderr?.on('data', () => handlers.diagnostic())
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('终端服务启动超时'))
      }, 4000)
      child.on('message', handlers.message)
      child.on('exit', () => {
        clearTimeout(timeout)
        handlers.exit()
        reject(new Error('终端服务已退出'))
      })
      child.on('error', () => {
        clearTimeout(timeout)
        child.kill()
        handlers.exit()
        reject(new Error('终端服务启动失败'))
      })
      child.once('spawn', () => {
        clearTimeout(timeout)
        resolve(child)
      })
    })
  }
})
/** Terminal output for paired phones; recording starts with the first terminal. */
const remoteTerminals = new RemoteTerminals(() => terminalManager)
remoteTerminals.attach()
let activeSessionPath: string | null = null
let workbenchContextGeneration = 0
let workbenchContextKey = ''
let selectedWorkerId: string | null = null
const mutationCapabilities = new WorkerMutationCapabilities()
const pluginAgentBridge = new PluginAgentBridge({
  contributions: async () => (workbenchHost ? workbenchHost.agentContributions() : null),
  runTool: (pluginId, name, input, signal) => {
    if (!workbenchHost) return Promise.reject(new Error('插件运行时不可用'))
    return workbenchHost.runAgentTool(pluginId, name, input, signal)
  },
  foregroundProject: () => activeProjectPath
})
const workerRoots = new Map<string, unknown>()
type MobileWorkerListener = (event: {
  workerId: string
  snapshot: MobileConversationSnapshot
  runFinished: boolean
}) => void
const mobileSessionListeners = new Set<MobileWorkerListener>()
const mobileWorkerStatus = new Map<string, string>()
function publishMobileWorker(workerId: string, snapshot: AgentSnapshot | null): void {
  if (!snapshot) {
    mobileWorkerStatus.delete(workerId)
    return
  }
  const live = sessionWorkers.findLiveSummary(workerId)
  const mobile = toMobileSnapshot(workerId, live?.cwd ?? snapshot.project?.path ?? '', snapshot)
  const previous = mobileWorkerStatus.get(workerId)
  mobileWorkerStatus.set(workerId, snapshot.status)
  const runFinished = Boolean(
    previous &&
      previous !== snapshot.status &&
      (previous === 'running' || previous === 'awaiting-approval') &&
      (snapshot.status === 'idle' || snapshot.status === 'stopped' || snapshot.status === 'error')
  )
  for (const listener of mobileSessionListeners)
    listener({ workerId, snapshot: mobile, runFinished })
}
const runtimeProviders = new AgentRuntimeProviderRegistry()
runtimeProviders.register(
  new UtilityProcessAgentRuntime({
    script: join(__dirname, 'agent-host.js'),
    ...(e2eAgentDir
      ? { env: { ...process.env, PI_DESKTOP_E2E: '1', PI_DESKTOP_E2E_AGENT_DIR: e2eAgentDir } }
      : {}),
    onMessage: (worker, message, reply) =>
      handleWorkerCapability(worker.workerId, worker.cwd, message, reply)
  })
)

const sessionWorkers = new SessionWorkerSupervisor({
  runtime: runtimeProviders.get('pi'),
  publish: forwardEvent,
  receiptsSettled: workerReceiptsSettled,
  selected: snapshot => {
    foregroundCapabilities.invalidate()
    const workerId = snapshot.desktopScope!.workerId
    if (selectedWorkerId !== workerId || snapshot.desktopScope!.selectionEpoch !== lastSelectionEpoch) {
      nativePaletteFocus.invalidate()
      packageRootsLifecycle.hostExited()
      packageRootsLifecycle.hostStarted()
      selectedWorkerId = workerId
      lastSelectionEpoch = snapshot.desktopScope!.selectionEpoch
    }
  },
  onNeedsSnapshot: workerId => {
    void sessionWorkers.resyncWorker(workerId).catch(() => {})
  },
  onWorkerEvent: (workerId, snapshot) => { foregroundCapabilities.invalidate(); publishMobileWorker(workerId, snapshot) },
  onExit: (workerId, error) => {
    foregroundCapabilities.cancelOwner(workerId)
    mutationCapabilities.exit(workerId)
    pluginAgentBridge.cancelOwner(workerId)
    attachmentSubmissions.retireWorker(workerId)
    const failed = sessionWorkers.findLiveSummary(workerId)
    if (failed?.sessionId && failed.generation !== null) attachmentSubmissions.retireScope({ projectPath: failed.cwd, sessionId: failed.sessionId, generation: failed.generation })
    workerRoots.delete(workerId)
    sessionWorkers.summaries()
    if (selectedWorkerId !== workerId || quitInProgress) return
    selectedWorkerId = null
    recoveryTarget = { project: activeProjectPath, session: activeSessionPath }
    foregroundCapabilities.invalidate()
    packageRootsLifecycle.hostExited()
    workspaceFiles.setProject(null)
    textAttachments.setContext(null)
    attachmentSubmissions.setContext(null)
    gitReview?.setProject(null)
    forwardEvent({ type: 'event', event: 'disconnected', data: { message: error?.message ?? '当前会话已断开；其他会话仍可继续。重新连接不会自动重发任务。' } })
  }
})

function startPerformanceDiagnostics(): void {
  if (process.env.PI_DESKTOP_PERF_LOG !== '1') return

  const cpuSampler = new ProcessCpuSampler()
  const sample = (): void => {
    try {
      const metrics = app.getAppMetrics()
      const coreCpu = cpuSampler.sample(metrics, performance.now())
      const processes = metrics
        .map((metric, index) => ({
          pid: metric.pid,
          type: metric.type,
          name: metric.name,
          serviceName: metric.serviceName,
          coreCpuPercent: coreCpu[index] === null ? null : Number(coreCpu[index]!.toFixed(1)),
          electronCpuPercent: Number(metric.cpu.percentCPUUsage.toFixed(1)),
          idleWakeupsPerSecond: Number(metric.cpu.idleWakeupsPerSecond.toFixed(1)),
          workingSetMiB: Number((metric.memory.workingSetSize / 1024).toFixed(1))
        }))
        .sort((left, right) => (right.coreCpuPercent ?? -1) - (left.coreCpuPercent ?? -1))

      const browserState = browserManager?.getState()
      console.log(
        '[perf]',
        JSON.stringify({
          at: new Date().toISOString(),
          ...sessionWorkers.getDiagnostics(),
          lobby: { pid: agentHost?.pid ?? null, pendingRequests: responseBroker.pendingCount },
          foregroundCapabilitiesPending: foregroundCapabilities.pendingCount,
          computerUseStates: computerUse?.stateCount ?? 0,
          mobileGateway: mobileGateway?.getDiagnostics() ?? null,
          browserPages: browserState?.pages.length ?? 0,
          browserVisible: browserState?.visible ?? false,
          processes
        })
      )
    } catch (error) {
      console.warn('[perf] sample failed', errorMessage(error))
    }
  }

  sample()
  const timer = setInterval(sample, 5000)
  timer.unref()
  app.once('before-quit', () => clearInterval(timer))
}

let lastSelectionEpoch = 0
function workerReceiptsSettled(workerId: string, snapshot: AgentSnapshot): boolean {
  return !snapshot.edit?.pending && !mutationCapabilities.hasPending(workerId) && ![...attachmentSubmissions.values()].some(entry => (entry.workerId === workerId || (entry.scope.sessionId === snapshot.sessionId && entry.scope.generation === snapshot.generation)) && entry.receipt.status === 'uncertain')
}
function refreshWorkerSafety(workerId: string): void {
  try {
    const snapshot = sessionWorkers.getSnapshot(workerId)
    if (snapshot) sessionWorkers.updateSafety(workerId, { receipts: workerReceiptsSettled(workerId, snapshot) ? 'settled' : 'pending', unsaved: !snapshot.activeSessionPath })
  } catch { /* A receipt can settle after its worker has exited. */ }
}
let recoveryTarget: { project: string | null; session: string | null } | null = null
let reconnectingHost: Promise<AgentSnapshot> | null = null
const packageRootsLifecycle = createPiPackageRootsLifecycle({
  initialIdentity: activeHostIdentity,
  warn: (warning) => console.warn(warning)
})
const AUTH_EXTERNAL_HOSTS = new Set(['auth.openai.com'])
const responseBroker = new HostResponseBroker({
  onInvalid: (message) => console.warn('忽略无效 Agent Host 消息', message)
})
const projectOpenCoordinator = new ProjectOpenCoordinator<AgentSnapshot>()
const workbenchPanelIpc = createWorkbenchPanelIpcRouter({
  createAdapter: createWorkbenchPanelStateAdapter
})

type Preferences = {
  desktopSettings?: import('../shared/desktop-settings').DesktopSettings
  navigationLibrary?: import('../shared/navigation-library').NavigationLibraryState
  recentProjects?: string[]
  lastProjectPath?: string
  workbenchDesktopEnabled?: Record<string, boolean>
  workbenchPanelState?: Record<string, unknown>
  mobileDevices?: PairedDeviceRecord[]
  mobileRemoteViews?: RemoteViewAccess
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Only the user's global commit identity is read; plugin git otherwise ignores global config. */
/** Bundled plugins are unpacked from the asar archive so they are real files on disk. */
function bundledPluginDirectory(): string {
  return join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', 'plugins')
}

async function gitCommitIdentity(): Promise<{ name: string; email: string } | null> {
  const read = (key: string): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        '/usr/bin/git',
        ['config', '--global', '--get', key],
        { env: { HOME: homedir(), PATH: '/usr/bin:/bin' }, timeout: 3000 },
        (error, stdout) => resolve(error ? '' : String(stdout).trim())
      )
    })
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  return name && email && !/[\0\n]/.test(name + email) ? { name, email } : null
}

/** The foreground session's approval level; plugin writes follow it. */
let activePermissionMode: PermissionMode = 'ask'

function updateWorkbenchContext(): void {
  attachmentSubmissions.setContext(
    activeProjectPath && activeHostIdentity.sessionId
      ? {
          projectPath: activeProjectPath,
          sessionId: activeHostIdentity.sessionId,
          generation: activeHostIdentity.generation
        }
      : null
  )
  textAttachments.setContext(
    activeProjectPath && activeHostIdentity.sessionId
      ? {
          projectPath: activeProjectPath,
          sessionId: activeHostIdentity.sessionId,
          generation: activeHostIdentity.generation
        }
      : null
  )
  workspaceFiles.setProject(activeProjectPath)
  gitReview?.setProject(activeProjectPath)
  terminalManager.setProject(activeProjectPath ?? recoveryTarget?.project ?? null)
  const host = workbenchHost
  if (!host) return
  try {
    const key = JSON.stringify([selectedWorkerId, activeProjectPath, activeHostIdentity])
    if (key !== workbenchContextKey) { workbenchContextKey = key; workbenchContextGeneration++ }
    host.setContext({
      projectPath: activeProjectPath,
      sessionId: activeHostIdentity.sessionId,
      generation: workbenchContextGeneration
    })
  } catch (error) {
    console.warn('忽略过期的 Workbench 上下文', errorMessage(error))
  }
}

function forwardEvent(event: DesktopEvent): void {
  if (!sessionWorkers.hasSelection) {
    if (event.event === 'snapshot') event = { ...event, data: { ...event.data, desktopEpoch: sessionWorkers.selectionEpoch } }
    if (event.event === 'patch') event = { ...event, data: { ...event.data, meta: { ...event.data.meta, desktopEpoch: sessionWorkers.selectionEpoch } } }
  }
  if (event.event === 'snapshot' || event.event === 'patch') {
    const nextIdentity = {
      sessionId: event.data.sessionId,
      generation: event.data.generation
    }
    packageRootsLifecycle.transitionIdentity(nextIdentity, () => {
      activeHostIdentity = nextIdentity
      if (event.event === 'snapshot') {
        activePermissionMode = event.data.permissionMode
        activeSessionPath = event.data.activeSessionPath
        activeProjectPath = event.data.project?.path ?? null
        browserManager?.setProject(activeProjectPath)
      }
      if (event.event === 'patch' && 'project' in event.data.meta) {
        activeProjectPath = event.data.meta.project?.path ?? null
        browserManager?.setProject(activeProjectPath)
      }
      if (event.event === 'patch' && event.data.meta.permissionMode !== undefined) {
        activePermissionMode = event.data.meta.permissionMode
      }
      if (event.event === 'patch' && 'activeSessionPath' in event.data.meta) {
        activeSessionPath = event.data.meta.activeSessionPath ?? null
      }
      updateWorkbenchContext()
    })
    if (selectedWorkerId) {
      const roots = workerRoots.get(selectedWorkerId)
      if (roots) packageRootsLifecycle.handleMessage(roots)
    }
  }
  if (event.event === 'open-external') {
    try {
      const target = new URL(event.data.url)
      // MCP authorization pages belong to servers the user trusted and asked to sign in to.
      const allowed = event.data.mcp
        ? !target.username && !target.password &&
          (target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))
        : target.protocol === 'https:' && AUTH_EXTERNAL_HOSTS.has(target.hostname)
      if (allowed) void shell.openExternal(target.toString())
    } catch {
      // Ignore malformed provider URLs rather than handing them to the OS.
    }
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:event', event)
  }
}

function handleHostMessage(child: UtilityProcess, owner: string, message: unknown): void {
  if (agentHost !== child) return
  if (packageRootsLifecycle.handleMessage(message)) return
  if (pluginAgentBridge.handle(owner, message, response => child.postMessage(response))) return
  if (foregroundCapabilities.handle(owner, message, response => child.postMessage(response))) return
  const event = responseBroker.accept(message)
  if (event?.event === 'snapshot') lobbySnapshot = event.data
  if (event?.event === 'patch' && lobbySnapshot) {
    const applied = applyStatePatch(lobbySnapshot, event.data)
    if (applied.status === 'applied') lobbySnapshot = applied.snapshot
  }
  foregroundCapabilities.invalidate()
  if (event && !sessionWorkers.selectedScope) forwardEvent(event)
}

function handleWorkerCapability(workerId: string, cwd: string, message: unknown, reply: (message: unknown) => void): boolean {
  let snapshot: AgentSnapshot | null = null
  try { snapshot = sessionWorkers.getSnapshot(workerId) } catch { /* Child may still be bootstrapping. */ }
  if (mutationCapabilities.handle(workerId, cwd, snapshot, message, reply)) return true
  if (pluginAgentBridge.handle(workerId, message, reply)) return true
  const roots = piPackageRootsMessageSchema.safeParse(message)
  if (roots.success) {
    workerRoots.set(workerId, roots.data)
    if (sessionWorkers.selectedScope?.workerId === workerId) packageRootsLifecycle.handleMessage(roots.data)
    return true
  }
  return foregroundCapabilities.handle(workerId, message, reply)
}

async function callHost(command: HostCommand): Promise<HostResult> {
  if (command.type === 'prompt:abort') {
    const owner = sessionWorkers.selectedScope?.workerId ?? lobbyOwnerId
    if (owner) foregroundCapabilities.cancelOwner(owner)
  }
  if (sessionWorkers.selectedScope) return sessionWorkers.request(command).finally(() => foregroundCapabilities.invalidate())
  return callLobby(command)
}

async function callLobby(command: HostCommand): Promise<HostResult> {
  if (!hostSpawned) {
    if (!hostReady) throw new Error('Agent Host 尚未启动')
    await hostReady
  }
  if (!agentHost) throw new Error('Agent Host 尚未就绪')
  const child = agentHost

  const result = await responseBroker.request(command, (request) => {
    child.postMessage(request)
  }).catch(error => {
    if (agentHost === child && hostSpawned && (globalMutations.has(command.type) || command.type === 'runtime:refresh')) globalConfiguration.recordFailure('lobby', error)
    throw error
  })
  if (agentHost === child && result.kind === 'snapshot') {
    lobbySnapshot = result.snapshot
    foregroundCapabilities.invalidate()
  }
  return result
}

async function callHostSnapshot(command: SnapshotHostCommand): Promise<AgentSnapshot> {
  const result = await callHost(command)
  if (result.kind === 'snapshot' && !sessionWorkers.hasSelection)
    result.snapshot = { ...result.snapshot, desktopEpoch: sessionWorkers.selectionEpoch }
  if (result.kind !== 'snapshot') {
    throw new Error(`Agent Host 未返回状态快照：${command.type}`)
  }
  const selected = sessionWorkers.selectedScope
  if (result.snapshot.desktopScope
    ? selected?.workerId !== result.snapshot.desktopScope.workerId || selected.selectionEpoch !== result.snapshot.desktopScope.selectionEpoch
    : selected !== null) return result.snapshot
  const nextIdentity = {
    sessionId: result.snapshot.sessionId,
    generation: result.snapshot.generation
  }
  packageRootsLifecycle.transitionIdentity(nextIdentity, () => {
    activeHostIdentity = nextIdentity
    activeProjectPath = result.snapshot.project?.path ?? null
    activePermissionMode = result.snapshot.permissionMode
    activeSessionPath = result.snapshot.activeSessionPath
    browserManager?.setProject(activeProjectPath)
    updateWorkbenchContext()
  })
  return result.snapshot
}

function preferenceStore(): ElectronStore<Preferences> {
  if (!preferences) throw new Error('偏好存储尚未就绪')
  return preferences
}

let nativeNavigationLibrary: NavigationLibrary | null = null
function navigationLibrary(): NavigationLibrary {
  return nativeNavigationLibrary ??= new NavigationLibrary({
    store: preferenceStore(),
    mutationReason: (cwd, path) => {
      if (globalConfiguration.busy) return '配置正在更新，请稍后重试'
      if (activeProjectPath === cwd && (!path || activeSessionPath === path) && !lobbySnapshot?.ready)
        return '工作区首页尚未就绪，请稍后重试'
      for (const worker of sessionWorkers.getLiveSummaries())
        if (worker.cwd === cwd && (!path || worker.sessionPath === path)) refreshWorkerSafety(worker.workerId)
      return sessionWorkers.navigationMutationReason(cwd, path)
    },
    renamedSession: async (cwd, path, name) => {
      if (globalConfiguration.busy) throw new Error('配置正在更新，请稍后重试')
      const { workerId, snapshot } = await sessionWorkers.openBackground({ cwd, path })
      const reason = sessionWorkers.navigationMutationReason(cwd, path)
      if (reason) throw new Error(reason)
      if (!snapshot.sessionId) throw new Error('会话尚未保存，不能重命名')
      await sessionWorkers.requestWorker(workerId, {
        type: 'session:rename', sessionId: snapshot.sessionId, generation: snapshot.generation, name
      }, { sessionId: snapshot.sessionId, generation: snapshot.generation }).finally(() => foregroundCapabilities.invalidate())
    },
    hiddenProject: (cwd) => {
      const store = preferenceStore()
      store.set('recentProjects', (store.get('recentProjects') ?? []).filter((path) => path !== cwd))
      if (store.get('lastProjectPath') === cwd) store.delete('lastProjectPath')
      closeWorkspaceForNavigation(cwd)
    },
    archivedSession: (cwd, path) => closeWorkspaceForNavigation(cwd, path),
    reveal: async (cwd) => {
      const canonical = await resolveExistingProjectPath(cwd)
      if (!canonical) throw new Error('项目目录不存在或不可访问；可以从侧栏移除后重新添加')
      const error = await shell.openPath(canonical)
      if (error) throw new Error('无法打开项目目录：' + error)
    },
    copyPath: (cwd) => clipboard.writeText(cwd),
    changed: (data) => forwardEvent({ type: 'event', event: 'navigation-library', data })
  })
}

/** Detach the foreground only; resident workers, drafts and on-disk history are retained. */
function closeWorkspaceForNavigation(cwd: string, path?: string): void {
  const scope = sessionWorkers.selectedScope
  const selected = scope ? sessionWorkers.tryGetSnapshot(scope.workerId) : null
  const selectedCwd = selected?.project?.path ?? (!scope ? recoveryTarget?.project : null)
  const selectedPath = selected?.activeSessionPath ?? (!scope ? recoveryTarget?.session : null)
  if (selectedCwd !== cwd || (path && selectedPath !== path)) return
  if (!lobbySnapshot?.ready) throw new Error('工作区首页尚未就绪')
  const desktopEpoch = sessionWorkers.clearSelection(scope)
  selectedWorkerId = null
  lastSelectionEpoch = desktopEpoch
  recoveryTarget = null
  foregroundCapabilities.invalidate()
  nativePaletteFocus.invalidate()
  packageRootsLifecycle.hostExited()
  packageRootsLifecycle.hostStarted()
  preferenceStore().delete('lastProjectPath')
  forwardEvent({ type: 'event', event: 'snapshot', data: { ...lobbySnapshot, desktopEpoch } })
}

async function openCanonicalProject(canonicalPath: string, expected = sessionWorkers.selectedScope, origin?: DesktopCommandOrigin): Promise<AgentSnapshot> {
  const catalog = await callLobby({ type: 'project:catalog', cwd: canonicalPath, includeHidden: true, navigation: navigationLibrary().read() })
  sessionWorkers.validateSelected(expected)
  if (catalog.kind !== 'project-catalog') throw new Error('项目会话目录不可读取')
  const path = catalog.catalog.projects.find(project => project.path === canonicalPath)?.sessions[0]?.path
  const snapshot = await openWorker({ cwd: canonicalPath, ...(path ? { path } : {}) }, expected, undefined, origin)
  const persistedPath = pathToPersistAfterOpen(canonicalPath, snapshot)
  if (!persistedPath) throw new Error('Agent Host 未确认所选工作区')
  navigationLibrary().restoreAfterOpen(persistedPath, snapshot.activeSessionPath)
  preferenceStore().set('lastProjectPath', persistedPath)
  preferenceStore().set('recentProjects', mergeRecentProjects(preferenceStore().get('recentProjects'), persistedPath))
  return snapshot
}

async function openUserProject(candidatePath: unknown, expected = sessionWorkers.selectedScope, origin?: DesktopCommandOrigin): Promise<AgentSnapshot> {
  const canonicalPath = await resolveExistingProjectPath(candidatePath)
  if (!canonicalPath) throw new Error('所选工作区不存在或不是文件夹')
  return projectOpenCoordinator.runUserOpen(() => openCanonicalProject(canonicalPath, expected, origin))
}

async function openWorker(target: { cwd: string; path?: string }, expected: SelectedSessionScope | null, explicitModel?: { providerId: string; modelId: string }, origin?: DesktopCommandOrigin): Promise<AgentSnapshot> {
  if (globalConfiguration.busy) throw new Error('配置正在更新，请稍后切换会话')
  sessionWorkers.validateSelected(expected)
  const source = expected ? sessionWorkers.getSnapshot(expected.workerId) : null
  const model = explicitModel ?? (source?.activeProvider && source.activeModel ? { providerId: source.activeProvider, modelId: source.activeModel } : undefined)
  return sessionWorkers.open(target, expected, model, origin)
}

const globalConfiguration = new GlobalConfigurationGate(() => sessionWorkers.quiescent && !mutationCapabilities.pending && ![...attachmentSubmissions.values()].some(entry => entry.receipt.status === 'uncertain') && (!lobbySnapshot || ['idle', 'success', 'error'].includes(lobbySnapshot.login.phase)))
let configDirty = false
const globalMutations = new Set(['account:login', 'account:alias:add', 'endpoint:save', 'mcp:save', 'mcp:toggle', 'mcp:reload'])
async function refreshWorkers(): Promise<void> {
  await callLobby({ type: 'runtime:refresh' })
  await Promise.all(sessionWorkers.getResidentSummaries().map(worker => {
    const snapshot = sessionWorkers.getSnapshot(worker.workerId)!
    return sessionWorkers.requestWorker(worker.workerId, { type: 'runtime:refresh' }, { sessionId: snapshot.sessionId, generation: snapshot.generation }).finally(() => foregroundCapabilities.invalidate())
  }))
  configDirty = false
}
async function preparePromptConfiguration(): Promise<void> {
  if (globalConfiguration.busy) throw new Error('全局配置正在更新，请稍后重试')
  if (configDirty) await globalConfiguration.run(refreshWorkers)
}
function assertPromptConfigurationReady(): void {
  if (globalConfiguration.busy || configDirty) throw new Error('全局配置已改变，请稍后重试发送')
}
async function dispatchWorkerCommand(command: HostCommand, origin: DesktopCommandOrigin | undefined, captured: SelectedSessionScope | null): Promise<HostResult> {
  const request = () => {
    // Validate the renderer's captured selection before Stop can revoke authority.
    if (command.type === 'prompt:abort') {
      if (captured) sessionWorkers.capture(origin)
      const owner = captured?.workerId ?? lobbyOwnerId
      if (owner) foregroundCapabilities.cancelOwner(owner)
    }
    return captured ? sessionWorkers.request(command, origin).finally(() => foregroundCapabilities.invalidate()) : callLobby(command)
  }
  if (command.type === 'account:login:respond') return request()
  if (globalConfiguration.busy) throw new Error('全局配置正在更新，请稍后重试')
  if (globalMutations.has(command.type)) {
    return globalConfiguration.run(async () => {
      configDirty = true
      const result = await request()
      if (command.type !== 'account:login') await refreshWorkers()
      return result
    })
  }
  if (configDirty && ['prompt:send', 'session:edit:send', 'model:set'].includes(command.type)) {
    if (!sessionWorkers.quiescent) throw new Error('请先完成登录和所有运行，再使用更新后的配置')
    await globalConfiguration.run(refreshWorkers)
    sessionWorkers.capture(origin)
  }
  return request()
}

function createMobileSessionBridge(): MobileSessionBridge {
  const request = async (
    workerId: string,
    command: HostCommand,
    identity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> => {
    if (globalConfiguration.busy) throw new Error('全局配置正在更新，请稍后重试')
    if (command.type === 'prompt:send') {
      await preparePromptConfiguration()
      assertPromptConfigurationReady()
    }
    return sessionWorkers.requestWorker(workerId, command, identity).finally(() => foregroundCapabilities.invalidate())
  }
  return {
    listLive: () => liveToMobile(sessionWorkers.getLiveSummaries()),
    listCatalog: async () => {
      const result = await callLobby({
        type: 'project:catalog',
        recentPaths: mergeRecentProjects(
          preferenceStore().get('recentProjects'),
          preferenceStore().get('lastProjectPath')
        )
      })
      if (result.kind !== 'project-catalog') return []
      return result.catalog.projects.map((project) => ({
        path: project.path,
        name: project.name,
        sessions: project.sessions.map((session) => ({
          path: session.path,
          title: session.title,
          modified: session.modified,
          status: session.status
        }))
      }))
    },
    snapshot: (workerId) => {
      try {
        const snapshot = sessionWorkers.getSnapshot(workerId)
        if (!snapshot) return null
        const live = sessionWorkers.findLiveSummary(workerId)
        return toMobileSnapshot(workerId, live?.cwd ?? snapshot.project?.path ?? '', snapshot)
      } catch {
        return null
      }
    },
    open: async (cwd, sessionPath, model) => {
      const snapshot = await openWorker(
        { cwd, ...(sessionPath ? { path: sessionPath } : {}) },
        sessionWorkers.selectedScope,
        model
      )
      const workerId = snapshot.desktopScope?.workerId
      if (!workerId) throw new Error('会话未打开')
      return toMobileSnapshot(workerId, cwd, snapshot)
    },
    send: async (workerId, text, sessionId, generation, images) => {
      await request(workerId, { type: 'prompt:send', text, sessionId, generation, ...(images?.length ? { images } : {}) }, { sessionId, generation })
    },
    abort: async (workerId) => {
      foregroundCapabilities.cancelOwner(workerId)
      await request(workerId, { type: 'prompt:abort' })
    },
    clearQueue: async (workerId) => {
      await request(workerId, { type: 'queue:clear' })
    },
    respond: async (workerId, approvalId, allow) => {
      await request(workerId, { type: 'permission:respond', approvalId, allow })
    },
    setModel: async (workerId, identity, providerId, modelId) => {
      await request(workerId, { type: 'model:set', providerId, modelId }, identity)
    },
    setPermission: async (workerId, mode) => {
      await request(workerId, { type: 'permission:set', mode })
    },
    setThinking: async (workerId, identity, level) => {
      await request(workerId, { type: 'thinking:set', level }, identity)
    },
    skills: async (workerId, identity) => {
      const result = await request(workerId, { type: 'skills:list', ...identity }, identity)
      return result.kind === 'skills-list' ? result.catalog.skills.filter((skill) => skill.canInsert) : []
    },
    checkpointPlan: async (workerId, identity, entryId) => {
      const result = await request(workerId, { type: 'checkpoint:plan', ...identity, entryId }, identity)
      return result.kind === 'checkpoint' ? (result.plan ?? null) : null
    },
    checkpointRestore: async (workerId, identity, entryId, force) => {
      const result = await request(workerId, { type: 'checkpoint:restore', ...identity, entryId, force }, identity)
      return result.kind === 'checkpoint' ? (result.outcome ?? null) : null
    },
    subscribe: (listener) => {
      mobileSessionListeners.add(listener)
      return () => {
        mobileSessionListeners.delete(listener)
      }
    }
  }
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

  // A legacy recent-project entry can be a symlink spelling of a hidden directory.
  if (projectIsHidden(navigationLibrary().read(), canonicalPath)) {
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
  packageRootsLifecycle.hostStarted()
  hostReady = new Promise((resolve, reject) => {
    resolveHostReady = resolve
    rejectHostReady = reject
  })
  void hostReady.catch(() => undefined)
  const script = join(__dirname, 'agent-host.js')
  const child = utilityProcess.fork(script, [], {
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

  agentHost = child
  const owner = `lobby:${randomUUID()}`
  lobbyOwnerId = owner
  lobbySnapshot = null
  hostSpawned = false

  child.stdout?.on('data', (chunk) => {
    if (is.dev) process.stdout.write(`[agent-host] ${String(chunk)}`)
  })
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[agent-host] ${String(chunk)}`)
  })
  child.on('spawn', () => {
    if (agentHost !== child) return
    hostSpawned = true
    resolveHostReady?.()
    resolveHostReady = null
    rejectHostReady = null
    child.postMessage({ type: 'bootstrap', requestId: randomUUID() } satisfies HostRequest)
  })
  child.on('error', (error) => {
    foregroundCapabilities.cancelOwner(owner)
    if (agentHost !== child) return
    packageRootsLifecycle.hostExited()
    console.error('Agent Host 进程错误', errorMessage(error))
  })
  child.on('message', message => handleHostMessage(child, owner, message))
  child.on('exit', (code) => {
    foregroundCapabilities.cancelOwner(owner)
    if (agentHost !== child) return
    lobbyOwnerId = null
    lobbySnapshot = null
    globalConfiguration.ownerExited('lobby')
    if (sessionWorkers.selectedScope) {
      hostSpawned = false
      agentHost = null
      hostReady = null
      responseBroker.rejectAll(new Error('项目目录服务已退出'))
      return
    }
    recoveryTarget ??= { project: activeProjectPath, session: activeSessionPath }
    activeProjectPath = null
    terminalManager.setProject(recoveryTarget?.project ?? null)
    workspaceFiles.setProject(null)
    textAttachments.setContext(null)
    attachmentSubmissions.setContext(null)
    gitReview?.setProject(null)
    packageRootsLifecycle.hostExited()
    hostSpawned = false
    agentHost = null
    foregroundCapabilities.invalidate()
    const failure = new Error(`Agent Host 已退出（code ${code}）`)
    if (code !== 0) console.error(failure.message)
    rejectHostReady?.(failure)
    resolveHostReady = null
    rejectHostReady = null
    hostReady = null
    responseBroker.rejectAll(failure)
    forwardEvent({
      type: 'event',
      event: 'disconnected',
      data: {
        message: 'Pi 引擎已断开。草稿和当前画布已保留，重新连接后不会自动重发任务。'
      }
    })
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
  ipcMain.handle(NAVIGATION_LIBRARY_CHANNEL, (event, command: unknown) => {
    assertTrustedRenderer(event)
    return navigationLibrary().dispatch(command)
  })
  ipcMain.handle(DESKTOP_SETTINGS_CHANNEL, (event, command: unknown) => {
    assertTrustedRenderer(event)
    const settings = handleDesktopSettings(preferenceStore(), command)
    nativeTheme.themeSource = settings.theme
    updateWindowBackgrounds()
    return settings
  })
  ipcMain.handle(MOBILE_GATEWAY_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    if (!mobileGateway) throw new Error('手机网关尚未就绪')
    return mobileGateway.dispatch(command)
  })
  const nativeComputerUseHelperPath = app.isPackaged
    ? join(process.resourcesPath, '..', 'Helpers', 'pi-computer-use-helper')
    : join(app.getAppPath(), 'resources', 'native', 'pi-computer-use-helper')
  desktopControl = new DesktopControlService({
    platform: process.platform,
    appBundlePath: app.isPackaged ? join(process.resourcesPath, '..', '..') : process.execPath,
    nativeHelperPath: nativeComputerUseHelperPath,
    getMediaAccessStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
    getSources: (options) => desktopCapturer.getSources(options),
    getDisplays: () => {
      const primaryId = screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        bounds: {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height
        },
        scaleFactor: display.scaleFactor,
        primary: display.id === primaryId
      }))
    },
    openExternal: (url) => shell.openExternal(url)
  })
  computerUse = new ComputerUseService(desktopControl)
  ipcMain.handle(DESKTOP_CONTROL_CHANNEL, (event, command: unknown) => {
    assertTrustedRenderer(event)
    return desktopControl!.dispatch(command)
  })
  const tableExporter = new MarkdownTableExporter((owner) => dialog.showSaveDialog(BrowserWindow.fromId(owner.id)!, { title: '保存表格 CSV', defaultPath: '表格.csv', filters: [{ name: 'CSV 表格', extensions: ['csv'] }], properties: ['showOverwriteConfirmation'] }))
  ipcMain.handle(MARKDOWN_TABLE_EXPORT_CHANNEL, (event, request: unknown) => {
    try {
      assertTrustedRenderer(event)
      return tableExporter.export(BrowserWindow.fromWebContents(event.sender)!, request)
    } catch { return { status: 'failed', message: '无法从此窗口保存表格。' } }
  })
  ipcMain.handle(TEXT_ATTACHMENT_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = attachmentCommandSchema.safeParse(command)
    if (!parsed.success) return { type: 'error', message: '无效的文本文件请求' }
    const request = parsed.data
    const owner = event.sender.id
    const receiptWorkerId = request.type === 'send' || request.type === 'query' ? attachmentSubmissions.get(request.submissionId)?.workerId : undefined
    const attachmentWorker = sessionWorkers.getLiveSummaries().find(worker => receiptWorkerId ? worker.workerId === receiptWorkerId : worker.cwd === request.scope.projectPath && worker.sessionId === request.scope.sessionId && worker.generation === request.scope.generation)
    const callAttachmentHost = (command: HostCommand): Promise<HostResult> => attachmentWorker
      ? sessionWorkers.requestWorker(attachmentWorker.workerId, command, command.type === 'attachment:query' ? undefined : { sessionId: request.scope.sessionId, generation: request.scope.generation }).finally(() => foregroundCapabilities.invalidate())
      : Promise.reject(new Error('附件所属会话已结束'))
    try {
      if (request.type === 'send' || request.type === 'query') {
        for (const [id, entry] of attachmentSubmissions)
          if (entry.receipt.status !== 'uncertain' && Date.now() - entry.at > 30 * 60 * 1000)
            attachmentSubmissions.delete(id)
        let entry = attachmentSubmissions.get(request.submissionId)
        if (
          entry &&
          (entry.owner !== owner || JSON.stringify(entry.scope) !== JSON.stringify(request.scope))
        )
          return {
            type: 'receipt',
            receipt: { submissionId: request.submissionId, status: 'rejected', code: 'stale' }
          }
        if (!entry && request.type === 'query')
          return {
            type: 'receipt',
            receipt: { submissionId: request.submissionId, status: 'uncertain', code: 'unknown' }
          }
        if (!entry) {
          await preparePromptConfiguration()
          assertPromptConfigurationReady()
          if (
            [...attachmentSubmissions.values()].some(
              (e) =>
                e.owner === owner &&
                JSON.stringify(e.scope) === JSON.stringify(request.scope) &&
                e.receipt.status === 'uncertain'
            )
          )
            return {
              type: 'receipt',
              receipt: { submissionId: request.submissionId, status: 'rejected', code: 'busy' }
            }
          const files = textAttachments.capture(
            owner,
            request.scope,
            request.type === 'send' ? request.ids : []
          )
          const refusal = attachmentSubmissions.reserve(request.submissionId)
          if (refusal) return { type: 'receipt', receipt: refusal }
          entry = {
            owner,
            workerId: attachmentWorker?.workerId,
            scope: request.scope,
            files,
            ids: files.map((f) => f.id),
            receipt: { submissionId: request.submissionId, status: 'uncertain', code: 'unknown' },
            at: Date.now()
          }
          attachmentSubmissions.set(request.submissionId, entry)
          const captured = entry
          entry.pending = callAttachmentHost({
            type: 'attachment:prompt',
            scope: request.scope,
            submissionId: request.submissionId,
            text: formatTextContext(request.type === 'send' ? request.text : '', files)
          })
            .then((result) => {
              if (
                result.kind === 'attachment' &&
                result.receipt.submissionId === request.submissionId
              ) {
                captured.receipt = result.receipt
                captured.at = Date.now()
              }
              return captured.receipt
            })
            .catch(() => captured.receipt)
            .finally(() => {
              captured.pending = undefined
              attachmentSubmissions.prune()
              if (captured.workerId) refreshWorkerSafety(captured.workerId)
            })
        } else if (
          request.type === 'query' &&
          !entry.pending &&
          entry.receipt.status === 'uncertain'
        ) {
          const result = await callAttachmentHost({
            type: 'attachment:query',
            scope: request.scope,
            submissionId: request.submissionId
          }).catch(() => null)
          if (
            result?.kind === 'attachment' &&
            result.receipt.submissionId === request.submissionId
          ) {
            entry.receipt = result.receipt
            entry.at = Date.now()
          }
        }
        const receipt = entry.pending ? await entry.pending : entry.receipt
        if (entry.workerId) refreshWorkerSafety(entry.workerId)
        if (receipt.status !== 'uncertain') {
          entry.files = []
          if (receipt.status === 'accepted')
            for (const id of entry.ids) {
              try {
                textAttachments.remove(owner, request.scope, id)
              } catch {
                /* Scope may have changed. */
              }
            }
        }
        return { type: 'receipt', receipt }
      }
      const check = textAttachments.lease(request.scope)
      if (request.type === 'remove') textAttachments.remove(owner, request.scope, request.id)
      if (request.type === 'pick') {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) throw new Error('窗口已关闭')
        const selected = await dialog.showOpenDialog(window, {
          title: '添加 UTF-8 文本文件',
          properties: ['openFile', 'multiSelections']
        })
        check()
        assertTrustedRenderer(event)
        if (!selected.canceled) await textAttachments.add(owner, request.scope, selected.filePaths)
      }
      if (request.type === 'file') {
        // Reuse the Files authority, including project identity and .git rejection.
        await workspaceFiles.dispatch({
          type: 'read',
          projectPath: request.scope.projectPath,
          path: request.path
        })
        check()
        assertTrustedRenderer(event)
        await textAttachments.add(owner, request.scope, [
          join(request.scope.projectPath, request.path)
        ])
      }
      check()
      assertTrustedRenderer(event)
      return { type: 'staged', files: textAttachments.list(owner, request.scope) }
    } catch (error) {
      if (request.type === 'send' && !attachmentSubmissions.has(request.submissionId))
        return {
          type: 'receipt',
          receipt: { submissionId: request.submissionId, status: 'rejected', code: 'stale' }
        }
      const message =
        error instanceof Error && !('code' in error) ? error.message : '无法添加文本文件，请重试'
      return { type: 'error', message }
    }
  })
  ipcMain.handle(TERMINAL_CHANNEL, (event, command: unknown) => {
    try {
      assertTrustedRenderer(event)
    } catch {
      return { type: 'unavailable', message: '拒绝非可信主窗口终端请求' }
    }
    if (
      !terminalPluginEnabled() &&
      typeof command === 'object' &&
      command !== null &&
      (command as { type?: unknown }).type === 'create'
    )
      return {
        type: 'unavailable',
        message: '终端插件已关闭。在「设置 › Desktop 插件」中打开「终端」后才能新建终端。'
      }
    return terminalManager.dispatch(event.sender.id, command)
  })
  ipcMain.handle(GIT_REVIEW_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = gitReviewCommandSchema.safeParse(command)
    if (!parsed.success)
      return { type: 'unavailable', reason: 'invalid-request', message: '无效的 Git Review 请求' }
    if (!gitReview)
      return { type: 'unavailable', reason: 'git-unavailable', message: '可信 Git 服务不可用' }
    return gitReview.dispatch(parsed.data)
  })
  ipcMain.handle(WORKSPACE_FILES_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = workspaceFilesCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的工作区文件请求')
    return workspaceFiles.dispatch(parsed.data)
  })
  ipcMain.handle('pi:reconnect', async (event) => {
    assertTrustedRenderer(event)
    if (!reconnectingHost) {
      reconnectingHost = (async () => {
        if (!agentHost) startAgentHost()
        const target = recoveryTarget
        const snapshot = target?.project
          ? await openWorker({ cwd: target.project, ...(target.session ? { path: target.session } : {}) }, sessionWorkers.selectedScope)
          : await callHostSnapshot({ type: 'state:get' })
        recoveryTarget = null
        return snapshot
      })().finally(() => {
        reconnectingHost = null
      })
    }
    return reconnectingHost
  })
  ipcMain.handle('pi:state', async (event) => {
    assertTrustedRenderer(event)
    return projectOpenCoordinator.restoreThenRead(attemptRecentProjectRestore, () =>
      callHostSnapshot({ type: 'state:get' })
    )
  })
  ipcMain.handle('pi:session-select', (event, workerId: unknown, rawOrigin?: unknown) => {
    assertTrustedRenderer(event)
    if (typeof workerId !== 'string' || !workerId) throw new Error('无效的会话标识')
    const origin = rawOrigin === undefined ? undefined : desktopCommandOriginSchema.parse(rawOrigin)
    const captured = sessionWorkers.captureNavigation(origin)
    let resident = false
    try { resident = !!sessionWorkers.getSnapshot(workerId) } catch { /* A crashed saved session can be explicitly reopened. */ }
    if (!resident) {
      const failed = sessionWorkers.findLiveSummary(workerId)
      if (failed?.sessionPath) return openWorker({ cwd: failed.cwd, path: failed.sessionPath }, captured, undefined, origin).then((snapshot) => {
        if (snapshot.project) navigationLibrary().restoreAfterOpen(snapshot.project.path, snapshot.activeSessionPath)
        return snapshot
      })
    }
    const selected = sessionWorkers.select(workerId, origin)
    if (selected.project) navigationLibrary().restoreAfterOpen(selected.project.path, selected.activeSessionPath)
    return selected
  })
  ipcMain.handle('pi:command', async (event, command: HostCommand, rawOrigin?: unknown) => {
    assertTrustedRenderer(event)
    const origin = rawOrigin === undefined ? undefined : desktopCommandOriginSchema.parse(rawOrigin)
    const parsed = hostCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的 Pi Desktop IPC 请求')
    const captured = ['project:open', 'project:navigate', 'session:new', 'session:open', 'project:catalog', 'session:search', 'project:search'].includes(parsed.data.type)
      ? sessionWorkers.captureNavigation(origin) : sessionWorkers.capture(origin)
    if (['mcp:shutdown', 'runtime:shutdown', 'runtime:refresh', 'bootstrap'].includes(parsed.data.type)) throw new Error('该命令仅供宿主内部使用')
    if (parsed.data.type === 'attachment:prompt' || parsed.data.type === 'attachment:query')
      throw new Error('文本附件必须通过文件选择入口发送')
    if (parsed.data.type === 'project:open') {
      const snapshot = await openUserProject(parsed.data.cwd, captured, origin)
      return { kind: 'snapshot', snapshot } satisfies HostResult
    }
    if (parsed.data.type === 'project:catalog' || parsed.data.type === 'session:search' || parsed.data.type === 'project:search') {
      return callLobby({...parsed.data, navigation: navigationLibrary().read(), recentPaths:mergeRecentProjects(preferenceStore().get('recentProjects'),preferenceStore().get('lastProjectPath'))})
    }
    if (parsed.data.type === 'project:navigate') {
      const command = parsed.data
      return projectOpenCoordinator.runUserOpen(async () => {
        const cwd = await resolveExistingProjectPath(command.cwd)
        if (!cwd) throw new Error('所选项目目录不可用，请重试')
        const snapshot = await openWorker({ cwd, ...(command.sessionPath ? { path: command.sessionPath } : {}) }, captured, undefined, origin)
        if (snapshot.project?.path === cwd) {
          navigationLibrary().restoreAfterOpen(cwd, snapshot.activeSessionPath)
          preferenceStore().set('lastProjectPath',cwd)
          preferenceStore().set('recentProjects',mergeRecentProjects(preferenceStore().get('recentProjects'),cwd))
        }
        return snapshot
      }).then(snapshot => ({kind:'snapshot',snapshot} satisfies HostResult))
    }
    if (parsed.data.type === 'session:new' || parsed.data.type === 'session:open') {
      const cwd = captured ? sessionWorkers.getSnapshot(captured.workerId)?.project?.path : null
      if (!cwd) throw new Error('请先选择项目')
      const request = parsed.data
      const snapshot = await openWorker({ cwd, ...(request.type === 'session:open' ? { path: request.path } : {}) }, captured,
        request.type === 'session:new' && 'providerId' in request ? { providerId: request.providerId, modelId: request.modelId } : undefined, origin)
      return { kind: 'snapshot', snapshot } satisfies HostResult
    }
    if (parsed.data.type === 'browser:e2e' && !E2E_MODE) {
      throw new Error('该 Agent Browser 测试命令只在 E2E 模式可用')
    }
    return dispatchWorkerCommand(parsed.data, origin, captured)
  })
  ipcMain.handle('pi:select-project', async (event, rawOrigin?: unknown) => {
    assertTrustedRenderer(event)
    const origin = rawOrigin === undefined ? undefined : desktopCommandOriginSchema.parse(rawOrigin)
    const captured = sessionWorkers.captureNavigation(origin)
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
    return openUserProject(cwd, captured, origin)
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
    const result = await host.dispatch(parsed.data)
    nativePaletteFocus.surfaceUpdated()
    return result
  })
  ipcMain.handle(NATIVE_PALETTE_FOCUS_CHANNEL, (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = nativePaletteFocusSchema.parse(command)
    if (parsed.type === 'invalidate') nativePaletteFocus.invalidate()
    else nativePaletteFocus.finish(parsed.token, parsed.restore)
  })
  ipcMain.handle(WORKBENCH_PANEL_CHANNEL, (event, command: unknown) =>
    workbenchPanelIpc.handle(event, command)
  )
}

function updateWindowBackgrounds(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff')
  }
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
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  browserOwner = mainWindow
  const registerTerminalWindow = (): void =>
    terminalManager.registerWindow(mainWindow.webContents.id, (event) => {
      if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send(TERMINAL_EVENT_CHANNEL, event)
    })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) terminalManager.invalidateWindow(mainWindow.webContents.id)
  })
  mainWindow.webContents.on('render-process-gone', () =>
    terminalManager.invalidateWindow(mainWindow.webContents.id)
  )
  mainWindow.webContents.on('did-finish-load', registerTerminalWindow)
  let terminalCloseComplete = false
  mainWindow.on('close', (event) => {
    if (terminalCloseComplete || terminalQuitComplete) return
    event.preventDefault()
    void terminalManager.shutdown().finally(() => {
      terminalCloseComplete = true
      if (!mainWindow.isDestroyed()) mainWindow.close()
    })
  })
  browserManager = new BrowserManager(mainWindow, (state) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pi:browser:event', { type: 'state', data: state })
    }
    remoteBrowser?.changed()
  })
  remoteBrowser = new RemoteBrowser(
    () => browserManager,
    (wake) => {
      if (mainWindow.isDestroyed()) return
      // Frames need the view on screen: bring the panel (and on request the window) back.
      if (wake) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        if (!mainWindow.isVisible()) mainWindow.showInactive()
      }
      mainWindow.webContents.send(WORKBENCH_EVENT_CHANNEL, {
        type: 'reveal',
        viewId: BROWSER_VIEW_ID
      } satisfies WorkbenchEvent)
    }
  )
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
    pluginHostPath: join(__dirname, 'plugin-host.js'),
    permissionMode: () => activePermissionMode,
    bundledPluginDirectory: bundledPluginDirectory(),
    appearance: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    pluginServices: (() => {
      mkdirSync(app.getPath('sessionData'), { recursive: true })
      const hooksPath = mkdtempSync(join(app.getPath('sessionData'), 'plugin-git-hooks-'))
      return {
        fs: new PluginFileService(),
        git: new PluginGitService(
          new GitReviewProcess({
            gitPath: '/usr/bin/git',
            hooksPath,
            trustedEnv: {
              HOME: homedir(),
              PATH: '/usr/bin:/bin',
              TMPDIR: app.getPath('temp'),
              LC_ALL: 'C'
            }
          }),
          gitCommitIdentity,
          createUserGitPushRunner({ gitPath: '/usr/bin/git', hooksPath })
        )
      }
    })(),
    onEvent: (event) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(WORKBENCH_EVENT_CHANNEL, event)
    },
    onState: (state) => {
      // Turning the terminal plugin off ends its shells instead of leaving them hidden.
      const terminalOn = state.plugins.some(
        ({ pluginId, desktopEnabled }) => pluginId === TERMINAL_PLUGIN_ID && desktopEnabled
      )
      if (!terminalOn && state.plugins.some(({ pluginId }) => pluginId === TERMINAL_PLUGIN_ID))
        terminalManager.closeAll()
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
  packageRootsLifecycle.attachHost(workbenchHost)

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
  const attachmentOwner = mainWindow.webContents.id
  mainWindow.webContents.on('destroyed', () => {
    textAttachments.clearOwner(attachmentOwner)
    for (const [id, entry] of attachmentSubmissions)
      if (entry.owner === attachmentOwner) attachmentSubmissions.delete(id)
  })
  mainWindow.on('closed', () => {
    if (browserOwner !== mainWindow) return
    foregroundCapabilities.cancelAll()
    const host = workbenchHost
    if (host) packageRootsLifecycle.detachHost(host)
    host?.dispose()
    workbenchHost = null
    browserManager?.dispose()
    browserManager = null
    nativePaletteFocus.invalidate()
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
  startPerformanceDiagnostics()
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  app.on('web-contents-created', (_event, contents) => {
    contents.on('before-mouse-event', (_event, input) => { if (input.type === 'mouseDown') nativePaletteFocus.interruptPending() })
    contents.on('focus', () => nativePaletteFocus.interruptPending())
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') nativePaletteFocus.interruptPending()
      const owner = browserOwner
      if (!owner || owner.isDestroyed() || contents === owner.webContents || !contents.isFocused()) return
      const view = owner.contentView.children.find(view => view instanceof WebContentsView && view.webContents === contents)
      if (!(view instanceof WebContentsView)) return
      if (input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat || input.key.toLowerCase() !== 'k' || !(input.meta || input.control) || input.alt || input.shift) return
      event.preventDefault()
      const token = randomUUID()
      const identity = paletteSourceIdentity()
      nativePaletteFocus.capture(token, {
        valid: () => browserOwner === owner && !owner.isDestroyed() && !contents.isDestroyed() && owner.isFocused() &&
          identity === paletteSourceIdentity() && owner.contentView.children.includes(view) &&
          (owner.webContents.isFocused() || contents.isFocused()) &&
          !owner.contentView.children.some(other => other instanceof WebContentsView && other !== view && other.webContents !== owner.webContents && other.getVisible()),
        visible: () => view.getVisible(),
        focus: () => contents.focus()
      })
      owner.webContents.focus()
      owner.webContents.send('pi:event', { type: 'event', event: 'command-palette', data: { source: 'native-view', token } } satisfies DesktopEvent)
    })
  })
  try {
    const sessionData = app.getPath('sessionData')
    await mkdir(sessionData, { recursive: true })
    const hooksPath = await mkdtemp(join(sessionData, 'git-review-hooks-'))
    gitReview = new GitReview({
      gitPath: '/usr/bin/git',
      hooksPath,
      trustedEnv: {
        HOME: homedir(),
        PATH: '/usr/bin:/bin',
        TMPDIR: app.getPath('temp'),
        LC_ALL: 'C'
      }
    })
    gitReview.setProject(activeProjectPath)
  } catch {
    console.warn('Git Review 初始化失败')
  }

  const Store = await loadElectronStoreConstructor()
  preferences = new Store<Preferences>({
    name: 'pi-desktop-preferences',
    schema: {
      navigationLibrary: { type: 'object' },
      lastProjectPath: { type: 'string' },
      recentProjects: { type: 'array', items: {type:'string'}, maxItems:100 },
      workbenchDesktopEnabled: {
        type: 'object',
        additionalProperties: { type: 'boolean' }
      },
      workbenchPanelState: { type: 'object' },
      mobileRemoteViews: { type: 'string', enum: ['off', 'view', 'control'] },
      mobileDevices: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          properties: {
            deviceId: { type: 'string' },
            name: { type: 'string' },
            tokenHash: { type: 'string' },
            createdAt: { type: 'number' },
            lastSeenAt: { type: 'number' }
          }
        }
      }
    }
  })

  nativeTheme.themeSource = handleDesktopSettings(preferenceStore(), { type: 'get' }).theme
  nativeTheme.on('updated', updateWindowBackgrounds)
  mobileGateway = new MobileGatewayService({
    devices: {
      load: () => preferenceStore().get('mobileDevices') ?? [],
      save: (devices) => preferenceStore().set('mobileDevices', devices)
    },
    sessions: createMobileSessionBridge(),
    publish: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed())
          window.webContents.send('pi:event', {
            type: 'event',
            event: 'mobile-gateway',
            data: state
          } satisfies DesktopEvent)
      }
    },
    powerSave: {
      start: () => powerSaveBlocker.start('prevent-app-suspension'),
      stop: (id) => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
      }
    },
    writeClipboard: (text) => clipboard.writeText(text),
    // Isolated E2E apps must not contend for the fixed gateway port.
    ...(E2E_MODE && Number(process.env.PI_DESKTOP_E2E_MOBILE_PORT) > 0
      ? { port: Number(process.env.PI_DESKTOP_E2E_MOBILE_PORT) }
      : {}),
    remoteViews: {
      get: () => preferenceStore().get('mobileRemoteViews') ?? 'off',
      set: (access) => preferenceStore().set('mobileRemoteViews', access),
      bridge: createRemoteViewsBridge({
        access: () => preferenceStore().get('mobileRemoteViews') ?? 'off',
        browser: () => remoteBrowser,
        browserEnabled: browserPluginEnabled,
        browserSummary: () => {
          const state = browserManager?.getState()
          const active = state?.pages.find((page) => page.active)
          return {
            live: Boolean(state?.available),
            ...(active ? { detail: active.title || active.url } : {})
          }
        },
        terminals: remoteTerminals,
        terminalEnabled: terminalPluginEnabled
      })
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

let terminalQuitComplete = false
let quitInProgress = false
app.on('before-quit', (event) => {
  if (!terminalQuitComplete) {
    event.preventDefault()
    if (quitInProgress) return
    quitInProgress = true
    foregroundCapabilities.cancelAll()
    const shutdownMcp = async () => {
      if (!agentHost) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([callHost({ type: 'mcp:shutdown' }), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    void Promise.allSettled([
      terminalManager.shutdown(),
      sessionWorkers.shutdown(),
      mobileGateway?.shutdown() ?? Promise.resolve(),
      shutdownMcp()
    ]).finally(() => {
      terminalQuitComplete = true
      app.quit()
    })
    return
  }
  gitReview?.setProject(null)
  const host = workbenchHost
  if (host) packageRootsLifecycle.detachHost(host)
  host?.dispose()
  workbenchHost = null
  browserManager?.dispose()
  browserManager = null
  agentHost?.kill()
  agentHost = null
})
