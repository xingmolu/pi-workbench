import type { DesktopPluginSummary, WorkbenchCommand } from '../../../shared/contracts'

export function pluginDesktopToggleCommand(
  plugin: Pick<DesktopPluginSummary, 'pluginId' | 'builtin'>,
  desktopEnabled: boolean
): WorkbenchCommand | null {
  if (plugin.builtin) return null
  return {
    type: 'plugin:set-enabled',
    pluginId: plugin.pluginId,
    desktopEnabled
  }
}

export function pluginSourceLabel(
  plugin: Pick<DesktopPluginSummary, 'builtin' | 'source'> & {
    scope?: DesktopPluginSummary['scope']
  }
): string {
  if (plugin.scope === 'bundled') return '随 Pi Desktop 分发'
  return plugin.builtin ? 'Pi Desktop 内置' : plugin.source
}

export type PluginSettingsOperationState = {
  pendingPluginIds: readonly string[]
  pluginErrors: Readonly<Record<string, string>>
  reloading: boolean
  reloadError: string | null
}

export type PluginSettingsOperationAction =
  | { type: 'toggle:start'; pluginId: string }
  | { type: 'toggle:success'; pluginId: string }
  | { type: 'toggle:failure'; pluginId: string; message: string }
  | { type: 'reload:start' }
  | { type: 'reload:success' }
  | { type: 'reload:failure'; message: string }

export const INITIAL_PLUGIN_SETTINGS_OPERATION_STATE: PluginSettingsOperationState = {
  pendingPluginIds: [],
  pluginErrors: {},
  reloading: false,
  reloadError: null
}

export function pluginSettingsOperationReducer(
  state: PluginSettingsOperationState,
  action: PluginSettingsOperationAction
): PluginSettingsOperationState {
  if (action.type === 'reload:start') {
    return { ...state, reloading: true, reloadError: null }
  }
  if (action.type === 'reload:success') {
    return { ...state, reloading: false, reloadError: null }
  }
  if (action.type === 'reload:failure') {
    return { ...state, reloading: false, reloadError: action.message }
  }

  const pendingPluginIds = state.pendingPluginIds.filter((pluginId) => pluginId !== action.pluginId)
  const pluginErrors = { ...state.pluginErrors }

  if (action.type === 'toggle:start') {
    delete pluginErrors[action.pluginId]
    return { ...state, pendingPluginIds: [...pendingPluginIds, action.pluginId], pluginErrors }
  }
  if (action.type === 'toggle:success') delete pluginErrors[action.pluginId]
  else pluginErrors[action.pluginId] = action.message
  return { ...state, pendingPluginIds, pluginErrors }
}

export function pluginSettingsErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/requires an app restart|repeated crashes/i.test(message)) {
    return '插件因连续崩溃已锁定。请重启 Pi Desktop 后再启用。'
  }
  return `插件设置未保存：${message}`
}
