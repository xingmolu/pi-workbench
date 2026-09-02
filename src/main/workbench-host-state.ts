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
  const desktopEnabled = readDesktopEnabled(dependencies.store)
  const panelStates = readPanelStates(dependencies.store)
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
  const crashCounts = new Map<string, number>()
  const crashDiagnostics = new Map<string, WorkbenchDiagnostic>()
  let activeViewId: string | null = null

  const isDesktopEnabled = (pluginId: string): boolean => desktopEnabled[pluginId] !== false

  const destroyView = (viewId: string): void => {
    const record = views.get(viewId)
    if (!record) return
    record.view.destroy()
    views.delete(viewId)
    if (activeViewId === viewId) activeViewId = null
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

  const hideActiveView = async (): Promise<void> => {
    if (activeViewId === null) return
    if (activeViewId === 'works.pi.desktop.browser') {
      await dependencies.nativeViews.browser.setView(false)
    } else {
      views.get(activeViewId)?.view.setVisible(false)
    }
    activeViewId = null
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

  const handlePanelCrash = (
    pluginId: string,
    viewId: string,
    token: object,
    reason: string
  ): void => {
    const record = views.get(viewId)
    if (!record || record.token !== token) return
    destroyView(viewId)
    const crashCount = (crashCounts.get(pluginId) ?? 0) + 1
    crashCounts.set(pluginId, crashCount)
    if (crashCount >= 3) {
      desktopEnabled[pluginId] = false
      dependencies.store.set(DESKTOP_ENABLED_STORE_KEY, { ...desktopEnabled })
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

  const api: WorkbenchHostState = {
    snapshot,
    async reload() {
      abortOperations()
      const userRoots = await dependencies.userRoots()
      const nextDiscovery = reserveBuiltinRegistry(
        await dependencies.discover({
          roots: [...userRoots, ...packageRoots],
          appVersion: dependencies.appVersion
        })
      )
      destroyAllViews()
      discovery = nextDiscovery
      revision += 1
      const nextSnapshot = snapshot()
      dependencies.onState?.(nextSnapshot)
      return nextSnapshot
    },
    async dispatch(command) {
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
          desktopEnabled[command.pluginId] = command.desktopEnabled
          dependencies.store.set(DESKTOP_ENABLED_STORE_KEY, { ...desktopEnabled })
          if (!command.desktopEnabled) destroyPluginViews(command.pluginId)
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
            if (command.visible && activeViewId !== command.viewId) await hideActiveView()
            if (builtinContribution.surface.kind === 'native-view') {
              await dependencies.nativeViews.browser.setView(command.visible, command.bounds)
            }
            if (command.visible) activeViewId = command.viewId
            else if (activeViewId === command.viewId) activeViewId = null
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
          if (command.visible && activeViewId !== command.viewId) await hideActiveView()
          let record = views.get(command.viewId)
          if (command.visible && !record) {
            const token = {}
            const panelContext = this.panelContext(command.viewId)
            let pendingView: WorkbenchPanelView | undefined
            try {
              await this.runPanelOperation(panelContext, async (signal) => {
                pendingView = await dependencies.createView({
                  plugin,
                  entry,
                  context: panelContext,
                  signal,
                  onCrash: (reason) =>
                    handlePanelCrash(plugin.pluginId, command.viewId, token, reason)
                })
              })
            } catch (error) {
              pendingView?.destroy()
              throw error
            }
            const view = pendingView!
            record = {
              pluginId: plugin.pluginId,
              activation: entry.contribution.activation,
              token,
              view
            }
            views.set(command.viewId, record)
          }
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
      packageRoots = roots.map((root) => ({ ...root }))
      return this.reload()
    },
    panelContext(viewId) {
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
      assertCurrentPanelContext(panelContext)
      return panelStates[panelStateKey(panelContext)] ?? null
    },
    setPanelState(panelContext, value) {
      assertCurrentPanelContext(panelContext)
      const parsed = pluginPanelStateSchema.parse(value)
      panelStates[panelStateKey(panelContext)] = parsed
      dependencies.store.set(PANEL_STATE_STORE_KEY, { ...panelStates })
    },
    async runPanelOperation(panelContext, operation) {
      assertCurrentPanelContext(panelContext)
      const controller = new AbortController()
      activeOperations.add(controller)
      try {
        const result = await operation(controller.signal)
        if (controller.signal.aborted) throw new Error('Workbench panel operation was aborted')
        assertCurrentPanelContext(panelContext)
        return result
      } finally {
        activeOperations.delete(controller)
      }
    },
    dispose() {
      abortOperations()
      destroyAllViews()
      if (activeViewId === 'works.pi.desktop.browser') {
        void dependencies.nativeViews.browser.setView(false)
      }
      activeViewId = null
    }
  }
  return api
}
