import { createHash } from 'node:crypto'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import type { PluginAgentContributions } from '../shared/plugin-agent'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  session,
  utilityProcess,
  WebContentsView,
  type BrowserWindow,
  type OnBeforeRequestListenerDetails,
  type Session,
  type WebContents
} from 'electron'
import { WORKBENCH_PANEL_CONTEXT_CHANNEL } from '../shared/workbench-contracts'
import type {
  JsonValue,
  PluginPanelContext,
  WorkbenchCommand,
  WorkbenchCommandResult,
  WorkbenchEvent,
  WorkbenchSnapshot
} from '../shared/workbench-contracts'
import type { PermissionMode } from '../shared/contracts'
import { PluginApiError } from '../shared/plugin-api'
import { randomUUID } from 'node:crypto'
import {
  PluginRuntime,
  type PluginAuditEntry,
  type PluginProcessHandle,
  type PluginRuntimeDependencies
} from './plugin-runtime'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import { discoverWorkbenchManifests } from './workbench-manifest'
import { loadAbortableWorkbenchPanel } from './workbench-panel-lifecycle'
import {
  cleanupWorkbenchPanelSessions,
  configureOwnedWorkbenchPanelSession,
  createWorkbenchPanelSessionOwnership,
  type WorkbenchPanelSessionOwnership
} from './workbench-panel-session'
import {
  canonicalWorkbenchPanelFile,
  isPotentialWorkbenchPanelNavigation,
  secureWorkbenchPanelResponseHeaders
} from './workbench-panel-security'
import {
  createWorkbenchHostState,
  type MobilePluginViewSource,
  type WorkbenchHostContext,
  type WorkbenchHostState,
  type WorkbenchPanelView,
  type WorkbenchPanelViewRequest,
  type WorkbenchStateStore
} from './workbench-host-state'
import { t } from '../shared/i18n'
import type { PluginLogs } from './plugin-logs'

export interface WorkbenchHost {
  /** A `pi.*` call from a plugin view, authorized against the view's owning plugin. */
  pluginCall(viewId: string, method: string, params: unknown): Promise<unknown>
  /**
   * A `pi.*` call from a plugin page on the paired phone. Only host methods are reachable and
   * `approve` answers any confirmation instead of the desktop prompt.
   */
  mobileCall(
    viewId: string,
    method: string,
    params: unknown,
    approve: NonNullable<PluginRuntimeDependencies['approve']>
  ): Promise<unknown>
  /** Plugin pages that opted into the phone. */
  mobileViews(): MobilePluginViewSource[]
  /** What enabled plugins contribute to agent sessions, once the registry has loaded. */
  agentContributions(): Promise<PluginAgentContributions>
  /** Runs a plugin agent tool after checking the input against its declared schema. */
  runAgentTool(
    pluginId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<string>
  snapshot(): WorkbenchSnapshot
  reload(): Promise<WorkbenchSnapshot>
  dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult>
  setContext(context: WorkbenchHostContext): void
  setPackageRoots(roots: readonly PiPackageRoot[]): Promise<WorkbenchSnapshot>
  panelContext(viewId: string): PluginPanelContext
  dispose(): void
}

export type WorkbenchPanelSenderBinding = {
  bind(sender: WebContents, host: WorkbenchHost, viewId: string): () => void
  unbindHost(host: WorkbenchHost): void
}

export type WorkbenchPanelStateAdapter = {
  context(): PluginPanelContext
  getState(context: PluginPanelContext): JsonValue
  setState(context: PluginPanelContext, value: unknown): void
  runOperation<Result>(
    context: PluginPanelContext,
    operation: (signal: AbortSignal) => Promise<Result>
  ): Promise<Result>
}

export type WorkbenchHostDependencies = {
  appVersion: string
  agentDir: string
  preloadPath: string
  store: WorkbenchStateStore
  window: BrowserWindow
  browser: { setView(visible: boolean, bounds?: Electron.Rectangle): void | Promise<void> }
  onState?: (snapshot: WorkbenchSnapshot) => void
  /** Plugin-originated toasts and view reveals for the main window. */
  onEvent?: (event: WorkbenchEvent) => void
  /** Absolute path of the bundled plugin process entry; plugins with `main` stay stopped without it. */
  pluginHostPath?: string
  /** Directory of plugins shipped with the app (one plugin per child directory). */
  bundledPluginDirectory?: string
  /** The app's current light/dark appearance, for `app.getAppearance`. */
  appearance?: () => 'light' | 'dark'
  spawnPlugin?: PluginRuntimeDependencies['spawn']
  pluginServices?: PluginRuntimeDependencies['services']
  /** Opens an https URL a plugin asked for in the user's browser. */
  openExternal?: (url: string) => void
  /** `ai.complete`: a short answer from the user's model. */
  complete?: PluginRuntimeDependencies['complete']
  /** The foreground session's approval level; plugin writes follow it. */
  permissionMode?: () => PermissionMode
  approvalTimeoutMs?: number
  createView?: (request: WorkbenchPanelViewRequest) => Promise<WorkbenchPanelView>
  panelSenderBinding?: WorkbenchPanelSenderBinding
  /** Folders of plugins under development; they load ahead of installed plugins. */
  developmentRoots?: () => Promise<PiPackageRoot[]>
  /** Receives plugin process output, panel console messages and load failures. */
  logs?: PluginLogs
}

const PLUGIN_AUDIT_MAX_BYTES = 1024 * 1024

/** Append-only JSONL with one rotation; records method and outcome, never arguments. */
function pluginAuditWriter(file: string): (entry: PluginAuditEntry) => void {
  return (entry) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size > PLUGIN_AUDIT_MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* First write. */
      }
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
        mode: 0o600
      })
    } catch {
      /* Auditing must not break the plugin call it describes. */
    }
  }
}

/** Plugin processes get only what they need to run tools, never provider keys or app env. */
export function pluginProcessEnv(pluginId: string, source = process.env): Record<string, string> {
  const env: Record<string, string> = { PI_PLUGIN_ID: pluginId, NODE_ENV: 'production' }
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'USERPROFILE',
    'LANG',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'PI_DESKTOP_LOCALE'
  ])
    if (source[key]) env[key] = source[key]!
  if (!env.HOME) env.HOME = homedir()
  return env
}

function electronPluginSpawner(
  entry: string,
  logs?: PluginLogs
): PluginRuntimeDependencies['spawn'] {
  return (pluginId) => {
    const child = utilityProcess.fork(entry, [], {
      serviceName: `Pi Plugin ${pluginId}`,
      stdio: 'pipe',
      env: pluginProcessEnv(pluginId)
    })
    if (logs) {
      child.stdout
        ?.setEncoding('utf8')
        .on('data', (text: string) => logs.write(pluginId, 'out', text))
      child.stderr
        ?.setEncoding('utf8')
        .on('data', (text: string) => logs.write(pluginId, 'err', text))
    } else {
      child.stdout?.resume()
      child.stderr?.resume()
    }
    const handle: PluginProcessHandle = {
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => child.on('message', listener),
      onExit: (listener) => child.on('exit', listener),
      kill: () => {
        child.kill()
      }
    }
    return handle
  }
}

const panelStates = new WeakMap<WorkbenchHost, WorkbenchHostState>()

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

async function revalidateEntry(
  request: WorkbenchPanelViewRequest
): Promise<{ canonicalRootPath: string; canonicalEntryPath: string }> {
  const canonicalRootPath = await realpath(request.plugin.canonicalRootPath)
  if (canonicalRootPath !== request.plugin.canonicalRootPath) {
    throw new Error('Workbench plugin root changed after discovery')
  }
  if (!(await stat(canonicalRootPath)).isDirectory()) {
    throw new Error('Workbench plugin root is no longer a directory')
  }

  if (request.entry.canonicalEntryPath === undefined) {
    throw new Error('Workbench view is drawn by the host, not loaded from the plugin')
  }
  const canonicalEntryPath = await realpath(request.entry.canonicalEntryPath)
  if (canonicalEntryPath !== request.entry.canonicalEntryPath) {
    throw new Error('Workbench plugin entry changed after discovery')
  }
  if (
    !isPathInside(canonicalRootPath, canonicalEntryPath) ||
    !(await stat(canonicalEntryPath)).isFile()
  ) {
    throw new Error('Workbench plugin entry is no longer a regular file inside its root')
  }
  return { canonicalRootPath, canonicalEntryPath }
}

function pluginPartition(pluginId: string, viewId: string): string {
  const digest = createHash('sha256').update(`${pluginId}\0${viewId}`).digest('hex').slice(0, 32)
  return `pi-workbench-${digest}`
}

function configurePanelSession(
  partition: string,
  panelSession: Session,
  canonicalRootPath: string,
  ownership: WorkbenchPanelSessionOwnership,
  inlineScripts: boolean
): void {
  configureOwnedWorkbenchPanelSession({
    partition,
    panelSession,
    ownership,
    configureWebRequest: (ownedSession) => {
      ownedSession.webRequest.onBeforeRequest(
        { urls: ['<all_urls>'] },
        (details: OnBeforeRequestListenerDetails, callback) => {
          void canonicalWorkbenchPanelFile(details.url, canonicalRootPath)
            .then((allowedPath) => callback({ cancel: allowedPath === null }))
            .catch(() => callback({ cancel: true }))
        }
      )
      ownedSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        callback({
          responseHeaders: secureWorkbenchPanelResponseHeaders(details.responseHeaders, {
            inlineScripts
          })
        })
      })
    }
  })
}

async function createElectronPanelView(
  window: BrowserWindow,
  preloadPath: string,
  request: WorkbenchPanelViewRequest,
  sessionOwnership: WorkbenchPanelSessionOwnership,
  bindPanelSender?: (sender: WebContents, viewId: string) => () => void,
  logs?: PluginLogs
): Promise<WorkbenchPanelView> {
  request.signal.throwIfAborted()
  const { canonicalRootPath, canonicalEntryPath } = await revalidateEntry(request)
  request.signal.throwIfAborted()

  const partition = pluginPartition(
    request.entry.contribution.pluginId,
    request.entry.contribution.viewId
  )
  const panelSession = session.fromPartition(partition, { cache: false })
  configurePanelSession(
    partition,
    panelSession,
    canonicalRootPath,
    sessionOwnership,
    request.plugin.piDesktopCompat === true
  )
  const view = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      navigateOnDragDrop: false,
      webviewTag: false
    }
  })
  const contents = view.webContents
  let unbindPanelSender = (): void => undefined
  try {
    unbindPanelSender =
      bindPanelSender?.(contents, request.entry.contribution.viewId) ?? unbindPanelSender
  } catch {
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
    throw new Error('Workbench panel binding failed')
  }
  view.setBackgroundColor('#0A0A0A')
  view.setVisible(false)
  window.contentView.addChildView(view)
  let destroyed = false
  let currentContext = request.context

  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-frame-navigate', (event) => {
    if (!isPotentialWorkbenchPanelNavigation(event.url, canonicalRootPath)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isPotentialWorkbenchPanelNavigation(url, canonicalRootPath)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('did-finish-load', () => {
    if (!contents.isDestroyed()) contents.send(WORKBENCH_PANEL_CONTEXT_CHANNEL, currentContext)
  })
  contents.on('render-process-gone', (_event, details) => request.onCrash(details.reason))
  if (logs)
    contents.on('console-message', (details) => {
      if (details.level === 'debug') return
      const where = details.sourceId
        ? ` (${details.sourceId.split('/').pop()}:${details.lineNumber})`
        : ''
      logs.append(
        request.entry.contribution.pluginId,
        details.level,
        `${details.message}${where}`,
        'panel'
      )
    })

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    unbindPanelSender()
    try {
      window.contentView.removeChildView(view)
    } catch {
      // The owner window may already be closing.
    }
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
  }

  await loadAbortableWorkbenchPanel({
    signal: request.signal,
    load: () => contents.loadFile(canonicalEntryPath),
    stop: () => {
      if (!contents.isDestroyed()) contents.stop()
    },
    destroy
  })

  return {
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
    setContext: (context) => {
      currentContext = context
      if (!contents.isDestroyed()) contents.send(WORKBENCH_PANEL_CONTEXT_CHANNEL, context)
    },
    reload: () => {
      if (!contents.isDestroyed()) contents.reloadIgnoringCache()
    },
    destroy
  }
}

async function pluginRootsIn(
  desktopPluginsDirectory: string,
  source: string,
  scope: PiPackageRoot['scope']
): Promise<PiPackageRoot[]> {
  let children
  try {
    children = await readdir(desktopPluginsDirectory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }

  return children
    .filter((child) => child.isDirectory() || child.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child) => ({
      path: join(desktopPluginsDirectory, child.name),
      source,
      scope,
      hasExecutablePiResources: false
    }))
}

class WorkbenchHostImplementation implements WorkbenchHost {
  constructor(
    private readonly state: WorkbenchHostState,
    private readonly cleanupSessions: () => void,
    private readonly cleanupPanelSenders: (host: WorkbenchHost) => void,
    private readonly plugins: {
      call(
        viewId: string,
        method: string,
        params: unknown,
        approve?: NonNullable<PluginRuntimeDependencies['approve']>
      ): Promise<unknown>
      runTool(pluginId: string, name: string, input: unknown, signal?: AbortSignal): Promise<string>
      respond(id: string, allow: boolean): void
    }
  ) {}

  pluginCall(viewId: string, method: string, params: unknown): Promise<unknown> {
    return this.plugins.call(viewId, method, params)
  }

  mobileCall(
    viewId: string,
    method: string,
    params: unknown,
    approve: NonNullable<PluginRuntimeDependencies['approve']>
  ): Promise<unknown> {
    if (!this.state.mobileViews().some((view) => view.id === viewId))
      return Promise.reject(new PluginApiError('NOT_FOUND', t('这个插件页面没有开放给手机')))
    return this.plugins.call(viewId, method, params, approve)
  }

  mobileViews(): MobilePluginViewSource[] {
    return this.state.mobileViews()
  }

  async agentContributions(): Promise<PluginAgentContributions> {
    await this.state.whenLoaded()
    return this.state.agentContributions()
  }

  runAgentTool(
    pluginId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<string> {
    return this.plugins.runTool(pluginId, name, input, signal)
  }

  snapshot(): WorkbenchSnapshot {
    return this.state.snapshot()
  }

  reload(): Promise<WorkbenchSnapshot> {
    return this.state.reload()
  }

  dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult> {
    if (command.type === 'plugin:approval:respond') {
      this.plugins.respond(command.id, command.allow)
      return Promise.resolve({ state: this.state.snapshot() })
    }
    return this.state.dispatch(command)
  }

  setContext(context: WorkbenchHostContext): void {
    this.state.setContext(context)
  }

  setPackageRoots(roots: readonly PiPackageRoot[]): Promise<WorkbenchSnapshot> {
    return this.state.setPackageRoots(roots)
  }

  panelContext(viewId: string): PluginPanelContext {
    return this.state.panelContext(viewId)
  }

  dispose(): void {
    try {
      this.state.dispose()
    } finally {
      try {
        this.cleanupPanelSenders(this)
      } finally {
        this.cleanupSessions()
        panelStates.delete(this)
      }
    }
  }
}

export function createWorkbenchHost(dependencies: WorkbenchHostDependencies): WorkbenchHost {
  const sessionOwnership = createWorkbenchPanelSessionOwnership()
  const panelSenderBinding = dependencies.panelSenderBinding
  let projectPath: string | null = null
  let notifyRuntime = (): void => undefined
  const spawn =
    dependencies.spawnPlugin ??
    (dependencies.pluginHostPath
      ? electronPluginSpawner(dependencies.pluginHostPath, dependencies.logs)
      : undefined)
  const storageKey = 'workbenchPluginStorage'
  const approvals = new Map<string, (allow: boolean) => void>()
  const approve: PluginRuntimeDependencies['approve'] = (request) =>
    new Promise<boolean>((resolve) => {
      if (!dependencies.onEvent) return resolve(false)
      const id = randomUUID()
      const settle = (allow: boolean): void => {
        if (!approvals.delete(id)) return
        clearTimeout(timer)
        dependencies.onEvent?.({ type: 'plugin-approval-closed', id })
        resolve(allow)
      }
      const timer = setTimeout(() => settle(false), dependencies.approvalTimeoutMs ?? 120_000)
      approvals.set(id, settle)
      dependencies.onEvent({
        type: 'plugin-approval',
        id,
        pluginId: request.pluginId,
        pluginName: request.pluginName,
        title: request.title.slice(0, 600),
        detail: request.detail.slice(0, 20_000)
      })
    })
  const runtime = spawn
    ? new PluginRuntime({
        spawn,
        context: () => ({
          projectPath,
          ...(dependencies.permissionMode ? { permissionMode: dependencies.permissionMode() } : {})
        }),
        ...(dependencies.pluginServices ? { services: dependencies.pluginServices } : {}),
        approve,
        storage: {
          get: (key) => {
            const all = dependencies.store.get(storageKey)
            return all && typeof all === 'object'
              ? (all as Record<string, unknown>)[key]
              : undefined
          },
          set: (key, value) => {
            const all = dependencies.store.get(storageKey)
            dependencies.store.set(storageKey, {
              ...(all && typeof all === 'object' ? all : {}),
              [key]: value
            })
          }
        },
        toast: (pluginId, message) => {
          dependencies.logs?.append(pluginId, 'warning', message)
          dependencies.onEvent?.({ type: 'toast', pluginId, message: message.slice(0, 600) })
        },
        openView: (viewId) => dependencies.onEvent?.({ type: 'reveal', viewId }),
        chatDraft: (pluginId, text) =>
          dependencies.onEvent?.({ type: 'chat-draft', pluginId, text }),
        openSettings: (section) => dependencies.onEvent?.({ type: 'open-settings', section }),
        ...(dependencies.openExternal ? { openExternal: dependencies.openExternal } : {}),
        ...(dependencies.complete ? { complete: dependencies.complete } : {}),
        audit: pluginAuditWriter(join(dependencies.agentDir, 'pi-desktop', 'plugin-audit.jsonl')),
        settings: {
          get: (pluginId) => state.pluginSettings(pluginId),
          set: (pluginId, values) => state.setPluginSettings(pluginId, values)
        },
        dataPath: async (pluginId) => {
          const path = join(dependencies.agentDir, 'pi-desktop', 'plugin-data', pluginId)
          await mkdir(path, { recursive: true })
          return path
        },
        ...(dependencies.appearance ? { appearance: dependencies.appearance } : {}),
        onChange: () => notifyRuntime()
      })
    : undefined
  const state = createWorkbenchHostState({
    ...(runtime ? { runtime } : {}),
    appVersion: dependencies.appVersion,
    userRoots: async () => [
      ...((await dependencies.developmentRoots?.()) ?? []),
      ...(await pluginRootsIn(
        join(dependencies.agentDir, 'desktop-plugins'),
        t('本机插件'),
        'user'
      ))
    ],
    ...(dependencies.bundledPluginDirectory
      ? {
          bundledRoots: () =>
            pluginRootsIn(dependencies.bundledPluginDirectory!, t('内置插件'), 'bundled')
        }
      : {}),
    discover: discoverWorkbenchManifests,
    store: dependencies.store,
    createView:
      dependencies.createView ??
      ((request) =>
        createElectronPanelView(
          dependencies.window,
          dependencies.preloadPath,
          request,
          sessionOwnership,
          panelSenderBinding
            ? (sender, viewId) => panelSenderBinding.bind(sender, host, viewId)
            : undefined,
          dependencies.logs
        )),
    nativeViews: { browser: dependencies.browser },
    ...(dependencies.onState === undefined ? {} : { onState: dependencies.onState })
  })
  notifyRuntime = () => state.runtimeChanged()
  const trackedState = Object.assign(Object.create(state) as typeof state, {
    setContext(context: Parameters<typeof state.setContext>[0]) {
      projectPath = context.projectPath
      state.setContext(context)
    },
    dispose() {
      for (const settle of [...approvals.values()]) settle(false)
      state.dispose()
      runtime?.dispose()
    }
  })
  const host = new WorkbenchHostImplementation(
    trackedState,
    () => cleanupWorkbenchPanelSessions(sessionOwnership),
    (owner) => panelSenderBinding?.unbindHost(owner),
    {
      call: async (viewId, method, params, approve) => {
        const plugin = state.pluginForView(viewId)
        if (!plugin) throw new PluginApiError('NOT_FOUND', t('插件未启用'))
        if (!runtime) throw new PluginApiError('UNSUPPORTED', t('插件运行时不可用'))
        return runtime.callFromView(plugin, method, params, approve ? { approve } : undefined)
      },
      runTool: async (pluginId, name, input, signal) => {
        if (!runtime) throw new PluginApiError('UNSUPPORTED', t('插件运行时不可用'))
        await state.whenLoaded()
        const tool = state
          .agentContributions()
          .tools.find((candidate) => candidate.pluginId === pluginId && candidate.name === name)
        if (!tool) throw new PluginApiError('NOT_FOUND', t('插件工具不可用'))
        if ((JSON.stringify(input ?? {}) ?? '').length > 64 * 1024)
          throw new PluginApiError('INVALID_ARGUMENT', t('插件工具参数超限'))
        const validate = new AjvJsonSchemaValidator().getValidator(tool.parameters)
        if (!validate(input ?? {}).valid)
          throw new PluginApiError('INVALID_ARGUMENT', t('参数不符合插件工具声明的 schema'))
        return runtime.runTool(pluginId, name, input ?? {}, signal)
      },
      respond: (id, allow) => approvals.get(id)?.(allow)
    }
  )
  panelStates.set(host, state)
  return host
}

/** Internal bridge seam for Task 4; it does not expand the seven-method WorkbenchHost Interface. */
export function createWorkbenchPanelStateAdapter(
  host: WorkbenchHost,
  viewId: string
): WorkbenchPanelStateAdapter {
  const state = panelStates.get(host)
  if (!state) throw new Error('Workbench host is unavailable')
  return {
    context: () => host.panelContext(viewId),
    getState: (context) => state.getPanelState(context),
    setState: (context, value) => state.setPanelState(context, value),
    runOperation: (context, operation) => state.runPanelOperation(context, operation)
  }
}
