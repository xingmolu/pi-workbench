import { useEffect, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Code2,
  Files,
  GitPullRequest,
  Globe2,
  KeyRound,
  LoaderCircle,
  LogIn,
  MonitorCog,
  Plus,
  Settings2,
  TerminalSquare,
  X
} from 'lucide-react'
import type { AgentSnapshot, LoginMethod, LoginPrompt } from '../../../shared/contracts'

export type WorkbenchMode = 'files' | 'review' | 'terminal' | 'browser'

const MODES: { id: WorkbenchMode; label: string; icon: typeof Files }[] = [
  { id: 'files', label: '文件', icon: Files },
  { id: 'review', label: '审查', icon: GitPullRequest },
  { id: 'terminal', label: '终端', icon: TerminalSquare },
  { id: 'browser', label: '浏览器', icon: Globe2 }
]

const MODE_HINT: Record<WorkbenchMode, { title: string; copy: string }> = {
  files: { title: '文件面板', copy: '本轮保持占位，不读取或复制项目文件树。' },
  review: { title: 'Git Review', copy: '本轮保持占位，不接入 Git diff 或审查工作流。' },
  terminal: { title: '用户终端', copy: '本轮保持占位。Agent 命令会作为对话工具卡片显示。' },
  browser: { title: '内嵌浏览器', copy: '本轮保持占位。Codex 登录会打开系统浏览器。' }
}

type WorkbenchProps = {
  collapsed: boolean
  mode: WorkbenchMode
  settingsOpen: boolean
  snapshot: AgentSnapshot
  loginPrompt: LoginPrompt | null
  onModeChange: (mode: WorkbenchMode) => void
  onToggle: () => void
  onCloseSettings: () => void
  onLogin: (providerId: string, method: LoginMethod) => void
  onAddAlias: (slug: string) => void
  onLoginPrompt: (promptId: string, value?: string) => void
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

function SettingsPanel({
  snapshot,
  loginPrompt,
  onClose,
  onLogin,
  onAddAlias,
  onLoginPrompt
}: Pick<WorkbenchProps, 'snapshot' | 'loginPrompt' | 'onLogin' | 'onAddAlias' | 'onLoginPrompt'> & {
  onClose: () => void
}): React.JSX.Element {
  const [addingAlias, setAddingAlias] = useState(false)
  const [alias, setAlias] = useState('')
  const mainAccount = snapshot.accounts.find((account) => account.id === 'openai-codex')
  const aliasAccounts = snapshot.accounts.filter((account) => account.alias)

  return (
    <div className="settings-panel">
      <header className="settings-head">
        <div>
          <span>设置</span>
          <h2>账号与模型</h2>
        </div>
        <button className="icon-btn" type="button" onClick={onClose} title="关闭设置">
          <X size={17} />
        </button>
      </header>

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

          <LoginState snapshot={snapshot} />
          {loginPrompt ? <AuthPromptCard prompt={loginPrompt} onRespond={onLoginPrompt} /> : null}
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
              disabled={!snapshot.project}
              onClick={() => setAddingAlias((value) => !value)}
            >
              <Plus size={16} />
            </button>
          </div>

          {!snapshot.project ? (
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

export default function Workbench({
  collapsed,
  mode,
  settingsOpen,
  snapshot,
  loginPrompt,
  onModeChange,
  onToggle,
  onCloseSettings,
  onLogin,
  onAddAlias,
  onLoginPrompt
}: WorkbenchProps): React.JSX.Element {
  if (collapsed) {
    return (
      <aside className="workbench is-collapsed" aria-label="折叠的工作台">
        <div className="workbench-rail">
          {MODES.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={`icon-btn${!settingsOpen && item.id === mode ? ' is-active' : ''}`}
                title={item.label}
                onClick={() => onModeChange(item.id)}
              >
                <Icon size={16} />
              </button>
            )
          })}
          <span className="rail-spacer" />
          <button className="icon-btn" type="button" onClick={onToggle} title="展开工作台">
            <ChevronLeft size={17} />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="workbench">
      <div className="workbench-picker">
        {settingsOpen ? (
          <div className="settings-tab-label">
            <Settings2 size={14} /> 设置
          </div>
        ) : (
          MODES.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={item.id === mode ? 'is-active' : undefined}
                onClick={() => onModeChange(item.id)}
              >
                <Icon size={13} />
                {item.label}
              </button>
            )
          })
        )}
        <button className="icon-btn fold" type="button" onClick={onToggle} title="折叠工作台">
          <ChevronRight size={17} />
        </button>
      </div>

      {settingsOpen ? (
        <SettingsPanel
          snapshot={snapshot}
          loginPrompt={loginPrompt}
          onClose={onCloseSettings}
          onLogin={onLogin}
          onAddAlias={onAddAlias}
          onLoginPrompt={onLoginPrompt}
        />
      ) : (
        <div className="workbench-body">
          <MonitorCog size={23} />
          <p className="workbench-empty-title">{MODE_HINT[mode].title}</p>
          <p className="workbench-empty-copy">{MODE_HINT[mode].copy}</p>
          <span className="placeholder-pill">占位</span>
        </div>
      )}
    </aside>
  )
}
