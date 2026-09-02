import type {
  DesktopPluginSummary,
  JsonValue,
  PluginPanelContext,
  WorkbenchBounds,
  WorkbenchCommand,
  WorkbenchCommandResult,
  WorkbenchDiagnostic,
  WorkbenchSnapshot
} from '../shared/workbench-contracts'
import { pluginPanelStateSchema } from '../shared/workbench-schemas'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import type {
  ValidatedWorkbenchEntry,
  ValidatedWorkbenchPlugin,
  WorkbenchManifestDiscovery,
  WorkbenchManifestDiscoveryOptions
} from './workbench-manifest'

export type WorkbenchHostContext = Pick<
  PluginPanelContext,
  'projectPath' | 'sessionId' | 'generation'
>

export type WorkbenchStateStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export type WorkbenchPanelView = {
  setBounds(bounds: WorkbenchBounds): void
  setVisible(visible: boolean): void
  setContext(context: PluginPanelContext): void
  destroy(): void
}

export type WorkbenchPanelViewRequest = {
  plugin: ValidatedWorkbenchPlugin
  entry: ValidatedWorkbenchEntry
  context: PluginPanelContext
  signal: AbortSignal
  onCrash: (reason: string) => void
}

export type WorkbenchNativeView = {
  setView(visible: boolean, bounds?: WorkbenchBounds): void | Promise<void>
}

export type WorkbenchHostStateDependencies = {
  appVersion: string
  userRoots: () => Promise<readonly PiPackageRoot[]>
  discover: (options: WorkbenchManifestDiscoveryOptions) => Promise<WorkbenchManifestDiscovery>
  store: WorkbenchStateStore
  createView: (request: WorkbenchPanelViewRequest) => Promise<WorkbenchPanelView>
  nativeViews: { browser: WorkbenchNativeView }
  onState?: (snapshot: WorkbenchSnapshot) => void
}

export type WorkbenchHostState = {
  snapshot(): WorkbenchSnapshot
  reload(): Promise<WorkbenchSnapshot>
  dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult>
  setContext(context: WorkbenchHostContext): void
  setPackageRoots(roots: readonly PiPackageRoot[]): Promise<WorkbenchSnapshot>
  panelContext(viewId: string): PluginPanelContext
  getPanelState(context: PluginPanelContext): JsonValue
  setPanelState(context: PluginPanelContext, value: unknown): void
  runPanelOperation<Result>(
    context: PluginPanelContext,
    operation: (signal: AbortSignal) => Promise<Result>
  ): Promise<Result>
  dispose(): void
}

const BUILTIN_PLUGIN: DesktopPluginSummary = {
  pluginId: 'works.pi.desktop.builtin',
  name: 'Pi Desktop',
  version: '0.1.0',
  description: 'Built-in Workbench views',
  source: 'builtin',
  scope: 'builtin',
  builtin: true,
  desktopEnabled: true,
  hasExecutablePiResources: false,
  requestedPermissions: [],
  diagnostics: []
}

const BUILTIN_CONTRIBUTIONS: WorkbenchSnapshot['contributions'] = [
  {
    pluginId: BUILTIN_PLUGIN.pluginId,
    viewId: 'works.pi.desktop.files',
    title: 'Files',
    icon: 'files',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'files' }
  },
  {
    pluginId: BUILTIN_PLUGIN.pluginId,
    viewId: 'works.pi.desktop.review',
    title: 'Review',
    icon: 'git-review',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'review' }
  },
  {
    pluginId: BUILTIN_PLUGIN.pluginId,
    viewId: 'works.pi.desktop.terminal',
    title: 'Terminal',
    icon: 'terminal',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'terminal' }
  },
  {
    pluginId: BUILTIN_PLUGIN.pluginId,
    viewId: 'works.pi.desktop.browser',
    title: 'Browser',
    icon: 'browser',
    activation: 'onApp',
    surface: { kind: 'native-view', adapter: 'browser' }
  }
]

const DESKTOP_ENABLED_STORE_KEY = 'workbenchDesktopEnabled'
const PANEL_STATE_STORE_KEY = 'workbenchPanelState'
const BROWSER_VIEW_ID = 'works.pi.desktop.browser'

function readDesktopEnabled(store: WorkbenchStateStore): Record<string, boolean> {
  const stored = store.get(DESKTOP_ENABLED_STORE_KEY)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, boolean] => {
      return typeof entry[1] === 'boolean'
    })
  )
}

function readPanelStates(store: WorkbenchStateStore): Record<string, JsonValue> {
  const stored = store.get(PANEL_STATE_STORE_KEY)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).flatMap(([key, value]) => {
      const parsed = pluginPanelStateSchema.safeParse(value)
      return parsed.success ? [[key, parsed.data] as const] : []
    })
  )
}

function reserveBuiltinRegistry(discovery: WorkbenchManifestDiscovery): WorkbenchManifestDiscovery {
  const reservedViewIds = new Set(BUILTIN_CONTRIBUTIONS.map(({ viewId }) => viewId))
  const plugins: ValidatedWorkbenchPlugin[] = []
  const diagnostics = [...discovery.diagnostics]
  for (const plugin of discovery.plugins) {
    if (plugin.pluginId === BUILTIN_PLUGIN.pluginId) {
      diagnostics.push({
        severity: 'error',
        code: 'reserved-plugin-id',
        message: 'Workbench plugin id is reserved by Pi Desktop.',
        pluginId: plugin.pluginId
      })
      continue
    }
    const reservedView = plugin.workbench.find(({ contribution }) =>
      reservedViewIds.has(contribution.viewId)
    )
    if (reservedView) {
      diagnostics.push({
        severity: 'error',
        code: 'reserved-view-id',
        message: 'Workbench view id is reserved by Pi Desktop.',
        pluginId: plugin.pluginId,
        viewId: reservedView.contribution.viewId
      })
      continue
    }
    plugins.push(plugin)
  }
  return { plugins, diagnostics }
}

export function createWorkbenchHostState(
  dependencies: WorkbenchHostStateDependencies
): WorkbenchHostState {
  let revision = 0
  let discovery: WorkbenchManifestDiscovery = { plugins: [], diagnostics: [] }
  let context: WorkbenchHostContext = { projectPath: null, sessionId: null, generation: 0 }
  let packageRoots: PiPackageRoot[] = []
  let registryEpoch = 0
  let selectionEpoch = 0
  let desiredViewId: string | null = null
  let disposed = false
  const desktopEnabled = readDesktopEnabled(dependencies.store)
  const panelStates = readPanelStates(dependencies.store)
  type PendingCreation = {
    pluginId: string
    viewId: string
    generation: number
    registryEpoch: number
    selectionEpoch: number
    token: object
    controller: AbortController
    view?: WorkbenchPanelView
    invalidated: boolean
  }
  const views = new Map<
    string,
    {
      pluginId: string
      activation: 'onApp' | 'onProject'
      token: object
      view: WorkbenchPanelView
    }
  >()
  const activeOperations = new Set<AbortController>()
  const pendingCreations = new Map<string, PendingCreation>()
  const crashCounts = new Map<string, number>()
  const crashDiagnostics = new Map<string, WorkbenchDiagnostic>()
  const browserOperations = new Map<Promise<void>, boolean>()
  let browserReconcileQueued = false
  let desiredBrowserBounds: WorkbenchBounds | undefined
  let activeViewId: string | null = null

  const isDesktopEnabled = (pluginId: string): boolean => desktopEnabled[pluginId] !== false

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('Workbench host has been disposed')
  }

  const destroyView = (viewId: string): void => {
    const record = views.get(viewId)
    if (!record) return
    views.delete(viewId)
    if (activeViewId === viewId) activeViewId = null
    record.view.destroy()
  }

  const destroyPluginViews = (pluginId: string): void => {
    for (const [viewId, record] of views) {
      if (record.pluginId === pluginId) destroyView(viewId)
    }
  }

  const destroyAllViews = (): void => {
    for (const viewId of [...views.keys()]) destroyView(viewId)
  }

  const abortOperations = (): void => {
    for (const controller of activeOperations) controller.abort()
    activeOperations.clear()
  }

  const invalidatePendingCreation = (pending: PendingCreation): void => {
    if (pendingCreations.get(pending.viewId)?.token === pending.token) {
      pendingCreations.delete(pending.viewId)
    }
    pending.invalidated = true
    pending.controller.abort()
    pending.view?.destroy()
  }

  const invalidatePendingCreations = (pluginId?: string): void => {
    for (const pending of [...pendingCreations.values()]) {
      if (pluginId === undefined || pending.pluginId === pluginId) {
        invalidatePendingCreation(pending)
      }
    }
  }

  type SelectionToken = { epoch: number; viewId: string | null }

  const assertCurrentSelection = (token: SelectionToken): void => {
    assertNotDisposed()
    if (token.epoch !== selectionEpoch || token.viewId !== desiredViewId) {
      throw new Error('Workbench panel selection was superseded')
    }
  }

  function scheduleBrowserReconciliation(): void {
    if (disposed || browserReconcileQueued) return
    browserReconcileQueued = true
    queueMicrotask(() => {
      browserReconcileQueued = false
      if (disposed) return
      const reconcileEpoch = selectionEpoch
      const visible = desiredViewId === BROWSER_VIEW_ID
      const bounds = visible ? desiredBrowserBounds : undefined
      void startBrowserOperation(visible, bounds, reconcileEpoch).catch(() => undefined)
    })
  }

  function startBrowserOperation(
    visible: boolean,
    bounds: WorkbenchBounds | undefined,
    operationEpoch: number
  ): Promise<void> {
    let adapterOperation: Promise<void>
    try {
      adapterOperation = Promise.resolve(dependencies.nativeViews.browser.setView(visible, bounds))
    } catch (error) {
      adapterOperation = Promise.reject(error)
    }
    browserOperations.set(adapterOperation, visible)
    const finish = (): void => {
      browserOperations.delete(adapterOperation)
      if (!disposed && operationEpoch !== selectionEpoch) scheduleBrowserReconciliation()
    }
    const observed = adapterOperation.then(
      () => finish(),
      (error) => {
        finish()
        throw error
      }
    )
    void observed.catch(() => undefined)
    return observed
  }

  const browserCouldBeVisible = (): boolean =>
    activeViewId === BROWSER_VIEW_ID ||
    desiredViewId === BROWSER_VIEW_ID ||
    [...browserOperations.values()].some(Boolean)

  const hideBrowserAfterDispose = async (): Promise<void> => {
    try {
      await startBrowserOperation(false, undefined, selectionEpoch)
    } catch {
      // Disposal is best-effort, including adapters that reject while their owner is closing.
    }
  }

  const beginSelection = (
    viewId: string,
    visible: boolean,
    bounds?: WorkbenchBounds
  ): { token: SelectionToken; browserOperation?: Promise<void> } => {
    const previousDesiredViewId = desiredViewId
    const changesDesired = visible || desiredViewId === viewId
    if (changesDesired) {
      selectionEpoch += 1
      desiredViewId = visible ? viewId : null
      desiredBrowserBounds = desiredViewId === BROWSER_VIEW_ID ? bounds : undefined
      if (visible) invalidatePendingCreations()
      else {
        const pending = pendingCreations.get(viewId)
        if (pending) invalidatePendingCreation(pending)
      }
    }

    if (
      activeViewId !== null &&
      activeViewId !== desiredViewId &&
      activeViewId !== BROWSER_VIEW_ID
    ) {
      views.get(activeViewId)?.view.setVisible(false)
      activeViewId = null
    }

    const browserBarrier =
      viewId === BROWSER_VIEW_ID ||
      previousDesiredViewId === BROWSER_VIEW_ID ||
      browserCouldBeVisible()
    const token = { epoch: selectionEpoch, viewId: desiredViewId }
    const browserOperation = browserBarrier
      ? startBrowserOperation(desiredViewId === BROWSER_VIEW_ID, desiredBrowserBounds, token.epoch)
      : undefined
    return browserOperation === undefined ? { token } : { token, browserOperation }
  }

  const isAvailable = (activation: 'onApp' | 'onProject'): boolean =>
    activation === 'onApp' || context.projectPath !== null

  const assertCurrentPanelContext = (panelContext: PluginPanelContext): void => {
    const current = api.panelContext(panelContext.viewId)
    if (
      current.pluginId !== panelContext.pluginId ||
      current.projectPath !== panelContext.projectPath ||
      current.sessionId !== panelContext.sessionId ||
      current.generation !== panelContext.generation
    ) {
      throw new Error('Workbench panel context or generation is no longer current')
    }
  }

  const panelStateKey = (panelContext: PluginPanelContext): string =>
    JSON.stringify([
      panelContext.pluginId,
      panelContext.viewId,
      panelContext.projectPath ?? '$workbench-app'
    ])

  const pluginDiagnostics = (pluginId: string): WorkbenchDiagnostic[] => [
    ...discovery.diagnostics.filter((diagnostic) => diagnostic.pluginId === pluginId),
    ...(crashDiagnostics.has(pluginId) ? [crashDiagnostics.get(pluginId)!] : [])
  ]

  const snapshot = (): WorkbenchSnapshot => ({
    revision,
    plugins: [
      { ...BUILTIN_PLUGIN, version: dependencies.appVersion },
      ...discovery.plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        name: plugin.name,
        version: plugin.version,
        ...(plugin.description === undefined ? {} : { description: plugin.description }),
        source: plugin.source,
        scope: plugin.scope,
        builtin: false,
        desktopEnabled: isDesktopEnabled(plugin.pluginId),
        hasExecutablePiResources: plugin.hasExecutablePiResources,
        requestedPermissions: plugin.requestedPermissions,
        diagnostics: pluginDiagnostics(plugin.pluginId)
      }))
    ],
    contributions: [
      ...BUILTIN_CONTRIBUTIONS.filter(({ activation }) => isAvailable(activation)),
      ...discovery.plugins.flatMap((plugin) =>
        isDesktopEnabled(plugin.pluginId)
          ? plugin.workbench
              .map(({ contribution }) => contribution)
              .filter(({ activation }) => isAvailable(activation))
          : []
      )
    ],
    diagnostics: [...discovery.diagnostics, ...crashDiagnostics.values()]
  })

  const beginRegistryReload = (): number => {
    registryEpoch += 1
    invalidatePendingCreations()
    abortOperations()
    destroyAllViews()
    discovery = { plugins: [], diagnostics: [] }
    revision += 1
    dependencies.onState?.(snapshot())
    return registryEpoch
  }

  const reloadRegistry = async (
    requestEpoch: number,
    requestedPackageRoots: readonly PiPackageRoot[]
  ): Promise<WorkbenchSnapshot> => {
    try {
      const userRoots = await dependencies.userRoots()
      const discovered = await dependencies.discover({
        roots: [...userRoots, ...requestedPackageRoots],
        appVersion: dependencies.appVersion
      })
      if (disposed || requestEpoch !== registryEpoch) return snapshot()

      discovery = reserveBuiltinRegistry(discovered)
      revision += 1
      const nextSnapshot = snapshot()
      dependencies.onState?.(nextSnapshot)
      return nextSnapshot
    } catch (error) {
      if (disposed || requestEpoch !== registryEpoch) return snapshot()
      throw error
    }
  }

  const recordPanelCrash = (pluginId: string, viewId: string, reason: string): void => {
    if (disposed) return
    const crashCount = (crashCounts.get(pluginId) ?? 0) + 1
    crashCounts.set(pluginId, crashCount)
    if (crashCount >= 3) {
      desktopEnabled[pluginId] = false
      dependencies.store.set(DESKTOP_ENABLED_STORE_KEY, { ...desktopEnabled })
      invalidatePendingCreations(pluginId)
      destroyPluginViews(pluginId)
      crashDiagnostics.set(pluginId, {
        severity: 'error',
        code: 'plugin-crash-disabled',
        message: `Desktop contributions were disabled after ${crashCount} renderer crashes (${reason}).`,
        pluginId,
        viewId
      })
    } else {
      crashDiagnostics.set(pluginId, {
        severity: 'warning',
        code: 'plugin-crashed',
        message: `Plugin renderer crashed (${reason}); it will be recreated when revealed.`,
        pluginId,
        viewId
      })
    }
    revision += 1
    dependencies.onState?.(snapshot())
  }

  const handlePanelCrash = (
    pluginId: string,
    viewId: string,
    token: object,
    reason: string
  ): void => {
    const pending = pendingCreations.get(viewId)
    if (
      pending?.token === token &&
      pending.pluginId === pluginId &&
      pending.generation === context.generation &&
      pending.registryEpoch === registryEpoch &&
      pending.selectionEpoch === selectionEpoch
    ) {
      invalidatePendingCreation(pending)
      recordPanelCrash(pluginId, viewId, reason)
      return
    }
    const record = views.get(viewId)
    if (!record || record.token !== token) return
    destroyView(viewId)
    recordPanelCrash(pluginId, viewId, reason)
  }

  const runTrackedPanelOperation = async <Result>(
    panelContext: PluginPanelContext,
    operation: (signal: AbortSignal) => Promise<Result>,
    controller = new AbortController()
  ): Promise<Result> => {
    assertCurrentPanelContext(panelContext)
    activeOperations.add(controller)
    try {
      const result = await operation(controller.signal)
      if (controller.signal.aborted) throw new Error('Workbench panel operation was aborted')
      assertCurrentPanelContext(panelContext)
      return result
    } finally {
      activeOperations.delete(controller)
    }
  }

  const api: WorkbenchHostState = {
    snapshot,
    async reload() {
      assertNotDisposed()
      const requestedPackageRoots = packageRoots.map((root) => ({ ...root }))
      const requestEpoch = beginRegistryReload()
      return reloadRegistry(requestEpoch, requestedPackageRoots)
    },
    async dispatch(command) {
      assertNotDisposed()
      switch (command.type) {
        case 'state:get':
          break
        case 'plugins:reload':
          return { state: await this.reload() }
        case 'plugin:set-enabled': {
          if (command.pluginId === BUILTIN_PLUGIN.pluginId) {
            throw new Error('The built-in Workbench plugin cannot be disabled')
          }
          if (!discovery.plugins.some((plugin) => plugin.pluginId === command.pluginId)) {
            throw new Error('Workbench plugin is unavailable')
          }
          if (command.desktopEnabled && (crashCounts.get(command.pluginId) ?? 0) >= 3) {
            throw new Error(
              'Workbench plugin was disabled after repeated crashes and requires an app restart'
            )
          }
          desktopEnabled[command.pluginId] = command.desktopEnabled
          dependencies.store.set(DESKTOP_ENABLED_STORE_KEY, { ...desktopEnabled })
          if (!command.desktopEnabled) {
            invalidatePendingCreations(command.pluginId)
            destroyPluginViews(command.pluginId)
          }
          revision += 1
          dependencies.onState?.(snapshot())
          break
        }
        case 'view:set': {
          const builtinContribution = BUILTIN_CONTRIBUTIONS.find(
            ({ viewId }) => viewId === command.viewId
          )
          if (builtinContribution) {
            if (!isAvailable(builtinContribution.activation)) {
              throw new Error('Workbench panel is unavailable')
            }
            const selection = beginSelection(command.viewId, command.visible, command.bounds)
            if (selection.browserOperation) {
              await selection.browserOperation
              assertCurrentSelection(selection.token)
            }
            if (command.visible) {
              assertCurrentSelection(selection.token)
              activeViewId = command.viewId
            } else if (activeViewId === command.viewId) activeViewId = null
            break
          }
          const plugin = discovery.plugins.find((candidate) =>
            candidate.workbench.some(({ contribution }) => contribution.viewId === command.viewId)
          )
          if (!plugin || !isDesktopEnabled(plugin.pluginId)) {
            throw new Error('Workbench panel is unavailable')
          }
          const entry = plugin.workbench.find(
            ({ contribution }) => contribution.viewId === command.viewId
          )
          if (!entry || !isAvailable(entry.contribution.activation)) {
            throw new Error('Workbench panel is unavailable')
          }
          const selection = beginSelection(command.viewId, command.visible, command.bounds)
          if (selection.browserOperation) {
            await selection.browserOperation
            assertCurrentSelection(selection.token)
            if (activeViewId === BROWSER_VIEW_ID) activeViewId = null
          }
          let record = views.get(command.viewId)
          if (command.visible && !record) {
            if (pendingCreations.has(command.viewId)) {
              throw new Error('Workbench panel creation is already in progress')
            }
            const token = {}
            const panelContext = this.panelContext(command.viewId)
            const controller = new AbortController()
            const pending: PendingCreation = {
              pluginId: plugin.pluginId,
              viewId: command.viewId,
              generation: panelContext.generation,
              registryEpoch,
              selectionEpoch: selection.token.epoch,
              token,
              controller,
              invalidated: false
            }
            pendingCreations.set(command.viewId, pending)
            try {
              await runTrackedPanelOperation(
                panelContext,
                async (signal) => {
                  pending.view = await dependencies.createView({
                    plugin,
                    entry,
                    context: panelContext,
                    signal,
                    onCrash: (reason) =>
                      handlePanelCrash(plugin.pluginId, command.viewId, token, reason)
                  })
                },
                controller
              )
              if (
                pending.invalidated ||
                pending.registryEpoch !== registryEpoch ||
                pending.selectionEpoch !== selectionEpoch ||
                pendingCreations.get(command.viewId)?.token !== pending.token
              ) {
                throw new Error('Workbench panel creation became stale or crashed')
              }
              pendingCreations.delete(command.viewId)
            } catch (error) {
              invalidatePendingCreation(pending)
              throw error
            }
            const view = pending.view
            if (!view) {
              throw new Error('Workbench panel creation did not return a view')
            }
            record = {
              pluginId: plugin.pluginId,
              activation: entry.contribution.activation,
              token,
              view
            }
            views.set(command.viewId, record)
          }
          if (command.visible) assertCurrentSelection(selection.token)
          if (command.bounds) record?.view.setBounds(command.bounds)
          record?.view.setVisible(command.visible)
          if (command.visible) activeViewId = command.viewId
          else if (activeViewId === command.viewId) activeViewId = null
          break
        }
      }
      return { state: snapshot() }
    },
    setContext(nextContext) {
      assertNotDisposed()
      if (
        nextContext.projectPath === context.projectPath &&
        nextContext.sessionId === context.sessionId &&
        nextContext.generation === context.generation
      ) {
        return
      }
      if (nextContext.generation <= context.generation) {
        throw new Error('Workbench context generation must advance')
      }
      invalidatePendingCreations()
      abortOperations()
      context = { ...nextContext }
      for (const [viewId, record] of views) {
        if (record.activation === 'onProject') {
          destroyView(viewId)
          continue
        }
        record.view.setContext({
          pluginId: record.pluginId,
          viewId,
          ...context
        })
      }
      revision += 1
      dependencies.onState?.(snapshot())
    },
    async setPackageRoots(roots) {
      assertNotDisposed()
      const requestedPackageRoots = roots.map((root) => ({ ...root }))
      packageRoots = requestedPackageRoots
      const requestEpoch = beginRegistryReload()
      return reloadRegistry(requestEpoch, requestedPackageRoots)
    },
    panelContext(viewId) {
      assertNotDisposed()
      const plugin = discovery.plugins.find(
        (candidate) =>
          isDesktopEnabled(candidate.pluginId) &&
          candidate.workbench.some(
            ({ contribution }) =>
              contribution.viewId === viewId && isAvailable(contribution.activation)
          )
      )
      if (!plugin) throw new Error('Workbench panel is unavailable')
      return { pluginId: plugin.pluginId, viewId, ...context }
    },
    getPanelState(panelContext) {
      assertNotDisposed()
      assertCurrentPanelContext(panelContext)
      return panelStates[panelStateKey(panelContext)] ?? null
    },
    setPanelState(panelContext, value) {
      assertNotDisposed()
      assertCurrentPanelContext(panelContext)
      const parsed = pluginPanelStateSchema.parse(value)
      panelStates[panelStateKey(panelContext)] = parsed
      dependencies.store.set(PANEL_STATE_STORE_KEY, { ...panelStates })
    },
    async runPanelOperation(panelContext, operation) {
      assertNotDisposed()
      return runTrackedPanelOperation(panelContext, operation)
    },
    dispose() {
      if (disposed) return
      disposed = true
      registryEpoch += 1
      selectionEpoch += 1
      desiredViewId = null
      desiredBrowserBounds = undefined
      browserOperations.clear()
      invalidatePendingCreations()
      abortOperations()
      destroyAllViews()
      activeViewId = null
      void hideBrowserAfterDispose().catch(() => undefined)
    }
  }
  return api
}
