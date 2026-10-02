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
import type { CredentialGrant } from '../../../shared/engine-credentials'
import { useRuntimeCatalog } from '../store/runtime-catalog'
import { engineSummary } from '../store/engine-presentation'
import { apiRows, subscriptionRows, useRuntimeAccounts } from '../store/runtime-accounts'
import { AuthPromptCard, LoginState } from './AccountLogin'
import AccountQuota from './AccountQuota'
import AddApiConnection from './AddApiConnection'
import CustomEndpoints from './CustomEndpoints'
import { SettingsPage } from './SettingsPrimitives'
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
        const binary = engine?.binary
        const status = !engine
          ? { tone: '', text: '读取中…' }
          : binary?.state === 'downloading'
            ? { tone: 'is-warning', text: `下载中 ${percent(binary.received, binary.size)}` }
            : binary && binary.state !== 'ready'
              ? {
                  tone: 'is-warning',
                  text: binary.state === 'unsupported' ? '不支持此系统' : '未下载'
                }
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

const percent = (received = 0, size = 0): string =>
  size ? `${Math.min(99, Math.floor((received / size) * 100))}%` : ''
const megabytes = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1048576))} MB`

/** Engines the installer leaves out: download, follow progress, or free the space again. */
function EngineDownloads({
  engines,
  onChange
}: {
  engines: RuntimeAccounts[]
  onChange: () => Promise<void>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const rows = engines.filter(
    (engine) =>
      engine.binary && (engine.binary.state !== 'ready' || engine.binary.source === 'downloaded')
  )
  if (!rows.length) return null
  const act = async (runtimeId: string, action: 'install' | 'remove'): Promise<void> => {
    setBusy(runtimeId)
    setError('')
    try {
      await window.pi.engineBinary(runtimeId, action)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
      await onChange()
    }
  }
  return (
    <div className="ea-downloads" role="group" aria-label="引擎下载">
      {rows.map((engine) => {
        const binary = engine.binary!
        const downloading = binary.state === 'downloading'
        return (
          <div className="ea-download" key={engine.runtimeId}>
            <span className="ea-download-text">
              <strong>{engine.label}</strong>
              <small>
                {binary.state === 'ready'
                  ? binary.outdated
                    ? `已下载 ${binary.outdated}，有新版本 ${binary.version}（约 ${megabytes(binary.size)}）`
                    : `已下载 ${binary.version}`
                  : binary.state === 'unsupported'
                    ? '没有适用于这台电脑的版本'
                    : downloading
                      ? `正在下载 ${megabytes(binary.received ?? 0)} / ${megabytes(binary.size)}`
                      : binary.state === 'error'
                        ? (binary.error ?? '下载失败')
                        : `首次使用需要下载（约 ${megabytes(binary.size)}）`}
              </small>
              {downloading ? (
                <span
                  className="ea-progress"
                  role="progressbar"
                  aria-label={`${engine.label} 下载进度`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.floor(((binary.received ?? 0) / (binary.size || 1)) * 100)}
                >
                  <span
                    style={{ width: `${((binary.received ?? 0) / (binary.size || 1)) * 100}%` }}
                  />
                </span>
              ) : null}
            </span>
            {binary.state === 'ready' && binary.outdated ? (
              <button
                type="button"
                className="acct-button is-primary"
                disabled={busy !== null}
                onClick={() => void act(engine.runtimeId, 'install')}
              >
                {busy === engine.runtimeId ? <LoaderCircle size={14} className="spin" /> : null}
                更新
              </button>
            ) : null}
            {binary.state === 'ready' ? (
              <button
                type="button"
                className="acct-button is-quiet"
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(`删除已下载的 ${engine.label}？之后使用时需要重新下载。`))
                    void act(engine.runtimeId, 'remove')
                }}
              >
                删除
              </button>
            ) : binary.state !== 'unsupported' ? (
              <button
                type="button"
                className="acct-button is-primary"
                disabled={busy !== null || downloading}
                onClick={() => void act(engine.runtimeId, 'install')}
              >
                {downloading || busy === engine.runtimeId ? (
                  <LoaderCircle size={14} className="spin" />
                ) : null}
                {downloading ? '下载中' : binary.state === 'error' ? '重试' : '下载'}
              </button>
            ) : null}
          </div>
        )
      })}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
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
  sharedWith = [],
  onLogin,
  onRemove,
  onRevoke
}: {
  row: { runtimeId: string; engine: string; account: AccountSummary }
  engine: RuntimeAccounts
  busy: boolean
  /** Other engines the user allowed to use this login. */
  sharedWith?: { runtimeId: string; label: string; account: string }[]
  onLogin: (method: LoginMethod) => void
  onRemove: () => void
  onRevoke?: (grant: { runtimeId: string; account: string }) => void
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
            {account.plan ? ` ${account.plan}` : ''} · 用于{' '}
            {[row.engine, ...sharedWith.map((grant) => grant.label)].join('、')}
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
              {sharedWith.map((grant) => (
                <Dropdown.Item
                  key={grant.runtimeId}
                  className="ea-menu-item"
                  onSelect={() => onRevoke?.(grant)}
                >
                  不再允许 {grant.label} 使用
                  <small>下次使用时会重新询问</small>
                </Dropdown.Item>
              ))}
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
  const { engines, error, pending, reload, run } = useRuntimeAccounts()
  const [defaultEngine, setDefaultEngine] = useState<string | null>(null)
  const [addingApi, setAddingApi] = useState(false)
  const [endpointsKey, setEndpointsKey] = useState(0)
  const [grants, setGrants] = useState<CredentialGrant[]>([])
  useEffect(() => {
    void window.pi
      .credentialGrants()
      .then(setGrants)
      .catch(() => undefined)
  }, [engines])
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
        {engines ? <EngineDownloads engines={engines} onChange={reload} /> : null}
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
        {snapshot.login.phase !== 'idle' || snapshot.loginPrompt ? (
          // A sign-in started from the open chat (e.g. the model picker) runs in that chat.
          <div className="ea-login">
            <LoginState login={snapshot.login} />
            {snapshot.loginPrompt ? (
              <AuthPromptCard
                prompt={snapshot.loginPrompt}
                onRespond={(promptId, value) =>
                  void window.pi.send({ type: 'account:login:respond', promptId, value })
                }
              />
            ) : null}
          </div>
        ) : null}
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
                sharedWith={grants
                  .filter(
                    (grant) =>
                      grant.account === (row.account.email?.toLowerCase() ?? row.account.id)
                  )
                  .map((grant) => ({
                    ...grant,
                    label:
                      runtimes.find((runtime) => runtime.id === grant.runtimeId)?.label ??
                      grant.runtimeId
                  }))}
                onRevoke={(grant) =>
                  void window.pi
                    .revokeCredentialGrant(grant.runtimeId, grant.account)
                    .then(setGrants)
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
          <div className="ea-group-header">
            <div>
              <h3>API 连接</h3>
              <p>用 API Key 接入官方或兼容服务，可以添加多个。</p>
            </div>
            {!addingApi ? (
              <button
                type="button"
                className="acct-button"
                disabled={Boolean(pending)}
                onClick={() => setAddingApi(true)}
              >
                <Plus size={14} />
                添加 API 连接
              </button>
            ) : null}
          </div>
        </div>

        {addingApi ? (
          <AddApiConnection
            claudeAvailable={Boolean(claude && !claude.error)}
            onClose={() => setAddingApi(false)}
            onSaved={() => {
              setAddingApi(false)
              setEndpointsKey((key) => key + 1)
              void reload()
            }}
          />
        ) : null}

        {claude ? (
          <div className="ea-subgroup">
            <div className="ea-subgroup-head">
              <span>
                <strong>Claude Code API</strong>
                <small>Anthropic 兼容接口，可以添加多个</small>
              </span>
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
            ) : !claude.error ? (
              <p className="ea-empty">还没有 Claude Code 的 API 连接。</p>
            ) : null}
          </div>
        ) : null}

        {runtimes.some((runtime) => runtime.id === 'pi') ? (
          <div className="ea-subgroup">
            <CustomEndpoints
              key={endpointsKey}
              snapshot={snapshot}
              detached={snapshot.runtime?.id !== 'pi'}
            />
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
