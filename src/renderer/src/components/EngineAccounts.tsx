import { useEffect, useState } from 'react'
import * as Dropdown from '@radix-ui/react-dropdown-menu'
import {
  Check,
  ChevronDown,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  LogIn,
  MoreHorizontal,
  Plus,
  Server
} from 'lucide-react'
import type {
  AccountSummary,
  AgentSnapshot,
  LoginMethod,
  RuntimeAccounts,
  SubscriptionPlatform
} from '../../../shared/contracts'
import type { AgentRuntimeManifest } from '../../../shared/agent-runtime'
import { useRuntimeCatalog } from '../store/runtime-catalog'
import { engineSummary } from '../store/engine-presentation'
import { apiRows, subscriptionRows, useRuntimeAccounts } from '../store/runtime-accounts'
import { AuthPromptCard, LoginState } from './AccountLogin'
import AccountQuota from './AccountQuota'
import CustomEndpoints from './CustomEndpoints'
import { SettingsPage } from './SettingsPrimitives'
import { useSettingsDraft } from './SettingsDraftContext'
import '../assets/accounts-settings.css'
import '../assets/engine-accounts.css'

const PLATFORM_LABEL: Record<SubscriptionPlatform, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude'
}

function EngineCards({
  runtimes,
  engines,
  selected,
  onSelect
}: {
  runtimes: AgentRuntimeManifest[]
  engines: RuntimeAccounts[] | null
  selected: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="ea-engines" role="radiogroup" aria-label="新会话默认引擎">
      {runtimes.map((runtime) => {
        const engine = engines?.find((item) => item.runtimeId === runtime.id)
        const ready = engine?.accounts.filter((account) => account.connected).length ?? 0
        const status = !engine
          ? { tone: '', text: '读取中…' }
          : engine.error
            ? { tone: 'is-error', text: '无法启动' }
            : ready
              ? { tone: 'is-ready', text: `已就绪 · ${ready} 个账号或连接` }
              : { tone: 'is-warning', text: '需要登录或添加 API' }
        const checked = selected === runtime.id
        return (
          <button
            type="button"
            role="radio"
            key={runtime.id}
            aria-checked={checked}
            className={`ea-engine${checked ? ' is-selected' : ''}`}
            onClick={() => onSelect(runtime.id)}
          >
            <span className="ea-engine-head">
              <strong>{runtime.label}</strong>
              <span className="ea-radio" aria-hidden="true">
                {checked ? <Check size={12} /> : null}
              </span>
            </span>
            <small>{engineSummary(runtime)}</small>
            <span className={`ea-engine-status ${status.tone}`} title={engine?.error}>
              {status.text}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function identity(account: AccountSummary): string {
  if (account.email) return account.email
  return account.platform === 'claude' ? 'Claude 账号' : account.name
}

function SubscriptionItem({
  row,
  engine,
  busy,
  onLogin,
  onRemove
}: {
  row: { runtimeId: string; engine: string; account: AccountSummary }
  engine: RuntimeAccounts
  busy: boolean
  onLogin: (method: LoginMethod) => void
  onRemove: () => void
}): React.JSX.Element {
  const { account } = row
  const [quota, setQuota] = useState(false)
  const name = identity(account)
  const loginActive = ['starting', 'browser', 'device_code', 'waiting'].includes(engine.login.phase)
  return (
    <li className="ea-row">
      <div className="ea-row-main">
        <span className={`ea-avatar is-${account.platform}`} aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="ea-row-text">
          <strong title={name}>{name}</strong>
          <small>
            {PLATFORM_LABEL[account.platform!]}
            {account.plan ? ` ${account.plan}` : ''} · 用于 {row.engine}
          </small>
        </div>
        {account.connected ? (
          <span className="ea-pill is-ready">已登录</span>
        ) : (
          <button
            type="button"
            className="acct-button is-primary"
            disabled={busy || loginActive}
            onClick={() => onLogin('browser')}
          >
            <LogIn size={14} />
            登录
          </button>
        )}
        <Dropdown.Root>
          <Dropdown.Trigger className="icon-btn ea-more" aria-label={`${name} 的更多操作`}>
            <MoreHorizontal size={16} />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="ea-menu" align="end" sideOffset={4}>
              <Dropdown.Item
                className="ea-menu-item"
                disabled={busy || loginActive}
                onSelect={() => onLogin('browser')}
              >
                重新登录
              </Dropdown.Item>
              {account.platform === 'chatgpt' && account.connected ? (
                <Dropdown.Item className="ea-menu-item" onSelect={() => setQuota((open) => !open)}>
                  {quota ? '收起额度' : '查看额度'}
                </Dropdown.Item>
              ) : null}
              <Dropdown.Separator className="ea-menu-separator" />
              <Dropdown.Item
                className="ea-menu-item is-danger"
                disabled={busy}
                onSelect={() => {
                  if (window.confirm(`移除 ${name}？这会退出登录，已有会话不受影响。`)) onRemove()
                }}
              >
                移除账号
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
      {quota ? (
        <div className="ea-row-detail">
          <AccountQuota
            account={account}
            authGeneration={engine.authGeneration}
            loginActive={loginActive}
            runtimeId={row.runtimeId}
          />
        </div>
      ) : null}
    </li>
  )
}

function ClaudeApiForm({
  busy,
  onSubmit,
  onCancel
}: {
  busy: boolean
  onSubmit: (apiKey: string, baseUrl: string) => Promise<boolean>
  onCancel: () => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  useSettingsDraft('claude-api', Boolean(key || url))
  return (
    <form
      className="ea-form"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit(key.trim(), url.trim()).then((ok) => {
          if (ok) {
            setKey('')
            setUrl('')
          }
        })
      }}
    >
      <label htmlFor="claude-api-url">
        服务地址 <span>可选，留空使用 Anthropic 官方</span>
      </label>
      <input
        id="claude-api-url"
        type="url"
        value={url}
        placeholder="https://api.anthropic.com"
        onChange={(event) => setUrl(event.target.value)}
        disabled={busy}
      />
      <label htmlFor="claude-api-key">API Key</label>
      <input
        id="claude-api-key"
        type="password"
        value={key}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setKey(event.target.value)}
        disabled={busy}
      />
      <div className="ea-form-actions">
        <button type="button" className="acct-button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" className="acct-button is-primary" disabled={busy || !key.trim()}>
          {busy ? <LoaderCircle size={14} className="spin" /> : null}
          添加连接
        </button>
      </div>
    </form>
  )
}

function LegacyPiHistory(): React.JSX.Element | null {
  const [legacy, setLegacy] = useState<{ location: string; count: number } | null>(null)
  const [state, setState] = useState<{ pending?: boolean; result?: string; error?: string }>({})
  useEffect(() => {
    let live = true
    void window.pi
      .legacyPiHistory()
      .then((value) => live && setLegacy(value))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!legacy?.count) return null
  return (
    <section className="sp-group">
      <div className="sp-group-header">
        <h3>导入旧 Pi 历史</h3>
        <p>
          发现 {legacy.count}{' '}
          个历史文件。导入后可在侧栏继续这些会话；原文件保留，登录和端点不随历史导入。
        </p>
      </div>
      <div className="ea-inline">
        <button
          type="button"
          className="acct-button"
          disabled={state.pending}
          onClick={() => {
            setState({ pending: true })
            void window.pi
              .importPiHistory()
              .then((value) =>
                setState({
                  result: `已导入 ${value.imported} 个，跳过 ${value.skipped} 个已有或无效文件。`
                })
              )
              .catch((reason) =>
                setState({ error: reason instanceof Error ? reason.message : String(reason) })
              )
          }}
        >
          {state.pending ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}
          导入历史
        </button>
        {state.result ? <span role="status">{state.result}</span> : null}
        {state.error ? (
          <span className="inline-error" role="alert">
            {state.error}
          </span>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Engines, subscription accounts and API connections on one page. Everything here comes
 * from each engine's configuration, so it reads the same whichever chat is open.
 */
export default function EngineAccounts({
  snapshot
}: {
  snapshot: AgentSnapshot
}): React.JSX.Element {
  const runtimes = useRuntimeCatalog((state) => state.runtimes)
  const { engines, error, pending, run } = useRuntimeAccounts()
  const [defaultEngine, setDefaultEngine] = useState<string | null>(null)
  const [addingApi, setAddingApi] = useState(false)
  useEffect(() => {
    let live = true
    void window.pi.defaultRuntime().then((id) => live && setDefaultEngine(id))
    return () => {
      live = false
    }
  }, [])
  const subscriptions = engines ? subscriptionRows(engines) : []
  const providers = runtimes.flatMap((runtime) =>
    (runtime.accountProviders ?? []).flatMap((provider) =>
      provider.login.map((method) => ({ runtime, provider, method }))
    )
  )
  const claude = engines?.find((engine) => engine.runtimeId === 'claude')
  const claudeApis = engines ? apiRows(engines, 'claude') : []
  const signingIn = engines?.filter((engine) => engine.login.phase !== 'idle') ?? []

  return (
    <SettingsPage
      title="引擎与账号"
      description="新会话默认用哪个引擎，以及可以使用的订阅账号和 API 连接。凭据只保存在本机。"
    >
      {error ? (
        <p className="acct-notice is-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="sp-group" aria-label="新会话默认引擎">
        <div className="sp-group-header">
          <h3>新会话默认引擎</h3>
          <p>已有会话保留各自的引擎；侧栏「新会话」旁的箭头可以临时换一个引擎。</p>
        </div>
        <EngineCards
          runtimes={runtimes}
          engines={engines}
          selected={defaultEngine}
          onSelect={(id) => {
            setDefaultEngine(id)
            void window.pi.setDefaultRuntime(id)
          }}
        />
      </section>

      <section className="sp-group" aria-label="订阅账号">
        <div className="sp-group-header ea-group-header">
          <div>
            <h3>订阅账号</h3>
            <p>按邮箱区分；同一个邮箱只需要登录一次。在输入框旁切换使用哪个账号。</p>
          </div>
          <Dropdown.Root>
            <Dropdown.Trigger className="acct-button" disabled={!engines || Boolean(pending)}>
              <Plus size={14} />
              添加订阅账号
              <ChevronDown size={12} />
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content className="ea-menu" align="end" sideOffset={4}>
                {providers.map(({ runtime, provider, method }) => {
                  const engine = engines?.find((item) => item.runtimeId === runtime.id)
                  return (
                    <Dropdown.Item
                      key={`${runtime.id}:${provider.platform}:${method}`}
                      className="ea-menu-item"
                      disabled={!engine || Boolean(engine.error)}
                      onSelect={() =>
                        void run(runtime.id, {
                          type: 'account:add',
                          platform: provider.platform,
                          method
                        })
                      }
                    >
                      <span>
                        {provider.label} 账号{method === 'device_code' ? '（设备码）' : ''}
                      </span>
                      <small>
                        {engine?.error ? `${runtime.label} 无法启动` : `用于 ${runtime.label}`}
                      </small>
                    </Dropdown.Item>
                  )
                })}
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        </div>
        {signingIn.map((engine) => (
          <div className="ea-login" key={engine.runtimeId}>
            <LoginState login={engine.login} />
            {engine.loginPrompt ? (
              <AuthPromptCard
                prompt={engine.loginPrompt}
                onRespond={(promptId, value) =>
                  void run(engine.runtimeId, { type: 'account:login:respond', promptId, value })
                }
              />
            ) : null}
          </div>
        ))}
        {!engines ? (
          <p className="ea-empty">正在读取账号…</p>
        ) : subscriptions.length ? (
          <ul className="sp-card ea-list">
            {subscriptions.map((row) => (
              <SubscriptionItem
                key={`${row.runtimeId}:${row.account.id}`}
                row={row}
                engine={engines.find((engine) => engine.runtimeId === row.runtimeId)!}
                busy={Boolean(pending)}
                onLogin={(method) =>
                  void run(row.runtimeId, {
                    type: 'account:login',
                    providerId: row.account.id,
                    method
                  })
                }
                onRemove={() =>
                  void run(row.runtimeId, { type: 'account:remove', providerId: row.account.id })
                }
              />
            ))}
          </ul>
        ) : (
          <p className="ea-empty">
            还没有订阅账号。添加 ChatGPT 或 Claude 账号后会按邮箱显示在这里。
          </p>
        )}
      </section>

      <section className="sp-group" aria-label="API 连接">
        <div className="sp-group-header">
          <h3>API 连接</h3>
          <p>用 API Key 接入官方或兼容服务，可以添加多个。</p>
        </div>

        {claude ? (
          <div className="ea-subgroup">
            <div className="ea-subgroup-head">
              <span>
                <strong>Claude Code API</strong>
                <small>Anthropic 兼容接口，可以添加多个</small>
              </span>
              {!addingApi && !claude.error ? (
                <button
                  type="button"
                  className="acct-button"
                  disabled={Boolean(pending)}
                  onClick={() => setAddingApi(true)}
                >
                  <Plus size={14} />
                  添加连接
                </button>
              ) : null}
            </div>
            {claude.error ? (
              <details className="acct-notice is-warning ea-error">
                <summary>Claude Code 现在无法启动，暂时不能管理它的连接</summary>
                <p>{claude.error}</p>
              </details>
            ) : null}
            {claudeApis.length ? (
              <ul className="sp-card ea-list">
                {claudeApis.map((row) => (
                  <li className="ea-row" key={row.account.id}>
                    <div className="ea-row-main">
                      <span className="ea-avatar is-api" aria-hidden="true">
                        <Server size={14} />
                      </span>
                      <div className="ea-row-text">
                        <strong>{row.account.name}</strong>
                        <small>{row.account.endpoint ?? 'api.anthropic.com'}</small>
                      </div>
                      <button
                        type="button"
                        className="acct-button is-quiet"
                        disabled={Boolean(pending)}
                        onClick={() => {
                          if (window.confirm(`移除 ${row.account.name} 这个 API 连接？`))
                            void run('claude', {
                              type: 'account:remove',
                              providerId: row.account.id
                            })
                        }}
                      >
                        移除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : !addingApi && !claude.error ? (
              <p className="ea-empty">还没有 API 连接。</p>
            ) : null}
            {addingApi ? (
              <ClaudeApiForm
                busy={pending === 'claude-api'}
                onCancel={() => setAddingApi(false)}
                onSubmit={async (apiKey, baseUrl) => {
                  const ok = await run(
                    'claude',
                    {
                      type: 'account:api-key:set',
                      providerId: 'new',
                      apiKey,
                      ...(baseUrl ? { baseUrl } : {})
                    },
                    'claude-api'
                  )
                  if (ok) setAddingApi(false)
                  return ok
                }}
              />
            ) : null}
          </div>
        ) : null}

        {runtimes.some((runtime) => runtime.id === 'pi') ? (
          <div className="ea-subgroup">
            <CustomEndpoints snapshot={snapshot} detached={snapshot.runtime?.id !== 'pi'} />
          </div>
        ) : null}
      </section>

      {runtimes.some((runtime) => runtime.id === 'pi') ? <LegacyPiHistory /> : null}

      <p className="acct-footnote">
        <KeyRound size={13} aria-hidden="true" />
        <span>
          凭据只保存在本机：Pi 的在它的 <code>auth.json</code>，Claude Code
          的每个账号各用一个独立配置目录。桌面端不复制 token。
        </span>
      </p>
    </SettingsPage>
  )
}
