/** Renderer-safe, JSON-serializable contracts for the Main-owned Workbench host. */

export const WORKBENCH_PANEL_STATE_MAX_BYTES = 32 * 1024
export const WORKBENCH_JSON_MAX_DEPTH = 64
export const WORKBENCH_JSON_MAX_NODES = 4096

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type WorkbenchSurface =
  | { kind: 'first-party'; adapter: 'files' | 'review' | 'terminal' }
  | { kind: 'native-view'; adapter: 'browser' }
  | { kind: 'sandboxed-web' }

export type WorkbenchIcon = 'files' | 'git-review' | 'terminal' | 'browser' | 'plugin' | 'flask'

export type WorkbenchActivation = 'onApp' | 'onProject'

export type WorkbenchBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type WorkbenchContribution = {
  pluginId: string
  viewId: string
  title: string
  icon: WorkbenchIcon
  activation: WorkbenchActivation
  surface: WorkbenchSurface
}

export type WorkbenchDiagnostic = {
  severity: 'warning' | 'error'
  code: string
  message: string
  pluginId?: string
  viewId?: string
}

export type DesktopPluginSummary = {
  pluginId: string
  name: string
  version: string
  description?: string
  source: string
  scope: 'builtin' | 'user' | 'project'
  builtin: boolean
  desktopEnabled: boolean
  hasExecutablePiResources: boolean
  requestedPermissions: string[]
  diagnostics: WorkbenchDiagnostic[]
}

export type WorkbenchSnapshot = {
  revision: number
  plugins: DesktopPluginSummary[]
  contributions: WorkbenchContribution[]
  diagnostics: WorkbenchDiagnostic[]
}

export type WorkbenchCommand =
  | { type: 'state:get' }
  | { type: 'plugins:reload' }
  | { type: 'plugin:set-enabled'; pluginId: string; desktopEnabled: boolean }
  | { type: 'view:set'; viewId: string; visible: boolean; bounds?: WorkbenchBounds }

export type WorkbenchCommandResult = { state: WorkbenchSnapshot }

export type WorkbenchEvent =
  | { type: 'state'; data: WorkbenchSnapshot }
  | { type: 'reveal'; viewId: string; context?: JsonValue }

export type PluginPanelContext = {
  pluginId: string
  viewId: string
  projectPath: string | null
  sessionId: string | null
  generation: number
}

export type PluginPanelContextCommand = { type: 'context:get' }
export type PluginPanelGetStateCommand = {
  type: 'state:get'
  context: PluginPanelContext
}
export type PluginPanelSetStateCommand = {
  type: 'state:set'
  context: PluginPanelContext
  value: JsonValue
}
export type PluginPanelCommand =
  PluginPanelContextCommand | PluginPanelGetStateCommand | PluginPanelSetStateCommand

export type PluginPanelContextResult = {
  type: 'context'
  context: PluginPanelContext
}
export type PluginPanelStateResult = {
  type: 'state'
  context: PluginPanelContext
  value: JsonValue
}
export type PluginPanelStateStoredResult = {
  type: 'state:stored'
  context: PluginPanelContext
}
export type PluginPanelCommandResult =
  PluginPanelContextResult | PluginPanelStateResult | PluginPanelStateStoredResult

export type PluginPanelAPI = {
  getContext: () => Promise<PluginPanelContext>
  getState: (generation: number) => Promise<JsonValue>
  setState: (generation: number, value: JsonValue) => Promise<void>
  onContext: (listener: (context: PluginPanelContext) => void) => () => void
}
