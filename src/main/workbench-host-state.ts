import type { MobilePluginView } from '../shared/remote-views'
import type {
  DesktopPluginSummary,
  JsonValue,
  PluginPanelContext,
  WorkbenchBounds,
  WorkbenchCommand,
  WorkbenchCommandResult,
  WorkbenchDiagnostic,
  WorkbenchSnapshot,
  WorkbenchContribution
} from '../shared/workbench-contracts'
import { resolveSettingPlaceholders } from './manifest-compat'
import {
  BROWSER_PLUGIN_ID,
  BROWSER_VIEW_ID,
  TERMINAL_PLUGIN_ID,
  TERMINAL_VIEW_ID
} from '../shared/workbench-contracts'

/** Views the host draws itself, each reserved for the bundled package that ships it. */
const HOST_VIEW_OWNERS = new Map([
  [BROWSER_VIEW_ID, BROWSER_PLUGIN_ID],
  [TERMINAL_VIEW_ID, TERMINAL_PLUGIN_ID]
])
import { pluginPanelStateSchema } from '../shared/workbench-schemas'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import type {
  ValidatedWorkbenchEntry,
  ValidatedPluginSetting,
  ValidatedWorkbenchPlugin,
  WorkbenchManifestDiscovery,
  WorkbenchManifestDiscoveryOptions
} from './workbench-manifest'
import { realpath } from 'node:fs/promises'
import { mergeWorkbenchPackageRoots } from './workbench-package-root-merge'
import {
  IMPLICIT_PLUGIN_PERMISSIONS,
  isKnownPluginPermission,
  PluginApiError
} from '../shared/plugin-api'
import type { PluginCommandSummary, PluginRuntimeStatus } from '../shared/workbench-contracts'
import type { GatewayPlugin, RuntimePlugin } from './plugin-runtime'
import {
  pluginMcpServerId,
  pluginToolName,
  type PluginAgentContributions
} from '../shared/plugin-agent'
import { t } from '../shared/i18n'

/** The part of PluginRuntime the Workbench state depends on. */
export type MobilePluginViewSource = MobilePluginView & {
  /** Canonical plugin root; the phone may load files from inside it only. */
  root: string
  entryPath: string
}

export type WorkbenchPluginRuntime = {
  sync(plugins: readonly RuntimePlugin[]): void
  status(pluginId: string): PluginRuntimeStatus
  commands(): PluginCommandSummary[]
  runCommand(pluginId: string, commandId: string): Promise<void>
  /** Stops the plugin's process so the next sync starts a fresh one. */
  reset?(pluginId: string): void
}

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
  /** Loads the page again from disk, keeping the view where it is. */
  reload?(): void
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
  /** Plugins shipped inside the app: trusted, on by default, may be disabled. */
  bundledRoots?: () => Promise<readonly PiPackageRoot[]>
  canonicalizeRoot?: (path: string) => Promise<string>
  discover: (options: WorkbenchManifestDiscoveryOptions) => Promise<WorkbenchManifestDiscovery>
  store: WorkbenchStateStore
  createView: (request: WorkbenchPanelViewRequest) => Promise<WorkbenchPanelView>
  nativeViews: { browser: WorkbenchNativeView }
  onState?: (snapshot: WorkbenchSnapshot) => void
  runtime?: WorkbenchPluginRuntime
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
  /** Plugin processes started, stopped or registered commands. */
  runtimeChanged(): void
  /** The enabled plugin that owns a view, as the gateway sees it. */
  pluginForView(viewId: string): GatewayPlugin | null
  /** Agent tools, skills and MCP servers from enabled plugins, each behind its grant. */
  agentContributions(): PluginAgentContributions
  /** Pages of enabled plugins that opted into the phone, with where their files live. */
  mobileViews(): MobilePluginViewSource[]
  /** Waits for registry reloads in flight, e.g. the one a session switch starts. */
  whenLoaded(): Promise<void>
  /** Declared settings merged with stored values. */
  pluginSettings(pluginId: string): Record<string, JsonValue>
  /** Stores values for declared settings; rejects unknown keys and wrong types. */
  setPluginSettings(pluginId: string, values: Record<string, unknown>): Record<string, JsonValue>
  dispose(): void
}

const BUILTIN_PLUGIN: DesktopPluginSummary = {
  pluginId: 'works.pi.desktop.builtin',
  name: 'Pi Desktop',
  version: '0.1.0',
  description: t('Pi Desktop 内置工作台视图'),
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
    title: t('文件'),
    icon: 'files',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'files' }
  },
  {
    pluginId: BUILTIN_PLUGIN.pluginId,
    viewId: 'works.pi.desktop.review',
    title: t('审查'),
    icon: 'git-review',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'review' }
  }
]

const DESKTOP_ENABLED_STORE_KEY = 'workbenchDesktopEnabled'
const PANEL_STATE_STORE_KEY = 'workbenchPanelState'
const GRANTS_STORE_KEY = 'workbenchPluginGrants'
const SETTINGS_STORE_KEY = 'workbenchPluginSettings'

function readPluginSettings(store: WorkbenchStateStore): Record<string, Record<string, JsonValue>> {
  const stored = store.get(SETTINGS_STORE_KEY)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, Record<string, JsonValue>] =>
        Boolean(entry[1]) && typeof entry[1] === 'object' && !Array.isArray(entry[1])
    )
  )
}

function settingFallback(setting: ValidatedPluginSetting): JsonValue {
  if (setting.default !== undefined && pluginPanelStateSchema.safeParse(setting.default).success)
    return setting.default as JsonValue
  switch (setting.type) {
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'select':
      return setting.options?.[0]?.value ?? ''
    case 'json':
      return null
    default:
      return ''
  }
}

function acceptsSettingValue(setting: ValidatedPluginSetting, value: unknown): value is JsonValue {
  switch (setting.type) {
    case 'string':
    case 'shortcut':
      return typeof value === 'string' && value.length <= 8192
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'select':
      return (
        typeof value === 'string' &&
        (setting.options ?? []).some((option) => option.value === value)
      )
    case 'json':
      return pluginPanelStateSchema.safeParse(value).success
    default:
      return false
  }
}

function readGrants(store: WorkbenchStateStore): Record<string, string[]> {
  const stored = store.get(GRANTS_STORE_KEY)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string')
    )
  )
}

/** Only names this version implements are grantable; the rest are shown as unsupported. */
function knownRequested(plugin: ValidatedWorkbenchPlugin): string[] {
  return plugin.requestedPermissions.filter(isKnownPluginPermission)
}

/** Plugins that run code or ask for more than a view need an explicit, reviewed grant. */
function requiresGrant(plugin: ValidatedWorkbenchPlugin): boolean {
  return (
    plugin.canonicalMainPath !== undefined ||
    knownRequested(plugin).some((permission) => !IMPLICIT_PLUGIN_PERMISSIONS.has(permission))
  )
}

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
    const reservedView = plugin.workbench.find(
      ({ contribution }) =>
        reservedViewIds.has(contribution.viewId) ||
        // Host views belong to their bundled packages and nothing else.
        (HOST_VIEW_OWNERS.has(contribution.viewId) &&
          (plugin.pluginId !== HOST_VIEW_OWNERS.get(contribution.viewId) ||
            plugin.scope !== 'bundled'))
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
  const grants = readGrants(dependencies.store)
  const storedSettings = readPluginSettings(dependencies.store)
  const settingsOf = (plugin: ValidatedWorkbenchPlugin): Record<string, JsonValue> =>
    Object.fromEntries(
      plugin.settings.map((setting) => {
        const stored = storedSettings[plugin.pluginId]?.[setting.key]
        return [
          setting.key,
          stored !== undefined && acceptsSettingValue(setting, stored)
            ? stored
            : settingFallback(setting)
        ]
      })
    )
  const storeSettings = (
    plugin: ValidatedWorkbenchPlugin,
    values: Record<string, unknown>
  ): Record<string, JsonValue> => {
    const next = { ...(storedSettings[plugin.pluginId] ?? {}) }
    for (const [key, value] of Object.entries(values)) {
      const setting = plugin.settings.find((candidate) => candidate.key === key)
      if (!setting)
        throw new PluginApiError(
          'INVALID_ARGUMENT',
          t('设置 {value} 未在 manifest 中声明', { value: key.slice(0, 64) })
        )
      if (!acceptsSettingValue(setting, value))
        throw new PluginApiError('INVALID_ARGUMENT', t('设置 {key} 的值类型不对', { key }))
      next[key] = value
    }
    storedSettings[plugin.pluginId] = next
    dependencies.store.set(SETTINGS_STORE_KEY, { ...storedSettings })
    return settingsOf(plugin)
  }
  const panelStates = readPanelStates(dependencies.store)
  type PendingCreation = {
    pluginId: string
    viewId: string
    generation: number
    registryEpoch: number
    selectionEpoch: number
    token: object
    controller: AbortController
    bounds?: WorkbenchBounds
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

  const discovered = (pluginId: string): ValidatedWorkbenchPlugin | undefined =>
    discovery.plugins.find((plugin) => plugin.pluginId === pluginId)

  const bundled = (plugin: ValidatedWorkbenchPlugin): boolean => plugin.scope === 'bundled'

  /** Bundled plugins ship with the app, so installing it granted what they request. */
  const grantedTo = (plugin: ValidatedWorkbenchPlugin): string[] =>
    bundled(plugin) ? knownRequested(plugin) : (grants[plugin.pluginId] ?? [])

  const needsGrant = (plugin: ValidatedWorkbenchPlugin): boolean =>
    !bundled(plugin) &&
    requiresGrant(plugin) &&
    desktopEnabled[plugin.pluginId] === true &&
    !knownRequested(plugin).every(
      (permission) =>
        IMPLICIT_PLUGIN_PERMISSIONS.has(permission) ||
        (grants[plugin.pluginId] ?? []).includes(permission)
    )

  /** View-only plugins keep their historical default-on behavior; code needs an opt-in. */
  const isDesktopEnabled = (pluginId: string): boolean => {
    const plugin = discovered(pluginId)
    if (plugin && requiresGrant(plugin) && !bundled(plugin))
      return desktopEnabled[pluginId] === true && !needsGrant(plugin)
    return desktopEnabled[pluginId] !== false
  }

  const gatewayPlugin = (plugin: ValidatedWorkbenchPlugin): GatewayPlugin => ({
    pluginId: plugin.pluginId,
    name: plugin.name,
    granted: new Set([
      ...IMPLICIT_PLUGIN_PERMISSIONS,
      ...grantedTo(plugin).filter(isKnownPluginPermission)
    ]),
    commands: plugin.commands,
    agentTools: plugin.agentTools.map(({ name }) => name),
    views: new Map(
      plugin.workbench.map(({ contribution }) => [
        contribution.viewId.startsWith(`${plugin.pluginId}.`)
          ? contribution.viewId.slice(plugin.pluginId.length + 1)
          : contribution.viewId,
        contribution.viewId
      ])
    )
  })

  const syncRuntime = (): void => {
    dependencies.runtime?.sync(
      discovery.plugins.flatMap((plugin) =>
        plugin.canonicalMainPath !== undefined && isDesktopEnabled(plugin.pluginId)
          ? [{ ...gatewayPlugin(plugin), canonicalMainPath: plugin.canonicalMainPath }]
          : []
      )
    )
  }

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

  const hostDrawnContribution = (viewId: string): WorkbenchContribution | undefined => {
    for (const plugin of discovery.plugins) {
      if (!isDesktopEnabled(plugin.pluginId)) continue
      const entry = plugin.workbench.find(
        ({ contribution }) =>
          contribution.viewId === viewId && contribution.surface.kind !== 'sandboxed-web'
      )
      if (entry) return entry.contribution
    }
    return undefined
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
    const changesDesired = visible ? desiredViewId !== viewId : desiredViewId === viewId
    if (changesDesired) {
      selectionEpoch += 1
      desiredViewId = visible ? viewId : null
      desiredBrowserBounds = desiredViewId === BROWSER_VIEW_ID ? bounds : undefined
      if (visible) invalidatePendingCreations()
      else {
        const pending = pendingCreations.get(viewId)
        if (pending) invalidatePendingCreation(pending)
      }
    } else if (visible && viewId === BROWSER_VIEW_ID && bounds !== undefined) {
      desiredBrowserBounds = bounds
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
        diagnostics: pluginDiagnostics(plugin.pluginId),
        ...(plugin.settings.length > 0
          ? {
              settings: plugin.settings.map((setting) => ({
                key: setting.key,
                title: setting.title,
                ...(setting.description === undefined ? {} : { description: setting.description }),
                type: setting.type,
                value: settingsOf(plugin)[setting.key],
                ...(setting.options === undefined ? {} : { options: setting.options })
              }))
            }
          : {}),
        ...(requiresGrant(plugin)
          ? {
              runtime: {
                hasMain: plugin.canonicalMainPath !== undefined,
                status: dependencies.runtime?.status(plugin.pluginId) ?? 'stopped',
                grantedPermissions: grantedTo(plugin),
                needsGrant: needsGrant(plugin)
              }
            }
          : {})
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
    diagnostics: [...discovery.diagnostics, ...crashDiagnostics.values()],
    commands: (dependencies.runtime?.commands() ?? []).filter(({ pluginId }) =>
      isDesktopEnabled(pluginId)
    ),
    themes: discovery.plugins.flatMap((plugin) =>
      isDesktopEnabled(plugin.pluginId) && gatewayPlugin(plugin).granted.has('ui.theme')
        ? plugin.themes.map((theme) => ({
            id: `${plugin.pluginId}/${theme.id}`,
            pluginId: plugin.pluginId,
            pluginName: plugin.name,
            label: theme.label,
            base: theme.base,
            tokens: theme.tokens
          }))
        : []
    )
  })

  /** Resolves once the most recent registry reload has finished (successfully or not). */
  let loaded: Promise<unknown> = Promise.resolve()
  const trackLoad = (reload: Promise<WorkbenchSnapshot>): Promise<WorkbenchSnapshot> => {
    const settled = reload.catch(() => undefined)
    loaded = settled
    return reload
  }

  const beginRegistryReload = (): number => {
    registryEpoch += 1
    invalidatePendingCreations()
    abortOperations()
    destroyAllViews()
    // Host-drawn views of bundled packages (the browser) never depend on rediscovery, so
    // they stay usable across the reload barrier exactly like built-in views.
    discovery = {
      plugins: discovery.plugins.filter(
        (plugin) =>
          bundled(plugin) &&
          plugin.workbench.some(({ contribution }) => contribution.surface.kind !== 'sandboxed-web')
      ),
      diagnostics: []
    }
    // Plugin processes keep running until the new registry is known; `syncRuntime` then
    // restarts only plugins that changed, so a reload does not interrupt tool calls.
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
      const bundledRoots = (await dependencies.bundledRoots?.()) ?? []
      const canonicalize = dependencies.canonicalizeRoot
      const merged = await mergeWorkbenchPackageRoots([...userRoots, ...requestedPackageRoots], {
        ...(canonicalize === undefined ? {} : { canonicalize })
      })
      // Bundled roots stay out of the merge so no other source can relabel them as trusted.
      const bundledPaths = new Set(
        await Promise.all(
          bundledRoots.map((root) => (canonicalize ?? realpath)(root.path).catch(() => root.path))
        )
      )
      const roots = [
        ...bundledRoots,
        ...merged.filter(({ path, scope }) => scope !== 'bundled' && !bundledPaths.has(path))
      ]
      if (disposed || requestEpoch !== registryEpoch) return snapshot()
      const discovered = await dependencies.discover({
        roots,
        appVersion: dependencies.appVersion
      })
      if (disposed || requestEpoch !== registryEpoch) return snapshot()

      discovery = reserveBuiltinRegistry(discovered)
      syncRuntime()
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
      return trackLoad(reloadRegistry(requestEpoch, requestedPackageRoots))
    },
    async dispatch(command) {
      assertNotDisposed()
      switch (command.type) {
        case 'state:get':
          break
        case 'plugins:reload':
          return { state: await this.reload() }
        case 'plugin:restart': {
          if (!discovered(command.pluginId)) throw new Error('Workbench plugin is unavailable')
          // A restart is a fresh start: earlier crashes no longer count against the plugin.
          crashCounts.delete(command.pluginId)
          crashDiagnostics.delete(command.pluginId)
          invalidatePendingCreations(command.pluginId)
          // Open panels reload in place, so the author keeps looking at the same panel.
          for (const [viewId, record] of views)
            if (record.pluginId === command.pluginId) {
              if (record.view.reload) record.view.reload()
              else destroyView(viewId)
            }
          dependencies.runtime?.reset?.(command.pluginId)
          syncRuntime()
          revision += 1
          dependencies.onState?.(snapshot())
          break
        }
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
          // Enabling is the grant: the settings UI shows the requested permissions first.
          const plugin = discovered(command.pluginId)!
          if (!bundled(plugin)) {
            if (command.desktopEnabled) grants[command.pluginId] = knownRequested(plugin)
            else delete grants[command.pluginId]
            dependencies.store.set(GRANTS_STORE_KEY, { ...grants })
          }
          if (!command.desktopEnabled) {
            invalidatePendingCreations(command.pluginId)
            destroyPluginViews(command.pluginId)
            const hostsBrowser = plugin.workbench.some(
              ({ contribution }) => contribution.viewId === BROWSER_VIEW_ID
            )
            if (hostsBrowser && (desiredViewId === BROWSER_VIEW_ID || browserCouldBeVisible())) {
              const selection = beginSelection(BROWSER_VIEW_ID, false)
              if (activeViewId === BROWSER_VIEW_ID) activeViewId = null
              await selection.browserOperation?.catch(() => undefined)
            }
          }
          syncRuntime()
          revision += 1
          dependencies.onState?.(snapshot())
          break
        }
        case 'plugin:settings:set': {
          const plugin = discovered(command.pluginId)
          if (!plugin) throw new Error('Workbench plugin is unavailable')
          storeSettings(plugin, { [command.key]: command.value })
          revision += 1
          dependencies.onState?.(snapshot())
          break
        }
        case 'plugin:command:run': {
          if (!dependencies.runtime || !isDesktopEnabled(command.pluginId))
            throw new Error(t('插件未启用'))
          await dependencies.runtime.runCommand(command.pluginId, command.commandId)
          break
        }
        case 'view:set': {
          // Views the host draws natively (the browser) take the built-in path even when an
          // enabled bundled package contributes them.
          const builtinContribution =
            BUILTIN_CONTRIBUTIONS.find(({ viewId }) => viewId === command.viewId) ??
            hostDrawnContribution(command.viewId)
          if (builtinContribution) {
            if (!isAvailable(builtinContribution.activation)) {
              if (!command.visible) break
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
            // Destruction can race Renderer cleanup. An already absent panel is hidden.
            if (!command.visible) break
            throw new Error('Workbench panel is unavailable')
          }
          const entry = plugin.workbench.find(
            ({ contribution }) => contribution.viewId === command.viewId
          )
          if (!entry || !isAvailable(entry.contribution.activation)) {
            if (!command.visible) break
            throw new Error('Workbench panel is unavailable')
          }
          const selection = beginSelection(command.viewId, command.visible, command.bounds)
          if (selection.browserOperation) {
            await selection.browserOperation
            assertCurrentSelection(selection.token)
            if (activeViewId === BROWSER_VIEW_ID) activeViewId = null
          }
          let record = views.get(command.viewId)
          const existingPending = pendingCreations.get(command.viewId)
          if (command.visible && !record && existingPending) {
            if (command.bounds) existingPending.bounds = command.bounds
            break
          }
          let nextBounds = command.bounds
          if (command.visible && !record) {
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
              ...(command.bounds === undefined ? {} : { bounds: command.bounds }),
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
            nextBounds = pending.bounds
          }
          if (command.visible) assertCurrentSelection(selection.token)
          if (nextBounds) record?.view.setBounds(nextBounds)
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
      return trackLoad(reloadRegistry(requestEpoch, requestedPackageRoots))
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
    pluginSettings(pluginId) {
      const plugin = discovered(pluginId)
      return plugin ? settingsOf(plugin) : {}
    },
    setPluginSettings(pluginId, values) {
      const plugin = discovered(pluginId)
      if (!plugin) throw new PluginApiError('NOT_FOUND', t('插件不可用'))
      const result = storeSettings(plugin, values)
      revision += 1
      dependencies.onState?.(snapshot())
      return result
    },
    async whenLoaded() {
      // A reload can start while waiting for another; wait until none is newer.
      for (let current = loaded; ;) {
        await current
        if (current === loaded) return
        current = loaded
      }
    },
    agentContributions() {
      const contributions: PluginAgentContributions = {
        tools: [],
        skillPaths: [],
        mcpServers: {}
      }
      for (const plugin of discovery.plugins) {
        if (!isDesktopEnabled(plugin.pluginId)) continue
        const granted = gatewayPlugin(plugin).granted
        if (granted.has('agent.tools') && plugin.canonicalMainPath !== undefined)
          for (const tool of plugin.agentTools) {
            const toolName = pluginToolName(plugin.pluginId, tool.name)
            // Ids like `a.b` and `a_b` share a slug; the first plugin keeps the name.
            if (!toolName || contributions.tools.some((known) => known.toolName === toolName))
              continue
            contributions.tools.push({
              pluginId: plugin.pluginId,
              pluginName: plugin.name,
              name: tool.name,
              toolName,
              title: tool.title,
              description: tool.description,
              parameters: tool.parameters,
              readOnly: tool.readOnly
            })
          }
        if (granted.has('agent.skills')) contributions.skillPaths.push(...plugin.skillPaths)
        for (const [id, server] of Object.entries(plugin.mcpServers)) {
          const serverId = pluginMcpServerId(plugin.pluginId, id)
          if (!serverId || server.disabled) continue
          if (!(server.command ? granted.has('mcp.local') : granted.has('mcp.remote'))) continue
          // `{ setting: key }` references in env and headers read this plugin's settings.
          const values = settingsOf(plugin)
          const resolve = (map: Record<string, string> | undefined) =>
            map &&
            Object.fromEntries(
              Object.entries(map).map(([key, value]) => [
                key,
                resolveSettingPlaceholders(value, values)
              ])
            )
          contributions.mcpServers[serverId] = {
            ...server,
            ...(server.env ? { env: resolve(server.env) } : {}),
            ...(server.headers ? { headers: resolve(server.headers) } : {})
          }
        }
      }
      return contributions
    },
    mobileViews() {
      return discovery.plugins
        .filter((plugin) => isDesktopEnabled(plugin.pluginId))
        .flatMap((plugin) =>
          plugin.workbench.flatMap(({ contribution, canonicalEntryPath, mobile }) =>
            mobile && canonicalEntryPath
              ? [
                  {
                    id: contribution.viewId,
                    pluginId: plugin.pluginId,
                    pluginName: plugin.name,
                    title: contribution.title,
                    available: isAvailable(contribution.activation),
                    root: plugin.canonicalRootPath,
                    entryPath: canonicalEntryPath
                  }
                ]
              : []
          )
        )
    },
    pluginForView(viewId) {
      const plugin = discovery.plugins.find((candidate) =>
        candidate.workbench.some(({ contribution }) => contribution.viewId === viewId)
      )
      return plugin && isDesktopEnabled(plugin.pluginId) ? gatewayPlugin(plugin) : null
    },
    runtimeChanged() {
      if (disposed) return
      revision += 1
      dependencies.onState?.(snapshot())
    },
    dispose() {
      if (disposed) return
      disposed = true
      dependencies.runtime?.sync([])
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
