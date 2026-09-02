import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  session,
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
  WorkbenchSnapshot
} from '../shared/workbench-contracts'
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
  type WorkbenchHostContext,
  type WorkbenchHostState,
  type WorkbenchPanelView,
  type WorkbenchPanelViewRequest,
  type WorkbenchStateStore
} from './workbench-host-state'

export interface WorkbenchHost {
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
  createView?: (request: WorkbenchPanelViewRequest) => Promise<WorkbenchPanelView>
  panelSenderBinding?: WorkbenchPanelSenderBinding
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
  ownership: WorkbenchPanelSessionOwnership
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
          responseHeaders: secureWorkbenchPanelResponseHeaders(details.responseHeaders)
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
  bindPanelSender?: (sender: WebContents, viewId: string) => () => void
): Promise<WorkbenchPanelView> {
  request.signal.throwIfAborted()
  const { canonicalRootPath, canonicalEntryPath } = await revalidateEntry(request)
  request.signal.throwIfAborted()

  const partition = pluginPartition(
    request.entry.contribution.pluginId,
    request.entry.contribution.viewId
  )
  const panelSession = session.fromPartition(partition, { cache: false })
  configurePanelSession(partition, panelSession, canonicalRootPath, sessionOwnership)
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
    destroy
  }
}

async function userDesktopPluginRoots(agentDir: string): Promise<PiPackageRoot[]> {
  const desktopPluginsDirectory = join(agentDir, 'desktop-plugins')
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
      source: `desktop-plugin:${child.name}`,
      scope: 'user' as const,
      hasExecutablePiResources: false
    }))
}

class WorkbenchHostImplementation implements WorkbenchHost {
  constructor(
    private readonly state: WorkbenchHostState,
    private readonly cleanupSessions: () => void,
    private readonly cleanupPanelSenders: (host: WorkbenchHost) => void
  ) {}

  snapshot(): WorkbenchSnapshot {
    return this.state.snapshot()
  }

  reload(): Promise<WorkbenchSnapshot> {
    return this.state.reload()
  }

  dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult> {
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
  const state = createWorkbenchHostState({
    appVersion: dependencies.appVersion,
    userRoots: () => userDesktopPluginRoots(dependencies.agentDir),
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
            : undefined
        )),
    nativeViews: { browser: dependencies.browser },
    ...(dependencies.onState === undefined ? {} : { onState: dependencies.onState })
  })
  const host = new WorkbenchHostImplementation(
    state,
    () => cleanupWorkbenchPanelSessions(sessionOwnership),
    (owner) => panelSenderBinding?.unbindHost(owner)
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
