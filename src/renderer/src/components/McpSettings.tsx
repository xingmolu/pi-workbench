import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Server,
  Terminal
} from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import {
  mcpServerSchema,
  type McpCommand,
  type McpSnapshot,
  type McpSummary
} from '../../../shared/mcp'
import { projectNavigationReason } from '../../../shared/project-catalog'
import { confirmDiscardSettingsDraft, useSettingsDraft } from './SettingsDraftContext'
import '../assets/mcp-settings.css'

type Form = {
  id: string
  create: boolean
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  timeout: number
  secrets: string
  enabled: boolean
  confirmed: boolean
}
const emptyForm = (): Form => ({
  id: '',
  create: true,
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  timeout: 30000,
  secrets: '',
  enabled: false,
  confirmed: false
})
const labels: Record<McpSummary['status'], string> = {
  connected: '已连接',
  connecting: '连接中',
  error: '连接失败',
  disconnected: '未连接',
  disabled: '已停用',
  untrusted: '待确认启用',
  unsupported: '高级配置只读'
}
function parseSecrets(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined
  const entries = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const split = line.indexOf('=')
      if (split < 1) throw new Error('环境变量或请求头请每行填写 KEY=value。')
      return [line.slice(0, split).trim(), line.slice(split + 1)]
    })
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new Error('存在重复的变量或请求头。')
  return Object.fromEntries(entries)
}
export default function McpSettings({ snapshot }: { snapshot: AgentSnapshot }): React.JSX.Element {
  const [catalog, setCatalog] = useState<McpSnapshot | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [unknown, setUnknown] = useState(false)
  const [confirm, setConfirm] = useState<McpSummary | null>(null)
  const epoch = useRef(0)
  const lock = useRef(false)
  const baseline = useRef<Form | null>(null)
  const identity = { sessionId: snapshot.sessionId, generation: snapshot.generation }
  const blocked =
    projectNavigationReason(snapshot) ?? (snapshot.edit?.pending ? '请先完成编辑' : null)
  const run = async (command: McpCommand) => {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError('')
    const attempt = ++epoch.current
    try {
      const response = await window.pi.send(command)
      if (attempt !== epoch.current) return
      setCatalog(response.result)
      setUnknown(false)
      if (command.type !== 'mcp:list') {
        baseline.current = null
        setForm(null)
        setConfirm(null)
      }
    } catch {
      if (attempt !== epoch.current) return
      setUnknown(command.type !== 'mcp:list')
      setError(
        command.type === 'mcp:list'
          ? '读取失败，请刷新重试。'
          : '操作未确认完成。请刷新列表核对，不要直接重复提交。'
      )
    } finally {
      if (attempt === epoch.current) {
        lock.current = false
        setPending(false)
      }
    }
  }
  useEffect(() => {
    void run({ type: 'mcp:list' })
    return () => {
      epoch.current++
      lock.current = false
    }
  }, [])
  const edit = (server: McpSummary): void => {
    const next: Form = {
      id: server.id,
      create: false,
      transport: server.transport === 'http' ? 'http' : 'stdio',
      command: server.command ?? '',
      args: (server.args ?? []).join('\n'),
      url: server.url ?? '',
      timeout: server.timeout ?? 30000,
      secrets: '',
      enabled: server.enabled,
      confirmed: false
    }
    baseline.current = next
    setForm(next)
  }
  const dirty = Boolean(form && JSON.stringify(form) !== JSON.stringify(baseline.current))
  useSettingsDraft('mcp', dirty)
  const save = () => {
    if (!form || !catalog || lock.current) return
    try {
      const secrets = parseSecrets(form.secrets)
      const server = mcpServerSchema.parse({
        timeout: form.timeout,
        ...(form.transport === 'stdio'
          ? {
              command: form.command,
              args: form.args ? form.args.split('\n') : [],
              ...(secrets ? { env: secrets } : {})
            }
          : { url: form.url, ...(secrets ? { headers: secrets } : {}) })
      })
      if (form.enabled && !form.confirmed) {
        setError('启用前请确认本机执行与网络访问风险。')
        return
      }
      setForm({ ...form, secrets: '' })
      void run({
        type: 'mcp:save',
        ...identity,
        revision: catalog.revision,
        id: form.id,
        create: form.create,
        server,
        enabled: form.enabled
      })
    } catch {
      setError(
        '配置无效。检查名称、命令/URL、超时及 KEY=value 格式；HTTP 仅支持 HTTPS 或本机地址。'
      )
    }
  }
  const editable = !pending && !unknown && !blocked && Boolean(catalog?.writable)
  const visible =
    catalog?.servers.filter((server) => server.id.toLowerCase().includes(query.toLowerCase())) ?? []
  return (
    <section className="mcp-settings" aria-label="MCP 服务器设置">
      <header className="mcp-heading">
        <div>
          <h2>MCP 服务器</h2>
          <p>
            通过 MCP 协议为 Agent 接入本地命令或远程服务提供的工具。配置保存在{' '}
            <code>~/.pi/agent/mcp.json</code>，不会自动导入其他应用或项目的配置。
          </p>
        </div>
        <button
          className="mcp-button"
          type="button"
          disabled={pending}
          onClick={() => {
            if (!confirmDiscardSettingsDraft(dirty)) return
            baseline.current = null
            setForm(null)
            void run({ type: 'mcp:list' })
          }}
        >
          <RefreshCw size={14} className={pending ? 'spin' : undefined} />
          刷新列表
        </button>
      </header>
      {error && (
        <p role="alert" className="mcp-message is-error">
          {error}
        </p>
      )}
      {catalog?.message && (
        <p role="status" className="mcp-message">
          {catalog.message}
        </p>
      )}
      {blocked && (
        <p role="status" className="mcp-message">
          {blocked}；当前仅可查看配置。
        </p>
      )}
      {form ? (
        <form
          className="mcp-form"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <button
            type="button"
            className="mcp-back"
            disabled={pending}
            onClick={() => {
              if (!confirmDiscardSettingsDraft(dirty)) return
              baseline.current = null
              setForm(null)
              setError('')
            }}
          >
            <ChevronLeft size={14} />
            返回列表
          </button>
          <h3>{form.create ? '新建 MCP 服务器' : `编辑 ${form.id}`}</h3>

          <div className="mcp-form-group">
            <p className="mcp-form-group-title">基本信息</p>
            <div className="mcp-form-card">
              <label className="mcp-field">
                <span>名称</span>
                <input
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                  aria-label="名称"
                  value={form.id}
                  disabled={!form.create || pending}
                  placeholder="my-mcp-server"
                  onChange={(event) => setForm({ ...form, id: event.target.value })}
                />
                <small>字母、数字、- 或 _，保存后不可修改。</small>
              </label>
              <label className="mcp-field">
                <span>连接类型</span>
                <span className="mcp-select">
                  <select
                    aria-label="连接类型"
                    value={form.transport}
                    disabled={pending}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        transport: event.target.value as Form['transport'],
                        secrets: '',
                        confirmed: false
                      })
                    }
                  >
                    <option value="stdio">stdio · 本地命令</option>
                    <option value="http">Streamable HTTP · 远程服务</option>
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              </label>
            </div>
          </div>

          <div className="mcp-form-group">
            <p className="mcp-form-group-title">连接</p>
            <div className="mcp-form-card">
              {form.transport === 'stdio' ? (
                <>
                  <label className="mcp-field">
                    <span>命令</span>
                    <input
                      required
                      className="is-mono"
                      placeholder="npx 或可执行文件的绝对路径"
                      aria-label="命令"
                      value={form.command}
                      disabled={pending}
                      onChange={(event) =>
                        setForm({ ...form, command: event.target.value, confirmed: false })
                      }
                    />
                  </label>
                  <label className="mcp-field">
                    <span>参数 · 每行一个</span>
                    <textarea
                      aria-label="参数 · 每行一个"
                      className="is-mono"
                      value={form.args}
                      disabled={pending}
                      onChange={(event) =>
                        setForm({ ...form, args: event.target.value, confirmed: false })
                      }
                      placeholder={'-y\n@modelcontextprotocol/server-memory'}
                    />
                  </label>
                </>
              ) : (
                <label className="mcp-field">
                  <span>服务 URL</span>
                  <input
                    required
                    type="url"
                    className="is-mono"
                    value={form.url}
                    disabled={pending}
                    onChange={(event) =>
                      setForm({ ...form, url: event.target.value, confirmed: false })
                    }
                    placeholder="https://example.com/mcp"
                    aria-label="服务 URL"
                  />
                  <small>仅支持 HTTPS 或本机地址；凭据请放在请求头里，不要写进 URL。</small>
                </label>
              )}
              <label className="mcp-field is-inline">
                <span>超时时间（毫秒）</span>
                <input
                  type="number"
                  min={1000}
                  max={60000}
                  aria-label="超时时间（毫秒）"
                  required
                  value={form.timeout}
                  disabled={pending}
                  onChange={(event) => setForm({ ...form, timeout: Number(event.target.value) })}
                />
              </label>
            </div>
          </div>

          <div className="mcp-form-group">
            <p className="mcp-form-group-title">
              {form.transport === 'stdio' ? '环境变量' : '请求头'}
            </p>
            <div className="mcp-form-card">
              <label className="mcp-field">
                <span>{form.transport === 'stdio' ? '环境变量' : '请求头'} · 每行 KEY=value</span>
                <textarea
                  aria-label={`${form.transport === 'stdio' ? '环境变量' : '请求头'} · 每行 KEY=value`}
                  value={form.secrets}
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                  className="mcp-secret-input is-mono"
                  onChange={(event) =>
                    setForm({ ...form, secrets: event.target.value, confirmed: false })
                  }
                  placeholder="留空保留已有值；填写后替换此组配置"
                />
                <small>
                  已有秘密值不会回显；不要把令牌放进命令参数或
                  URL。秘密保存在权限受限的本地配置文件中，不是系统钥匙串。
                </small>
              </label>
            </div>
          </div>

          <div className="mcp-form-group">
            <div className="mcp-form-card">
              <label className="mcp-toggle">
                <span>
                  <strong>保存后启用</strong>
                  <small>
                    启用后 Agent 会连接这个服务器并使用它的工具；工具调用仍按审批档位确认。
                  </small>
                </span>
                <input
                  type="checkbox"
                  aria-label="保存后启用"
                  checked={form.enabled}
                  disabled={pending}
                  onChange={(event) =>
                    setForm({ ...form, enabled: event.target.checked, confirmed: false })
                  }
                />
              </label>
              {form.enabled && (
                <label className="mcp-trust">
                  <input
                    type="checkbox"
                    required
                    checked={form.confirmed}
                    disabled={pending}
                    onChange={(event) => setForm({ ...form, confirmed: event.target.checked })}
                  />
                  <span>
                    我信任此服务器，允许它以本机用户权限运行或访问所填网络地址；审批只保护 Agent
                    的工具调用，不限制它的启动行为。
                  </span>
                </label>
              )}
            </div>
          </div>

          <div className="mcp-form-actions">
            <button
              type="button"
              className="mcp-button"
              disabled={pending}
              onClick={() => {
                if (!confirmDiscardSettingsDraft(dirty)) return
                baseline.current = null
                setForm(null)
                setError('')
              }}
            >
              取消
            </button>
            <button
              className="mcp-button is-primary"
              type="submit"
              disabled={pending || unknown || !!blocked || !catalog?.writable}
            >
              {pending ? '保存与连接中…' : '保存服务器'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="mcp-toolbar">
            <label className="mcp-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="搜索 MCP 服务器"
                placeholder="搜索服务器"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              className="mcp-button"
              type="button"
              disabled={!editable || !snapshot.project}
              onClick={() => void run({ type: 'mcp:reload', ...identity })}
            >
              重新连接
            </button>
            <button
              className="mcp-button is-primary"
              type="button"
              disabled={!editable}
              onClick={() => {
                const next = emptyForm()
                baseline.current = next
                setForm(next)
                setError('')
              }}
            >
              <Plus size={14} />
              新建
            </button>
          </div>
          {!catalog ? (
            <p role="status" className="mcp-loading">
              {pending ? '读取服务器配置…' : '尚未读取配置'}
            </p>
          ) : !catalog.servers.length ? (
            <div className="mcp-empty">
              <span className="mcp-tile" aria-hidden="true">
                <Server size={18} />
              </span>
              <h3>还没有 MCP 服务器</h3>
              <p>添加本地命令或远程服务，让 Agent 使用它提供的工具。</p>
            </div>
          ) : (
            <div className="mcp-list">
              {visible.map((server) => (
                <article className="mcp-server" key={server.id}>
                  <div className="mcp-server-head">
                    <span className="mcp-tile" aria-hidden="true">
                      {server.transport === 'http' ? <Globe size={15} /> : <Terminal size={15} />}
                    </span>
                    <div className="mcp-server-text">
                      <div className="mcp-server-name">
                        <strong>{server.id}</strong>
                        <span className={`mcp-state is-${server.status}`}>
                          {labels[server.status]}
                        </span>
                      </div>
                      <code>{server.command ?? server.url ?? '本版不支持的高级配置'}</code>
                      <small>
                        {server.toolCount} 个工具
                        {server.envKeys.length ? ` · 环境变量：${server.envKeys.join(', ')}` : ''}
                        {server.headerKeys.length
                          ? ` · 请求头：${server.headerKeys.join(', ')}`
                          : ''}
                      </small>
                    </div>
                    <div className="mcp-row-actions">
                      <button
                        className="mcp-button is-quiet"
                        type="button"
                        disabled={!editable || !server.editable}
                        onClick={() => edit(server)}
                      >
                        编辑
                      </button>
                      <button
                        className="mcp-button"
                        type="button"
                        disabled={!editable || !server.editable}
                        onClick={() =>
                          server.enabled
                            ? void run({
                                type: 'mcp:toggle',
                                ...identity,
                                id: server.id,
                                revision: catalog.revision,
                                enabled: false
                              })
                            : setConfirm(server)
                        }
                      >
                        {server.enabled ? '停用' : '启用'}
                      </button>
                    </div>
                  </div>
                  {server.message && (
                    <p role="status" className="mcp-server-message">
                      {server.message}
                    </p>
                  )}
                  {confirm?.id === server.id && (
                    <div className="mcp-confirm">
                      <p>
                        启用 {server.id} 会允许本机命令启动或连接该网络地址。仅启用你信任的服务器。
                      </p>
                      <div>
                        <button
                          className="mcp-button"
                          type="button"
                          disabled={pending}
                          onClick={() => setConfirm(null)}
                        >
                          取消
                        </button>
                        <button
                          className="mcp-button is-primary"
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            void run({
                              type: 'mcp:toggle',
                              ...identity,
                              id: server.id,
                              revision: catalog.revision,
                              enabled: true
                            })
                          }
                        >
                          确认信任并启用
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {visible.length === 0 ? <p className="mcp-no-match">没有匹配的服务器</p> : null}
            </div>
          )}
        </>
      )}
      <p className="mcp-footnote">
        当前支持文本工具；不支持 MCP Apps、资源与提示模板、远程 OAuth 或 JSON
        批量导入。服务报错不会显示为成功；停止工具调用会关闭连接，可以随时重新连接。
      </p>
    </section>
  )
}
