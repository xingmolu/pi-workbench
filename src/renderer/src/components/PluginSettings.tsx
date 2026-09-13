import { useReducer } from 'react'
import { CircleAlert, Puzzle, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react'
import type {
  DesktopPluginSummary,
  WorkbenchCommand,
  WorkbenchDiagnostic,
  WorkbenchSnapshot
} from '../../../shared/contracts'
import {
  INITIAL_PLUGIN_SETTINGS_OPERATION_STATE,
  pluginDesktopToggleCommand,
  pluginSourceLabel,
  pluginSettingsErrorMessage,
  pluginSettingsOperationReducer
} from '../store/plugin-settings'

function pluginScope(plugin: DesktopPluginSummary): string {
  if (plugin.scope === 'builtin') return '内置'
  if (plugin.scope === 'project') return '项目'
  return '用户'
}

function diagnosticMessage(diagnostic: WorkbenchDiagnostic): string {
  if (diagnostic.code === 'plugin-crash-disabled') {
    return '桌面面板已因连续崩溃停用。请重启 Pi Desktop 后再尝试启用。'
  }
  if (diagnostic.code === 'plugin-crashed') {
    return '插件面板发生崩溃；再次打开时会重建。'
  }
  return diagnostic.message
}

function DiagnosticList({
  diagnostics
}: {
  diagnostics: WorkbenchDiagnostic[]
}): React.JSX.Element {
  return (
    <ul className="plugin-diagnostics" aria-label="插件诊断">
      {diagnostics.map((diagnostic, index) => {
        const Icon = diagnostic.severity === 'error' ? CircleAlert : TriangleAlert
        return (
          <li
            key={`${diagnostic.code}:${diagnostic.viewId ?? ''}:${index}`}
            className={`is-${diagnostic.severity}`}
            role={diagnostic.severity === 'error' ? 'alert' : 'status'}
          >
            <Icon size={13} aria-hidden="true" />
            <span>
              <strong>{diagnostic.severity === 'error' ? '错误' : '警告'}</strong>
              {diagnosticMessage(diagnostic)}
              <code>{diagnostic.code}</code>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export default function PluginSettings({
  snapshot,
  onCommand
}: {
  snapshot: WorkbenchSnapshot
  onCommand: (command: WorkbenchCommand) => Promise<void>
}): React.JSX.Element {
  const [operation, dispatch] = useReducer(
    pluginSettingsOperationReducer,
    INITIAL_PLUGIN_SETTINGS_OPERATION_STATE
  )
  const knownPluginIds = new Set(snapshot.plugins.map(({ pluginId }) => pluginId))
  const registryDiagnostics = snapshot.diagnostics.filter(
    ({ pluginId }) => !pluginId || !knownPluginIds.has(pluginId)
  )

  const toggle = async (plugin: DesktopPluginSummary): Promise<void> => {
    const command = pluginDesktopToggleCommand(plugin, !plugin.desktopEnabled)
    if (!command) return
    dispatch({ type: 'toggle:start', pluginId: plugin.pluginId })
    try {
      await onCommand(command)
      dispatch({ type: 'toggle:success', pluginId: plugin.pluginId })
    } catch (error) {
      dispatch({
        type: 'toggle:failure',
        pluginId: plugin.pluginId,
        message: pluginSettingsErrorMessage(error)
      })
    }
  }

  const reload = async (): Promise<void> => {
    dispatch({ type: 'reload:start' })
    try {
      await onCommand({ type: 'plugins:reload' })
      dispatch({ type: 'reload:success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch({ type: 'reload:failure', message: `插件列表刷新失败：${message}` })
    }
  }

  return (
    <section className="settings-section plugin-settings-section">
      <div className="settings-section-title plugin-settings-title">
        <div>
          <span>工作台插件</span>
          <small>管理右侧 Desktop 面板</small>
        </div>
        <button
          className="plugin-reload-button"
          type="button"
          disabled={operation.reloading}
          onClick={() => void reload()}
        >
          <RefreshCw className={operation.reloading ? 'spin' : undefined} size={13} />
          {operation.reloading ? '正在刷新' : '重新加载'}
        </button>
      </div>

      <p className="plugin-settings-note">
        这里的开关只隐藏并销毁右侧 Desktop 贡献；不会禁用 Pi 已加载的 Skills/Extensions。
      </p>

      {operation.reloadError ? (
        <div className="plugin-operation-error" role="alert">
          <CircleAlert size={13} />
          <span>{operation.reloadError}</span>
        </div>
      ) : null}

      <div className="plugin-list">
        {snapshot.plugins.length === 0 ? (
          <div className="plugin-list-empty">
            <Puzzle size={17} />
            <span>尚未取得插件清单。重新加载后会显示可用的 Desktop 插件。</span>
          </div>
        ) : (
          snapshot.plugins.map((plugin) => {
            const pending = operation.pendingPluginIds.includes(plugin.pluginId)
            const operationError = operation.pluginErrors[plugin.pluginId]
            return (
              <article className="plugin-row" key={plugin.pluginId}>
                <div className="plugin-row-head">
                  <div className="plugin-identity">
                    <strong title={plugin.name}>{plugin.name}</strong>
                    <span>版本 {plugin.version}</span>
                  </div>
                  <button
                    className="desktop-plugin-switch"
                    type="button"
                    role="switch"
                    aria-checked={plugin.desktopEnabled}
                    aria-label={`${plugin.name} Desktop 面板`}
                    title={plugin.builtin ? '内置插件固定启用' : undefined}
                    disabled={plugin.builtin || pending}
                    onClick={() => void toggle(plugin)}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>

                <div className="plugin-meta">
                  <span>范围：{pluginScope(plugin)}</span>
                  <span title={pluginSourceLabel(plugin)}>来源：{pluginSourceLabel(plugin)}</span>
                  <span>
                    Desktop：
                    {plugin.builtin ? '内置锁定' : plugin.desktopEnabled ? '已启用' : '已隐藏'}
                  </span>
                </div>

                {plugin.description ? (
                  <p className="plugin-description">{plugin.description}</p>
                ) : null}
                <p className="plugin-permissions">
                  <ShieldAlert size={12} aria-hidden="true" />
                  <span>
                    请求权限：
                    {plugin.requestedPermissions.length > 0
                      ? plugin.requestedPermissions.join('、')
                      : '无'}
                  </span>
                </p>

                {plugin.hasExecutablePiResources ? (
                  <div className="plugin-executable-warning" role="note">
                    <TriangleAlert size={13} aria-hidden="true" />
                    <span>
                      该插件还含 Pi 已加载的 Skills/Extensions。切换 Desktop
                      开关不会停用或停止这些资源。
                    </span>
                  </div>
                ) : null}

                {operationError ? (
                  <div className="plugin-operation-error" role="alert">
                    <CircleAlert size={13} />
                    <span>{operationError}</span>
                  </div>
                ) : null}
                {plugin.diagnostics.length > 0 ? (
                  <DiagnosticList diagnostics={plugin.diagnostics} />
                ) : null}
              </article>
            )
          })
        )}
      </div>

      {registryDiagnostics.length > 0 ? (
        <div className="registry-diagnostics">
          <strong>发现诊断</strong>
          <DiagnosticList diagnostics={registryDiagnostics} />
        </div>
      ) : null}
    </section>
  )
}
