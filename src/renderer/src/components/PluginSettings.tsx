import { useEffect, useReducer, useState } from 'react'
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
import {
  PLUGIN_PERMISSIONS,
  isKnownPluginPermission,
  type PluginPermissionRisk
} from '../../../shared/plugin-api'
import { SettingsPage } from './SettingsPrimitives'
import { PluginInstallButtons } from './PluginInstall'
import { PluginDevelopmentTools, PluginLogView } from './PluginDevelopment'
import { sourceText, usePluginInstall } from '../store/plugin-install'
import { t } from '../../../shared/i18n'
import '../assets/plugin-settings.css'

const RISK_LABEL: Record<PluginPermissionRisk, string> = {
  low: t('低'),
  medium: t('中'),
  high: t('高')
}
const STATUS_LABEL = {
  stopped: t('未运行'),
  starting: t('正在启动'),
  running: t('运行中'),
  crashed: t('已崩溃'),
  failed: t('加载失败')
} as const

/** Shown before a plugin that runs code (or asks for more than a view) is enabled. */
function GrantReview({
  plugin,
  pending,
  onCancel,
  onConfirm
}: {
  plugin: DesktopPluginSummary
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <div className="plugin-grant" role="group" aria-label={t('授权 {name}', { name: plugin.name })}>
      {plugin.runtime?.hasMain ? (
        <p>
          {t(
            '该插件会在独立进程中运行代码。权限只约束它调用 Pi Desktop 的接口， 不能阻止它直接访问本机文件或网络，请只启用来源可信的插件。'
          )}
        </p>
      ) : null}
      <ul>
        {plugin.requestedPermissions.map((permission) => {
          const known = isKnownPluginPermission(permission)
          const risk = known ? PLUGIN_PERMISSIONS[permission] : null
          return (
            <li key={permission} className={risk ? `is-${risk}` : 'is-unsupported'}>
              <code>{permission}</code>
              <span>
                {risk
                  ? t('风险：{value}', { value: RISK_LABEL[risk] })
                  : t('此版本不支持，不会授予')}
              </span>
            </li>
          )
        })}
        {plugin.requestedPermissions.length === 0 ? <li>{t('不请求额外权限')}</li> : null}
      </ul>
      <div className="plugin-grant-actions">
        <button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>
          {t('取消')}
        </button>
        <button type="button" className="primary-button" disabled={pending} onClick={onConfirm}>
          {t('授权并启用')}
        </button>
      </div>
    </div>
  )
}

type PluginSetting = NonNullable<DesktopPluginSummary['settings']>[number]

function SettingField({
  setting,
  pluginName,
  disabled,
  onChange
}: {
  setting: PluginSetting
  pluginName: string
  disabled: boolean
  onChange: (value: PluginSetting['value']) => void
}): React.JSX.Element {
  const label = t('{pluginName} 设置：{title}', { pluginName, title: setting.title })
  let control: React.JSX.Element
  switch (setting.type) {
    case 'boolean':
      control = (
        <input
          type="checkbox"
          aria-label={label}
          checked={setting.value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      )
      break
    case 'select':
      control = (
        <select
          aria-label={label}
          value={String(setting.value ?? '')}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {(setting.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )
      break
    case 'number':
    case 'string':
      control = (
        <input
          // Remount when the stored value changes so an external update shows.
          key={String(setting.value)}
          type={setting.type === 'number' ? 'number' : 'text'}
          aria-label={label}
          defaultValue={String(setting.value ?? '')}
          disabled={disabled}
          onBlur={(event) => {
            const raw = event.target.value
            const value = setting.type === 'number' ? Number(raw) : raw
            if (setting.type === 'number' && !Number.isFinite(value)) return
            if (value !== setting.value) onChange(value)
          }}
        />
      )
      break
    default:
      // JSON and shortcut settings are shown but edited by the plugin itself.
      control = <code>{JSON.stringify(setting.value)}</code>
  }
  return (
    <label className="plugin-setting">
      <span>
        {setting.title}
        {setting.description ? <small>{setting.description}</small> : null}
      </span>
      {control}
    </label>
  )
}

function pluginScope(plugin: DesktopPluginSummary): string {
  if (plugin.scope === 'builtin' || plugin.scope === 'bundled') return t('内置')
  if (plugin.scope === 'project') return t('项目')
  return t('用户')
}

function diagnosticMessage(diagnostic: WorkbenchDiagnostic): string {
  if (diagnostic.code === 'plugin-crash-disabled') {
    return t('桌面面板已因连续崩溃停用。请重启 Pi Desktop 后再尝试启用。')
  }
  if (diagnostic.code === 'plugin-crashed') {
    return t('插件面板发生崩溃；再次打开时会重建。')
  }
  return diagnostic.message
}

function DiagnosticList({
  diagnostics
}: {
  diagnostics: WorkbenchDiagnostic[]
}): React.JSX.Element {
  return (
    <ul className="plugin-diagnostics" aria-label={t('插件诊断')}>
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
              <strong>{diagnostic.severity === 'error' ? t('错误') : t('警告')}</strong>
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
  const [reviewing, setReviewing] = useState<string | null>(null)
  const install = usePluginInstall()
  const [logsOpen, setLogsOpen] = useState<string | null>(null)
  // A reload (also after a file of a plugin under development changed) can change what each
  // development folder holds.
  const refreshInstalls = install.refresh
  useEffect(() => {
    void refreshInstalls()
  }, [refreshInstalls, snapshot.revision])
  const knownPluginIds = new Set(snapshot.plugins.map(({ pluginId }) => pluginId))
  const registryDiagnostics = snapshot.diagnostics.filter(
    ({ pluginId }) => !pluginId || !knownPluginIds.has(pluginId)
  )

  const toggle = async (plugin: DesktopPluginSummary, reviewed = false): Promise<void> => {
    // Bundled plugins ship with the app; installing it was the review.
    if (!plugin.desktopEnabled && plugin.runtime && plugin.scope !== 'bundled' && !reviewed) {
      setReviewing(plugin.pluginId)
      return
    }
    setReviewing(null)
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
      dispatch({ type: 'reload:failure', message: t('插件列表刷新失败：{message}', { message }) })
    }
  }

  return (
    <SettingsPage
      title={t('Desktop 插件')}
      description={t(
        '插件可以在右侧工作台添加面板，并为 Agent 提供工具、技能和主题。会运行代码的插件需要你查看权限并授权后才会启动。'
      )}
    >
      <div className="plugin-toolbar">
        <span>
          {t('{length} 个插件 · 已启用{value} {length2} 个', {
            length: snapshot.plugins.length,
            value: ' ',
            length2: snapshot.plugins.filter(({ desktopEnabled }) => desktopEnabled).length
          })}
        </span>
        <button
          className="plugin-reload-button"
          type="button"
          disabled={operation.reloading}
          onClick={() => void reload()}
        >
          <RefreshCw className={operation.reloading ? 'spin' : undefined} size={13} />
          {operation.reloading ? t('正在刷新') : t('重新加载')}
        </button>
      </div>

      <PluginInstallButtons install={install} />
      <PluginDevelopmentTools install={install} />

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
            <span>{t('尚未取得插件清单。重新加载后会显示可用的 Desktop 插件。')}</span>
          </div>
        ) : (
          snapshot.plugins.map((plugin) => {
            const pending = operation.pendingPluginIds.includes(plugin.pluginId)
            const record = install.installed[plugin.pluginId]
            const developing = install.development.find(
              (folder) => folder.pluginId === plugin.pluginId
            )
            const operationError = operation.pluginErrors[plugin.pluginId]
            const status =
              plugin.runtime?.hasMain && plugin.desktopEnabled
                ? STATUS_LABEL[plugin.runtime.status]
                : null
            return (
              <article className="plugin-row" key={plugin.pluginId}>
                <div className="plugin-row-head">
                  <span className="plugin-tile" aria-hidden="true">
                    {plugin.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="plugin-identity">
                    <div className="plugin-name-line">
                      <strong title={plugin.name}>{plugin.name}</strong>
                      <span className="plugin-version">{plugin.version}</span>
                      <span className="plugin-badge">{pluginScope(plugin)}</span>
                      {status ? (
                        <span
                          className={`plugin-badge plugin-runtime is-${plugin.runtime!.status}`}
                        >
                          {status}
                        </span>
                      ) : null}
                    </div>
                    {plugin.description ? (
                      <p className="plugin-description">{plugin.description}</p>
                    ) : null}
                    <p className="plugin-meta">
                      {developing ? null : (
                        <span title={pluginSourceLabel(plugin)}>{pluginSourceLabel(plugin)}</span>
                      )}
                      {plugin.builtin ? <span>{t('固定启用')}</span> : null}
                      {record ? (
                        <span title={sourceText(record.source)}>
                          {t('安装自 {source}', { source: sourceText(record.source) })}
                        </span>
                      ) : null}
                    </p>
                    {developing ? (
                      <div className="plugin-row-actions">
                        <span className="plugin-badge is-development">{t('开发中')}</span>
                        <span className="plugin-meta" title={developing.path}>
                          {developing.path}
                        </span>
                        <button
                          type="button"
                          disabled={install.busy}
                          onClick={() => void install.reload(plugin.pluginId)}
                        >
                          {t('重新加载')}
                        </button>
                        <button
                          type="button"
                          aria-expanded={logsOpen === plugin.pluginId}
                          onClick={() =>
                            setLogsOpen((open) =>
                              open === plugin.pluginId ? null : plugin.pluginId
                            )
                          }
                        >
                          {t('日志')}
                        </button>
                        <button
                          type="button"
                          disabled={install.busy}
                          onClick={() => void install.undevelop(developing.path)}
                        >
                          {t('停止开发')}
                        </button>
                      </div>
                    ) : plugin.scope === 'user' ? (
                      <div className="plugin-row-actions">
                        <span className="plugin-badge is-unverified">{t('未验证')}</span>
                        {record ? (
                          <button
                            type="button"
                            disabled={install.busy || install.preview !== null}
                            onClick={() => void install.update(plugin.pluginId)}
                          >
                            {t('检查更新')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="is-danger"
                          disabled={install.busy || install.preview !== null}
                          onClick={() => void install.uninstall(plugin.pluginId, plugin.name)}
                        >
                          {t('卸载')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    className="desktop-plugin-switch"
                    type="button"
                    role="switch"
                    aria-checked={plugin.desktopEnabled}
                    aria-label={t('{name} Desktop 面板', { name: plugin.name })}
                    title={plugin.builtin ? t('内置插件固定启用') : undefined}
                    disabled={plugin.builtin || pending}
                    onClick={() => void toggle(plugin)}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>

                {logsOpen === plugin.pluginId ? <PluginLogView pluginId={plugin.pluginId} /> : null}

                {plugin.requestedPermissions.length > 0 ? (
                  <div className="plugin-permissions" aria-label={t('请求权限')}>
                    <ShieldAlert size={12} aria-hidden="true" />
                    {plugin.requestedPermissions.map((permission) => (
                      <code key={permission}>{permission}</code>
                    ))}
                  </div>
                ) : null}

                {plugin.runtime?.needsGrant ? (
                  <div className="plugin-executable-warning" role="note">
                    <TriangleAlert size={13} aria-hidden="true" />
                    <span>{t('插件请求的权限有变化，已暂停运行。重新打开开关以查看并授权。')}</span>
                  </div>
                ) : null}
                {reviewing === plugin.pluginId ? (
                  <GrantReview
                    plugin={plugin}
                    pending={pending}
                    onCancel={() => setReviewing(null)}
                    onConfirm={() => void toggle(plugin, true)}
                  />
                ) : null}

                {plugin.settings && plugin.settings.length > 0 ? (
                  <div
                    className="plugin-settings-fields"
                    role="group"
                    aria-label={t('{name} 设置', { name: plugin.name })}
                  >
                    {plugin.settings.map((setting) => (
                      <SettingField
                        key={setting.key}
                        setting={setting}
                        pluginName={plugin.name}
                        disabled={pending}
                        onChange={(value) =>
                          void onCommand({
                            type: 'plugin:settings:set',
                            pluginId: plugin.pluginId,
                            key: setting.key,
                            value
                          }).catch((error: unknown) =>
                            dispatch({
                              type: 'toggle:failure',
                              pluginId: plugin.pluginId,
                              message: pluginSettingsErrorMessage(error)
                            })
                          )
                        }
                      />
                    ))}
                  </div>
                ) : null}

                {plugin.hasExecutablePiResources ? (
                  <div className="plugin-executable-warning" role="note">
                    <TriangleAlert size={13} aria-hidden="true" />
                    <span>
                      {t(
                        '该插件还含 Pi 已加载的 Skills/Extensions。切换 Desktop 开关不会停用或停止这些资源。'
                      )}
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
          <strong>{t('发现诊断')}</strong>
          <DiagnosticList diagnostics={registryDiagnostics} />
        </div>
      ) : null}
    </SettingsPage>
  )
}
