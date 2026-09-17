import {
  BUILTIN_BROWSER_VIEW_ID,
  type DesktopPluginSummary,
  type WorkbenchActivation,
  type WorkbenchContribution,
  type WorkbenchDiagnostic,
  type WorkbenchSnapshot
} from '../shared/workbench-contracts'
import type {
  ValidatedWorkbenchEntry,
  ValidatedWorkbenchPlugin,
  WorkbenchManifestDiscovery
} from './workbench-manifest'

export const BUILTIN_WORKBENCH_PLUGIN_ID = 'works.pi.desktop.builtin'

const BUILTIN_PLUGIN_TEMPLATE: Omit<DesktopPluginSummary, 'version'> = {
  pluginId: BUILTIN_WORKBENCH_PLUGIN_ID,
  name: 'Pi Desktop',
  description: 'Pi Desktop 内置工作台视图',
  source: 'builtin',
  scope: 'builtin',
  builtin: true,
  desktopEnabled: true,
  hasExecutablePiResources: false,
  requestedPermissions: [],
  diagnostics: []
}

export const BUILTIN_WORKBENCH_CONTRIBUTIONS: readonly WorkbenchContribution[] = [
  {
    pluginId: BUILTIN_WORKBENCH_PLUGIN_ID,
    viewId: 'works.pi.desktop.files',
    title: '文件',
    icon: 'files',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'files' }
  },
  {
    pluginId: BUILTIN_WORKBENCH_PLUGIN_ID,
    viewId: 'works.pi.desktop.review',
    title: '审查',
    icon: 'git-review',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'review' }
  },
  {
    pluginId: BUILTIN_WORKBENCH_PLUGIN_ID,
    viewId: 'works.pi.desktop.terminal',
    title: '终端',
    icon: 'terminal',
    activation: 'onProject',
    surface: { kind: 'first-party', adapter: 'terminal' }
  },
  {
    pluginId: BUILTIN_WORKBENCH_PLUGIN_ID,
    viewId: BUILTIN_BROWSER_VIEW_ID,
    title: '浏览器',
    icon: 'browser',
    activation: 'onApp',
    surface: { kind: 'native-view', adapter: 'browser' }
  }
]

const RESERVED_WORKBENCH_VIEW_IDS = new Set(
  BUILTIN_WORKBENCH_CONTRIBUTIONS.map(({ viewId }) => viewId)
)

export type RegisteredWorkbenchContribution =
  | { kind: 'builtin'; contribution: WorkbenchContribution }
  | {
      kind: 'plugin'
      plugin: ValidatedWorkbenchPlugin
      entry: ValidatedWorkbenchEntry
      contribution: WorkbenchContribution
    }

export type WorkbenchRegistrySnapshotOptions = {
  revision: number
  appVersion: string
  discovery: WorkbenchManifestDiscovery
  isDesktopEnabled(pluginId: string): boolean
  isAvailable(activation: WorkbenchActivation): boolean
  pluginDiagnostics?(pluginId: string): readonly WorkbenchDiagnostic[]
  runtimeDiagnostics?: Iterable<WorkbenchDiagnostic>
}

export function builtinWorkbenchPlugin(appVersion: string): DesktopPluginSummary {
  return { ...BUILTIN_PLUGIN_TEMPLATE, version: appVersion }
}

/**
 * Reserve first-party identities before plugin contributions enter runtime state.
 * A plugin colliding with any first-party plugin/view id is rejected as a whole,
 * preserving one stable owner for every contribution id.
 */
export function reserveBuiltinWorkbenchRegistry(
  discovery: WorkbenchManifestDiscovery
): WorkbenchManifestDiscovery {
  const plugins: ValidatedWorkbenchPlugin[] = []
  const diagnostics = [...discovery.diagnostics]

  for (const plugin of discovery.plugins) {
    if (plugin.pluginId === BUILTIN_WORKBENCH_PLUGIN_ID) {
      diagnostics.push({
        severity: 'error',
        code: 'reserved-plugin-id',
        message: 'Workbench plugin id is reserved by Pi Desktop.',
        pluginId: plugin.pluginId
      })
      continue
    }

    const reservedView = plugin.workbench.find(({ contribution }) =>
      RESERVED_WORKBENCH_VIEW_IDS.has(contribution.viewId)
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

export function findWorkbenchContribution(
  discovery: WorkbenchManifestDiscovery,
  viewId: string
): RegisteredWorkbenchContribution | undefined {
  const builtin = BUILTIN_WORKBENCH_CONTRIBUTIONS.find(
    (contribution) => contribution.viewId === viewId
  )
  if (builtin) return { kind: 'builtin', contribution: builtin }

  for (const plugin of discovery.plugins) {
    const entry = plugin.workbench.find(({ contribution }) => contribution.viewId === viewId)
    if (entry) {
      return { kind: 'plugin', plugin, entry, contribution: entry.contribution }
    }
  }

  return undefined
}

/** Build the renderer-safe registry projection from first-party and discovered sources. */
export function buildWorkbenchRegistrySnapshot({
  revision,
  appVersion,
  discovery,
  isDesktopEnabled,
  isAvailable,
  pluginDiagnostics = () => [],
  runtimeDiagnostics = []
}: WorkbenchRegistrySnapshotOptions): WorkbenchSnapshot {
  const runtime = [...runtimeDiagnostics]
  return {
    revision,
    plugins: [
      builtinWorkbenchPlugin(appVersion),
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
        diagnostics: [...pluginDiagnostics(plugin.pluginId)]
      }))
    ],
    contributions: [
      ...BUILTIN_WORKBENCH_CONTRIBUTIONS.filter(({ activation }) =>
        isAvailable(activation)
      ),
      ...discovery.plugins.flatMap((plugin) =>
        isDesktopEnabled(plugin.pluginId)
          ? plugin.workbench
              .map(({ contribution }) => contribution)
              .filter(({ activation }) => isAvailable(activation))
          : []
      )
    ],
    diagnostics: [...discovery.diagnostics, ...runtime]
  }
}
