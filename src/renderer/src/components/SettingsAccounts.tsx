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
import '../assets/accounts-settings.css'
import { confirmDiscardSettingsDraft, useSettingsDraftController } from './SettingsDraftContext'

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
    <div className="acct-actions">
      <button
        className="acct-button"
        type="button"
        onClick={() => onLogin(providerId, 'device_code')}
      >
        <Code2 size={14} />
        设备码
      </button>
      <button
        className={connected ? 'acct-button' : 'acct-button is-primary'}
        type="button"
        onClick={() => onLogin(providerId, 'browser')}
      >
        <LogIn size={14} />
        {connected ? '重新登录' : '浏览器登录'}
      </button>
    </div>
  )
}

function AccountHead({
  name,
  id,
  connected,
  alias = false,
  children
}: {
  name: string
  id: string
  connected: boolean
  alias?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="acct-head">
      <span className={alias ? 'acct-avatar is-alias' : 'acct-avatar'} aria-hidden="true">
        C
      </span>
      <div className="acct-meta">
        <span className="acct-name">
          <strong>{name}</strong>
          <span className={connected ? 'acct-status is-on' : 'acct-status'}>
            {connected ? '已登录' : '未登录'}
          </span>
        </span>
        <small>{id}</small>
      </div>
      {children}
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
  const [provider, setProvider] = useState<'codex' | 'endpoints' | 'claude'>('codex')
  const settingsDraft = useSettingsDraftController()
  const chooseProvider = (next: 'codex' | 'endpoints' | 'claude'): void => {
    if (next === provider) return
    if (!confirmDiscardSettingsDraft(Boolean(settingsDraft?.dirty))) return
    settingsDraft?.clear()
    setProvider(next)
  }
  const mainAccount = agentSnapshot.accounts.find((account) => account.id === 'openai-codex')
  const aliasAccounts = agentSnapshot.accounts.filter((account) => account.alias)

  return (
    <div className="acct">
      <div className="acct-tabs" role="group" aria-label="模型供应商">
        <button
          type="button"
          aria-pressed={provider === 'codex'}
          onClick={() => chooseProvider('codex')}
        >
          <span>OpenAI Codex</span> <small>编程套餐 / 订阅</small>
        </button>
        <button
          type="button"
          aria-pressed={provider === 'endpoints'}
          onClick={() => chooseProvider('endpoints')}
        >
          <span>自定义端点</span> <small>API Key · 兼容服务</small>
        </button>
        <button
          type="button"
          aria-pressed={provider === 'claude'}
          onClick={() => chooseProvider('claude')}
        >
          <span>Anthropic</span> <small>连接方式说明</small>
        </button>
      </div>

      <LoginState snapshot={agentSnapshot} />
      {agentSnapshot.loginPrompt ? (
        <AuthPromptCard prompt={agentSnapshot.loginPrompt} onRespond={onLoginPrompt} />
      ) : null}

      {provider === 'codex' ? (
        <>
          <div className="sp-group">
            <div className="sp-group-header">
              <h3>主账号</h3>
              <p>
                登录由 Pi 的 <code>/login openai-codex</code>{' '}
                完成，授权页在系统浏览器打开。账号额度与当前会话的 token 用量分别统计。
              </p>
            </div>
            <div className="sp-card acct-card">
              <AccountHead
                name="Codex 主账号"
                id="openai-codex"
                connected={Boolean(mainAccount?.connected)}
              >
                <LoginButtons
                  providerId="openai-codex"
                  connected={Boolean(mainAccount?.connected)}
                  onLogin={onLogin}
                />
              </AccountHead>
              {mainAccount && renderAccountQuota?.(mainAccount)}
            </div>
          </div>

          <div className="sp-group">
            <div className="sp-group-header acct-group-header">
              <div>
                <h3>更多 Codex 账号</h3>
                <p>每个账号使用独立的 Pi provider 别名，可在输入框旁切换。</p>
              </div>
              <button
                className="acct-button"
                type="button"
                title="添加账号"
                aria-label="添加 Codex 账号"
                aria-expanded={addingAlias}
                disabled={!agentSnapshot.project}
                onClick={() => setAddingAlias((value) => !value)}
              >
                <Plus size={14} />
                添加账号
              </button>
            </div>

            {!agentSnapshot.project ? (
              <p className="acct-empty">先选择工作区，Pi 才能加载账号扩展。</p>
            ) : null}

            {addingAlias ? (
              <form
                className="sp-card acct-alias-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!alias.trim()) return
                  onAddAlias(alias.trim())
                  setAlias('')
                  setAddingAlias(false)
                }}
              >
                <label htmlFor="account-alias">账号别名</label>
                <div className="acct-alias-input">
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
                <button className="acct-button is-primary" type="submit" disabled={!alias.trim()}>
                  创建别名槽
                </button>
              </form>
            ) : null}

            {aliasAccounts.length > 0 ? (
              <div className="acct-alias-list">
                {aliasAccounts.map((account) => (
                  <div className="sp-card acct-card" key={account.id}>
                    <AccountHead
                      name={account.name}
                      id={account.id}
                      connected={account.connected}
                      alias
                    >
                      <LoginButtons
                        providerId={account.id}
                        connected={account.connected}
                        onLogin={onLogin}
                      />
                    </AccountHead>
                    {renderAccountQuota?.(account)}
                  </div>
                ))}
              </div>
            ) : agentSnapshot.project && !addingAlias ? (
              <p className="acct-empty">还没有其他账号。添加别名后分别登录，额度互不影响。</p>
            ) : null}
          </div>
        </>
      ) : null}

      {provider === 'endpoints' ? <CustomEndpoints snapshot={agentSnapshot} /> : null}

      {provider === 'claude' ? (
        <div className="sp-group">
          <div className="sp-group-header">
            <h3>关于 Claude</h3>
          </div>
          <div className="sp-card acct-note">
            <p>
              Pi 的 <code>/login anthropic</code> 使用 Anthropic API 的 extra usage，按 token
              计费；它不占 Claude Code 套餐限额。本应用不会默认导入 Claude Code token。
            </p>
            <p>
              需要接入其他 Anthropic 兼容服务时，可在“自定义端点”里选择 Anthropic Messages 协议。
            </p>
          </div>
        </div>
      ) : null}

      <p className="acct-footnote">
        <KeyRound size={13} aria-hidden="true" />
        <span>
          凭证只保存在 <code>~/.pi/agent/auth.json</code>，会话只保存在 Pi JSONL；桌面端不复制 token
          或对话。
        </span>
      </p>
    </div>
  )
}
