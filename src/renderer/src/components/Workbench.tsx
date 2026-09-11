import { useEffect, useReducer, useState } from 'react'
import {
  Blocks,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Code2,
  Files,
  FlaskConical,
  GitPullRequest,
  Globe2,
  KeyRound,
  LoaderCircle,
  LogIn,
  MonitorCog,
  Plus,
  Puzzle,
  RefreshCw,
  Settings2,
  ShieldAlert,
  TerminalSquare,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import type {
  AgentSnapshot,
  DesktopPluginSummary,
  LoginMethod,
  LoginPrompt,
  WorkbenchCommand,
  WorkbenchContribution,
  WorkbenchDiagnostic,
  WorkbenchIcon,
  WorkbenchSnapshot
} from '../../../shared/contracts'
import {
  INITIAL_PLUGIN_SETTINGS_OPERATION_STATE,
  pluginDesktopToggleCommand,
  pluginSourceLabel,
  pluginSettingsErrorMessage,
  pluginSettingsOperationReducer
} from '../store/plugin-settings'
import BrowserPane from './BrowserPane'
import FilesPane from './FilesPane'
import GitReviewPane from './GitReviewPane'
import SandboxedPluginPane from './SandboxedPluginPane'
import TerminalPane from './TerminalPane'
import CustomEndpoints from './CustomEndpoints'

const WORKBENCH_ICONS: Record<WorkbenchIcon, LucideIcon> = {
  files: Files,
  'git-review': GitPullRequest,
  terminal: TerminalSquare,
  browser: Globe2,
  plugin: Puzzle,
  flask: FlaskConical
}

type WorkbenchProps = {
  collapsed: boolean
  selectedViewId: string | null
  settingsOpen: boolean
  agentSnapshot: AgentSnapshot
  workbenchSnapshot: WorkbenchSnapshot
  workbenchError: string | null
  onSelectView: (viewId: string) => void
  onToggle: () => void
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  onWorkbenchError: (message: string) => void
  onLogin: (providerId: string, method: LoginMethod) => void
  onAddAlias: (slug: string) => void
  onLoginPrompt: (promptId: string, value?: string) => void
}

function contributionIcon(icon: WorkbenchIcon): LucideIcon {
  return WORKBENCH_ICONS[icon] ?? Blocks
}

function LoginState({ snapshot }: { snapshot: AgentSnapshot }): React.JSX.Element | null {
  const login = snapshot.login
  if (login.phase === 'idle') return null
  if (login.phase === 'error') {
    return (
      <div className="login-state is-error">
        <CircleAlert size={15} />
        <span>{login.message}</span>
      </div>
    )
  }
  if (login.phase === 'success') {
    return (
      <div className="login-state is-success">
        <Check size={15} />
        <span>登录成功，Pi 凭证已刷新。</span>
      </div>
    )
  }
  if (login.phase === 'device_code') {
    return (
      <div className="device-code-card">
        <span>在浏览器中输入设备码</span>
        <div>
          <code>{login.userCode}</code>
          <button
            type="button"
            className="icon-btn"
            title="复制设备码"
            aria-label="复制设备码"
            onClick={() => void navigator.clipboard.writeText(login.userCode)}
          >
            <Clipboard size={14} />
          </button>
        </div>
        <small>{login.verificationUri}</small>
      </div>
    )
  }
  return (
    <div className="login-state">
      <LoaderCircle className="spin" size={15} />
      <span>
        {login.phase === 'starting'
          ? '正在启动 Pi /login…'
          : login.phase === 'browser'
            ? login.instructions || '已在系统浏览器打开登录页。'
            : login.message}
      </span>
    </div>
  )
}

function AuthPromptCard({
  prompt,
  onRespond
}: {
  prompt: LoginPrompt
  onRespond: (promptId: string, value?: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  useEffect(() => setValue(''), [prompt.id])

  if (prompt.type === 'select') {
    return (
      <div className="auth-prompt-card">
        <strong>{prompt.message}</strong>
        <div className="prompt-options">
          {prompt.options?.map((option) => (
            <button
              key={option.id}
              type="button"
              className="secondary-button prompt-option"
              onClick={() => onRespond(prompt.id, option.id)}
            >
              <span>{option.label}</span>
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <form
      className="auth-prompt-card"
      onSubmit={(event) => {
        event.preventDefault()
        onRespond(prompt.id, value)
      }}
    >
      <label htmlFor={`auth-${prompt.id}`}>{prompt.message}</label>
      <input
        id={`auth-${prompt.id}`}
        type={prompt.type === 'secret' ? 'password' : 'text'}
        value={value}
        autoFocus
        placeholder={prompt.placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="primary-button" type="submit" disabled={!value.trim()}>
        继续
      </button>
    </form>
  )
}

function LoginButtons({
  providerId,
  connected,
  onLogin
}: {
  providerId: string
  connected: boolean
  onLogin: (providerId: string, method: LoginMethod) => void
}): React.JSX.Element {
  return (
    <div className="login-actions">
      <button
        className="primary-button"
        type="button"
        onClick={() => onLogin(providerId, 'browser')}
      >
        <LogIn size={14} />
        {connected ? '重新登录' : '浏览器登录'}
      </button>
      <button
        className="secondary-button"
        type="button"
        onClick={() => onLogin(providerId, 'device_code')}
      >
        <Code2 size={14} />
        设备码
      </button>
    </div>
  )
}

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

function PluginSettingsSection({
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

function SettingsPanel({
  agentSnapshot,
  workbenchSnapshot,
  onWorkbenchCommand,
  onLogin,
  onAddAlias,
  onLoginPrompt
}: Pick<
  WorkbenchProps,
  | 'agentSnapshot'
  | 'workbenchSnapshot'
  | 'onWorkbenchCommand'
  | 'onLogin'
  | 'onAddAlias'
  | 'onLoginPrompt'
>): React.JSX.Element {
  const [addingAlias, setAddingAlias] = useState(false)
  const [alias, setAlias] = useState('')
  const mainAccount = agentSnapshot.accounts.find((account) => account.id === 'openai-codex')
  const aliasAccounts = agentSnapshot.accounts.filter((account) => account.alias)

  return (
    <div className="settings-panel">
      <div className="settings-scroll">
        <section className="settings-section">
          <div className="section-kicker">ChatGPT Plus / Pro</div>
          <div className="account-card is-primary">
            <div className="account-head">
              <span className="account-symbol">C</span>
              <div>
                <strong>Codex 主账号</strong>
                <small>Pi provider · openai-codex</small>
              </div>
              <span className={`status-badge${mainAccount?.connected ? ' is-on' : ''}`}>
                {mainAccount?.connected ? '已登录' : '未登录'}
              </span>
            </div>
            <p>
              登录由 Pi 的 <code>/login openai-codex</code> 完成；授权页会在系统浏览器打开。
            </p>
            <LoginButtons
              providerId="openai-codex"
              connected={Boolean(mainAccount?.connected)}
              onLogin={onLogin}
            />
          </div>

          <LoginState snapshot={agentSnapshot} />
          {agentSnapshot.loginPrompt ? (
            <AuthPromptCard prompt={agentSnapshot.loginPrompt} onRespond={onLoginPrompt} />
          ) : null}
        </section>

        <section className="settings-section">
          <div className="settings-section-title">
            <div>
              <span>更多 Codex 账号</span>
              <small>每个账号使用独立的 Pi provider 别名</small>
            </div>
            <button
              className="icon-btn"
              type="button"
              title="添加账号"
              aria-label="添加 Codex 账号"
              disabled={!agentSnapshot.project}
              onClick={() => setAddingAlias((value) => !value)}
            >
              <Plus size={16} />
            </button>
          </div>

          {!agentSnapshot.project ? (
            <p className="inline-hint">先选择工作区，Pi 才能加载账号扩展。</p>
          ) : null}

          {addingAlias ? (
            <form
              className="alias-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (!alias.trim()) return
                onAddAlias(alias.trim())
                setAlias('')
                setAddingAlias(false)
              }}
            >
              <label htmlFor="account-alias">账号别名</label>
              <div>
                <span>openai-codex-</span>
                <input
                  id="account-alias"
                  value={alias}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  placeholder="work"
                  autoFocus
                  onChange={(event) => setAlias(event.target.value.toLowerCase())}
                />
              </div>
              <button className="primary-button" type="submit">
                创建别名槽
              </button>
            </form>
          ) : null}

          {aliasAccounts.map((account) => (
            <div className="account-card alias-account" key={account.id}>
              <div className="account-head">
                <span className="account-symbol is-alias">C</span>
                <div>
                  <strong>{account.name}</strong>
                  <small>{account.id}</small>
                </div>
                <span className={`status-badge${account.connected ? ' is-on' : ''}`}>
                  {account.connected ? '已登录' : '未登录'}
                </span>
              </div>
              <LoginButtons
                providerId={account.id}
                connected={account.connected}
                onLogin={onLogin}
              />
            </div>
          ))}
        </section>

        <CustomEndpoints snapshot={agentSnapshot} />

        <PluginSettingsSection snapshot={workbenchSnapshot} onCommand={onWorkbenchCommand} />

        <section className="settings-section provider-note">
          <div className="section-kicker">关于 Claude</div>
          <p>
            Pi 的 <code>/login anthropic</code> 使用 Anthropic API 的 extra usage，按 token
            计费；它不占 Claude Code 套餐限额。本应用不会默认导入 Claude Code token。
          </p>
        </section>

        <section className="settings-section storage-note">
          <KeyRound size={15} />
          <p>
            凭证只保存在 <code>~/.pi/agent/auth.json</code>，会话只保存在 Pi JSONL；桌面端不复制
            token 或对话。
          </p>
        </section>
      </div>
    </div>
  )
}

function EmptyWorkbench({ hasContributions }: { hasContributions: boolean }): React.JSX.Element {
  return (
    <div className="workbench-body">
      <MonitorCog size={23} />
      <p className="workbench-empty-title">
        {hasContributions ? '选择一个工作台面板' : '暂无可用面板'}
      </p>
      <p className="workbench-empty-copy">
        {hasContributions
          ? '从活动栏选择一个面板；一次只会打开一个工作台视图。'
          : '选择工作区或在设置中重新加载插件，即可查看可用的右侧面板。'}
      </p>
    </div>
  )
}

function ContributionSurface({
  contribution,
  projectReady,
  gitReady,
  projectPath,
  onCommand,
  onError
}: {
  contribution: WorkbenchContribution | undefined
  projectReady: boolean
  gitReady: boolean
  projectPath: string | null
  onCommand: (command: WorkbenchCommand) => Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  if (!contribution) return <EmptyWorkbench hasContributions={false} />
  if (contribution.surface.kind === 'first-party') {
    if (contribution.surface.adapter === 'files')
      return <FilesPane key={projectPath ?? 'no-project'} projectPath={projectPath} />
    if (contribution.surface.adapter === 'review')
      return (
        <GitReviewPane
          key={`${projectPath ?? 'no-project'}:${gitReady}`}
          projectPath={projectPath}
          ready={gitReady}
        />
      )
    // Terminal is owned by the persistent stage below, outside conditional surfaces.
    return <></>
  }
  if (contribution.surface.kind === 'native-view') {
    return (
      <BrowserPane
        viewId={contribution.viewId}
        projectReady={projectReady}
        onWorkbenchCommand={onCommand}
        onWorkbenchError={onError}
      />
    )
  }
  if (contribution.surface.kind === 'sandboxed-web') {
    return (
      <SandboxedPluginPane
        viewId={contribution.viewId}
        visible
        onWorkbenchCommand={onCommand}
        onWorkbenchError={onError}
      />
    )
  }
  return <EmptyWorkbench hasContributions />
}

export default function Workbench({
  collapsed,
  selectedViewId,
  settingsOpen,
  agentSnapshot,
  workbenchSnapshot,
  workbenchError,
  onSelectView,
  onToggle,
  onWorkbenchCommand,
  onWorkbenchError,
  onLogin,
  onAddAlias,
  onLoginPrompt
}: WorkbenchProps): React.JSX.Element {
  const selectedContribution = workbenchSnapshot.contributions.find(
    ({ viewId }) => viewId === selectedViewId
  )
  const selectedPlugin = selectedContribution
    ? workbenchSnapshot.plugins.find(({ pluginId }) => pluginId === selectedContribution.pluginId)
    : undefined
  const SelectedIcon = selectedContribution
    ? contributionIcon(selectedContribution.icon)
    : MonitorCog

  return (
    <aside
      className={`workbench${collapsed ? ' is-collapsed' : ''}`}
      aria-label={collapsed ? '折叠的工作台' : '工作台'}
    >
      <nav className="workbench-rail" aria-label="工作台视图">
        <div className="workbench-rail-spacer" aria-hidden="true" />
        <div className="workbench-rail-scroll">
          {workbenchSnapshot.contributions.map((contribution) => {
            const Icon = contributionIcon(contribution.icon)
            const active = !settingsOpen && contribution.viewId === selectedViewId
            return (
              <button
                key={contribution.viewId}
                type="button"
                className={`workbench-rail-button${active ? ' is-active' : ''}`}
                title={contribution.title}
                aria-label={contribution.title}
                aria-pressed={active}
                onClick={() => onSelectView(contribution.viewId)}
              >
                <Icon size={17} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      </nav>

      <div className="workbench-stage" hidden={collapsed}>
        <header className="workbench-stage-head">
          <div className="workbench-stage-title">
            {settingsOpen ? <Settings2 size={15} /> : <SelectedIcon size={15} />}
            <span
              title={collapsed ? undefined : settingsOpen ? '设置' : selectedContribution?.title}
            >
              {settingsOpen ? '设置' : (selectedContribution?.title ?? '工作台')}
            </span>
            {!settingsOpen && selectedContribution ? (
              <small>{selectedPlugin?.builtin ? '内置' : '插件'}</small>
            ) : null}
          </div>
          <button
            className="icon-btn workbench-fold"
            type="button"
            onClick={onToggle}
            title={settingsOpen ? '关闭设置' : '折叠工作台'}
            aria-label={settingsOpen ? '关闭设置' : '折叠工作台'}
          >
            <ChevronRight size={17} />
          </button>
        </header>

        {workbenchError ? (
          <div className="workbench-error" role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{workbenchError}</span>
          </div>
        ) : null}

        <div className="workbench-stage-body">
          <TerminalPane
            projectPath={agentSnapshot.project?.path ?? null}
            visible={
              !collapsed &&
              !settingsOpen &&
              selectedContribution?.surface.kind === 'first-party' &&
              selectedContribution.surface.adapter === 'terminal'
            }
          />
          {collapsed ? null : settingsOpen ? (
            <SettingsPanel
              agentSnapshot={agentSnapshot}
              workbenchSnapshot={workbenchSnapshot}
              onWorkbenchCommand={onWorkbenchCommand}
              onLogin={onLogin}
              onAddAlias={onAddAlias}
              onLoginPrompt={onLoginPrompt}
            />
          ) : selectedContribution?.surface.kind === 'first-party' &&
            selectedContribution.surface.adapter === 'terminal' ? null : selectedContribution ? (
            <ContributionSurface
              contribution={selectedContribution}
              projectReady={Boolean(agentSnapshot.project)}
              gitReady={agentSnapshot.ready}
              projectPath={agentSnapshot.project?.path ?? null}
              onCommand={onWorkbenchCommand}
              onError={onWorkbenchError}
            />
          ) : (
            <EmptyWorkbench hasContributions={workbenchSnapshot.contributions.length > 0} />
          )}
        </div>
      </div>
    </aside>
  )
}
