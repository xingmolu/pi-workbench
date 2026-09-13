import { useEffect, useState } from 'react'
import {
  Check,
  CircleAlert,
  Clipboard,
  Code2,
  KeyRound,
  LoaderCircle,
  LogIn,
  Plus
} from 'lucide-react'
import type { AgentSnapshot, LoginMethod, LoginPrompt } from '../../../shared/contracts'
import CustomEndpoints from './CustomEndpoints'

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

export default function SettingsAccounts({
  agentSnapshot,
  renderAccountQuota,
  onLogin,
  onAddAlias,
  onLoginPrompt
}: {
  agentSnapshot: AgentSnapshot
  onLogin: (providerId: string, method: LoginMethod) => void
  onAddAlias: (slug: string) => void
  onLoginPrompt: (promptId: string, value?: string) => void
  renderAccountQuota?: (account: AgentSnapshot['accounts'][number]) => React.ReactNode
}): React.JSX.Element {
  const [addingAlias, setAddingAlias] = useState(false)
  const [alias, setAlias] = useState('')
  const [provider, setProvider] = useState('codex')
  const mainAccount = agentSnapshot.accounts.find((account) => account.id === 'openai-codex')
  const aliasAccounts = agentSnapshot.accounts.filter((account) => account.alias)

  return (
    <div className="settings-panel">
      <div className="account-provider-nav" aria-label="模型供应商">
        <button
          type="button"
          aria-pressed={provider === 'codex'}
          onClick={() => setProvider('codex')}
        >
          OpenAI Codex <small>编程套餐 / 订阅</small>
        </button>
        <button
          type="button"
          aria-pressed={provider === 'endpoints'}
          onClick={() => setProvider('endpoints')}
        >
          自定义端点 <small>API Key · 兼容服务</small>
        </button>
        <button
          type="button"
          aria-pressed={provider === 'claude'}
          onClick={() => setProvider('claude')}
        >
          Anthropic <small>连接方式说明</small>
        </button>
      </div>
      <div className="settings-scroll">
        <LoginState snapshot={agentSnapshot} />
        {agentSnapshot.loginPrompt ? (
          <AuthPromptCard prompt={agentSnapshot.loginPrompt} onRespond={onLoginPrompt} />
        ) : null}
        {provider === 'codex' ? (
          <>
            <section className="settings-section">
              <div className="section-kicker">OpenAI Codex · 编程套餐 / 订阅</div>
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
                <p>连接来源：Pi 登录凭证。账号额度与当前会话的 token 用量分别统计。</p>
                <LoginButtons
                  providerId="openai-codex"
                  connected={Boolean(mainAccount?.connected)}
                  onLogin={onLogin}
                />
              </div>

              {mainAccount && renderAccountQuota?.(mainAccount)}
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
                  {renderAccountQuota?.(account)}
                  <LoginButtons
                    providerId={account.id}
                    connected={account.connected}
                    onLogin={onLogin}
                  />
                </div>
              ))}
            </section>
          </>
        ) : null}
        {provider === 'endpoints' ? <CustomEndpoints snapshot={agentSnapshot} /> : null}

        {provider === 'claude' ? (
          <section className="settings-section provider-note">
            <div className="section-kicker">关于 Claude</div>
            <p>
              Pi 的 <code>/login anthropic</code> 使用 Anthropic API 的 extra usage，按 token
              计费；它不占 Claude Code 套餐限额。本应用不会默认导入 Claude Code token。
            </p>
          </section>
        ) : null}

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
