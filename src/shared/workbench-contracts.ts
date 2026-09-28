/** Renderer-safe, JSON-serializable contracts for the Main-owned Workbench host. */

export const WORKBENCH_PANEL_STATE_MAX_BYTES = 32 * 1024
export const WORKBENCH_JSON_MAX_DEPTH = 64
export const WORKBENCH_JSON_MAX_NODES = 4096
export const WORKBENCH_CHANNEL = 'pi:workbench'
export const WORKBENCH_EVENT_CHANNEL = 'pi:workbench:event'
export const WORKBENCH_PANEL_CHANNEL = 'pi:workbench-panel'
export const WORKBENCH_PANEL_CONTEXT_CHANNEL = 'pi:workbench-panel:context'
/** The browser view, contributed by the bundled `works.pi.browser` package. */
export const BROWSER_PLUGIN_ID = 'works.pi.browser'
export const BROWSER_VIEW_ID = 'works.pi.browser.view'
/** The terminal view, contributed by the bundled `works.pi.terminal` package. */
export const TERMINAL_PLUGIN_ID = 'works.pi.terminal'
export const TERMINAL_VIEW_ID = 'works.pi.terminal.view'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type WorkbenchSurface =
  | { kind: 'first-party'; adapter: 'files' | 'review' | 'terminal' }
  | { kind: 'native-view'; adapter: 'browser' }
  | { kind: 'sandboxed-web' }

export type WorkbenchIcon =
  'files' | 'git-review' | 'git-branch' | 'terminal' | 'browser' | 'plugin' | 'flask'

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

export type PluginRuntimeStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'failed'

export type PluginCommandSummary = {
  pluginId: string
  pluginName: string
  commandId: string
  title: string
  keywords: string[]
}

export type DesktopPluginSummary = {
  pluginId: string
  name: string
  version: string
  description?: string
  source: string
  scope: 'builtin' | 'bundled' | 'user' | 'project'
  builtin: boolean
  desktopEnabled: boolean
  hasExecutablePiResources: boolean
  requestedPermissions: string[]
  diagnostics: WorkbenchDiagnostic[]
  /** Present for plugins that run code or request grantable permissions. */
  runtime?: {
    hasMain: boolean
    status: PluginRuntimeStatus
    grantedPermissions: string[]
    /** Requested permissions changed since the last grant; the plugin stays off until re-granted. */
    needsGrant: boolean
  }
  /** Settings the plugin declares, with their current values. */
  settings?: PluginSettingSummary[]
}

export type PluginSettingSummary = {
  key: string
  title: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'json' | 'shortcut'
  value: JsonValue
  options?: { value: string; label: string }[]
}

export type WorkbenchSnapshot = {
  revision: number
  plugins: DesktopPluginSummary[]
  contributions: WorkbenchContribution[]
  diagnostics: WorkbenchDiagnostic[]
  commands?: PluginCommandSummary[]
  /** Themes from enabled plugins granted `ui.theme`. */
  themes?: PluginThemeSummary[]
}

export type PluginThemeSummary = {
  /** `<plugin id>/<theme id>`, the value stored in desktop settings. */
  id: string
  pluginId: string
  pluginName: string
  label: string
  base: 'light' | 'dark'
  /** Sanitized design-token overrides. */
  tokens: Record<string, string>
}

export type WorkbenchCommand =
  | { type: 'state:get' }
  | { type: 'plugins:reload' }
  | { type: 'plugin:set-enabled'; pluginId: string; desktopEnabled: boolean }
  | { type: 'view:set'; viewId: string; visible: boolean; bounds?: WorkbenchBounds }
  | { type: 'plugin:command:run'; pluginId: string; commandId: string }
  | { type: 'plugin:settings:set'; pluginId: string; key: string; value: JsonValue }
  | { type: 'plugin:approval:respond'; id: string; allow: boolean }

export type WorkbenchCommandResult = { state: WorkbenchSnapshot }

export type WorkbenchEvent =
  | { type: 'state'; data: WorkbenchSnapshot }
  | { type: 'reveal'; viewId: string; context?: JsonValue }
  | { type: 'toast'; pluginId: string; message: string }
  | {
      type: 'plugin-approval'
      id: string
      pluginId: string
      pluginName: string
      title: string
      detail: string
    }
  | { type: 'plugin-approval-closed'; id: string }

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
export type PluginPanelApiCallCommand = {
  type: 'api:call'
  context: PluginPanelContext
  method: string
  params: JsonValue
}
export type PluginPanelCommand =
  | PluginPanelContextCommand
  | PluginPanelGetStateCommand
  | PluginPanelSetStateCommand
  | PluginPanelApiCallCommand

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
export type PluginPanelApiResult = {
  type: 'api:result'
  context: PluginPanelContext
  ok: boolean
  value?: JsonValue
  code?: string
  message?: string
}
export type PluginPanelCommandResult =
  | PluginPanelContextResult
  | PluginPanelStateResult
  | PluginPanelStateStoredResult
  | PluginPanelApiResult

export type PluginPanelAPI = {
  getContext: () => Promise<PluginPanelContext>
  getState: (generation: number) => Promise<JsonValue>
  setState: (generation: number, value: JsonValue) => Promise<void>
  onContext: (listener: (context: PluginPanelContext) => void) => () => void
  /** Calls a `pi.*` host method on behalf of this view's plugin; rejects with a plain
   * `{ name, code, message }` object, since contextBridge would drop an Error's `code`. */
  call: (method: string, params?: JsonValue) => Promise<JsonValue>
}
