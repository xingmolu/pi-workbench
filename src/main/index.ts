// Must stay first: it sets the interface language before other modules build their strings.
import './locale-boot'
import { ProcessCpuSampler } from './process-cpu-sampler'
import { NAVIGATION_LIBRARY_CHANNEL, projectIsHidden } from '../shared/navigation-library'
import { NavigationLibrary } from './navigation-library'
import { DESKTOP_SETTINGS_CHANNEL } from '../shared/desktop-settings'
import { DESKTOP_CONTROL_CHANNEL } from '../shared/desktop-control'
import { SessionWorkerSupervisor } from './session-worker-supervisor'
import { importPiHistory, legacyPiHistory } from './pi-history-import'
import { RuntimeDirectory } from './runtime-directory'
import { createClaudeRuntimePlugin } from './runtime-plugins/claude'
import { createCodexRuntimePlugin } from './runtime-plugins/codex'
import { EngineCredentialBroker } from './engine-credentials'
import type { CredentialGrantDecision, CredentialGrantPrompt } from '../shared/engine-credentials'
import { runtimeStoragePaths } from './runtime-storage'
import { createPiRuntimePlugin } from './runtime-plugins/pi'
import { AgentRuntimeProviderRegistry } from './agent-runtime'
import { RUNTIME_CATALOG_CHANNEL } from '../shared/agent-runtime'
import { ForegroundCapabilityRouter } from './foreground-capability-router'
import { WorkerMutationCapabilities } from './worker-mutation-capabilities'
import { PluginAgentBridge } from './plugin-agent-bridge'
import {
  desktopCommandOriginSchema,
  type DesktopCommandOrigin,
  type SelectedSessionScope
} from '../shared/session-runtime'
import { piPackageRootsMessageSchema } from '../shared/workbench-host-schemas'
import { GlobalConfigurationGate } from './global-configuration-gate'
import { handleDesktopSettings } from './desktop-settings'
import { DesktopControlService } from './desktop-control-service'
import { NativePaletteFocus } from './native-palette-focus'
import {
  NATIVE_PALETTE_FOCUS_CHANNEL,
  nativePaletteFocusSchema
} from '../shared/native-palette-focus'
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
  crashReporter,
  net,
  safeStorage,
  shell,
  systemPreferences,
  utilityProcess,
  type BrowserWindow as BrowserWindowType,
  type IpcMainInvokeEvent
} from 'electron'
import { randomUUID } from 'node:crypto'
import { MarkdownTableExporter } from './markdown-table-export'
import { AppUpdates } from './app-updates'
import { Diagnostics } from './diagnostics'
import { DIAGNOSTICS_CHANNEL, type DiagnosticsCommand } from '../shared/diagnostics'
import {
  APP_UPDATE_CHANNEL,
  APP_UPDATE_EVENT_CHANNEL,
  type AppUpdateCommand
} from '../shared/app-updates'
import { MARKDOWN_TABLE_EXPORT_CHANNEL } from '../shared/markdown-table-export'
import { TextAttachments } from './text-attachments'
import { AttachmentSubmissions } from './attachment-submissions'
import {
  TEXT_ATTACHMENT_CHANNEL,
  attachmentCommandSchema,
  formatTextContext
} from '../shared/text-attachments'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, release, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type ElectronStore from 'electron-store'
import type {
  AgentSnapshot,
  BrowserCommand,
  HostCommand,
  DesktopEvent,
  HostResult,
  PermissionMode,
  RuntimeConfigCommand,
  RuntimeAccounts,
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
import { browserCommandSchema, hostCommandSchema } from '../shared/schemas'
import { workbenchCommandSchema } from '../shared/workbench-schemas'
import {
  PLUGIN_INSTALL_CHANNEL,
  pluginInstallCommandSchema,
  type PluginDevelopmentFolder,
  type PluginInstallCommand,
  type PluginInstallResult
} from '../shared/plugin-install'
import { PluginInstaller, type PluginInstallRecord } from './plugin-installer'
import { PluginDevelopment } from './plugin-development'
import { PluginLogs } from './plugin-logs'
import { scaffoldPlugin } from './plugin-scaffold'
import { discoverWorkbenchManifests } from './workbench-manifest'
import { WORKSPACE_FILES_CHANNEL, workspaceFilesCommandSchema } from '../shared/workspace-files'
import { WorkspaceFiles } from './workspace-files'
import { GIT_REVIEW_CHANNEL, gitReviewCommandSchema } from '../shared/git-review'
import { GitReview } from './git-review'
import { GitReviewProcess } from './git-review-process'
import { createUserGitPushRunner, PluginFileService, PluginGitService } from './plugin-services'
import { TerminalManager } from './terminal-manager'
import { TERMINAL_CHANNEL, TERMINAL_EVENT_CHANNEL } from '../shared/terminal'
import {
  resolveShell,
  terminalEnvironment,
  windowsTerminalFixtureEnv
} from '../shared/terminal-shell'
import { BrowserManager } from './browser-manager'
import { RemoteBrowser } from './remote-browser'
import { RemoteTerminals } from './remote-terminals'
import { createRemoteViewsBridge } from './remote-views-bridge'
import { MobilePluginViews } from './mobile-plugin-views'
import { EngineBinaries } from './engine-binaries'
import { isDownloadableEngine } from '../shared/engine-binaries'
import type { RemoteViewAccess } from '../shared/remote-views'
import { ComputerUseService } from './computer-use-service'
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
import {
  MOBILE_GATEWAY_CHANNEL,
  MOBILE_PREVIEW_AGENT,
  type MobileConversationSnapshot,
  type PairedDeviceRecord
} from '../shared/mobile-gateway'
import { MobileGatewayService } from './mobile-gateway-service'
import { liveToMobile, toMobileSnapshot, type MobileSessionBridge } from './mobile-session-bridge'
import { systemGit } from './system-git'
import icon from '../../resources/icon.png?asset'
import { locale, t } from '../shared/i18n'

const E2E_MODE = process.env['PI_DESKTOP_E2E'] === '1'
assertE2EModeAllowed(E2E_MODE, app.isPackaged)

function requiredE2ETempPath(
  name: 'PI_DESKTOP_E2E_USER_DATA' | 'PI_DESKTOP_E2E_AGENT_DIR'
): string {
  return canonicalExistingTempDirectory(process.env[name], name)
}

const e2eAgentDir = E2E_MODE ? requiredE2ETempPath('PI_DESKTOP_E2E_AGENT_DIR') : null
if (E2E_MODE) app.setPath('userData', requiredE2ETempPath('PI_DESKTOP_E2E_USER_DATA'))

let lobbySnapshot: AgentSnapshot | null = null
let lobbyRuntimeId = 'pi'
let preferences: ElectronStore<Preferences> | null = null
let browserManager: BrowserManager | null = null
/** Phones watching the desktop browser; created with the main window. */
let remoteBrowser: RemoteBrowser | null = null
let browserOwner: BrowserWindowType | null = null
let desktopControl: DesktopControlService | null = null
let computerUse: ComputerUseService | null = null
let lobbyOwnerId: string | null = null
const browserScopeOwners = new Map<string, object>()
function browserAgentScope(
  ownerId: string,
  identity: Pick<AgentSnapshot, 'sessionId' | 'generation'>
) {
  const owner = browserScopeOwners.get(ownerId) ?? {}
  browserScopeOwners.set(ownerId, owner)
  return { owner, projectPath: activeProjectPath ?? '', ...identity }
}
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
  authority: (owner) => {
    const identity = owner === lobbyOwnerId ? lobbySnapshot : sessionWorkers.tryGetSnapshot(owner)
    return {
      selected:
        !browserOwner || quitInProgress
          ? null
          : (sessionWorkers.selectedScope ??
            (lobbyOwnerId
              ? { workerId: lobbyOwnerId, selectionEpoch: sessionWorkers.selectionEpoch }
              : null)),
      identity,
      running:
        !quitInProgress &&
        (identity?.status === 'running' || identity?.status === 'awaiting-approval')
    }
  },
  execute: async (request, ownerId, executionId, signal) => {
    switch (request.capability) {
      case 'browser': {
        const manager = browserManager
        if (!manager) throw new Error(t('浏览器工作台尚未就绪'))
        if (!browserPluginEnabled())
          throw new Error(
            t('浏览器插件已关闭。在「设置 › Desktop 插件」中打开「浏览器」后，Pi 才能使用浏览器。')
          )
        browserOwner?.webContents.send(WORKBENCH_EVENT_CHANNEL, {
          type: 'reveal',
          viewId: BROWSER_VIEW_ID
        } satisfies WorkbenchEvent)
        const scope = browserAgentScope(ownerId, {
          sessionId: request.sessionId,
          generation: request.generation
        })
        return manager.executePrepared(
          scope,
          manager.prepare(scope, request.operation),
          executionId
        )
      }
      case 'computer-use':
        if (!computerUse) throw new Error(t('Computer Use 尚未就绪'))
        return computerUse.execute(
          request.operation,
          { ownerId, sessionId: request.sessionId, generation: request.generation },
          signal
        )
    }
  },
  abortBrowser: (executionId) => browserManager?.abortAgent(executionId),
  releaseOwner: (owner) => {
    computerUse?.releaseOwner(owner)
    const browserScopeOwner = browserScopeOwners.get(owner)
    if (browserScopeOwner) browserManager?.invalidateAgentScope(browserScopeOwner)
    browserScopeOwners.delete(owner)
  }
})

const nativePaletteFocus = new NativePaletteFocus()
const paletteSourceIdentity = (): string =>
  JSON.stringify([activeProjectPath, activeHostIdentity.sessionId, activeHostIdentity.generation])
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
      ? process.platform === 'win32'
        ? windowsTerminalFixtureEnv(shell, terminalHome, app.getPath('temp'))
        : {
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
        reject(new Error(t('终端服务启动超时')))
      }, 4000)
      child.on('message', handlers.message)
      child.on('exit', () => {
        clearTimeout(timeout)
        handlers.exit()
        reject(new Error(t('终端服务已退出')))
      })
      child.on('error', () => {
        clearTimeout(timeout)
        child.kill()
        handlers.exit()
        reject(new Error(t('终端服务启动失败')))
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
    if (!workbenchHost) return Promise.reject(new Error(t('插件运行时不可用')))
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
const runtimeProviders = new AgentRuntimeProviderRegistry({
  dataRoot: app.getPath('userData'),
  defaultProviderId: 'pi'
})
runtimeProviders.registerPlugin(
  createPiRuntimePlugin({
    script: join(__dirname, 'agent-host.js'),
    ...(e2eAgentDir
      ? { env: { ...process.env, PI_DESKTOP_E2E: '1', PI_DESKTOP_E2E_AGENT_DIR: e2eAgentDir } }
      : {}),
    onMessage: (worker, message, reply) =>
      handleWorkerCapability(worker.workerId, worker.cwd, message, reply)
  })
)

/** Engine CLIs are downloaded on first use rather than shipped in the installer. */
const engineBinaries = new EngineBinaries({
  root: join(app.getPath('userData'), 'engines'),
  fetch: (url, init) => net.fetch(url, init),
  // Tests serve their own archives; production always uses the pins built into the app.
  ...(E2E_MODE && process.env.PI_DESKTOP_E2E_ENGINE_PINS
    ? { pins: JSON.parse(readFileSync(process.env.PI_DESKTOP_E2E_ENGINE_PINS, 'utf8')) }
    : {}),
  override: (engine) => process.env[`PI_DESKTOP_${engine.toUpperCase()}_EXECUTABLE`] || undefined,
  bundled: (engine) => {
    if (engine !== 'claude' || (E2E_MODE && process.env.PI_DESKTOP_E2E_NO_BUNDLED_ENGINES))
      return undefined
    // Development checkouts still have the SDK's platform package installed.
    try {
      const packagePath = require.resolve(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`
      )
      return join(
        dirname(packagePath).replace('app.asar/', 'app.asar.unpacked/'),
        process.platform === 'win32' ? 'claude.exe' : 'claude'
      )
    } catch {
      return undefined
    }
  }
})

runtimeProviders.registerPlugin(
  createClaudeRuntimePlugin({
    script: join(__dirname, 'claude-host.js'),
    executable: () => engineBinaries.executable('claude'),
    onMessage: (worker, message, reply) =>
      handleWorkerCapability(worker.workerId, worker.cwd, message, reply)
  })
)
const credentialPrompts = new Map<string, (decision: CredentialGrantDecision) => void>()
/** Asks in the app window whether an engine may use one of Pi's ChatGPT accounts. */
function askCredentialGrant(prompt: CredentialGrantPrompt): Promise<CredentialGrantDecision> {
  return new Promise((resolve) => {
    const finish = (decision: CredentialGrantDecision): void => {
      if (!credentialPrompts.delete(prompt.id)) return
      clearTimeout(timer)
      broadcast({ type: 'event', event: 'credential-grant-closed', data: { id: prompt.id } })
      resolve(decision)
    }
    const timer = setTimeout(() => finish('deny'), 120_000)
    credentialPrompts.set(prompt.id, finish)
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    if (window?.isMinimized()) window.restore()
    window?.focus()
    broadcast({ type: 'event', event: 'credential-grant', data: prompt })
  })
}
function broadcast(event: DesktopEvent): void {
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed()) window.webContents.send('pi:event', event)
}
const credentialBroker = new EngineCredentialBroker({
  accounts: async () => {
    const result = await runtimeDirectory.request('pi', { type: 'state:get' })
    return result.kind === 'snapshot' ? result.snapshot.accounts : []
  },
  token: async (providerId) => {
    const result = await runtimeDirectory.request('pi', { type: 'account:token', providerId })
    if (result.kind !== 'account-token') throw new Error(t('Pi 没有返回访问令牌'))
    return result.token
  },
  grants: {
    read: () => preferenceStore().get('engineGrants') ?? [],
    write: (grants) => preferenceStore().set('engineGrants', grants)
  },
  ask: askCredentialGrant,
  label: (runtimeId) =>
    runtimeProviders.manifests().find((runtime) => runtime.id === runtimeId)?.label ?? runtimeId
})

runtimeProviders.registerPlugin(
  createCodexRuntimePlugin({
    script: join(__dirname, 'codex-host.js'),
    executable: () => engineBinaries.executable('codex'),
    // Tests point Codex at a local model server.
    ...(E2E_MODE && process.env.PI_DESKTOP_E2E_CODEX_CONFIG
      ? { env: { PI_DESKTOP_CODEX_CONFIG: process.env.PI_DESKTOP_E2E_CODEX_CONFIG } }
      : {}),
    onMessage: (worker, message, reply) =>
      credentialBroker.handle('codex', message, reply) ||
      handleWorkerCapability(worker.workerId, worker.cwd, message, reply)
  })
)
const runtimeDirectory = new RuntimeDirectory({
  registry: runtimeProviders,
  cwd: app.getPath('home'),
  onEvent: (runtimeId, event) => {
    // Settings sign in through any engine's configuration host, even while a chat is open.
    if (event.event === 'open-external') return openSignInPage(event.data)
    if (runtimeId !== lobbyRuntimeId) return
    lobbySnapshot = runtimeDirectory.snapshot(runtimeId)
    foregroundCapabilities.invalidate()
    if (!sessionWorkers.hasSelection) forwardEvent(event)
  },
  onExit: (runtimeId, error) => {
    const owner = runtimeDirectory.owner(runtimeId)
    foregroundCapabilities.cancelOwner(owner)
    pluginAgentBridge.cancelOwner(owner)
    configurationFor(runtimeId).gate.ownerExited(owner)
    if (runtimeId !== lobbyRuntimeId) return
    lobbySnapshot = null
    if (!sessionWorkers.hasSelection && !quitInProgress && error)
      forwardEvent({ type: 'event', event: 'disconnected', data: { message: error.message } })
  },
  onRequestFailure: (runtimeId, command, error) => {
    if (globalMutations.has(command.type) || command.type === 'runtime:refresh')
      configurationFor(runtimeId).gate.recordFailure(runtimeDirectory.owner(runtimeId), error)
  },
  onCapability: (owner, message, reply) => {
    if (owner === lobbyOwnerId && packageRootsLifecycle.handleMessage(message)) return true
    return (
      pluginAgentBridge.handle(owner, message, reply) ||
      foregroundCapabilities.handle(owner, message, reply)
    )
  }
})

const sessionWorkers = new SessionWorkerSupervisor({
  runtime: runtimeProviders,
  publish: forwardEvent,
  receiptsSettled: workerReceiptsSettled,
  selected: (snapshot) => {
    lobbyRuntimeId = snapshot.runtime?.id ?? lobbyRuntimeId
    lobbyOwnerId = runtimeDirectory.owner(lobbyRuntimeId)
    lobbySnapshot = runtimeDirectory.snapshot(lobbyRuntimeId)
    rememberRuntimeSelection(
      snapshot.runtime?.id,
      snapshot.activeSessionPath,
      snapshot.project?.path
    )
    foregroundCapabilities.invalidate()
    const workerId = snapshot.desktopScope!.workerId
    if (
      selectedWorkerId !== workerId ||
      snapshot.desktopScope!.selectionEpoch !== lastSelectionEpoch
    ) {
      nativePaletteFocus.invalidate()
      packageRootsLifecycle.hostExited()
      packageRootsLifecycle.hostStarted()
      selectedWorkerId = workerId
      lastSelectionEpoch = snapshot.desktopScope!.selectionEpoch
    }
  },
  onNeedsSnapshot: (workerId) => {
    void sessionWorkers.resyncWorker(workerId).catch(() => {})
  },
  onWorkerEvent: (workerId, snapshot) => {
    foregroundCapabilities.invalidate()
    publishMobileWorker(workerId, snapshot)
  },
  onExit: (workerId, error) => {
    foregroundCapabilities.cancelOwner(workerId)
    mutationCapabilities.exit(workerId)
    pluginAgentBridge.cancelOwner(workerId)
    attachmentSubmissions.retireWorker(workerId)
    const failed = sessionWorkers.findLiveSummary(workerId)
    if (failed?.sessionId && failed.generation !== null)
      attachmentSubmissions.retireScope({
        projectPath: failed.cwd,
        sessionId: failed.sessionId,
        generation: failed.generation
      })
    workerRoots.delete(workerId)
    sessionWorkers.summaries()
    if (selectedWorkerId !== workerId || quitInProgress) return
    selectedWorkerId = null
    recoveryTarget = {
      project: activeProjectPath,
      session: activeSessionPath,
      runtimeId: failed?.runtimeId
    }
    foregroundCapabilities.invalidate()
    packageRootsLifecycle.hostExited()
    workspaceFiles.setProject(null)
    textAttachments.setContext(null)
    attachmentSubmissions.setContext(null)
    gitReview?.setProject(null)
    forwardEvent({
      type: 'event',
      event: 'disconnected',
      data: {
        message: error?.message ?? t('当前会话已断开；其他会话仍可继续。重新连接不会自动重发任务。')
      }
    })
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
          lobby: { runtimeId: lobbyRuntimeId },
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
  return (
    !snapshot.edit?.pending &&
    !mutationCapabilities.hasPending(workerId) &&
    ![...attachmentSubmissions.values()].some(
      (entry) =>
        (entry.workerId === workerId ||
          (entry.scope.sessionId === snapshot.sessionId &&
            entry.scope.generation === snapshot.generation)) &&
        entry.receipt.status === 'uncertain'
    )
  )
}
function refreshWorkerSafety(workerId: string): void {
  try {
    const snapshot = sessionWorkers.getSnapshot(workerId)
    if (snapshot)
      sessionWorkers.updateSafety(workerId, {
        receipts: workerReceiptsSettled(workerId, snapshot) ? 'settled' : 'pending',
        unsaved: !snapshot.activeSessionPath
      })
  } catch {
    /* A receipt can settle after its worker has exited. */
  }
}
let recoveryTarget: { project: string | null; session: string | null; runtimeId?: string } | null =
  null
let reconnectingHost: Promise<AgentSnapshot> | null = null
const packageRootsLifecycle = createPiPackageRootsLifecycle({
  initialIdentity: activeHostIdentity,
  warn: (warning) => console.warn(warning)
})
const AUTH_EXTERNAL_HOSTS = new Set([
  'auth.openai.com',
  'claude.ai',
  'claude.com',
  'console.anthropic.com',
  'platform.claude.com',
  'auth.claude.com'
])
const projectOpenCoordinator = new ProjectOpenCoordinator<AgentSnapshot>()
const workbenchPanelIpc = createWorkbenchPanelIpcRouter({
  createAdapter: createWorkbenchPanelStateAdapter
})

type Preferences = {
  desktopSettings?: import('../shared/desktop-settings').DesktopSettings
  navigationLibrary?: import('../shared/navigation-library').NavigationLibraryState
  recentProjects?: string[]
  lastProjectPath?: string
  lastRuntimeId?: string
  /** Engine for new chats once the user picked one in Settings; otherwise chats inherit. */
  defaultRuntimeId?: string
  lastSessionPath?: string
  workbenchDesktopEnabled?: Record<string, boolean>
  workbenchPanelState?: Record<string, unknown>
  mobileDevices?: PairedDeviceRecord[]
  mobileRemoteViews?: RemoteViewAccess
  /** Engines the user allowed to use a ChatGPT account Pi holds. */
  engineGrants?: import('../shared/engine-credentials').CredentialGrant[]
  /** Read-only GitHub token for update checks against the private repository (encrypted). */
  updateToken?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rememberRuntimeSelection(
  runtimeId: string | undefined,
  path: string | null,
  projectPath?: string
): void {
  if (!preferences) return
  // Foreground selection can cross projects without going through project:open.
  // Persist the project with its runtime/session reference so restart cannot mix them.
  if (projectPath && preferences.get('lastProjectPath') !== projectPath)
    preferences.set('lastProjectPath', projectPath)
  if (runtimeId && preferences.get('lastRuntimeId') !== runtimeId)
    preferences.set('lastRuntimeId', runtimeId)
  if (path && preferences.get('lastSessionPath') !== path) preferences.set('lastSessionPath', path)
  else if (!path && preferences.get('lastSessionPath')) preferences.delete('lastSessionPath')
}

const PLUGIN_INSTALLS_KEY = 'pluginInstalls'
const PLUGIN_DEVELOPMENT_KEY = 'pluginDevelopmentFolders'
let pluginInstaller: PluginInstaller | null = null
let pluginDevelopment: PluginDevelopment | null = null
const pluginLogs = new PluginLogs()

/** Templates, types and the manifest schema for new plugins. */
function pluginSdkDirectory(): string {
  return join(app.getAppPath(), 'resources', 'plugin-sdk')
}

/** The plugin a development folder holds, or why it holds none. */
async function developmentFolder(path: string): Promise<PluginDevelopmentFolder> {
  const discovery = await discoverWorkbenchManifests({
    roots: [{ path, source: '', scope: 'user', hasExecutablePiResources: false }],
    appVersion: app.getVersion()
  }).catch((error: unknown) => ({
    plugins: [],
    diagnostics: [{ message: error instanceof Error ? error.message : String(error) }]
  }))
  const plugin = discovery.plugins[0]
  if (plugin) return { path, pluginId: plugin.pluginId, problem: null }
  const problem = discovery.diagnostics.map((diagnostic) => diagnostic.message).join(' ')
  return {
    path,
    pluginId: null,
    problem: problem || t('没有找到 pi-desktop.json 或 manifest.json')
  }
}

/** The manifest text of each development folder as last loaded. */
const developmentManifests = new Map<string, string>()

async function manifestText(folder: string): Promise<string> {
  for (const name of ['pi-desktop.json', 'manifest.json']) {
    const text = await readFile(join(folder, name), 'utf8').catch(() => null)
    if (text !== null) return `${name}\0${text}`
  }
  return ''
}

/**
 * A file in a development folder changed. Code and page changes restart the plugin's
 * process and reload its open panels in place; a manifest change also rediscovers plugins,
 * which closes and reopens every panel.
 */
async function developmentChanged(folder: string): Promise<void> {
  const manifest = await manifestText(folder)
  const manifestChanged = developmentManifests.get(folder) !== manifest
  developmentManifests.set(folder, manifest)
  const { pluginId } = await developmentFolder(folder)
  await reloadDevelopmentPlugin(pluginId, manifestChanged)
}

/** Rediscovers (when asked) and restarts the plugin, and notes it in the plugin's log. */
async function reloadDevelopmentPlugin(pluginId: string | null, rediscover = true): Promise<void> {
  const host = workbenchHost
  if (!host) return
  if (rediscover || !pluginId) await host.dispatch({ type: 'plugins:reload' })
  if (!pluginId) return
  if (!host.snapshot().plugins.some((candidate) => candidate.pluginId === pluginId)) return
  await host.dispatch({ type: 'plugin:restart', pluginId })
  pluginLogs.append(pluginId, 'info', t('已重新加载'))
}

/** Loads a development folder and enables its plugin; the author trusts their own code. */
async function startDevelopment(path: string): Promise<PluginDevelopmentFolder> {
  const development = pluginDevelopment
  const host = workbenchHost
  if (!development || !host) throw new Error(t('Workbench 尚未就绪'))
  const added = await development.add(path)
  developmentManifests.set(added, await manifestText(added))
  const folder = await developmentFolder(added)
  await host.dispatch({ type: 'plugins:reload' })
  if (folder.pluginId)
    await host
      .dispatch({ type: 'plugin:set-enabled', pluginId: folder.pluginId, desktopEnabled: true })
      .catch(() => undefined)
  return folder
}

/** Ids of the plugins that ship with the app; an installed plugin may not take one. */
async function bundledPluginIds(): Promise<Set<string>> {
  const directory = bundledPluginDirectory()
  const children = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const discovery = await discoverWorkbenchManifests({
    roots: children
      .filter((child) => child.isDirectory())
      .map((child) => ({
        path: join(directory, child.name),
        source: 'bundled',
        scope: 'bundled' as const,
        hasExecutablePiResources: false
      })),
    appVersion: app.getVersion()
  })
  return new Set(discovery.plugins.map((plugin) => plugin.pluginId))
}

/** Install, update and remove user plugins; enabling a confirmed install grants what it asked. */
async function handlePluginInstall(
  command: PluginInstallCommand,
  sender: Electron.WebContents
): Promise<PluginInstallResult> {
  const installer = pluginInstaller
  const host = workbenchHost
  if (!installer || !host) throw new Error(t('Workbench 尚未就绪'))
  switch (command.type) {
    case 'pick': {
      const owner = BrowserWindow.fromWebContents(sender)
      const options: Electron.OpenDialogOptions =
        command.kind === 'parent'
          ? { title: t('选择新插件的位置'), properties: ['openDirectory', 'createDirectory'] }
          : command.kind === 'folder'
            ? { title: t('选择插件文件夹'), properties: ['openDirectory'] }
            : {
                title: t('选择插件压缩包'),
                properties: ['openFile'],
                filters: [{ name: 'Zip', extensions: ['zip'] }]
              }
      const picked = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return { type: 'picked', path: picked.canceled ? null : (picked.filePaths[0] ?? null) }
    }
    case 'inspect':
      return { type: 'preview', preview: await installer.inspect(command.source) }
    case 'update':
      return { type: 'preview', preview: await installer.update(command.pluginId) }
    case 'cancel':
      await installer.cancel(command.stagingId)
      return { type: 'done' }
    case 'confirm': {
      const pluginId = await installer.confirm(command.stagingId)
      await host.dispatch({ type: 'plugins:reload' })
      // The user reviewed the requested permissions before confirming: enabling grants them.
      await host.dispatch({ type: 'plugin:set-enabled', pluginId, desktopEnabled: true })
      return { type: 'done' }
    }
    case 'uninstall': {
      await host
        .dispatch({ type: 'plugin:set-enabled', pluginId: command.pluginId, desktopEnabled: false })
        .catch(() => undefined)
      await installer.uninstall(command.pluginId)
      await host.dispatch({ type: 'plugins:reload' })
      return { type: 'done' }
    }
    case 'list':
      return {
        type: 'installed',
        plugins:
          (preferenceStore().get(PLUGIN_INSTALLS_KEY as keyof Preferences) as Record<
            string,
            PluginInstallRecord
          >) ?? {},
        development: await Promise.all(
          (pluginDevelopment?.folders() ?? []).map((path) => developmentFolder(path))
        )
      }
    case 'develop':
      await startDevelopment(command.path)
      return { type: 'done' }
    case 'undevelop': {
      const { pluginId } = await developmentFolder(command.path)
      if (pluginId)
        await host
          .dispatch({ type: 'plugin:set-enabled', pluginId, desktopEnabled: false })
          .catch(() => undefined)
      pluginDevelopment?.remove(command.path)
      await host.dispatch({ type: 'plugins:reload' })
      return { type: 'done' }
    }
    case 'reload':
      await reloadDevelopmentPlugin(command.pluginId)
      return { type: 'done' }
    case 'logs':
      return { type: 'logs', lines: pluginLogs.get(command.pluginId) }
    case 'clear-logs':
      pluginLogs.clear(command.pluginId)
      return { type: 'done' }
    case 'scaffold': {
      const path = await scaffoldPlugin({
        sdkDirectory: pluginSdkDirectory(),
        parentPath: command.parentPath,
        template: command.template,
        id: command.id,
        name: command.name,
        appVersion: app.getVersion()
      })
      const folder = await startDevelopment(path)
      return { type: 'created', path: folder.path, pluginId: command.id }
    }
  }
}

/** Bundled plugins are unpacked from the asar archive so they are real files on disk. */
function bundledPluginDirectory(): string {
  return join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', 'plugins')
}

/** The fixed system Git used by Git review and plugin git. */
const hostGit = systemGit()

/** Only the user's global commit identity is read; plugin git otherwise ignores global config. */
async function gitCommitIdentity(): Promise<{ name: string; email: string } | null> {
  const read = (key: string): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        hostGit.path,
        ['config', '--global', '--get', key],
        { env: { ...hostGit.env, HOME: homedir() }, timeout: 3000, windowsHide: true },
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
    if (key !== workbenchContextKey) {
      workbenchContextKey = key
      workbenchContextGeneration++
    }
    host.setContext({
      projectPath: activeProjectPath,
      sessionId: activeHostIdentity.sessionId,
      generation: workbenchContextGeneration
    })
  } catch (error) {
    console.warn(t('忽略过期的 Workbench 上下文'), errorMessage(error))
  }
}

/** Opens a sign-in page a host asked for, whichever host and window state it came from. */
function openSignInPage(data: { url: string; mcp?: true }): void {
  try {
    const target = new URL(data.url)
    // MCP authorization pages belong to servers the user trusted and asked to sign in to.
    const allowed = data.mcp
      ? !target.username &&
        !target.password &&
        (target.protocol === 'https:' ||
          (target.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))
      : target.protocol === 'https:' && AUTH_EXTERNAL_HOSTS.has(target.hostname)
    if (allowed) void shell.openExternal(target.toString())
  } catch {
    // Ignore malformed provider URLs rather than handing them to the OS.
  }
}

function forwardEvent(event: DesktopEvent): void {
  if (!sessionWorkers.hasSelection) {
    if (event.event === 'snapshot')
      event = { ...event, data: { ...event.data, desktopEpoch: sessionWorkers.selectionEpoch } }
    if (event.event === 'patch')
      event = {
        ...event,
        data: {
          ...event.data,
          meta: { ...event.data.meta, desktopEpoch: sessionWorkers.selectionEpoch }
        }
      }
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
        rememberRuntimeSelection(
          event.data.meta.runtime?.id,
          activeSessionPath,
          activeProjectPath ?? undefined
        )
      }
      updateWorkbenchContext()
    })
    if (selectedWorkerId) {
      const roots = workerRoots.get(selectedWorkerId)
      if (roots) packageRootsLifecycle.handleMessage(roots)
    }
  }
  if (event.event === 'open-external') openSignInPage(event.data)

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:event', event)
  }
}

function handleWorkerCapability(
  workerId: string,
  cwd: string,
  message: unknown,
  reply: (message: unknown) => void
): boolean {
  let snapshot: AgentSnapshot | null = null
  try {
    snapshot = sessionWorkers.getSnapshot(workerId)
  } catch {
    /* Child may still be bootstrapping. */
  }
  if (mutationCapabilities.handle(workerId, cwd, snapshot, message, reply)) return true
  if (pluginAgentBridge.handle(workerId, message, reply)) return true
  const roots = piPackageRootsMessageSchema.safeParse(message)
  if (roots.success) {
    workerRoots.set(workerId, roots.data)
    if (sessionWorkers.selectedScope?.workerId === workerId)
      packageRootsLifecycle.handleMessage(roots.data)
    return true
  }
  return foregroundCapabilities.handle(workerId, message, reply)
}

async function callHost(command: HostCommand): Promise<HostResult> {
  if (command.type === 'prompt:abort') {
    const owner = sessionWorkers.selectedScope?.workerId ?? lobbyOwnerId
    if (owner) foregroundCapabilities.cancelOwner(owner)
  }
  if (sessionWorkers.selectedScope)
    return sessionWorkers.request(command).finally(() => foregroundCapabilities.invalidate())
  return callLobby(command)
}

async function callLobby(command: HostCommand, runtimeId = lobbyRuntimeId): Promise<HostResult> {
  const result = await runtimeDirectory.request(runtimeId, command)
  if (runtimeId === lobbyRuntimeId && result.kind === 'snapshot') {
    lobbySnapshot = result.snapshot
    lobbyOwnerId = runtimeDirectory.owner(runtimeId)
    foregroundCapabilities.invalidate()
  }
  return result
}

function currentRuntimeId(): string {
  const selected = sessionWorkers.selectedScope
  return selected
    ? (sessionWorkers.getSnapshot(selected.workerId)?.runtime?.id ?? lobbyRuntimeId)
    : lobbyRuntimeId
}

function sessionRuntimeId(path: string): string {
  const known = runtimeDirectory.runtimeForPath(path)
  if (known) return known
  for (const runtime of runtimeProviders.manifests()) {
    const root = runtimeStoragePaths(app.getPath('userData'), runtime.id).sessions
    if (path.startsWith(root + '/')) return runtime.id
  }
  // Only the Pi compatibility/import path may use pre-plugin transcripts.
  return 'pi'
}

async function callHostSnapshot(command: SnapshotHostCommand): Promise<AgentSnapshot> {
  const result = await callHost(command)
  if (result.kind === 'snapshot' && !sessionWorkers.hasSelection)
    result.snapshot = { ...result.snapshot, desktopEpoch: sessionWorkers.selectionEpoch }
  if (result.kind !== 'snapshot') {
    throw new Error(t('Agent Host 未返回状态快照：{type}', { type: command.type }))
  }
  const selected = sessionWorkers.selectedScope
  if (
    result.snapshot.desktopScope
      ? selected?.workerId !== result.snapshot.desktopScope.workerId ||
        selected.selectionEpoch !== result.snapshot.desktopScope.selectionEpoch
      : selected !== null
  )
    return result.snapshot
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
  if (!preferences) throw new Error(t('偏好存储尚未就绪'))
  return preferences
}

let nativeNavigationLibrary: NavigationLibrary | null = null
function navigationLibrary(): NavigationLibrary {
  return (nativeNavigationLibrary ??= new NavigationLibrary({
    store: preferenceStore(),
    mutationReason: (cwd, path) => {
      if (globalConfiguration.busy) return t('配置正在更新，请稍后重试')
      if (
        activeProjectPath === cwd &&
        (!path || activeSessionPath === path) &&
        !lobbySnapshot?.ready
      )
        return t('工作区首页尚未就绪，请稍后重试')
      for (const worker of sessionWorkers.getLiveSummaries())
        if (worker.cwd === cwd && (!path || worker.sessionPath === path))
          refreshWorkerSafety(worker.workerId)
      return sessionWorkers.navigationMutationReason(cwd, path)
    },
    renamedSession: async (cwd, path, name) => {
      if (globalConfiguration.busy) throw new Error(t('配置正在更新，请稍后重试'))
      const { workerId, snapshot } = await sessionWorkers.openBackground({
        cwd,
        path,
        runtimeId: sessionRuntimeId(path)
      })
      const reason = sessionWorkers.navigationMutationReason(cwd, path)
      if (reason) throw new Error(reason)
      if (!snapshot.sessionId) throw new Error(t('会话尚未保存，不能重命名'))
      await sessionWorkers
        .requestWorker(
          workerId,
          {
            type: 'session:rename',
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            name
          },
          { sessionId: snapshot.sessionId, generation: snapshot.generation }
        )
        .finally(() => foregroundCapabilities.invalidate())
    },
    hiddenProject: (cwd) => {
      const store = preferenceStore()
      store.set(
        'recentProjects',
        (store.get('recentProjects') ?? []).filter((path) => path !== cwd)
      )
      if (store.get('lastProjectPath') === cwd) store.delete('lastProjectPath')
      closeWorkspaceForNavigation(cwd)
    },
    archivedSession: (cwd, path) => closeWorkspaceForNavigation(cwd, path),
    reveal: async (cwd) => {
      const canonical = await resolveExistingProjectPath(cwd)
      if (!canonical) throw new Error(t('项目目录不存在或不可访问；可以从侧栏移除后重新添加'))
      const error = await shell.openPath(canonical)
      if (error) throw new Error(t('无法打开项目目录：') + error)
    },
    copyPath: (cwd) => clipboard.writeText(cwd),
    changed: (data) => forwardEvent({ type: 'event', event: 'navigation-library', data })
  }))
}

/** Detach the foreground only; resident workers, drafts and on-disk history are retained. */
function closeWorkspaceForNavigation(cwd: string, path?: string): void {
  const scope = sessionWorkers.selectedScope
  const selected = scope ? sessionWorkers.tryGetSnapshot(scope.workerId) : null
  const selectedCwd = selected?.project?.path ?? (!scope ? recoveryTarget?.project : null)
  const selectedPath = selected?.activeSessionPath ?? (!scope ? recoveryTarget?.session : null)
  if (selectedCwd !== cwd || (path && selectedPath !== path)) return
  if (!lobbySnapshot?.ready) throw new Error(t('工作区首页尚未就绪'))
  const desktopEpoch = sessionWorkers.clearSelection(scope)
  selectedWorkerId = null
  lastSelectionEpoch = desktopEpoch
  recoveryTarget = null
  foregroundCapabilities.invalidate()
  nativePaletteFocus.invalidate()
  packageRootsLifecycle.hostExited()
  packageRootsLifecycle.hostStarted()
  preferenceStore().delete('lastProjectPath')
  preferenceStore().delete('lastRuntimeId')
  preferenceStore().delete('lastSessionPath')
  forwardEvent({ type: 'event', event: 'snapshot', data: { ...lobbySnapshot, desktopEpoch } })
}

async function openCanonicalProject(
  canonicalPath: string,
  expected = sessionWorkers.selectedScope,
  origin?: DesktopCommandOrigin,
  runtimeId?: string
): Promise<AgentSnapshot> {
  const source = expected ? sessionWorkers.getSnapshot(expected.workerId) : null
  const selectedRuntime = runtimeProviders.resolveProviderId(
    runtimeId ?? source?.runtime?.id ?? lobbyRuntimeId
  )
  const supportsCatalog =
    runtimeProviders
      .manifests()
      .find((runtime) => runtime.id === selectedRuntime)
      ?.features.includes('project-catalog') ?? false
  const catalog = supportsCatalog
    ? await callLobby(
        {
          type: 'project:catalog',
          cwd: canonicalPath,
          includeHidden: true,
          navigation: navigationLibrary().read()
        },
        selectedRuntime
      )
    : null
  sessionWorkers.validateSelected(expected)
  if (catalog && catalog.kind !== 'project-catalog') throw new Error(t('项目会话目录不可读取'))
  const path =
    catalog?.kind === 'project-catalog'
      ? catalog.catalog.projects.find((project) => project.path === canonicalPath)?.sessions[0]
          ?.path
      : undefined
  const snapshot = await openWorker(
    { cwd: canonicalPath, runtimeId: selectedRuntime, ...(path ? { path } : {}) },
    expected,
    undefined,
    origin
  )
  const persistedPath = pathToPersistAfterOpen(canonicalPath, snapshot)
  if (!persistedPath) throw new Error(t('Agent Host 未确认所选工作区'))
  navigationLibrary().restoreAfterOpen(persistedPath, snapshot.activeSessionPath)
  preferenceStore().set('lastProjectPath', persistedPath)
  preferenceStore().set('lastRuntimeId', selectedRuntime)
  preferenceStore().set(
    'recentProjects',
    mergeRecentProjects(preferenceStore().get('recentProjects'), persistedPath)
  )
  return snapshot
}

async function openUserProject(
  candidatePath: unknown,
  expected = sessionWorkers.selectedScope,
  origin?: DesktopCommandOrigin,
  runtimeId?: string
): Promise<AgentSnapshot> {
  const canonicalPath = await resolveExistingProjectPath(candidatePath)
  if (!canonicalPath) throw new Error(t('所选工作区不存在或不是文件夹'))
  return projectOpenCoordinator.runUserOpen(() =>
    openCanonicalProject(canonicalPath, expected, origin, runtimeId)
  )
}

async function openWorker(
  target: { cwd: string; path?: string; runtimeId?: string },
  expected: SelectedSessionScope | null,
  explicitModel?: { providerId: string; modelId: string },
  origin?: DesktopCommandOrigin
): Promise<AgentSnapshot> {
  sessionWorkers.validateSelected(expected)
  const source = expected ? sessionWorkers.getSnapshot(expected.workerId) : null
  const runtimeId = runtimeProviders.resolveProviderId(
    target.runtimeId ??
      (target.path ? undefined : configuredDefaultRuntime()) ??
      source?.runtime?.id ??
      lobbyRuntimeId
  )
  if (configurationFor(runtimeId).gate.busy)
    throw new Error(t('此引擎配置正在更新，请稍后切换会话'))
  const model =
    explicitModel ??
    (source?.runtime?.id === runtimeId &&
    source.runtime.features.includes('model-selection') &&
    source.activeProvider &&
    source.activeModel
      ? { providerId: source.activeProvider, modelId: source.activeModel }
      : undefined)
  return sessionWorkers.open({ ...target, runtimeId }, expected, model, origin)
}

function configuredDefaultRuntime(): string | undefined {
  const id = preferenceStore().get('defaultRuntimeId')
  return id && runtimeProviders.manifests().some((runtime) => runtime.id === id) ? id : undefined
}

const RUNTIME_CONFIG_COMMANDS = new Set<RuntimeConfigCommand['type']>([
  'account:add',
  'account:remove',
  'account:login',
  'account:login:respond',
  'account:api-key:set',
  'account:quota',
  'endpoint:list',
  'endpoint:save',
  'endpoint:remove',
  'endpoint:discover'
])

/** Every engine's accounts for Settings; one engine that cannot start reports only itself. */
async function runtimeAccounts(): Promise<RuntimeAccounts[]> {
  return Promise.all(
    runtimeProviders
      .manifests()
      .filter((runtime) => runtime.features.includes('auth-login'))
      .map(async (runtime): Promise<RuntimeAccounts> => {
        const binary = isDownloadableEngine(runtime.id)
          ? engineBinaries.status(runtime.id)
          : undefined
        const base = {
          runtimeId: runtime.id,
          label: runtime.label,
          ...(binary ? { binary } : {}),
          ...(runtime.authentication.includes('external') ? { borrowsAccounts: true } : {})
        }
        // An engine that is not downloaded yet has nothing to ask.
        if (binary && binary.state !== 'ready')
          return {
            ...base,
            accounts: [],
            login: { phase: 'idle' },
            loginPrompt: null,
            authGeneration: 0
          }
        try {
          const result = await callLobby({ type: 'state:get' }, runtime.id)
          if (result.kind !== 'snapshot') throw new Error(t('引擎未返回状态'))
          const { accounts, login, loginPrompt, authGeneration } = result.snapshot
          return { ...base, accounts, login, loginPrompt, authGeneration: authGeneration ?? 0 }
        } catch (error) {
          return {
            ...base,
            accounts: [],
            login: { phase: 'idle' },
            loginPrompt: null,
            authGeneration: 0,
            error: errorMessage(error)
          }
        }
      })
  )
}

/**
 * Account changes go to the engine's configuration host whatever chat is open, then reach
 * that engine's resident chats the same way other global settings do.
 */
async function runtimeConfig(runtimeId: string, input: RuntimeConfigCommand): Promise<HostResult> {
  if (!runtimeProviders.manifests().some((runtime) => runtime.id === runtimeId))
    throw new Error(t('未知的 Agent 引擎'))
  let command: HostCommand = input
  if (command.type === 'endpoint:save' || command.type === 'endpoint:remove') {
    // The configuration host has no chat; its own identity is the safe save context.
    const host = runtimeDirectory.snapshot(runtimeId)
    command = {
      ...command,
      context: { projectPath: null, sessionId: null, generation: host?.generation ?? 0 }
    }
  }
  if (!globalMutations.has(command.type)) return callLobby(command, runtimeId)
  const configuration = configurationFor(runtimeId)
  if (configuration.gate.busy) throw new Error(t('此引擎配置正在更新，请稍后重试'))
  return configuration.gate.run(async () => {
    configuration.dirty = true
    const result = await callLobby(command, runtimeId)
    if (result.kind === 'endpoint-save' && !result.result.ok) return result
    if (command.type !== 'account:login' && command.type !== 'account:add')
      await refreshWorkers(runtimeId)
    return result
  })
}

const configurations = new Map<string, { gate: GlobalConfigurationGate; dirty: boolean }>()
function configurationFor(runtimeId: string) {
  let configuration = configurations.get(runtimeId)
  if (!configuration) {
    configuration = {
      dirty: false,
      gate: new GlobalConfigurationGate(
        () =>
          sessionWorkers.quiescentFor(runtimeId) &&
          (!runtimeDirectory.snapshot(runtimeId) ||
            ['idle', 'success', 'error'].includes(
              runtimeDirectory.snapshot(runtimeId)!.login.phase
            ))
      )
    }
    configurations.set(runtimeId, configuration)
  }
  return configuration
}
const globalConfiguration = {
  get busy() {
    return configurationFor(currentRuntimeId()).gate.busy
  }
}
const globalMutations = new Set([
  'account:login',
  'account:api-key:set',
  'account:alias:add',
  'account:add',
  'account:remove',
  'endpoint:save',
  'endpoint:remove',
  'mcp:save',
  'mcp:toggle',
  'mcp:reload'
])
async function refreshWorkers(runtimeId = currentRuntimeId()): Promise<void> {
  await callLobby({ type: 'runtime:refresh' }, runtimeId)
  await Promise.all(
    sessionWorkers
      .getResidentSummaries()
      .filter((worker) => worker.runtimeId === runtimeId)
      .map((worker) => {
        const snapshot = sessionWorkers.getSnapshot(worker.workerId)!
        return sessionWorkers
          .requestWorker(
            worker.workerId,
            { type: 'runtime:refresh' },
            { sessionId: snapshot.sessionId, generation: snapshot.generation }
          )
          .finally(() => foregroundCapabilities.invalidate())
      })
  )
  configurationFor(runtimeId).dirty = false
}
async function preparePromptConfiguration(runtimeId = currentRuntimeId()): Promise<void> {
  const configuration = configurationFor(runtimeId)
  if (configuration.gate.busy) throw new Error(t('此引擎配置正在更新，请稍后重试'))
  if (configuration.dirty) await configuration.gate.run(() => refreshWorkers(runtimeId))
}
function assertPromptConfigurationReady(runtimeId = currentRuntimeId()): void {
  const configuration = configurationFor(runtimeId)
  if (configuration.gate.busy || configuration.dirty)
    throw new Error(t('引擎配置已改变，请稍后重试发送'))
}
async function dispatchWorkerCommand(
  command: HostCommand,
  origin: DesktopCommandOrigin | undefined,
  captured: SelectedSessionScope | null
): Promise<HostResult> {
  const runtimeId = currentRuntimeId()
  const manifest = runtimeProviders.manifests().find((runtime) => runtime.id === runtimeId)!
  if (command.type === 'session-task:cancel' && manifest.subagents === 'desktop') {
    await sessionWorkers.cancelSessionTask(command.taskId, command, origin)
    return {
      kind: 'ack',
      sessionId: command.sessionId,
      generation: command.generation,
      revision: 0
    }
  }
  const request = () => {
    if (command.type === 'prompt:abort') {
      if (captured) sessionWorkers.capture(origin)
      const owner = captured?.workerId ?? lobbyOwnerId
      if (owner) foregroundCapabilities.cancelOwner(owner)
    }
    return captured
      ? sessionWorkers.request(command, origin).finally(() => foregroundCapabilities.invalidate())
      : callLobby(command, runtimeId)
  }
  if (command.type === 'account:login:respond') return request()
  const configuration = configurationFor(runtimeId)
  if (configuration.gate.busy) throw new Error(t('此引擎配置正在更新，请稍后重试'))
  if (globalMutations.has(command.type)) {
    return configuration.gate.run(async () => {
      configuration.dirty = true
      const result = await request()
      if (result.kind === 'endpoint-save' && !result.result.ok) return result
      if (command.type !== 'account:login') await refreshWorkers(runtimeId)
      return result
    })
  }
  if (
    configuration.dirty &&
    ['prompt:send', 'session:edit:send', 'model:set'].includes(command.type)
  ) {
    await configuration.gate.run(() => refreshWorkers(runtimeId))
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
    const runtimeId = sessionWorkers.getSnapshot(workerId)?.runtime?.id ?? lobbyRuntimeId
    if (configurationFor(runtimeId).gate.busy) throw new Error(t('此引擎配置正在更新，请稍后重试'))
    if (command.type === 'prompt:send') {
      await preparePromptConfiguration(runtimeId)
      assertPromptConfigurationReady(runtimeId)
    }
    return sessionWorkers
      .requestWorker(workerId, command, identity)
      .finally(() => foregroundCapabilities.invalidate())
  }
  return {
    listLive: () => liveToMobile(sessionWorkers.getLiveSummaries()),
    listCatalog: async () => {
      const result = await runtimeDirectory.query({
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
        {
          cwd,
          runtimeId: sessionPath ? sessionRuntimeId(sessionPath) : currentRuntimeId(),
          ...(sessionPath ? { path: sessionPath } : {})
        },
        sessionWorkers.selectedScope,
        model
      )
      const workerId = snapshot.desktopScope?.workerId
      if (!workerId) throw new Error(t('会话未打开'))
      return toMobileSnapshot(workerId, cwd, snapshot)
    },
    send: async (workerId, text, sessionId, generation, images) => {
      await request(
        workerId,
        { type: 'prompt:send', text, sessionId, generation, ...(images?.length ? { images } : {}) },
        { sessionId, generation }
      )
    },
    abort: async (workerId) => {
      foregroundCapabilities.cancelOwner(workerId)
      await request(workerId, { type: 'prompt:abort' })
    },
    clearQueue: async (workerId) => {
      await request(workerId, { type: 'queue:clear' })
    },
    respond: async (workerId, approvalId, allow, scope) => {
      await request(workerId, {
        type: 'permission:respond',
        approvalId,
        allow,
        ...(scope === 'turn' ? { scope } : {})
      })
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
      return result.kind === 'skills-list'
        ? result.catalog.skills.filter((skill) => skill.canInsert)
        : []
    },
    checkpointPlan: async (workerId, identity, entryId) => {
      const result = await request(
        workerId,
        { type: 'checkpoint:plan', ...identity, entryId },
        identity
      )
      return result.kind === 'checkpoint' ? (result.plan ?? null) : null
    },
    checkpointRestore: async (workerId, identity, entryId, force) => {
      const result = await request(
        workerId,
        { type: 'checkpoint:restore', ...identity, entryId, force },
        identity
      )
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
  // `npm run demo` starts in its seeded project the first time.
  const storedPath =
    store.get('lastProjectPath') ?? (E2E_MODE ? process.env.PI_DESKTOP_DEMO_PROJECT : undefined)
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
    const savedSession = store.get('lastSessionPath')
    if (savedSession) {
      try {
        return await openWorker(
          { cwd: canonicalPath, path: savedSession, runtimeId: store.get('lastRuntimeId') },
          sessionWorkers.selectedScope
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        store.delete('lastSessionPath')
      }
    }
    return await openCanonicalProject(
      canonicalPath,
      sessionWorkers.selectedScope,
      undefined,
      store.get('lastRuntimeId')
    )
  } catch (error) {
    store.delete('lastProjectPath')
    console.warn(t('无法恢复最近工作区'), errorMessage(error))
    return null
  }
}

function startAgentHost(): void {
  lobbyRuntimeId = runtimeProviders.resolveProviderId(preferences?.get('lastRuntimeId'))
  lobbyOwnerId = runtimeDirectory.owner(lobbyRuntimeId)
  packageRootsLifecycle.hostStarted()
  void callLobby({ type: 'state:get' })
    .then((result) => {
      if (result.kind === 'snapshot' && !sessionWorkers.hasSelection)
        forwardEvent({ type: 'event', event: 'snapshot', data: result.snapshot })
    })
    .catch((error) => console.error('Runtime configuration host failed', errorMessage(error)))
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || event.senderFrame !== event.sender.mainFrame) {
    throw new Error(t('拒绝非主窗口 IPC 请求'))
  }
  const source = new URL(event.senderFrame.url)
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && rendererUrl) {
    if (source.origin !== new URL(rendererUrl).origin) {
      throw new Error(t('拒绝非本地开发页面 IPC 请求'))
    }
  } else if (source.href !== pathToFileURL(join(__dirname, '../renderer/index.html')).href) {
    throw new Error(t('拒绝非应用页面 IPC 请求'))
  }
}

const appUpdates = new AppUpdates({
  version: app.getVersion(),
  platform: process.platform,
  packaged: app.isPackaged && !E2E_MODE,
  ...(process.env.APPIMAGE ? { appImage: process.env.APPIMAGE } : {}),
  // Loaded on first use so development runs never touch electron-updater.
  updater: () =>
    (require('electron-updater') as typeof import('electron-updater'))
      .autoUpdater as unknown as import('./app-updates').Updater,
  token: {
    read: () => {
      const stored = preferenceStore().get('updateToken')
      if (!stored || !safeStorage.isEncryptionAvailable()) return undefined
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'))
      } catch {
        return undefined
      }
    },
    write: (token) => {
      if (!token) return preferenceStore().delete('updateToken')
      if (!safeStorage.isEncryptionAvailable()) throw new Error(t('这台电脑无法安全保存令牌'))
      preferenceStore().set('updateToken', safeStorage.encryptString(token).toString('base64'))
    }
  },
  openExternal: (url) => void shell.openExternal(url),
  onChange: (status) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(APP_UPDATE_EVENT_CHANNEL, status)
  }
})

// Crash dumps stay on this machine; Settings › 常规 › 诊断 summarises what went wrong.
crashReporter.start({ uploadToServer: false })
let diagnosticsInstance: Diagnostics | null = null
const diagnostics = (): Diagnostics =>
  (diagnosticsInstance ??= new Diagnostics(join(app.getPath('userData'), 'logs')))

function diagnosticFacts(): Record<string, unknown> {
  return {
    版本: app.getVersion(),
    系统: `${process.platform} ${process.arch} ${release()}`,
    Electron: process.versions.electron,
    Chromium: process.versions.chrome,
    Node: process.versions.node,
    语言: app.getLocale(),
    打包版本: app.isPackaged,
    默认引擎: configuredDefaultRuntime() ?? currentRuntimeId(),
    引擎程序: (['claude', 'codex'] as const).map((engine) => {
      const status = engineBinaries.status(engine)
      return `${engine}: ${status.state}${'source' in status && status.source ? ` (${status.source})` : ''} ${status.version}`
    }),
    更新: appUpdates.status().state,
    崩溃转储: app.getPath('crashDumps')
  }
}

const APP_UPDATE_COMMANDS = new Set<AppUpdateCommand['type']>([
  'status',
  'check',
  'download',
  'install',
  'open-release',
  'token:set',
  'token:clear'
])

function registerIpc(): void {
  ipcMain.on('pi:locale', (event) => {
    event.returnValue = locale()
  })
  ipcMain.handle('pi:relaunch', (event) => {
    assertTrustedRenderer(event)
    app.relaunch()
    app.quit()
  })
  ipcMain.handle(DIAGNOSTICS_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const type = (command as DiagnosticsCommand | undefined)?.type
    if (type === 'summary')
      return { crashes: diagnostics().crashes().length, directory: dirname(diagnostics().logFile) }
    if (type === 'open-folder') {
      const error = await shell.openPath(dirname(diagnostics().logFile))
      if (error) throw new Error(error)
      return { opened: true }
    }
    if (type !== 'export') throw new Error(t('无效的诊断操作'))
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const target =
      E2E_MODE && process.env.PI_DESKTOP_E2E_DIAGNOSTICS_PATH
        ? process.env.PI_DESKTOP_E2E_DIAGNOSTICS_PATH
        : (
            await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
              title: t('导出诊断信息'),
              defaultPath: join(
                app.getPath('downloads'),
                t('pi-desktop-诊断-{stamp}.md', { stamp })
              ),
              filters: [{ name: 'Markdown', extensions: ['md'] }],
              properties: ['showOverwriteConfirmation']
            })
          ).filePath
    if (!target) return { cancelled: true }
    await writeFile(target, diagnostics().report(diagnosticFacts()), { mode: 0o600 })
    return { saved: target }
  })
  ipcMain.handle(APP_UPDATE_CHANNEL, (event, command: unknown) => {
    assertTrustedRenderer(event)
    const value = command as AppUpdateCommand | undefined
    if (!value || typeof value !== 'object' || !APP_UPDATE_COMMANDS.has(value.type))
      throw new Error(t('无效的更新操作'))
    if (value.type === 'token:set' && typeof value.token !== 'string')
      throw new Error(t('无效的令牌'))
    return appUpdates.handle(value)
  })
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
    if (!mobileGateway) throw new Error(t('手机网关尚未就绪'))
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
  computerUse = new ComputerUseService(desktopControl, { selfPid: process.pid })
  ipcMain.handle(DESKTOP_CONTROL_CHANNEL, (event, command: unknown) => {
    assertTrustedRenderer(event)
    return desktopControl!.dispatch(command)
  })
  const tableExporter = new MarkdownTableExporter((owner) =>
    dialog.showSaveDialog(BrowserWindow.fromId(owner.id)!, {
      title: t('保存表格 CSV'),
      defaultPath: t('表格.csv'),
      filters: [{ name: t('CSV 表格'), extensions: ['csv'] }],
      properties: ['showOverwriteConfirmation']
    })
  )
  ipcMain.handle(MARKDOWN_TABLE_EXPORT_CHANNEL, (event, request: unknown) => {
    try {
      assertTrustedRenderer(event)
      return tableExporter.export(BrowserWindow.fromWebContents(event.sender)!, request)
    } catch {
      return { status: 'failed', message: t('无法从此窗口保存表格。') }
    }
  })
  ipcMain.handle(TEXT_ATTACHMENT_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = attachmentCommandSchema.safeParse(command)
    if (!parsed.success) return { type: 'error', message: t('无效的文本文件请求') }
    const request = parsed.data
    const owner = event.sender.id
    const receiptWorkerId =
      request.type === 'send' || request.type === 'query'
        ? attachmentSubmissions.get(request.submissionId)?.workerId
        : undefined
    const attachmentWorker = sessionWorkers
      .getLiveSummaries()
      .find((worker) =>
        receiptWorkerId
          ? worker.workerId === receiptWorkerId
          : worker.cwd === request.scope.projectPath &&
            worker.sessionId === request.scope.sessionId &&
            worker.generation === request.scope.generation
      )
    const callAttachmentHost = (command: HostCommand): Promise<HostResult> =>
      attachmentWorker
        ? sessionWorkers
            .requestWorker(
              attachmentWorker.workerId,
              command,
              command.type === 'attachment:query'
                ? undefined
                : { sessionId: request.scope.sessionId, generation: request.scope.generation }
            )
            .finally(() => foregroundCapabilities.invalidate())
        : Promise.reject(new Error(t('附件所属会话已结束')))
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
        if (!window) throw new Error(t('窗口已关闭'))
        const selected = await dialog.showOpenDialog(window, {
          title: t('添加 UTF-8 文本文件'),
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
        error instanceof Error && !('code' in error) ? error.message : t('无法添加文本文件，请重试')
      return { type: 'error', message }
    }
  })
  ipcMain.handle(TERMINAL_CHANNEL, (event, command: unknown) => {
    try {
      assertTrustedRenderer(event)
    } catch {
      return { type: 'unavailable', message: t('拒绝非可信主窗口终端请求') }
    }
    if (
      !terminalPluginEnabled() &&
      typeof command === 'object' &&
      command !== null &&
      (command as { type?: unknown }).type === 'create'
    )
      return {
        type: 'unavailable',
        message: t('终端插件已关闭。在「设置 › Desktop 插件」中打开「终端」后才能新建终端。')
      }
    return terminalManager.dispatch(event.sender.id, command)
  })
  ipcMain.handle(GIT_REVIEW_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = gitReviewCommandSchema.safeParse(command)
    if (!parsed.success)
      return {
        type: 'unavailable',
        reason: 'invalid-request',
        message: t('无效的 Git Review 请求')
      }
    if (!gitReview)
      return { type: 'unavailable', reason: 'git-unavailable', message: t('可信 Git 服务不可用') }
    return gitReview.dispatch(parsed.data)
  })
  ipcMain.handle(WORKSPACE_FILES_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = workspaceFilesCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error(t('无效的工作区文件请求'))
    return workspaceFiles.dispatch(parsed.data)
  })
  ipcMain.handle('pi:reconnect', async (event) => {
    assertTrustedRenderer(event)
    if (!reconnectingHost) {
      reconnectingHost = (async () => {
        if (!runtimeDirectory.snapshot(lobbyRuntimeId)) startAgentHost()
        const target = recoveryTarget
        const snapshot = target?.project
          ? await openWorker(
              {
                cwd: target.project,
                runtimeId: target.runtimeId,
                ...(target.session ? { path: target.session } : {})
              },
              sessionWorkers.selectedScope
            )
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
  ipcMain.handle(RUNTIME_CATALOG_CHANNEL, (event) => {
    assertTrustedRenderer(event)
    return runtimeProviders.manifests()
  })
  ipcMain.handle('pi:legacy-history', (event) => {
    assertTrustedRenderer(event)
    return legacyPiHistory(join(e2eAgentDir ?? join(homedir(), '.pi/agent'), 'sessions'))
  })
  ipcMain.handle('pi:import-history', async (event) => {
    assertTrustedRenderer(event)
    return configurationFor('pi').gate.run(async () => {
      const result = await importPiHistory(
        join(e2eAgentDir ?? join(homedir(), '.pi/agent'), 'sessions'),
        runtimeStoragePaths(app.getPath('userData'), 'pi').sessions
      )
      await refreshWorkers('pi')
      return result
    })
  })
  ipcMain.handle('pi:runtime-accounts', (event) => {
    assertTrustedRenderer(event)
    return runtimeAccounts()
  })
  ipcMain.handle('pi:runtime-config', (event, runtimeId: unknown, raw: unknown) => {
    assertTrustedRenderer(event)
    const parsed = hostCommandSchema.safeParse(raw)
    if (
      typeof runtimeId !== 'string' ||
      !parsed.success ||
      !RUNTIME_CONFIG_COMMANDS.has(parsed.data.type as RuntimeConfigCommand['type'])
    )
      throw new Error(t('无效的配置操作'))
    return runtimeConfig(runtimeId, parsed.data as RuntimeConfigCommand)
  })
  ipcMain.handle('pi:credential-grant:respond', (event, id: unknown, decision: unknown) => {
    assertTrustedRenderer(event)
    if (typeof id !== 'string' || !['once', 'always', 'deny'].includes(decision as string))
      throw new Error(t('无效的授权回应'))
    credentialPrompts.get(id)?.(decision as CredentialGrantDecision)
  })
  ipcMain.handle('pi:credential-grants', (event) => {
    assertTrustedRenderer(event)
    return credentialBroker.grantList()
  })
  ipcMain.handle('pi:credential-grant:revoke', (event, runtimeId: unknown, account: unknown) => {
    assertTrustedRenderer(event)
    if (typeof runtimeId !== 'string' || typeof account !== 'string')
      throw new Error(t('无效的授权'))
    credentialBroker.revoke(runtimeId, account)
    return credentialBroker.grantList()
  })
  ipcMain.handle('pi:engine-binary', async (event, runtimeId: unknown, action: unknown) => {
    assertTrustedRenderer(event)
    if (typeof runtimeId !== 'string' || !isDownloadableEngine(runtimeId))
      throw new Error(t('这个引擎不需要下载'))
    if (action === 'remove') {
      await runtimeDirectory.restart(runtimeId)
      await engineBinaries.remove(runtimeId)
      return engineBinaries.status(runtimeId)
    }
    if (action !== 'install') throw new Error(t('无效的引擎操作'))
    // Answer at once; Settings follows progress through runtimeAccounts.
    void engineBinaries
      .install(runtimeId)
      .then(() => runtimeDirectory.restart(runtimeId))
      .catch((error) => console.warn(`Engine download failed (${runtimeId}):`, errorMessage(error)))
    return engineBinaries.status(runtimeId)
  })
  ipcMain.handle('pi:default-runtime', (event) => {
    assertTrustedRenderer(event)
    return configuredDefaultRuntime() ?? currentRuntimeId()
  })
  ipcMain.handle('pi:default-runtime:set', (event, runtimeId: unknown) => {
    assertTrustedRenderer(event)
    if (
      typeof runtimeId !== 'string' ||
      !runtimeProviders.manifests().some((runtime) => runtime.id === runtimeId)
    )
      throw new Error(t('未知的 Agent 引擎'))
    preferenceStore().set('defaultRuntimeId', runtimeId)
  })
  ipcMain.handle('pi:runtime-select', async (event, runtimeId: unknown, rawOrigin?: unknown) => {
    assertTrustedRenderer(event)
    if (typeof runtimeId !== 'string') throw new Error(t('无效的引擎标识'))
    runtimeProviders.resolveProviderId(runtimeId)
    const origin = rawOrigin === undefined ? undefined : desktopCommandOriginSchema.parse(rawOrigin)
    const captured = sessionWorkers.captureNavigation(origin)
    const project = captured ? sessionWorkers.getSnapshot(captured.workerId)?.project?.path : null
    if (project) return openWorker({ cwd: project, runtimeId }, captured, undefined, origin)
    const result = await callLobby({ type: 'state:get' }, runtimeId)
    sessionWorkers.validateSelected(captured)
    if (result.kind !== 'snapshot') throw new Error(t('引擎未返回状态'))
    lobbyRuntimeId = runtimeId
    lobbyOwnerId = runtimeDirectory.owner(runtimeId)
    lobbySnapshot = result.snapshot
    preferences?.set('lastRuntimeId', runtimeId)
    const snapshot = { ...result.snapshot, desktopEpoch: sessionWorkers.clearSelection(captured) }
    forwardEvent({ type: 'event', event: 'snapshot', data: snapshot })
    return snapshot
  })
  ipcMain.handle('pi:subagent-inspect', (event, taskId: unknown, rawOrigin: unknown) => {
    assertTrustedRenderer(event)
    if (typeof taskId !== 'string' || !taskId || taskId.length > 256)
      throw new Error(t('无效的子 Agent 标识'))
    const origin = desktopCommandOriginSchema.parse(rawOrigin)
    sessionWorkers.capture(origin)
    const snapshot = sessionWorkers.getSnapshot(origin.scope.workerId)!
    if (snapshot.runtime?.subagents === 'native')
      return sessionWorkers
        .requestWorker(
          origin.scope.workerId,
          {
            type: 'subagent:inspect',
            taskId,
            sessionId: origin.sessionId!,
            generation: origin.generation
          },
          { sessionId: origin.sessionId, generation: origin.generation }
        )
        .then((result) => {
          if (result.kind !== 'subagent-inspection') throw new Error(t('子 Agent 内容不可读取'))
          return result.snapshot
        })
    return sessionWorkers.inspectSessionTask(taskId, origin)
  })
  ipcMain.handle('pi:session-select', (event, workerId: unknown, rawOrigin?: unknown) => {
    assertTrustedRenderer(event)
    if (typeof workerId !== 'string' || !workerId) throw new Error(t('无效的会话标识'))
    const origin = rawOrigin === undefined ? undefined : desktopCommandOriginSchema.parse(rawOrigin)
    const captured = sessionWorkers.captureNavigation(origin)
    let resident = false
    try {
      resident = !!sessionWorkers.getSnapshot(workerId)
    } catch {
      /* A crashed saved session can be explicitly reopened. */
    }
    if (!resident) {
      const failed = sessionWorkers.findLiveSummary(workerId)
      if (failed?.sessionPath)
        return openWorker(
          { cwd: failed.cwd, path: failed.sessionPath, runtimeId: failed.runtimeId },
          captured,
          undefined,
          origin
        ).then((snapshot) => {
          if (snapshot.project)
            navigationLibrary().restoreAfterOpen(snapshot.project.path, snapshot.activeSessionPath)
          return snapshot
        })
    }
    const selected = sessionWorkers.select(workerId, origin)
    if (selected.project)
      navigationLibrary().restoreAfterOpen(selected.project.path, selected.activeSessionPath)
    return selected
  })
  ipcMain.handle('pi:command', async (event, command: HostCommand, rawOrigin?: unknown) => {
    assertTrustedRenderer(event)
    const origin = rawOrigin === undefined ? undefined : desktopCommandOriginSchema.parse(rawOrigin)
    const parsed = hostCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error(t('无效的 Pi Desktop IPC 请求'))
    const captured = [
      'project:open',
      'project:navigate',
      'session:new',
      'session:open',
      'project:catalog',
      'session:search',
      'project:search'
    ].includes(parsed.data.type)
      ? sessionWorkers.captureNavigation(origin)
      : sessionWorkers.capture(origin)
    if (
      // `account:token` hands out credentials and is only for Main's own engine broker.
      [
        'mcp:shutdown',
        'runtime:shutdown',
        'runtime:refresh',
        'bootstrap',
        'account:token'
      ].includes(parsed.data.type)
    )
      throw new Error(t('该命令仅供宿主内部使用'))
    if (parsed.data.type === 'attachment:prompt' || parsed.data.type === 'attachment:query')
      throw new Error(t('文本附件必须通过文件选择入口发送'))
    if (parsed.data.type === 'project:open') {
      const snapshot = await openUserProject(
        parsed.data.cwd,
        captured,
        origin,
        parsed.data.runtimeId
      )
      return { kind: 'snapshot', snapshot } satisfies HostResult
    }
    if (
      parsed.data.type === 'project:catalog' ||
      parsed.data.type === 'session:search' ||
      parsed.data.type === 'project:search'
    ) {
      const query = {
        ...parsed.data,
        navigation: navigationLibrary().read(),
        recentPaths: mergeRecentProjects(
          preferenceStore().get('recentProjects'),
          preferenceStore().get('lastProjectPath')
        )
      }
      return runtimeDirectory.query(query)
    }
    if (parsed.data.type === 'project:navigate') {
      const command = parsed.data
      return projectOpenCoordinator
        .runUserOpen(async () => {
          const cwd = await resolveExistingProjectPath(command.cwd)
          if (!cwd) throw new Error(t('所选项目目录不可用，请重试'))
          const snapshot = await openWorker(
            {
              cwd,
              runtimeId:
                command.runtimeId ??
                (command.sessionPath ? sessionRuntimeId(command.sessionPath) : currentRuntimeId()),
              ...(command.sessionPath ? { path: command.sessionPath } : {})
            },
            captured,
            undefined,
            origin
          )
          if (snapshot.project?.path === cwd) {
            navigationLibrary().restoreAfterOpen(cwd, snapshot.activeSessionPath)
            preferenceStore().set('lastProjectPath', cwd)
            preferenceStore().set('lastRuntimeId', snapshot.runtime!.id)
            preferenceStore().set(
              'recentProjects',
              mergeRecentProjects(preferenceStore().get('recentProjects'), cwd)
            )
          }
          return snapshot
        })
        .then((snapshot) => ({ kind: 'snapshot', snapshot }) satisfies HostResult)
    }
    if (parsed.data.type === 'session:new' || parsed.data.type === 'session:open') {
      const cwd = captured ? sessionWorkers.getSnapshot(captured.workerId)?.project?.path : null
      if (!cwd) throw new Error(t('请先选择项目'))
      const request = parsed.data
      const snapshot = await openWorker(
        {
          cwd,
          runtimeId:
            request.type === 'session:new'
              ? (request.runtimeId ?? currentRuntimeId())
              : sessionRuntimeId(request.path),
          ...(request.type === 'session:open' ? { path: request.path } : {})
        },
        captured,
        request.type === 'session:new' && 'providerId' in request
          ? { providerId: request.providerId, modelId: request.modelId }
          : undefined,
        origin
      )
      return { kind: 'snapshot', snapshot } satisfies HostResult
    }
    if (parsed.data.type === 'browser:e2e' && !E2E_MODE) {
      throw new Error(t('该 Agent Browser 测试命令只在 E2E 模式可用'))
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
          title: t('选择 Pi 工作区'),
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: t('选择 Pi 工作区'),
          properties: ['openDirectory', 'createDirectory']
        })

    const cwd = result.filePaths[0]
    if (result.canceled || !cwd) return null
    return openUserProject(cwd, captured, origin)
  })
  ipcMain.handle('pi:browser', async (event, command: BrowserCommand) => {
    assertTrustedRenderer(event)
    const parsed = browserCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error(t('无效的浏览器 IPC 请求'))
    const manager = browserManager
    if (!manager) throw new Error(t('浏览器工作台尚未就绪'))
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
        if (!E2E_MODE) throw new Error(t('该浏览器测试命令只在 E2E 模式可用'))
        const ownerId = sessionWorkers.selectedScope?.workerId ?? lobbyOwnerId
        if (!ownerId) throw new Error(t('请先打开 Agent 会话'))
        const scope = browserAgentScope(ownerId, activeHostIdentity)
        const result = await manager.executePrepared(
          scope,
          manager.prepare(scope, parsed.data.operation),
          randomUUID()
        )
        return { state: manager.getState(), result }
      }
    }
  })
  ipcMain.handle(WORKBENCH_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = workbenchCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error(t('无效的 Workbench IPC 请求'))
    const host = workbenchHost
    if (!host) throw new Error(t('Workbench 尚未就绪'))
    const result = await host.dispatch(parsed.data)
    nativePaletteFocus.surfaceUpdated()
    return result
  })
  ipcMain.handle(PLUGIN_INSTALL_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    return handlePluginInstall(pluginInstallCommandSchema.parse(command), event.sender)
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

let mobilePreview: BrowserWindow | null = null
/**
 * The phone UI in a phone-sized window, so it can be tried without a phone. Its own
 * persistent session keeps the preview device's token apart from the app's renderer.
 */
function openMobilePreview(url: string): void {
  const origin = new URL(url).origin
  if (!mobilePreview || mobilePreview.isDestroyed()) {
    mobilePreview = new BrowserWindow({
      width: 400,
      height: 840,
      minWidth: 320,
      title: t('手机端预览'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
      webPreferences: {
        partition: 'persist:pi-mobile-preview',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    mobilePreview.webContents.setUserAgent(
      `${MOBILE_PREVIEW_AGENT} (iPhone; Mobile) ${mobilePreview.webContents.getUserAgent()}`
    )
    mobilePreview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mobilePreview.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== origin) event.preventDefault()
    })
    mobilePreview.on('closed', () => {
      mobilePreview = null
    })
  }
  void mobilePreview.loadURL(url)
  mobilePreview.show()
  mobilePreview.focus()
}

function updateWindowBackgrounds(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed())
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff')
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
  const workbenchAgentDir = e2eAgentDir ?? join(app.getPath('userData'), 'workbench')
  pluginInstaller = new PluginInstaller({
    pluginsDirectory: join(workbenchAgentDir, 'desktop-plugins'),
    stagingDirectory: join(workbenchAgentDir, 'plugin-staging'),
    appVersion: app.getVersion(),
    discover: discoverWorkbenchManifests,
    bundledIds: () => bundledPluginIds(),
    records: {
      get: () =>
        (workbenchStore.get(PLUGIN_INSTALLS_KEY) as Record<string, PluginInstallRecord>) ?? {},
      set: (records) => workbenchStore.set(PLUGIN_INSTALLS_KEY, records)
    },
    git: hostGit
  })
  void pluginInstaller.clearStaging()
  pluginDevelopment?.dispose()
  pluginDevelopment = new PluginDevelopment({
    folders: {
      get: () => {
        const folders = workbenchStore.get(PLUGIN_DEVELOPMENT_KEY)
        return Array.isArray(folders)
          ? folders.filter((folder): folder is string => typeof folder === 'string')
          : []
      },
      set: (folders) => workbenchStore.set(PLUGIN_DEVELOPMENT_KEY, folders)
    },
    onChange: (folder) => {
      void developmentChanged(folder).catch((error: unknown) =>
        console.warn('Plugin reload failed:', errorMessage(error))
      )
    }
  })
  for (const folder of pluginDevelopment.folders())
    void manifestText(folder).then((text) => developmentManifests.set(folder, text))
  pluginDevelopment.start()
  workbenchHost = createWorkbenchHost({
    appVersion: app.getVersion(),
    agentDir: workbenchAgentDir,
    preloadPath: join(__dirname, '../preload/plugin.js'),
    store: workbenchStore,
    window: mainWindow,
    browser: browserManager,
    panelSenderBinding: workbenchPanelIpc,
    pluginHostPath: join(__dirname, 'plugin-host.js'),
    permissionMode: () => activePermissionMode,
    bundledPluginDirectory: bundledPluginDirectory(),
    developmentRoots: () => pluginDevelopment?.roots() ?? Promise.resolve([]),
    logs: pluginLogs,
    appearance: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    pluginServices: (() => {
      mkdirSync(app.getPath('sessionData'), { recursive: true })
      const hooksPath = mkdtempSync(join(app.getPath('sessionData'), 'plugin-git-hooks-'))
      return {
        fs: new PluginFileService(),
        git: new PluginGitService(
          new GitReviewProcess({
            gitPath: hostGit.path,
            hooksPath,
            trustedEnv: {
              ...hostGit.env,
              HOME: homedir(),
              TMPDIR: app.getPath('temp'),
              LC_ALL: 'C'
            }
          }),
          gitCommitIdentity,
          createUserGitPushRunner({ gitPath: hostGit.path, hooksPath })
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
    console.error(t('无法加载 Workbench 插件'), errorMessage(error))
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
      console.warn(t('拒绝打开无效链接'), errorMessage(error))
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
    contents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown') nativePaletteFocus.interruptPending()
    })
    contents.on('focus', () => nativePaletteFocus.interruptPending())
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') nativePaletteFocus.interruptPending()
      const owner = browserOwner
      if (!owner || owner.isDestroyed() || contents === owner.webContents || !contents.isFocused())
        return
      const view = owner.contentView.children.find(
        (view) => view instanceof WebContentsView && view.webContents === contents
      )
      if (!(view instanceof WebContentsView)) return
      if (
        input.type !== 'keyDown' ||
        input.isComposing ||
        input.isAutoRepeat ||
        input.key.toLowerCase() !== 'k' ||
        !(input.meta || input.control) ||
        input.alt ||
        input.shift
      )
        return
      event.preventDefault()
      const token = randomUUID()
      const identity = paletteSourceIdentity()
      nativePaletteFocus.capture(token, {
        valid: () =>
          browserOwner === owner &&
          !owner.isDestroyed() &&
          !contents.isDestroyed() &&
          owner.isFocused() &&
          identity === paletteSourceIdentity() &&
          owner.contentView.children.includes(view) &&
          (owner.webContents.isFocused() || contents.isFocused()) &&
          !owner.contentView.children.some(
            (other) =>
              other instanceof WebContentsView &&
              other !== view &&
              other.webContents !== owner.webContents &&
              other.getVisible()
          ),
        visible: () => view.getVisible(),
        focus: () => contents.focus()
      })
      owner.webContents.focus()
      owner.webContents.send('pi:event', {
        type: 'event',
        event: 'command-palette',
        data: { source: 'native-view', token }
      } satisfies DesktopEvent)
    })
  })
  try {
    const sessionData = app.getPath('sessionData')
    await mkdir(sessionData, { recursive: true })
    const hooksPath = await mkdtemp(join(sessionData, 'git-review-hooks-'))
    gitReview = new GitReview({
      gitPath: hostGit.path,
      hooksPath,
      trustedEnv: {
        ...hostGit.env,
        HOME: homedir(),
        TMPDIR: app.getPath('temp'),
        LC_ALL: 'C'
      }
    })
    gitReview.setProject(activeProjectPath)
  } catch {
    console.warn(t('Git Review 初始化失败'))
  }

  const Store = await loadElectronStoreConstructor()
  preferences = new Store<Preferences>({
    name: 'pi-desktop-preferences',
    schema: {
      navigationLibrary: { type: 'object' },
      lastProjectPath: { type: 'string' },
      recentProjects: { type: 'array', items: { type: 'string' }, maxItems: 100 },
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
    openPreview: openMobilePreview,
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
        terminalEnabled: terminalPluginEnabled,
        plugins: new MobilePluginViews({
          views: () => workbenchHost?.mobileViews() ?? [],
          context: (viewId) => {
            if (!workbenchHost) throw new Error(t('插件宿主尚未就绪'))
            return workbenchHost.panelContext(viewId)
          },
          call: (viewId, method, params, approve) => {
            if (!workbenchHost) return Promise.reject(new Error(t('插件宿主尚未就绪')))
            return workbenchHost.mobileCall(viewId, method, params, approve)
          }
        })
      })
    }
  })
  diagnostics().capture(console)
  app.on('render-process-gone', (_event, _contents, details) => {
    if (details.reason !== 'clean-exit' && !quitInProgress)
      diagnostics().crash({ kind: 'renderer', reason: details.reason, exitCode: details.exitCode })
  })
  app.on('child-process-gone', (_event, details) => {
    // Engine hosts the app restarts on purpose end as `killed`.
    if (details.reason === 'clean-exit' || details.reason === 'killed' || quitInProgress) return
    diagnostics().crash({
      kind: details.type.toLowerCase(),
      reason: details.reason,
      exitCode: details.exitCode,
      ...(details.serviceName || details.name ? { name: details.serviceName ?? details.name } : {})
    })
  })
  registerIpc()
  startAgentHost()
  createWindow()
  appUpdates.start()

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
    void Promise.allSettled([
      terminalManager.shutdown(),
      sessionWorkers.shutdown(),
      mobileGateway?.shutdown() ?? Promise.resolve(),
      runtimeDirectory.shutdown()
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
})
